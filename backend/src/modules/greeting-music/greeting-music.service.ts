/**
 * GreetingMusicService — выбор музыкальной подложки для поздравления
 * (фича №4 компаньон-ТЗ).
 *
 * Своего каталога не держит: темы — лицензированные файлы, их список
 * ведёт владелец продукта настройкой платформы
 * (`GREETING_MUSIC_SETTING_KEY`, правится без редеплоя). Здесь только
 * «какие темы подходят поводу этой сессии» и «какая выбрана».
 *
 * Выбранная тема ложится в снимок брифа КОПИЕЙ — тем же приёмом, что
 * голос отправителя: каталог правится, а уже собранный ролик не
 * должен задним числом поменять музыку.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import axios from 'axios';
import { head } from '@vercel/blob';
import { createHash, randomBytes } from 'crypto';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GreetingMusicCandidate,
  GreetingMusicSelection,
  GreetingMusicTheme,
  GreetingMusicView,
  GreetingOccasion,
} from '../../common/types/greeting.types';
import { AudioService } from '../audio/audio.service';
import {
  AudioRequest,
  NormalizedAudioTrack,
  buildAttribution,
} from '../audio/audio.types';
import {
  GREETING_MUSIC_SETTING_KEY,
  findThemeForOccasion,
  parseMusicCatalog,
  themesForOccasion,
  userTrackUrl,
} from '../../common/greeting-music';
import {
  GreetingMusicConfirmRequestDto,
  GreetingMusicLinkRequestDto,
  GreetingMusicUploadUrlRequestDto,
  MAX_MUSIC_BYTES,
} from './dto/greeting-music.dto';

/**
 * Под какую длину искать трек. Ролик пятнадцать секунд, но искать
 * пятнадцатисекундную музыку бессмысленно: такой почти нет, а длинную
 * мы всё равно подрезаем сами (`atrim` в постобработке). Тридцать —
 * компромисс, при котором выдача не пустеет.
 */
const GREETING_MUSIC_TARGET_SECONDS = 30;

/** Расширение файла по типу — путь должен оставаться читаемым. */
const MUSIC_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

