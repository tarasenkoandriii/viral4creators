/**
 * GreetingStickerService — наклейки и оверлеи поверх кадра (фича №8).
 *
 * Своего каталога не держит и картинок в репозитории не хранит: их
 * ищет пользователь на Pixabay, по своему запросу. Тот же приём, что
 * в соседнем проекте автора (`atm-travel`, `blog.service.ts`):
 * Pixabay → скачать к себе → отдавать уже свой файл.
 *
 * Скачивание здесь не оптимизация, а требование условий Pixabay:
 * «permanent hotlinking of images is not allowed… please download them
 * to your server first». Ссылка Pixabay в готовом ролике была бы
 * нарушением — и заодно ролик сломался бы в тот день, когда картинку
 * там удалят.
 *
 * Кеш поиска — тоже требование («Requests must be cached for 24
 * hours»), а не забота о скорости. Кеш в памяти процесса: на Vercel
 * экземпляров много, и строго «один запрос на сутки на всех» он не
 * даёт, но повторные нажатия одного человека гасит — а это и есть та
 * нагрузка, ради которой правило написано.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { randomBytes } from 'crypto';
import { loadConfiguration } from '../../config/configuration';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GreetingStickerSelection,
  GreetingStickerView,
} from '../../common/types/greeting.types';
import {
  STICKER_CACHE_TTL_MS,
  StickerCandidate,
  parseStickerHits,
  stickerCacheKey,
  stickerSearchParams,
} from './pixabay-stickers';
import { normalizeStickerPlacement } from '../../common/sticker-overlay';

const PIXABAY_API = 'https://pixabay.com/api/';
const TIMEOUT_MS = 10_000;
/** Больше 2 МБ для наклейки не нужно — это PNG, а не постер. */
const MAX_STICKER_BYTES = 2 * 1024 * 1024;
/** Сколько разных запросов держим в памяти. Кеш — не база. */
const MAX_CACHED_QUERIES = 200;

interface CacheEntry {
  results: StickerCandidate[];
  expiresAt: number;
}

@Injectable()
export class GreetingStickerService {
  private readonly logger = new Logger(GreetingStickerService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
  ) {}

  private get apiKey(): string {
    // Читается на каждом вызове, а не в конструкторе: на Vercel
    // экземпляры живут разное время, и правка переменной иначе
    // вступала бы в силу для разных запросов в разное время.
    return loadConfiguration().pixabay.apiKey;
  }

  async view(sessionId: string, query: string): Promise<GreetingStickerView> {
    const snapshot = (await this.load(sessionId)).greetingBriefSnapshot!;
    const configured = !!this.apiKey;
    const results = configured && query.trim() ? await this.search(query) : [];
    return {
      // Наружу отдаём превью и страницу источника — полноразмерную
      // ссылку клиенту знать незачем, скачиваем мы сами.
      results: results.map((r) => ({
        id: r.id,
        previewUrl: r.previewUrl,
        sourceUrl: r.sourceUrl,
        tags: r.tags,
      })),
      selected: snapshot.sticker ?? null,
      configured,
    };
  }

  /**
   * Выбрать найденную наклейку: скачать к себе и записать в снимок.
   *
   * Кандидат берётся из кеша того же запроса, а не из тела запроса:
   * иначе клиент мог бы прислать любой URL и заставить сервер скачать
   * что угодно откуда угодно.
   */
  async select(
    sessionId: string,
    query: string,
    stickerId: string,
    placement: string | null,
  ): Promise<GreetingStickerView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    if (!this.apiKey) {
      throw new BadRequestException(
        'Поиск наклеек не настроен на этом стенде (PIXABAY_API_KEY)',
      );
    }
    const candidate = (await this.search(query)).find(
      (r) => r.id === stickerId,
    );
    if (!candidate) {
      throw new NotFoundException(
        'Такой наклейки в выдаче нет — повторите поиск',
      );
    }

    const file = await this.download(candidate.downloadUrl);
    const id = `st_${randomBytes(6).toString('hex')}`;
    const pathname = `sessions/${sessionId}/stickers/${id}.png`;
    const { url } = await this.blob.uploadBuffer(pathname, file, 'image/png');

    const selected: GreetingStickerSelection = {
      id,
      url,
      pathname,
      sourceUrl: candidate.sourceUrl,
      source: 'pixabay',
      placement: normalizeStickerPlacement(placement),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, sticker: selected },
    });
    return { ...(await this.view(sessionId, '')), selected };
  }

  /** Положение уже выбранной наклейки — без повторного скачивания. */
  async move(
    sessionId: string,
    placement: string,
  ): Promise<GreetingStickerView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    if (!snapshot.sticker) {
      throw new NotFoundException('Наклейка не выбрана');
    }
    const selected: GreetingStickerSelection = {
      ...snapshot.sticker,
      placement: normalizeStickerPlacement(placement),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, sticker: selected },
    });
    return { ...(await this.view(sessionId, '')), selected };
  }

  /** Снять наклейку. Файл остаётся до уборки сессии — он уже оплачен трафиком. */
  async clear(sessionId: string): Promise<GreetingStickerView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, sticker: null },
    });
    return { ...(await this.view(sessionId, '')), selected: null };
  }

  private async search(query: string): Promise<StickerCandidate[]> {
    const key = stickerCacheKey(query);
    if (!key) return [];
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.results;

    let results: StickerCandidate[] = [];
    try {
      const res = await axios.get(PIXABAY_API, {
        params: stickerSearchParams(query, this.apiKey),
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300) {
        results = parseStickerHits(res.data);
      } else {
        this.logger.warn(`Pixabay ответил ${res.status} на «${key}»`);
      }
    } catch (e) {
      // Пустая выдача вместо ошибки: без наклейки ролик всё равно
      // получится, а красный экран на поиске картинки — нет.
      this.logger.warn(
        `поиск наклеек не удался: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (this.cache.size >= MAX_CACHED_QUERIES) {
      // Простейшее вытеснение: кеш здесь — не база, и точность
      // политики вытеснения не стоит отдельной структуры.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, {
      results,
      expiresAt: Date.now() + STICKER_CACHE_TTL_MS,
    });
    return results;
  }

  private async download(url: string): Promise<Buffer> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_STICKER_BYTES,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BadRequestException(
        `не удалось скачать наклейку (HTTP ${res.status})`,
      );
    }
    return Buffer.from(res.data);
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException(
        `Session ${sessionId} is not a greeting session`,
      );
    }
    return session;
  }
}
