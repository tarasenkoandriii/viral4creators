/**
 * №113 (заход 11) — слова, которые Soniox распознал НЕУВЕРЕННО, — ЧИСТАЯ
 * часть (ТЗ помощника §4-тер.5 «Команда не распознана / низкая
 * уверенность STT на одном слове → слово и частота → словарь терминов»,
 * §5-кватер.10 «Предложения из очереди обучения»).
 *
 * Soniox отдаёт уверенность (`confidence`, 0…1) на КАЖДОМ токене; токен —
 * часть слова, новое слово начинается с пробела. Уверенность слова —
 * минимум его токенов. Слово ниже порога — кандидат в `context.terms`;
 * соседние такие слова — одна фраза («Нова Пошта»), ≤ 3 слов.
 *
 * Что НЕ становится кандидатом: короче 3 букв («ну», «а»), не слова
 * (точка, слеш, `@` внутри — адрес/путь/почта), служебный
 * `<end>` и звуковые события, всё, что не проходит разбор фразы карты
 * (`memoTextProblem`: ПД — e-mail, телефон, ключ, длинные цифры; ссылки,
 * разметка, инъекция; ≤ 40 символов). Не больше 3 кандидатов на запись.
 * Текст кандидата — как распознан (регистр сохраняется: «iPhone»), в базу
 * идёт ещё и нормой (`phraseNorm`) — по ней свёртка разных посетителей.
 */
import { memoTextProblem, phraseNorm } from '../../assist-ui-core/memo';
import { VOICE_MAP_LIMITS } from '../../assist-ui-core/voice-map';

export const STT_LOW_CONF = {
  /** Уверенность слова ниже — «неуверенно» (Soniox: чистая речь ≥ 0.9). */
  threshold: 0.6,
  minLetters: 3,
  maxWords: 3,
  maxSpans: 3,
} as const;

/** Токен Soniox с уверенностью (поле есть в async-транскрипте). */
export interface SonioxConfToken {
  text?: string;
  confidence?: number;
  is_audio_event?: boolean;
}

export interface LowConfTerm {
  /** Как распознано (обрезаны края-знаки препинания). */
  text: string;
  norm: string;
}

const WORDS_ONLY = /^[\p{L}\p{N}'’ʼ -]+$/u;

interface Word {
  text: string;
  conf: number;
}

/** Токены → слова с уверенностью (минимум токенов слова). */
function wordsOf(tokens: readonly SonioxConfToken[]): Word[] {
  const out: Word[] = [];
  let cur: Word | null = null;
  for (const t of tokens) {
    const s = t.text ?? '';
    if (!s || s === '<end>' || t.is_audio_event === true) continue;
    const c =
      typeof t.confidence === 'number' && Number.isFinite(t.confidence)
        ? t.confidence
        : 1;
    // Новое слово — с пробела (или первое); знаки — к прежнему слову.
    if (!cur || /^\s/.test(s)) {
      cur = { text: s.trim(), conf: c };
      out.push(cur);
    } else {
      cur.text += s;
      cur.conf = Math.min(cur.conf, c);
    }
  }
  return out
    .map((w) => ({
      text: w.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''),
      conf: w.conf,
    }))
    .filter((w) => w.text);
}

/**
 * Годится ли фраза в термин: только слова (буквы, цифры, апостроф, дефис —
 * не адрес, не путь), ≥ 3 букв, разбор фразы карты (`memoTextProblem`: ПД
 * — длинные цифры, ключи; > 40; разметка; инъекция).
 */
export function termOk(text: string): boolean {
  return (
    WORDS_ONLY.test(text) &&
    (text.match(/\p{L}/gu) ?? []).length >= STT_LOW_CONF.minLetters &&
    memoTextProblem(text, VOICE_MAP_LIMITS.synonymChars) === null
  );
}

/**
 * (Р-З11-Б8) Слова из спанов билета голоса — снова через `termOk` (билет
 * подписан, но текст — от посетителя); ≤ 3, без повторов нормы.
 */
export function termsFromSpans(spans: readonly string[]): LowConfTerm[] {
  const out: LowConfTerm[] = [];
  for (const text of spans) {
    if (out.length >= STT_LOW_CONF.maxSpans || !termOk(text)) continue;
    const norm = phraseNorm(text);
    if (norm && !out.some((x) => x.norm === norm)) out.push({ text, norm });
  }
  return out;
}

/** Места кандидатов в тексте (для билета v2); не нашлось — без места. */
export function spansIn(
  text: string,
  terms: readonly LowConfTerm[],
): Array<{ start: number; len: number }> {
  const t = text.trim();
  const out: Array<{ start: number; len: number }> = [];
  for (const x of terms) {
    const i = t.indexOf(x.text);
    if (i >= 0) out.push({ start: i, len: x.text.length });
  }
  return out;
}

/**
 * (Р-З11-Б8) План команды несёт значения полей — диктовку («введи ім'я
 * Тарасенко»): шаг с `value` или ввода (fill/select/check) у модели или
 * прямого пути (до проверки кодом — отказанный шаг тоже диктовка), слоты
 * мемо. Такие команды в кандидаты терминов не пишутся никогда.
 */
export function carriesFieldValues(
  raw: unknown,
  memoValues?: Record<string, unknown> | null,
): boolean {
  if (memoValues && Object.keys(memoValues).length) return true;
  if (!Array.isArray(raw)) return false;
  return raw.some((s) => {
    if (!s || typeof s !== 'object') return false;
    const r = s as { kind?: unknown; value?: unknown };
    return (
      (r.value !== null && r.value !== undefined && r.value !== '') ||
      /^(fill|select|check|type|input)$/.test(String(r.kind))
    );
  });
}

/**
 * (Р-З11-Б8) Вопрос чата: кандидат пишется, только если его норма есть в
 * словаре сайта — найденные фрагменты знаний (не UGC), термины и имена
 * опубликованной карты и мемо. Совпадение — по границам слов нормы.
 */
export function inSiteDictionary(
  norm: string,
  sources: readonly string[],
): boolean {
  if (!norm) return false;
  const needle = ` ${norm} `;
  return sources.some((src) => ` ${phraseNorm(src)} `.includes(needle));
}

/** Кандидаты в термины: соседние неуверенные слова — одной фразой. */
export function lowConfidenceTerms(
  tokens: readonly SonioxConfToken[] | undefined,
): LowConfTerm[] {
  if (!tokens?.length) return [];
  const words = wordsOf(tokens);
  const spans: string[][] = [];
  let run: string[] | null = null;
  for (const w of words) {
    if (w.conf < STT_LOW_CONF.threshold) {
      if (!run || run.length >= STT_LOW_CONF.maxWords) {
        run = [];
        spans.push(run);
      }
      run.push(w.text);
    } else run = null;
  }
  const out: LowConfTerm[] = [];
  const seen = new Set<string>();
  for (const sp of spans) {
    // Фраза не прошла (рядом номер телефона, адрес) — слова по отдельности.
    const whole = sp.join(' ');
    for (const text of termOk(whole) ? [whole] : sp.length > 1 ? sp : []) {
      if (out.length >= STT_LOW_CONF.maxSpans || !termOk(text)) continue;
      const norm = phraseNorm(text);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      out.push({ text, norm });
    }
  }
  return out;
}