@Injectable()
export class GreetingMusicService {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly audio: AudioService,
  ) {}

  /**
   * Запрос к библиотеке, общий для поиска и для выбора.
   *
   * Два ограничения жёсткие и не настраиваются снаружи.
   * `commercialUseRequired` — потому что поздравление делается в
   * платном продукте и отправляется другому человеку; некоммерческая
   * лицензия этого не покрывает. `allowPaidLicense: false` — потому
   * что трек, который «можно после покупки», без покупки использовать
   * нельзя, а показывать его в выдаче значит предлагать нарушение.
   *
   * Упоминание автора при этом РАЗРЕШЕНО: такие треки мы показываем и
   * сохраняем вместе со строкой кредита (см. `attribution` в снимке).
   */
  private audioRequest(query: string): AudioRequest {
    return {
      kind: 'music',
      query: query.trim().slice(0, 100),
      durationSec: GREETING_MUSIC_TARGET_SECONDS,
      commercialUseRequired: true,
      allowAttribution: true,
      allowPaidLicense: false,
      maxResults: 20,
    };
  }

  async get(sessionId: string): Promise<GreetingMusicView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    return {
      themes: await this.themes(snapshot.occasion),
      selected: snapshot.musicTheme ?? null,
    };
  }

  /**
   * `null` снимает подложку. Неизвестная (или не подходящая поводу)
   * тема — 404, а не тихое «ничего не выбрали»: иначе пользователь
   * увидел бы «сохранено» и получил ролик без музыки.
   */
  async select(
    sessionId: string,
    themeId: string | null,
  ): Promise<GreetingMusicView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    let selected: GreetingMusicView['selected'] = null;
    if (themeId) {
      const catalog = await this.themes(snapshot.occasion);
      const theme = findThemeForOccasion(catalog, snapshot.occasion, themeId);
      if (!theme) throw new NotFoundException('Такой музыкальной темы нет');
      selected = { id: theme.id, title: theme.title, url: theme.url };
    }
    const next = { ...snapshot, musicTheme: selected };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: next,
    });
    return { themes: await this.themes(snapshot.occasion), selected };
  }

  /**
   * Своя музыка: presigned PUT, тот же приём, что у референс-кадров и
   * образцов голоса. Файл ложится под префикс СЕССИИ — значит он
   * уедет вместе с ней при удалении (`common/blob-paths.ts`), в
   * отличие от каталожной темы, которая общая для всех.
   */
  async createUploadUrl(
    sessionId: string,
    dto: GreetingMusicUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; trackId: string }> {
    await this.load(sessionId);
    const trackId = `mt_${randomBytes(6).toString('hex')}`;
    const pathname = `sessions/${sessionId}/music/${trackId}.${
      MUSIC_EXT[dto.mimeType] ?? 'mp3'
    }`;
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_MUSIC_BYTES,
    );
    return { uploadUrl, pathname, trackId };
  }

  /**
   * Подтверждение загрузки: файл реально лежит, права подтверждены.
   *
   * Права — не формальность и не галочка ради галочки: готовый ролик
   * человек отправляет другому человеку, и чужая фонограмма в нём —
   * это распространение. Отказываем до того, как трек попадёт в
   * ролик, а не после претензии.
   */
  async confirmUpload(
    sessionId: string,
    dto: GreetingMusicConfirmRequestDto,
  ): Promise<GreetingMusicView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    // Путь выдали мы сами, но пришёл он от клиента — сессия в пути
    // обязана совпасть с сессией в маршруте, иначе это способ
    // приписать чужой файл своей сессии.
    const expectedPrefix = `sessions/${sessionId}/music/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `pathname должен начинаться с "${expectedPrefix}"`,
      );
    }
    if (!dto.rightsConfirmed) {
      throw new BadRequestException(
        'Нужно подтвердить, что вы вправе использовать эту музыку в ролике',
      );
    }
    let url: string;
    try {
      url = (await head(dto.pathname)).url;
    } catch (e) {
      throw new BadRequestException(
        `Файл не найден в хранилище по пути "${dto.pathname}" — сначала загрузите его через music/upload-url (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
    }
    const trackId = dto.pathname.slice(expectedPrefix.length).split('.')[0];
    const selected = {
      id: trackId,
      title: dto.title.trim() || 'Своя музыка',
      url,
      source: 'upload' as const,
      pathname: dto.pathname,
      rightsConfirmedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, musicTheme: selected },
    });
    return { themes: await this.themes(snapshot.occasion), selected };
  }

  /**
   * Ссылка на чужой хост вместо загрузки.
   *
   * Файла у нас не появляется вовсе: в снимок ложится только ссылка, и
   * удалять при чистке сессии нечего (`source: 'link'`). Взамен мы не
   * управляем её временем жизни — трек может исчезнуть у владельца, и
   * тогда постобработка честно провалится на этом ролике. Для
   * «музыки, которая уже где-то лежит» это приемлемый размен; кому
   * нужна надёжность, тот загружает файл.
   */
  async selectLink(
    sessionId: string,
    dto: GreetingMusicLinkRequestDto,
  ): Promise<GreetingMusicView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    if (!dto.rightsConfirmed) {
      throw new BadRequestException(
        'Нужно подтвердить, что вы вправе использовать эту музыку в ролике',
      );
    }
    const url = userTrackUrl(dto.url);
    if (!url) {
      throw new BadRequestException(
        'Нужна прямая https-ссылка на файл, без логина и пароля в адресе',
      );
    }
    const selected = {
      // Собственного идентификатора у ссылки нет — берём стабильный от
      // самой ссылки, чтобы повторный ввод той же не плодил разные.
      id: `ml_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`,
      title: dto.title.trim() || 'Своя музыка',
      url,
      source: 'link' as const,
      rightsConfirmedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, musicTheme: selected },
    });
    return { themes: await this.themes(snapshot.occasion), selected };
  }

  /**
   * Поиск по библиотекам со свободной лицензией (Freesound, Jamendo,
   * Mubert — `AudioModule`).
   *
   * Ничего не скачивает и ничего не меняет: только показывает, что
   * нашлось, и на каких условиях это можно взять.
   */
  async searchLibrary(
    sessionId: string,
    query: string,
  ): Promise<GreetingMusicView> {
    const view = await this.get(sessionId);
    if (!this.audio.enabled || !query.trim()) {
      return { ...view, library: [], libraryEnabled: this.audio.enabled };
    }
    const tracks = await this.audio.candidates(this.audioRequest(query));
    return {
      ...view,
      library: tracks.map((t) => toCandidate(t)),
      libraryEnabled: true,
    };
  }

  /**
   * Взять найденный трек: скачать к себе и записать в снимок вместе с
   * лицензией и строкой упоминания.
   *
   * Скачиваем, а не ссылаемся, по трём причинам сразу. Ссылка
   * провайдера живёт своей жизнью и может исчезнуть — ролик тогда
   * перестанет собираться. Превью Freesound отдаётся по токену,
   * который в готовый ролик попадать не должен. И копия у себя — это
   * то, что при разборе лицензии можно предъявить.
   *
   * Кандидат ищется тем же запросом, а не берётся из тела: иначе
   * клиент мог бы прислать любой URL и заставить сервер скачать что
   * угодно откуда угодно.
   */
  async selectFromLibrary(
    sessionId: string,
    query: string,
    provider: string,
    providerTrackId: string,
  ): Promise<GreetingMusicView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    if (!this.audio.enabled) {
      throw new BadRequestException(
        'Библиотека музыки не настроена на этом стенде',
      );
    }
    const track = (await this.audio.candidates(this.audioRequest(query))).find(
      (t) => t.provider === provider && t.providerTrackId === providerTrackId,
    );
    if (!track) {
      throw new NotFoundException(
        'Такого трека в выдаче нет — повторите поиск',
      );
    }

    const url = await this.audio.downloadUrl(track);
    const bytes = await this.fetchTrack(url);
    const id = `ml_${randomBytes(6).toString('hex')}`;
    const pathname = `sessions/${sessionId}/music/${id}.mp3`;
    const stored = await this.blob.uploadBuffer(pathname, bytes, 'audio/mpeg');

    const selected: GreetingMusicSelection = {
      id,
      title: track.title,
      url: stored.url,
      source: 'library',
      pathname,
      licenseType: track.license.type,
      // Поля необязательные: `undefined` в снимке означало бы ключ со
      // значением `undefined`, а это не то же самое, что его
      // отсутствие, — при сериализации в JSON он просто исчезнет, и
      // читатель снимка увидит разное в зависимости от пути записи.
      ...(buildAttribution(track)
        ? { attribution: buildAttribution(track) as string }
        : {}),
      ...(track.license.licenseUrl
        ? { sourceUrl: track.license.licenseUrl }
        : {}),
    };
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, musicTheme: selected },
    });
    return { ...(await this.get(sessionId)), selected };
  }

  private async fetchTrack(url: string): Promise<Buffer> {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 20_000,
      maxContentLength: MAX_MUSIC_BYTES,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new BadRequestException(
        `не удалось скачать трек (HTTP ${res.status})`,
      );
    }
    return Buffer.from(res.data);
  }

  private async themes(
    occasion: GreetingOccasion,
  ): Promise<GreetingMusicTheme[]> {
    const raw = await this.settings.get(GREETING_MUSIC_SETTING_KEY);
    return themesForOccasion(parseMusicCatalog(raw), occasion);
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

function toCandidate(t: NormalizedAudioTrack): GreetingMusicCandidate {
  return {
    provider: t.provider,
    providerTrackId: t.providerTrackId,
    title: t.title,
    artist: t.artist ?? null,
    durationSec: Math.round(t.durationSec),
    previewUrl: t.previewUrl ?? null,
    licenseType: t.license.type,
    attribution: buildAttribution(t) ?? null,
  };
}
