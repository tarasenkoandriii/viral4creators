/**
 * Метрики замеров поздравления (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-
 * Persona-Landing.md §8.1, §8.3) — ЧИСТЫЙ модуль: его зовут прогон
 * (`run.ts`) и юнит-тест (`src/common/greeting-eval.spec.ts`).
 *
 * Распознавание:
 * - WER = (замены + вставки + удаления) / слов эталона — по всему набору
 *   (сумма правок / сумма слов), а не среднее по фразам: короткая фраза
 *   из двух слов с одной ошибкой не должна весить как длинная. Тот же
 *   расчёт, что у WER помощника (`sites-backend/.../eval/wer.ts`), плюс
 *   допустимые записи (`alt`): «двенадцатое марта» и «12 марта» — оба
 *   верны, правки считаются по ближайшей;
 * - точность имён — доля имён эталона (в той форме, что в тексте), которые
 *   стоят в распознанном словом в слово (§4А.3 «Имена»);
 * - латиница — доля ответов, где латинских букв не меньше
 *   `LATIN_RETRY_SHARE` (та же граница, по которой продукт переспрашивает,
 *   `common/greeting-voice.ts`); приёмка §8.3 — ни одного такого ответа;
 * - совпадение языка — язык ответа (у Soniox — определённый по звуку, у
 *   Gemini — по буквам и служебным словам) равен языку фразы; суржик не
 *   считается (§8.3: «где говорящий не переключал язык»).
 *
 * Классификатор: точность, матрица ошибок по закрытому списку
 * `GREETING_REGISTERS` и главное — «траурный распознан праздничным»
 * (приёмка §8.1: ни одного) и вообще «мягче эталона» (ошибка в опасную
 * сторону, §3.4).
 */
import {
  GREETING_REGISTERS,
  type GreetingRegister,
} from '../../src/common/types/greeting.types';
import { LATIN_RETRY_SHARE, latinShare } from '../../src/common/greeting-voice';

// ── WER ─────────────────────────────────────────────────────────────────

/**
 * Слова для WER: регистр, пунктуация, апостроф (', ’, ʼ — одно), «ё» → «е»,
 * дефис — пробел («17-го» → «17 го»). Числа словами не переводятся:
 * «12» и «двенадцатое» — разные слова, допустимую запись цифрами задаёт
 * набор (`alt`), а не нормализация.
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKC')
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
  /** Эталон и допустимые записи; первая — главная. */
  refs: readonly string[];
  /** `null` — распознавание не вернуло текста: все слова — удаления. */
  hypothesis: string | null;
}

export interface WerItemResult {
  id: string;
  words: number;
  edits: number;
  wer: number;
  /** По какой записи эталона посчитано. */
  ref: string;
}

/**
 * Правки по ближайшей допустимой записи: меньший WER, при равенстве —
 * главная запись (первая).
 */
export function bestEdits(
  refs: readonly string[],
  hypothesis: string | null,
): WerItemResult & { id: '' } {
  const hyp = hypothesis === null ? [] : normalizeWords(hypothesis);
  let best: WerItemResult | null = null;
  for (const ref of refs) {
    const words = normalizeWords(ref);
    const edits = wordEdits(words, hyp);
    const wer = words.length ? edits / words.length : hyp.length ? 1 : 0;
    if (!best || wer < best.wer) {
      best = { id: '', words: words.length, edits, wer, ref };
    }
  }
  if (!best) throw new Error('у фразы нет эталона');
  return best as WerItemResult & { id: '' };
}

export interface WerReport {
  items: WerItemResult[];
  words: number;
  edits: number;
  /** Доля 0…1 по всему набору. */
  wer: number;
}

export function corpusWer(items: readonly WerItem[]): WerReport {
  const out: WerItemResult[] = [];
  let words = 0;
  let edits = 0;
  for (const it of items) {
    const r = { ...bestEdits(it.refs, it.hypothesis), id: it.id };
    out.push(r);
    words += r.words;
    edits += r.edits;
  }
  return { items: out, words, edits, wer: words ? edits / words : 0 };
}

// ── Имена ───────────────────────────────────────────────────────────────

/**
 * Какие имена из списка стоят в распознанном словом в слово (имя из двух
 * слов — подряд). Регистр, «ё», апостроф и пунктуация не считаются
 * ошибкой; падеж — считается: «Марине» вместо «Марина» — другое слово.
 */
export function namesFound(
  names: readonly string[],
  hypothesis: string | null,
): { total: number; found: number; missed: string[] } {
  const hyp = hypothesis === null ? [] : normalizeWords(hypothesis);
  const missed: string[] = [];
  for (const name of names) {
    const want = normalizeWords(name);
    let ok = false;
    for (let i = 0; i + want.length <= hyp.length && !ok; i++) {
      ok = want.every((w, k) => hyp[i + k] === w);
    }
    if (!ok) missed.push(name);
  }
  return {
    total: names.length,
    found: names.length - missed.length,
    missed,
  };
}

// ── Письменность и язык ─────────────────────────────────────────────────

/** Ответ латиницей — по той же границе, по которой продукт переспрашивает. */
export function isLatinAnswer(text: string | null): boolean {
  return !!text && latinShare(text) >= LATIN_RETRY_SHARE;
}

export { latinShare };

