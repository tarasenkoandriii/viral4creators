/**
 * YoutubeUploadService — тонкий клиент YouTube Data API v3 resumable
 * upload (этап 61, ТЗ §14.5). Сырой `axios`, без `googleapis` — та же
 * конвенция, что у остальных клиентов проекта.
 *
 * Один тик воркера открывает сессию и сразу же в неё одним PUT льёт
 * весь файл (ролики маленькие — в лимит функции Vercel Pro укладывается
 * с запасом). `PublishWorkerService` сохраняет `uploadJobId` СРАЗУ после
 * `openSession`.
 *
 * ## Возобновление вместо повторной заливки (Г-2.11 аудита round4, этап 64)
 *
 * Раньше при повторной попытке (после обрыва процесса МЕЖДУ открытием
 * сессии и записью результата — Vercel убивает функцию по таймауту без
 * гарантии, что код после `await` дойдёт до конца) воркер слепо открывал
 * НОВУЮ сессию и заливал файл заново поверх уже принятых площадкой
 * байт — если предыдущий PUT на самом деле долетел, это второй ролик на
 * канале клиента. Теперь при наличии сохранённого `uploadJobId`
 * (`checkStatus`) сначала спрашиваем у самой площадки, что с сессией:
 * `200/201` — видео уже создано, просто не успели записать `externalId`;
 * `308` с `Range` — заливка не завершена, `uploadBytes` продолжает СО
 * СЛЕДУЮЩЕГО байта, а не с нуля; иное (404/410 — сессия просрочена) —
 * вызывающий код открывает новую сессию с нуля, как раньше.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { PublicationPrivacy } from '../../common/types/publication.types';

const UPLOAD_INIT_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status';

export interface YoutubeUploadInput {
  title: string;
  description: string;
  tags: string[];
  privacy: PublicationPrivacy;
  /** Публичная Blob-ссылка на собственную копию ролика заявки. */
  videoUrl: string;
}

export interface YoutubeUploadResult {
  externalId: string;
  externalUrl: string;
}

export interface YoutubeSessionStatus {
  /** Видео уже создано площадкой — предыдущая попытка фактически
   * долетела, `externalId` заполнен и заливать больше нечего. */
  done: boolean;
  externalId?: string;
  /** Сколько байт площадка уже приняла — точка возобновления для
   * `uploadBytes`. Валидно только когда `done === false`. */
  bytesUploaded: number;
}

/** М-6.5 седьмого аудита: таймаут вызовов YouTube (заливка одним PUT — с запасом). */
const YT_TIMEOUT_MS = 180_000;

@Injectable()
export class YoutubeUploadService {
  /** Шаг 1 — открыть resumable-сессию, вернуть её URI (заголовок Location). */
  async openSession(
    input: YoutubeUploadInput,
    accessToken: string,
  ): Promise<string> {
    const body = {
      snippet: {
        title: input.title.slice(0, 100),
        description: input.description.slice(0, 5000),
        tags: input.tags,
      },
      status: {
        privacyStatus: mapPrivacy(input.privacy),
        selfDeclaredMadeForKids: false,
        // Раскрытие ИИ-контента — обязательное требование площадки для
        // синтетических роликов (§14.4), не опция оператора.
        containsSyntheticMedia: true,
      },
    };
    const res = await axios.post(UPLOAD_INIT_URL, body, {
      timeout: YT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
      },
      validateStatus: () => true,
    });
    const location = res.headers?.['location'] as string | undefined;
    if (res.status >= 400 || !location) {
      throw Object.assign(
        new Error(
          `YouTube: не удалось открыть сессию загрузки (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    return location;
  }

  /**
   * Проверить состояние уже открытой resumable-сессии без заливки байт
   * (Г-2.11) — пустой PUT с диапазоном "bytes star/star" в
   * `Content-Range` (см. код ниже), площадка сама сообщает, что с
   * сессией: см. заголовочный комментарий файла.
   */
  async checkStatus(
    sessionUri: string,
    accessToken: string,
  ): Promise<YoutubeSessionStatus> {
    const res = await axios.put(sessionUri, undefined, {
      timeout: YT_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Range': 'bytes */*',
      },
      validateStatus: () => true,
    });
    if (res.status === 200 || res.status === 201) {
      const id = (res.data as { id?: string } | undefined)?.id;
      if (!id) {
        throw new Error(
          'YouTube: сессия завершена, но ответ не содержит id видео',
        );
      }
      return { done: true, externalId: id, bytesUploaded: 0 };
    }
    if (res.status === 308) {
      // Заголовок вида "bytes=0-12345" — конец диапазона включительно,
      // значит принято ровно (конец + 1) байт; при полном отсутствии
      // заголовка площадка ещё не приняла ни одного байта.
      const range = res.headers?.['range'] as string | undefined;
      const end = range ? Number(range.split('-')[1]) : NaN;
      return {
        done: false,
        bytesUploaded: Number.isFinite(end) ? end + 1 : 0,
      };
    }
    // 404/410 и подобные — сессия просрочена/недействительна (площадка
    // хранит resumable-сессии ограниченное время); вызывающий код ловит
    // это и открывает новую сессию с нуля.
    throw Object.assign(
      new Error(
        `YouTube: сессия недействительна (${res.status}): ${describe(res.data)}`,
      ),
      { status: res.status },
    );
  }

  /**
   * Шаг 2 — скачать ролик по его собственной публичной ссылке (Blob) и
   * PUT'ом влить в открытую сессию. Источник байт — не наш файл на
   * диске: заявка ссылается на копию в Vercel Blob, площадка её не
   * видит и не может дотянуться сама, поэтому байты идут транзитом через
   * этот процесс.
   *
   * `offset` (Г-2.11) — байт, с которого продолжить уже частично
   * принятую площадкой сессию (см. `checkStatus`); по умолчанию 0 —
   * заливка с начала файла, как раньше.
   */
  async uploadBytes(
    sessionUri: string,
    videoUrl: string,
    accessToken: string,
    offset = 0,
  ): Promise<YoutubeUploadResult> {
    const source = await axios.get<ArrayBuffer>(videoUrl, {
      responseType: 'arraybuffer',
    });
    const full = Buffer.from(source.data);
    const bytes = offset > 0 ? full.subarray(offset) : full;
    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'video/mp4',
      'Content-Length': bytes.length,
    };
    if (offset > 0) {
      // Диапазон, а не файл с нуля — площадка склеивает с уже принятой
      // частью вместо того, чтобы получить дубликат первых байт.
      headers['Content-Range'] =
        `bytes ${offset}-${full.length - 1}/${full.length}`;
    }
    const res = await axios.put(sessionUri, bytes, {
      timeout: YT_TIMEOUT_MS,
      headers,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
    });
    if (res.status >= 400) {
      throw Object.assign(
        new Error(
          `YouTube: загрузка не удалась (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    const id = (res.data as { id?: string } | undefined)?.id;
    if (!id) {
      throw new Error('YouTube: ответ не содержит id созданного видео');
    }
    return { externalId: id, externalUrl: `https://youtu.be/${id}` };
  }
}

function mapPrivacy(p: PublicationPrivacy): string {
  return p === 'PUBLIC' ? 'public' : p === 'UNLISTED' ? 'unlisted' : 'private';
}

function describe(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}
