/**
 * TiktokUploadService — тонкий клиент TikTok Content Posting API
 * (этап 61, ТЗ §14.5). В отличие от YouTube этот шаг честно
 * многотиковый: `init` открывает публикацию и отдаёт `publish_id` (тик
 * N), `pollStatus` опрашивает готовность на последующих тиках (N+1…) —
 * TikTok обрабатывает видео асинхронно, синхронного «готово» не бывает.
 *
 * `privacy_level` — `TIKTOK_PUBLISH_PRIVACY`, по умолчанию `SELF_ONLY` (не
 * поле формы): Content Posting API для НЕАУДИРОВАННЫХ приложений
 * разрешает публиковать только в приватном режиме — это ограничение
 * площадки (см. ТЗ §14.1/§14.4). После аудита переменная переключает
 * видимость без деплоя; значение сверяется с creator_info.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';

const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const CREATOR_INFO_URL =
  'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';

/**
 * Видимость публикации — `TIKTOK_PUBLISH_PRIVACY`, по умолчанию
 * `SELF_ONLY` (единственное, что разрешено неаудированному приложению).
 * Значение сверяется с `privacy_level_options` из creator_info — так же,
 * как в работающей интеграции SilverFinance (`src/lib/server/tiktok.ts`).
 */
export function tiktokPublishPrivacy(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.TIKTOK_PUBLISH_PRIVACY?.trim() || 'SELF_ONLY';
}

export interface TiktokCreatorInfo {
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number | null;
}

/** М-6.5 седьмого аудита: без таймаутов зависший TLS держал крон-тик до
 * убийства функции Vercel, не снимая лок строки штатно. */
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 180_000;

/** HTTP 200 с `error.code !== 'ok'` — ошибка площадки, не «ещё идёт»
 * (М-6.3 седьмого аудита). Бросает с `status: 400`, чтобы воркер считал
 * её терминальной для этой попытки (recordFailure → backoff/FAILED). */
function assertTiktokOk(data: unknown, what: string): void {
  const err = (data as { error?: { code?: string; message?: string } } | null)
    ?.error;
  if (err?.code && err.code !== 'ok') {
    throw Object.assign(
      new Error(
        `TikTok: ${what} — ${err.code}${err.message ? `: ${err.message}` : ''}`,
      ),
      { status: 400 },
    );
  }
}

export interface TiktokUploadInput {
  title: string;
  description: string;
  /** Публичная Blob-ссылка на собственную копию ролика заявки. */
  videoUrl: string;
}

export interface TiktokInitResult {
  publishId: string;
  uploadUrl: string;
  /** Байты ролика, уже скачанные для `video_size`: заливка берёт их,
   * а не качает ролик из Blob второй раз (счёт Blob, 01.10.2026). */
  bytes: Buffer;
}

export interface TiktokPollResult {
  status: 'processing' | 'published' | 'failed';
  externalId: string | null;
  error: string | null;
}

