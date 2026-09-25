/**
 * YoutubeCaptionsService — загрузка дорожки субтитров к уже
 * опубликованному ролику (этап 137, ТЗ TZ-Multilingual-YouTube.md).
 *
 * ## Почему это отдельно от загрузки ролика
 *
 * `captions.insert` — единственный вызов всего ТЗ, которому нужен
 * скоуп `youtube.force-ssl`. Локализованные заголовки и описания
 * обходятся базовым правом (они уезжают частью `videos.insert`), а
 * субтитры — нет. Поэтому у канала без расширенного согласия этот шаг
 * просто не делается: ролик опубликован, всё остальное на месте, а
 * рядом на экране каналов стоит кнопка «Разрешить субтитры».
 *
 * ## Формат запроса
 *
 * `uploadType=multipart`: одна часть — JSON со `snippet` (id ролика,
 * язык, имя дорожки), вторая — сам `.srt`. Тело собирается руками, без
 * SDK и без формошлёпных библиотек — та же конвенция, что у остальных
 * клиентов площадок в проекте (сырой `axios`).
 *
 * `sync=false` (умолчание) означает «таймкоды у файла свои, не
 * подгонять»: у нас они есть, и просить площадку синхронизировать текст
 * по звуку значило бы отдать ей то, что мы уже посчитали.
 */

import { Injectable } from '@nestjs/common';
import axios from 'axios';

const INSERT_URL =
  'https://www.googleapis.com/upload/youtube/v3/captions?uploadType=multipart&part=snippet';
const TIMEOUT_MS = 60_000;

/** Граница multipart — фиксированная строка, которой нет в наших данных. */
const BOUNDARY = 'v4c-captions-boundary';

export interface CaptionsInsertInput {
  videoId: string;
  /** Язык дорожки (ISO 639-1) — тот же, что `defaultLanguage` ролика. */
  language: string;
  /** Подпись дорожки в списке языков. */
  name: string;
  srt: string;
}

@Injectable()
export class YoutubeCaptionsService {
  async insert(
    input: CaptionsInsertInput,
    accessToken: string,
  ): Promise<{ captionId: string }> {
    const snippet = {
      snippet: {
        videoId: input.videoId,
        language: input.language,
        name: input.name.slice(0, 150),
        isDraft: false,
      },
    };
    const body = [
      `--${BOUNDARY}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(snippet),
      `--${BOUNDARY}`,
      // `application/octet-stream`, а не `text/plain`: площадка
      // определяет формат по содержимому, а не по типу, и на `text/*`
      // некоторые прокси normalize'ят переводы строк — для `.srt` это
      // ломает блоки.
      'Content-Type: application/octet-stream',
      '',
      input.srt,
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n');

    const res = await axios.post(INSERT_URL, body, {
      timeout: TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${BOUNDARY}`,
      },
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      throw Object.assign(
        new Error(
          `YouTube: субтитры не приняты (${res.status}): ${describe(res.data)}`,
        ),
        { status: res.status },
      );
    }
    const id = (res.data as { id?: string } | undefined)?.id;
    if (!id) {
      throw new Error('YouTube: ответ на загрузку субтитров без id дорожки');
    }
    return { captionId: id };
  }
}

function describe(data: unknown): string {
  try {
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return String(data).slice(0, 300);
  }
}
