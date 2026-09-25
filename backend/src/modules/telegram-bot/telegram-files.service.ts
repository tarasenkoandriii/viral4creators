/**
 * Скачивание вложений из Telegram в наше хранилище (этап 157,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.3).
 *
 * ## Почему сразу, а не по требованию
 *
 * Telegram отдаёт `file_id`, а не файл. Хранить один `file_id` нельзя
 * по двум причинам, и вторая решает: админка не может ходить в Telegram
 * с токеном бота из браузера, а ссылка, выданная `getFile`, живёт около
 * часа — к моменту, когда оператор откроет тикет, её уже не будет.
 * Поэтому файл скачивается в момент приёма и кладётся в наше
 * хранилище, ровно как транзитные копии референсных роликов.
 *
 * ## Что делать с провалом
 *
 * Ничего страшного: тикет важнее вложения. Неудачная загрузка
 * возвращает `null`, тикет заводится без файла, а человеку об этом
 * говорят (`telegram-bot/tester-tickets.service.ts`). Молча терять
 * вложение нельзя — он будет считать, что прислал.
 */

import { Injectable, Logger } from '@nestjs/common';
import { BlobService } from '../storage/blob.service';
import {
  AttachmentClaim,
  TELEGRAM_FILE_LIMIT,
  tooBig,
} from '../../common/test-ticket';

/** Столько же, сколько у отправки сообщений в этот же Telegram. */
const TIMEOUT_MS = 10_000;

export interface StoredAttachment {
  url: string;
  kind: AttachmentClaim['kind'];
  size: number;
  fileName: string | null;
  mimeType: string | null;
}

export type DownloadFailure = 'too-big' | 'failed';

export interface DownloadResult {
  stored: StoredAttachment[];
  /** Что не доехало и почему — человеку про это скажут словами. */
  failures: DownloadFailure[];
}

@Injectable()
export class TelegramFilesService {
  private readonly logger = new Logger(TelegramFilesService.name);

  constructor(private readonly blob: BlobService) {}

  private get botToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  }

  /**
   * Скачать и сложить всё, что пришло с сообщением.
   *
   * Параллельно: файлы независимы, а последовательная загрузка трёх
   * скриншотов на serverless — это три времени ожидания подряд внутри
   * одного вебхука, у которого своё время жизни.
   */
  async store(
    claims: AttachmentClaim[],
    ticketKey: string,
  ): Promise<DownloadResult> {
    const stored: StoredAttachment[] = [];
    const failures: DownloadFailure[] = [];
    if (!claims.length) return { stored, failures };

    // Потолок платформы виден по размеру ДО скачивания — отказываем
    // сразу, не тратя запрос, который всё равно вернёт отказ.
    const big = claims.filter(tooBig);
    for (const _ of big) failures.push('too-big');

    const results = await Promise.all(
      claims
        .filter((c) => !tooBig(c))
        .map((claim, i) => this.one(claim, `${ticketKey}-${i}`)),
    );
    for (const result of results) {
      if (result) stored.push(result);
      else failures.push('failed');
    }
    return { stored, failures };
  }

  private async one(
    claim: AttachmentClaim,
    key: string,
  ): Promise<StoredAttachment | null> {
    const token = this.botToken;
    if (!token) return null;
    try {
      const meta = await this.fileMeta(token, claim.fileId);
      if (!meta) return null;
      // Размер бывает известен только отсюда: в самом сообщении
      // `file_size` необязателен, и потолок пришлось бы проверять
      // после скачивания — то есть уже потратив трафик.
      if (meta.size !== null && meta.size > TELEGRAM_FILE_LIMIT) return null;

      const res = await fetch(
        `https://api.telegram.org/file/bot${token}/${meta.path}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
      if (!res.ok) {
        this.logger.warn(`Telegram отдал ${res.status} на файл вложения`);
        return null;
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.byteLength > TELEGRAM_FILE_LIMIT) return null;

      const mimeType = claim.mimeType ?? guessType(meta.path);
      // `users/<userId>/tickets/…` — не собственный префикс (аудит
      // этапа 157). Метла (`common/orphan-sweep.ts`) обходит закрытый
      // список областей и разбирает пути как `<префикс>/<id>/…`; свой
      // префикс `test-tickets/` не попадал ни в одну из них, то есть
      // эти файлы не подбирал бы НИКТО и никогда — ровно та находка,
      // которая уже записана в самой метле про `users/`. Под чужим
      // префиксом владелец разбирается сам собой, а `users` уже умеет
      // и владельца (таблица `users`), и каскад: удалили человека —
      // ушли и тикеты, и их файлы.
      const { url } = await this.blob.uploadBuffer(
        `users/${key}${extensionOf(meta.path)}`,
        buffer,
        mimeType,
      );
      return {
        url,
        kind: claim.kind,
        size: buffer.byteLength,
        fileName: claim.fileName ?? null,
        mimeType,
      };
    } catch (error) {
      this.logger.warn(
        `вложение не доехало: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async fileMeta(
    token: string,
    fileId: string,
  ): Promise<{ path: string; size: number | null } | null> {
    const res = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.warn(`getFile ответил ${res.status}`);
      return null;
    }
    const body = (await res.json()) as {
      result?: { file_path?: string; file_size?: number };
    };
    const path = body.result?.file_path;
    if (!path) return null;
    return {
      path,
      size:
        typeof body.result?.file_size === 'number'
          ? body.result.file_size
          : null,
    };
  }
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash + 1) return '';
  // Расширение из пути Telegram, но обрезанное и без сюрпризов: этот
  // кусок попадёт в имя файла в нашем хранилище.
  const ext = path.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
}

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.json': 'application/json',
};

function guessType(path: string): string {
  return TYPES[extensionOf(path)] ?? 'application/octet-stream';
}
