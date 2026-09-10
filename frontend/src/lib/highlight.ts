/**
 * Подсветка сценария (spec §19). Чипы персонажей, сцен и массовки —
 * фильтры: выбранный чип подсвечивает в тексте разбора те строки, где о
 * нём идёт речь, остальные приглушаются.
 *
 * Почему по СТРОКАМ, а не по словам: разбор от Gemini — построчный
 * («Scene 2 (0:02-0:05): …», «Dialogue: …»), и подсветка строки читается,
 * а россыпь подсвеченных слов внутри абзаца — нет. Совпадение мягкое:
 * ищем не всю фразу целиком, а её значимые слова и таймкоды, потому что
 * Gemini пишет «woman in the red jacket», а ярлык персонажа —
 * «Женщина в красной куртке».
 */

export interface HighlightLine {
  text: string;
  match: boolean;
}

const STOP = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'in',
  'on',
  'at',
  'to',
  'with',
  'for',
  'from',
  'по',
  'на',
  'в',
  'во',
  'и',
  'или',
  'с',
  'со',
  'за',
  'у',
  'к',
  'от',
  'до',
  'из',
  'при',
  'над',
  'под',
]);

/** Значимые слова термина: ≥3 символов, без стоп-слов, в нижнем регистре. */
export function termTokens(term: string): string[] {
  return term
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** "0:02" и "2" — обе формы, чтобы поймать и «0:02-0:05», и «(2-5s)». */
export function timecodeTerms(start: number, end: number): string[] {
  const mmss = (n: number) =>
    `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, '0')}`;
  return [
    `${mmss(start)}-${mmss(end)}`,
    `${mmss(start)}–${mmss(end)}`,
    `${Math.round(start)}-${Math.round(end)}s`,
    `${Math.round(start)}-${Math.round(end)}`,
  ];
}

/**
 * Строка совпала, если содержит любой таймкод целиком ИЛИ хотя бы
 * половину (но не меньше одного) значимых слов термина.
 */
export function lineMatches(
  line: string,
  tokens: string[],
  exact: string[]
): boolean {
  const lower = line.toLowerCase();
  if (exact.some((e) => e && lower.includes(e.toLowerCase()))) return true;
  if (tokens.length === 0) return false;
  const hits = tokens.filter((t) => lower.includes(t)).length;
  return hits >= Math.max(1, Math.ceil(tokens.length / 2));
}

/**
 * Разбор → строки с флагом совпадения. `terms` — свободные фразы
 * (ярлык персонажа, заголовок сцены, описание массовки), `exact` —
 * подстроки, которые ищутся целиком (таймкоды).
 */
export function highlightLines(
  text: string,
  terms: string[],
  exact: string[] = []
): HighlightLine[] {
  const tokens = [...new Set(terms.flatMap(termTokens))];
  return text.split('\n').map((line) => ({
    text: line,
    match: line.trim().length > 0 && lineMatches(line, tokens, exact),
  }));
}

/** Есть ли вообще что подсвечивать — иначе фильтр молча ничего не делает. */
export function hasMatches(lines: HighlightLine[]): boolean {
  return lines.some((l) => l.match);
}