const UK_LETTERS = /[іїєґ]/giu;
const RU_LETTERS = /[ыэъё]/giu;
// Служебные слова, которых нет в другом языке (по написанию).
const UK_WORDS = new Set([
  'і',
  'й',
  'що',
  'це',
  'та',
  'як',
  'від',
  'мені',
  'ми',
  'вона',
  'він',
  'її',
  'його',
  'буде',
  'треба',
  'дуже',
  'усі',
  'всі',
  'привіт',
  'дякую',
  'з',
  // Слова мастера поздравления, которые пишутся по-разному.
  'років',
  'роки',
  'рік',
  'свята',
  'свято',
  'народження',
  'привітання',
  'отримувач',
  'відправник',
  "ім'я",
  'зроби',
  'додай',
  'постав',
  'нехай',
  'їй',
  'йому',
  'весілля',
]);
// Слова уже прошли `normalizeWords` — «её» там «ее».
const RU_WORDS = new Set([
  'и',
  'что',
  'это',
  'как',
  'от',
  'мне',
  'мы',
  'она',
  'он',
  'ее',
  'его',
  'будет',
  'нужно',
  'очень',
  'все',
  'всей',
  'привет',
  'спасибо',
  'когда',
  'чтобы',
  'с',
  'лет',
  'года',
  'год',
  'праздника',
  'праздник',
  'рождения',
  'поздравление',
  'получатель',
  'отправитель',
  'имя',
  'сделай',
  'добавь',
  'поставь',
  'пусть',
  'ей',
  'ему',
  'свадьба',
]);

/**
 * Русский или украинский — по буквам, которых нет в другом языке, и по
 * служебным словам. `null` — не определить (одни общие слова или нет
 * кириллицы). Только для Gemini: Soniox называет язык сам, по звуку.
 */
export function guessCyrillicLanguage(text: string | null): 'ru' | 'uk' | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  let uk = (lower.match(UK_LETTERS) ?? []).length * 2;
  let ru = (lower.match(RU_LETTERS) ?? []).length * 2;
  for (const w of normalizeWords(lower)) {
    // Общие для обоих («на», «до», «наш») в списки не входят; на всякий
    // случай слово из обоих списков не считается.
    const inUk = UK_WORDS.has(w);
    const inRu = RU_WORDS.has(w);
    if (inUk && !inRu) uk += 1;
    if (inRu && !inUk) ru += 1;
  }
  if (uk === ru) return null;
  return uk > ru ? 'uk' : 'ru';
}

// ── Классификатор ───────────────────────────────────────────────────────

export type Predicted = GreetingRegister | null;

export interface ClassifierRow {
  id: string;
  lang: string;
  label: GreetingRegister;
  predicted: Predicted;
}

export interface ClassifierReport {
  total: number;
  correct: number;
  accuracy: number;
  /** `matrix[label][predicted]`; `NONE` — ответа нет (сбой, мусор). */
  matrix: Record<GreetingRegister, Record<GreetingRegister | 'NONE', number>>;
  byLanguage: Record<string, { total: number; correct: number }>;
  /** Приёмка §8.1: траурный распознан праздничным — должно быть 0. */
  mourningAsCelebratory: string[];
  /** Мягче эталона — опасная сторона (§3.4); `NONE` сюда не входит. */
  softer: string[];
  /** Ответа нет — сигнал пропал, регистр решают выбор и ключевые слова. */
  none: string[];
}

const strictness = (r: GreetingRegister) => GREETING_REGISTERS.indexOf(r);

export function classifierReport(
  rows: readonly ClassifierRow[],
): ClassifierReport {
  const matrix = Object.fromEntries(
    GREETING_REGISTERS.map((l) => [
      l,
      Object.fromEntries(
        [...GREETING_REGISTERS, 'NONE'].map((p) => [p, 0]),
      ) as Record<GreetingRegister | 'NONE', number>,
    ]),
  ) as ClassifierReport['matrix'];
  const byLanguage: ClassifierReport['byLanguage'] = {};
  const mourningAsCelebratory: string[] = [];
  const softer: string[] = [];
  const none: string[] = [];
  let correct = 0;
  for (const r of rows) {
    const key = `${r.id}.${r.lang}`;
    matrix[r.label][r.predicted ?? 'NONE'] += 1;
    const lang = (byLanguage[r.lang] ??= { total: 0, correct: 0 });
    lang.total += 1;
    if (r.predicted === r.label) {
      correct += 1;
      lang.correct += 1;
    }
    if (r.predicted === null) none.push(key);
    else if (strictness(r.predicted) < strictness(r.label)) softer.push(key);
    if (r.label === 'MOURNING' && r.predicted === 'CELEBRATORY') {
      mourningAsCelebratory.push(key);
    }
  }
  return {
    total: rows.length,
    correct,
    accuracy: rows.length ? correct / rows.length : 0,
    matrix,
    byLanguage,
    mourningAsCelebratory,
    softer,
    none,
  };
}

/** Матрица ошибок строками Markdown — для отчёта. */
export function matrixMarkdown(m: ClassifierReport['matrix']): string {
  const cols = [...GREETING_REGISTERS, 'NONE'] as const;
  return [
    `| эталон \\ ответ | ${cols.join(' | ')} |`,
    `|---|${cols.map(() => '---').join('|')}|`,
    ...GREETING_REGISTERS.map(
      (l) => `| ${l} | ${cols.map((c) => m[l][c]).join(' | ')} |`,
    ),
  ].join('\n');
}
