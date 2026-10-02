/**
 * Чистая часть клиента распознавания Soniox (асинхронный API): тело запроса
 * транскрипции, разбор токенов в текст, преобладающий язык, секунды для
 * счёта. Вынесено из `modules/voice/soniox-stt.client.ts` без изменения
 * поведения (Э5 помощника клиентских сайтов, 02.10.2026): ту же механику
 * переиспользует sites-backend — копией через `scripts/sync-sites-shared.mjs`
 * (копируются только чистые модули, без Nest). Сам клиент с уборкой у
 * провайдера в `finally` остаётся в модуле голоса — его сторожит шов
 * `check-docs.mjs` «голос не остаётся у провайдера».
 */

import { SONIOX_STT_ASYNC_MODEL } from './soniox';

export interface SonioxSttRequest {
  audio: Buffer;
  mimeType: string;
  /** Упорядоченные подсказки языка. */
  languageHints: readonly string[];
  /** Держаться подсказок строже — повтор после ответа латиницей. */
  strictLanguage?: boolean;
  /** Слова, которые должны быть распознаны именно так: имена из брифа. */
  terms?: ReadonlyArray<string | null | undefined>;
}

/** Фрагмент расшифровки Soniox. Экспорт — для клиентов и тестов. */
export interface SonioxToken {
  text?: string;
  /** Язык фрагмента — есть при `enable_language_identification`. */
  language?: string;
  end_ms?: number;
  is_audio_event?: boolean;
}

/**
 * Секунды для счёта: по длительности, которую сообщил сам Soniox, — он
 * выставляет счёт за весь файл, а не за речь в нём. Последний токен —
 * только запасной вариант: на тишине токенов нет, и счёт по ним вышел
 * бы нулём за оплаченный вызов. Экспорт — для тестов.
 */
export function billedSeconds(
  audioMs: number | null,
  tokenSeconds: number,
): number {
  return audioMs !== null ? Math.round(audioMs / 100) / 10 : tokenSeconds;
}

/**
 * Токены → текст. Служебный `<end>` и звуковые события (смех, музыка) в
 * текст не попадают — то же, что у Devil's Advocate. Экспорт — для тестов.
 */
export function sonioxTranscriptText(transcript: {
  text?: string;
  tokens?: SonioxToken[];
}): { text: string | null; seconds: number; language: string | null } {
  const tokens = transcript.tokens ?? [];
  const spoken = tokens.filter(
    (t) => t.text !== '<end>' && t.is_audio_event !== true,
  );
  const joined = tokens.length
    ? spoken.map((t) => t.text ?? '').join('')
    : (transcript.text ?? '');
  const lastEnd = tokens.reduce(
    (max, t) =>
      typeof t.end_ms === 'number' && t.end_ms > max ? t.end_ms : max,
    0,
  );
  const text = joined.replace(/\s+/g, ' ').trim();
  return {
    text: text || null,
    seconds: Math.round(lastEnd / 100) / 10,
    language: dominantSonioxLanguage(spoken),
  };
}

/**
 * Преобладающий язык речи: у Soniox язык стоит на каждом фрагменте, а не
 * на расшифровке целиком — это и есть переключение языка внутри фразы.
 * Вес фрагмента — число букв в нём: «ну» не должно перевешивать
 * «поздравь маму с юбилеем». Ничья — у языка, встреченного первым.
 * Экспорт — для тестов.
 */
export function dominantSonioxLanguage(tokens: SonioxToken[]): string | null {
  const weight = new Map<string, number>();
  for (const t of tokens) {
    const lang = t.language?.trim().toLowerCase().split(/[-_]/)[0];
    if (!lang) continue;
    const letters = (t.text ?? '').replace(/[^\p{L}]/gu, '').length;
    weight.set(lang, (weight.get(lang) ?? 0) + letters);
  }
  let best: string | null = null;
  let bestWeight = 0;
  for (const [lang, w] of weight) {
    if (w > bestWeight) {
      best = lang;
      bestWeight = w;
    }
  }
  return best;
}

/** Тело запроса транскрипции. Экспорт — для тестов. */
export function sonioxTranscriptionBody(
  fileId: string,
  req: Pick<SonioxSttRequest, 'languageHints' | 'strictLanguage' | 'terms'>,
): Record<string, unknown> {
  const terms = (req.terms ?? [])
    .map((t) => t?.trim())
    .filter((t): t is string => !!t);
  return {
    model: SONIOX_STT_ASYNC_MODEL,
    file_id: fileId,
    // Пустой список — не «никакого языка», а «определи сам»: так
    // распознаётся диктовка описания товара, где язык продавца заранее
    // неизвестен.
    ...(req.languageHints.length
      ? { language_hints: [...req.languageHints] }
      : {}),
    ...(req.strictLanguage && req.languageHints.length
      ? { language_hints_strict: true }
      : {}),
    // Смешанная речь — норма аудитории: язык определяется по фрагментам.
    enable_language_identification: true,
    enable_speaker_diarization: false,
    ...(terms.length ? { context: { terms } } : {}),
  };
}
