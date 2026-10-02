/**
 * WER (word error rate) — приёмка Э5 п.3: «украинская речь распознаётся на
 * eval-наборе из 30 записей с WER ≤ 15% (ПРОВЕРИТЬ порог на первых
 * записях)». ЧИСТЫЙ модуль: его зовут живой прогон (`npm run eval:voice`,
 * run-live.ts) и тест (wer.spec.ts).
 *
 * WER = (замены + вставки + удаления) / слов в эталоне — по всему набору
 * (сумма правок / сумма слов), а не среднее по записям: короткая фраза из
 * двух слов с одной ошибкой не должна весить как длинная.
 *
 * Нормализация — та, что не меняет смысла для вопроса посетителя: регистр,
 * пунктуация, апостроф (', ’, ʼ — одно), «ё» → «е», дефис между словами —
 * пробел. Числа не переводятся в слова: «2» и «два» — разные слова, и это
 * честная ошибка распознавания для вопроса о цене.
 */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’ʼ`´]/g, "'")
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}'\s-]/gu, ' ')
    .replace(/(^|\s)['-]+|['-]+(?=\s|$)/g, ' ')
    .replace(/-/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Минимум правок (Левенштейн по словам). */
export function wordEdits(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[hyp.length];
}

export interface WerItem {
  id: string;
  reference: string;
  /** null — распознавание не вернуло текста (вся фраза — удаления). */
  hypothesis: string | null;
}

export interface WerReport {
  items: Array<{ id: string; words: number; edits: number; wer: number }>;
  words: number;
  edits: number;
  /** Доля 0…1 по всему набору. */
  wer: number;
}

export function corpusWer(items: WerItem[]): WerReport {
  const out: WerReport['items'] = [];
  let words = 0;
  let edits = 0;
  for (const it of items) {
    const ref = normalizeWords(it.reference);
    const hyp = it.hypothesis === null ? [] : normalizeWords(it.hypothesis);
    const e = wordEdits(ref, hyp);
    out.push({
      id: it.id,
      words: ref.length,
      edits: e,
      wer: ref.length ? e / ref.length : 0,
    });
    words += ref.length;
    edits += e;
  }
  return { items: out, words, edits, wer: words ? edits / words : 0 };
}

/** Порог приёмки Э5 (ПРОВЕРИТЬ на первых записях — вопрос владельцу). */
export const VOICE_WER_THRESHOLD = 0.15;
/** Размер набора приёмки Э5. */
export const VOICE_EVAL_SIZE = 30;