@Injectable()
export class TiktokUploadService {
  /**
   * Шаг 0 — creator_info/query. TikTok требует вызывать его перед прямой
   * публикацией (UX-правила Content Posting API): он отдаёт допустимые
   * уровни видимости и запреты аккаунта на комментарии/дуэты/стичи.
   * Портировано из работающей интеграции SilverFinance (01.10.2026).
   */
  async creatorInfo(accessToken: string): Promise<TiktokCreatorInfo> {
    const res = await axios.post(
      CREATOR_INFO_URL,
      {},
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        validateStatus: () => true,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    if (res.status < 400) assertTiktokOk(res.data, 'creator_info');
    if (res.status >= 400) {
      throw Object.assign(
        new Error(
          `TikTok: creator_info не удался (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    const d = (res.data?.data ?? {}) as Record<string, unknown>;
    return {
      privacyOptions: Array.isArray(d.privacy_level_options)
        ? (d.privacy_level_options as unknown[]).map(String)
        : [],
      commentDisabled: d.comment_disabled === true,
      duetDisabled: d.duet_disabled === true,
      stitchDisabled: d.stitch_disabled === true,
      maxDurationSec:
        typeof d.max_video_post_duration_sec === 'number'
          ? d.max_video_post_duration_sec
          : null,
    };
  }

  /** Шаг 1 — сообщить площадке размер файла, получить publish_id + upload_url. */
  async init(
    input: TiktokUploadInput,
    accessToken: string,
  ): Promise<TiktokInitResult> {
    const info = await this.creatorInfo(accessToken);
    const privacy = tiktokPublishPrivacy();
    if (
      info.privacyOptions.length > 0 &&
      !info.privacyOptions.includes(privacy)
    ) {
      throw Object.assign(
        new Error(
          `TikTok: видимость ${privacy} аккаунту недоступна — разрешены ${info.privacyOptions.join(', ')} (переменная TIKTOK_PUBLISH_PRIVACY)`,
        ),
        { status: 400 },
      );
    }
    const source = await axios.get<ArrayBuffer>(input.videoUrl, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT_MS,
    });
    const bytes = Buffer.from(source.data);
    const size = bytes.byteLength;
    // TikTok не разделяет title/description на площадке — единая подпись
    // (caption) до 2200 символов.
    const caption = [input.title, input.description]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2200);
    const res = await axios.post(
      INIT_URL,
      {
        post_info: {
          title: caption,
          privacy_level: privacy,
          // Не включаем то, что аккаунт запретил (creator_info).
          disable_duet: info.duetDisabled,
          disable_comment: info.commentDisabled,
          disable_stitch: info.stitchDisabled,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: size,
          // Один чанк на весь файл — ролики небольшие (та же посылка,
          // что у одного PUT в youtube-upload.service.ts).
          chunk_size: size,
          total_chunk_count: 1,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        validateStatus: () => true,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    if (res.status < 400) assertTiktokOk(res.data, 'init');
    const publishId = res.data?.data?.publish_id as string | undefined;
    const uploadUrl = res.data?.data?.upload_url as string | undefined;
    if (res.status >= 400 || !publishId || !uploadUrl) {
      throw Object.assign(
        new Error(
          `TikTok: init не удался (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    return { publishId, uploadUrl, bytes };
  }

  /** Шаг 2 (тот же тик, что init) — залить байты в полученный upload_url. */
  async uploadBytes(
    uploadUrl: string,
    videoUrl: string,
    /** Байты из `init` — без второго скачивания из Blob. */
    preloaded?: Buffer,
  ): Promise<void> {
    const bytes =
      preloaded ??
      Buffer.from(
        (
          await axios.get<ArrayBuffer>(videoUrl, {
            responseType: 'arraybuffer',
            timeout: DOWNLOAD_TIMEOUT_MS,
          })
        ).data,
      );
    const res = await axios.put(uploadUrl, bytes, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
      timeout: UPLOAD_TIMEOUT_MS,
    });
    if (res.status >= 400) {
      throw Object.assign(
        new Error(
          `TikTok: загрузка байт не удалась (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
  }

  /** Шаг 3 (следующие тики) — опрос готовности по сохранённому publish_id. */
  async pollStatus(
    publishId: string,
    accessToken: string,
  ): Promise<TiktokPollResult> {
    const res = await axios.post(
      STATUS_URL,
      { publish_id: publishId },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8',
        },
        validateStatus: () => true,
        timeout: REQUEST_TIMEOUT_MS,
      },
    );
    if (res.status >= 400) {
      throw Object.assign(
        new Error(
          `TikTok: опрос статуса не удался (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    // М-6.3 седьмого аудита: Content Posting API отвечает HTTP 200 с
    // `error.code !== 'ok'` (access_token_invalid, invalid_params,
    // scope_not_authorized…) — раньше это читалось как «ещё
    // обрабатывается» и заявка опрашивалась вечно.
    assertTiktokOk(res.data, 'опрос статуса');
    const status = res.data?.data?.status as string | undefined;
    const postIds = res.data?.data?.publicly_available_post_id as
      | Array<string | number>
      | undefined;
    const failReason = res.data?.data?.fail_reason as string | undefined;

    if (status === 'PUBLISH_COMPLETE') {
      const externalId =
        postIds && postIds.length > 0 ? String(postIds[0]) : publishId;
      return { status: 'published', externalId, error: null };
    }
    if (status === 'FAILED') {
      return {
        status: 'failed',
        externalId: null,
        error:
          failReason || 'TikTok сообщил об ошибке публикации без подробностей',
      };
    }
    // PROCESSING_DOWNLOAD / PROCESSING_UPLOAD / ещё не начато — ждём
    // следующего тика крона.
    return { status: 'processing', externalId: null, error: null };
  }
}

function describe(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}
