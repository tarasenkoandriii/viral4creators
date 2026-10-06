// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.
// Источник: sites-backend/src/modules/assist-ui-core/normalize.ts. Правка — в источнике, затем
// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Нормализация текста команды и подписей (§5-бис.6 п.3–4): значение поля
 * берётся ТОЛЬКО из сказанного, цель должна быть связана с командой. Чистый
 * модуль; тот же алгоритм у загрузчика не нужен — решает сервер.
 *
 * Сравнение слов — по началу слова (грубая основа): «доставку» ↔
 * «Доставка», «корзину» ↔ «корзина», «купити» ↔ «Купить». Для uk/ru/en
 * этого достаточно, чтобы связать команду с кнопкой, и недостаточно, чтобы
 * «придумать» значение поля: числа, e-mail и телефоны сверяются посимвольно.
 */

/** Нижний регистр, NFKC, ё→е, апострофы и тире — к одному виду. */
export function normText(raw: string): string {
  return raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Служебные слова команды: глаголы-действия, предлоги, вежливость — они не
 * связывают команду с целью («открой» есть в каждой команде).
 */
const STOP = new Set(
  [
    // uk
    'відкрий',
    'відкрийте',
    'відкрити',
    'натисни',
    'натисніть',
    'натиснути',
    'перейди',
    'перейдіть',
    'перейти',
    'покажи',
    'покажіть',
    'знайди',
    'знайдіть',
    'додай',
    'додайте',
    'додати',
    'введи',
    'введіть',
    'заповни',
    'заповніть',
    'вибери',
    'виберіть',
    'обери',
    'оберіть',
    'постав',
    'поставте',
    'прокрути',
    'прокрутіть',
    'будь',
    'ласка',
    'мені',
    'будь-ласка',
    'на',
    'в',
    'у',
    'до',
    'з',
    'із',
    'зі',
    'та',
    'і',
    'й',
    'для',
    'по',
    'це',
    'цю',
    'цей',
    'ту',
    'той',
    'сторінку',
    'сторінка',
    'кнопку',
    'кнопка',
    'розділ',
    'поле',
    // ru
    'открой',
    'откройте',
    'открыть',
    'нажми',
    'нажмите',
    'нажать',
    'перейди',
    'перейдите',
    'покажи',
    'покажите',
    'найди',
    'найдите',
    'добавь',
    'добавьте',
    'добавить',
    'введи',
    'введите',
    'заполни',
    'заполните',
    'выбери',
    'выберите',
    'поставь',
    'поставьте',
    'прокрути',
    'прокрутите',
    'пожалуйста',
    'мне',
    'на',
    'во',
    'к',
    'ко',
    'с',
    'со',
    'и',
    'для',
    'это',
    'эту',
    'этот',
    'ту',
    'тот',
    'страницу',
    'страница',
    'кнопку',
    'кнопка',
    'раздел',
    'поле',
    // en
    'open',
    'click',
    'press',
    'tap',
    'go',
    'to',
    'show',
    'me',
    'find',
    'search',
    'add',
    'enter',
    'type',
    'fill',
    'select',
    'choose',
    'pick',
    'check',
    'scroll',
    'please',
    'the',
    'a',
    'an',
    'in',
    'on',
    'into',
    'of',
    'for',
    'and',
    'page',
    'button',
    'section',
    'field',
    'this',
    'that',
  ].map(normText),
);

/** Слова текста без служебных (≥ 2 букв/цифр). */
export function tokens(raw: string): string[] {
  const out: string[] = [];
  for (const w of normText(raw).split(/[^\p{L}\p{N}']+/u)) {
    const t = w.replace(/^'+|'+$/g, '');
    if (t.length < 2 || STOP.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Два слова — «одно и то же» с точностью до окончания. */
export function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 3) return false;
  // Числа — только целиком (иначе «104» = «1042»).
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const k = Math.max(3, n - 2);
  return a.slice(0, k) === b.slice(0, k);
}

/** Есть ли общее слово у двух текстов (без служебных). */
export function overlaps(a: string, b: string): boolean {
  const tb = tokens(b);
  return tokens(a).some((x) => tb.some((y) => sameWord(x, y)));
}

/** Строка без пробелов и разделителей номера телефона — для посимвольной сверки. */
function compact(s: string): string {
  return normText(s).replace(/[\s()\-.]/g, '');
}

/**
 * Значение поля сказано в команде (§5-бис.6 п.3): числа, e-mail, телефоны
 * — посимвольно (после удаления пробелов и разделителей), слова — каждое
 * слово значения есть в команде (с точностью до окончания). Пустое значение
 * — не сказано.
 */
export function valueSaid(value: string, transcript: string): boolean {
  const v = normText(value);
  if (!v) return false;
  if (/[\d@+]/.test(v)) {
    const cv = compact(v);
    if (!cv || !compact(transcript).includes(cv)) return false;
    // И слова вокруг цифр («Київ 12») — тоже из команды.
  }
  const words = v
    .split(/[^\p{L}\p{N}@.+'-]+/u)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter((w) => w && !/[\d@]/.test(w));
  if (!words.length) return /[\d@+]/.test(v);
  const said = normText(transcript)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
  // Слово значения — сказанное с точностью до ОКОНЧАНИЯ: не длиннее
  // сказанного больше чем на 2 знака (иначе к «Київ» дописывается любой
  // хвост: «київ.evil.com», «київпроплачено»).
  return words.every((w) =>
    said.some((s) => sameWord(w, s) && w.length <= s.length + 2),
  );
}

/** `data-assist-id` → слова (`add-to-cart` → add, to, cart). */
export function assistIdWords(id: string | null): string {
  return id ? id.replace(/[-_.:]+/g, ' ') : '';
}

/** В команде есть глагол поиска («знайди», «найди», «find», «search»). */
export function saysFind(transcript: string): boolean {
  return /(^|[^\p{L}])(знайди|знайдіть|шукай|пошукай|найди|найдите|ищи|поищи|find|search|look for)([^\p{L}]|$)/u.test(
    normText(transcript),
  );
}
