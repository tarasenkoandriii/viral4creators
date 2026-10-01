/**
 * Проверка ответа модели до показа — K3 (§4.6 «S-id, которого не было в
 * промпте, вырезается», §4.7 «проверка чисел», лендинг-ТЗ §6.2: текст
 * чужого сайта не должен стать XSS/фишингом на нашем домене).
 * Чистые функции.
 */

/** Маркеры источников `[S3]`, `[S1, S2]`, `[S1][S2]`. */
const MARKER = /\[\s*S\s*\d+(?:\s*[,;]\s*S?\s*\d+)*\s*\]/gi;

/** Номера из маркеров ответа. */
export function citedNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MARKER)) {
    for (const d of m[0].matchAll(/\d+/g)) out.push(Number(d[0]));
  }
  return out;
}

/**
 * Текст ответа без HTML, без markdown-картинок и ссылок (остаётся только
 * подпись), без голых URL и доменов-ссылок; маркеры источников — только
 * допустимые номера, в каноничной форме `[S3]`.
 */
export function sanitizeAnswerText(text: string, allowed: Set<number>): string {
  let t = text
    // HTML-комментарии и теги целиком (вместе со <script>…</script>).
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // Картинки — целиком, ссылки — подпись.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    // Голые адреса и «javascript:»/«data:» — вон: ссылку ставит сервер по [S#].
    .replace(/\b(?:https?|ftp|javascript|data|vbscript):\S*/gi, '')
    .replace(/\bwww\.[^\s)\]]+/gi, '');
  t = t.replace(MARKER, (m) => {
    const nums = [...m.matchAll(/\d+/g)]
      .map((d) => Number(d[0]))
      .filter((n) => allowed.has(n));
    return [...new Set(nums)].map((n) => `[S${n}]`).join('');
  });
  return t
    .replace(/[ \t]+/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 2000);
}

/** Цифровые «слова» текста: разделители внутри числа (1 200,50 / 1.200) снимаются. */
export function numberTokens(text: string): string[] {
  const collapsed = text.replace(/(\d)[\s  .,'’](?=\d)/g, '$1');
  return [...collapsed.matchAll(/\d+/g)].map((m) => m[0]);
}

/**
 * Числа ответа, которых нет ни в источниках, ни в вопросе (§4.7 К-1).
 * Маркеры [S#] не считаются числами ответа.
 */
export function unsupportedNumbers(
  answer: string,
  sourceTexts: string[],
  question: string,
): string[] {
  const known = new Set<string>();
  for (const s of [...sourceTexts, question]) {
    for (const n of numberTokens(s)) known.add(n);
  }
  const own = numberTokens(answer.replace(MARKER, ' '));
  return [...new Set(own.filter((n) => !known.has(n)))];
}

/** Платформенный список «запрещённых обещаний» (§4.7) — флаг для ревью. */
export const FORBIDDEN_PROMISES: readonly string[] = [
  'гарантуємо',
  'гарантируем',
  '100% гарант',
  'we guarantee',
  'guaranteed refund',
  'безкоштовно назавжди',
  'бесплатно навсегда',
];
