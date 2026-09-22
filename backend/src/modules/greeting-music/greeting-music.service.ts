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
import { head } from '@vercel/blob';
import { createHash, randomBytes } from 'crypto';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GreetingMusicTheme,
  GreetingMusicView,
  GreetingOccasion,
} from '../../common/types/greeting.types';
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
  ) {}

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
