/**
 * TiktokUploadService — тонкий клиент TikTok Content Posting API
 * (этап 61, ТЗ §14.5). В отличие от YouTube этот шаг честно
 * многотиковый: `init` открывает публикацию и отдаёт `publish_id` (тик
 * N), `pollStatus` опрашивает готовность на последующих тиках (N+1…) —
 * TikTok обрабатывает видео асинхронно, синхронного «готово» не бывает.
 *
 * `privacy_level` жёстко `SELF_ONLY` (не поле формы): Content Posting
 * API для НЕАУДИРОВАННЫХ приложений разрешает публиковать только в
 * приватном режиме — это ограничение площадки (см. ТЗ §14.1/§14.4), а
 * не выбор оператора; в отличие от YouTube, где приватность настоящая
 * настройка API, не завязанная на аудит.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';

const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

export interface TiktokUploadInput {
  title: string;
  description: string;
  /** Публичная Blob-ссылка на собственную копию ролика заявки. */
  videoUrl: string;
}

export interface TiktokInitResult {
  publishId: string;
  uploadUrl: string;
}

export interface TiktokPollResult {
  status: 'processing' | 'published' | 'failed';
  externalId: string | null;
  error: string | null;
}

@Injectable()
export class TiktokUploadService {
  /** Шаг 1 — сообщить площадке размер файла, получить publish_id + upload_url. */
  async init(
    input: TiktokUploadInput,
    accessToken: string,
  ): Promise<TiktokInitResult> {
    const source = await axios.get<ArrayBuffer>(input.videoUrl, {
      responseType: 'arraybuffer',
    });
    const size = source.data.byteLength;
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
          privacy_level: 'SELF_ONLY',
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
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
      },
    );
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
    return { publishId, uploadUrl };
  }

  /** Шаг 2 (тот же тик, что init) — залить байты в полученный upload_url. */
  async uploadBytes(uploadUrl: string, videoUrl: string): Promise<void> {
    const source = await axios.get<ArrayBuffer>(videoUrl, {
      responseType: 'arraybuffer',
    });
    const bytes = Buffer.from(source.data);
    const res = await axios.put(uploadUrl, bytes, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      validateStatus: () => true,
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
