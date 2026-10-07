/**
 * Проверка наборов замеров — без сети и ключей. Зовут сухой прогон
 * (`run.ts --dry`) и юнит-тест: набор, который разошёлся с требованием
 * (меньше 50 сюжетов, траурных мало, имя не стоит в тексте фразы), должен
 * падать в CI, а не обнаруживаться на платном прогоне.
 *
 * Возвращает список проблем строками; пустой — набор годен.
 */
import {
  GREETING_OCCASIONS,
  GREETING_REGISTERS,
  MAX_CUSTOM_OCCASION_LENGTH,
} from '../../src/common/types/greeting.types';
import {
  EVAL_LANGUAGES,
  type EvalLanguage,
  type OccasionScenario,
} from './occasion-set';
import type { SpeechLanguage, SpeechPhrase, SpeechTag } from './speech-set';
import { normalizeWords } from './metrics';

/** §8.1: 50 описаний на пяти языках. */
export const OCCASION_SCENARIOS = 50;
/** Не меньше стольких сюжетов на каждый регистр — иначе матрица пуста. */
export const MIN_PER_REGISTER = 6;
/** Траурных — больше всех: ради них приёмка и написана. */
export const MIN_MOURNING = 10;

/** §8.3: не меньше 100 фраз на язык. */
export const SPEECH_PER_LANGUAGE = 100;
/** §8.3: «с именами, датами, возрастом и суржиком» — минимум каждого. */
export const MIN_SPEECH_TAGS: Partial<Record<SpeechTag, number>> = {
  name: 20,
  date: 20,
  age: 15,
  surzhyk: 10,
};

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;
const UK_ONLY = /[іїєґІЇЄҐ]/;
const RU_ONLY = /[ыэъЫЭЪ]/;

function scriptProblem(lang: EvalLanguage, text: string): string | null {
  const cyr = lang === 'ru' || lang === 'uk';
  if (cyr && LATIN.test(text)) return 'латиница в кириллическом тексте';
  if (!cyr && CYRILLIC.test(text)) return 'кириллица в латинском тексте';
  if (lang === 'ru' && UK_ONLY.test(text)) return 'украинские буквы в ru';
  if (lang === 'uk' && RU_ONLY.test(text)) return 'русские буквы в uk';
  return null;
}

export function validateOccasionSet(
  set: readonly OccasionScenario[],
): string[] {
  const problems: string[] = [];
  if (set.length !== OCCASION_SCENARIOS) {
    problems.push(`сюжетов ${set.length}, нужно ${OCCASION_SCENARIOS}`);
  }
  const ids = new Set<string>();
  const texts = new Set<string>();
  const perRegister = new Map<string, number>();
  for (const s of set) {
    if (ids.has(s.id)) problems.push(`${s.id}: повтор id`);
    ids.add(s.id);
    if (!GREETING_REGISTERS.includes(s.register)) {
      problems.push(`${s.id}: регистр «${s.register}» не из закрытого списка`);
    }
    if (!GREETING_OCCASIONS.includes(s.occasion)) {
      problems.push(`${s.id}: повод «${s.occasion}» не из каталога`);
    }
    perRegister.set(s.register, (perRegister.get(s.register) ?? 0) + 1);
    for (const lang of EVAL_LANGUAGES) {
      const t = s.text[lang]?.trim() ?? '';
      if (!t) {
        problems.push(`${s.id}.${lang}: пусто`);
        continue;
      }
      if (t.length > MAX_CUSTOM_OCCASION_LENGTH) {
        problems.push(
          `${s.id}.${lang}: длиннее ${MAX_CUSTOM_OCCASION_LENGTH} символов — в поле повода не поместится`,
        );
      }
      if (normalizeWords(t).length < 3) {
        problems.push(`${s.id}.${lang}: меньше трёх слов`);
      }
      const script = scriptProblem(lang, t);
      if (script) problems.push(`${s.id}.${lang}: ${script}`);
      if (texts.has(t)) problems.push(`${s.id}.${lang}: повтор текста`);
      texts.add(t);
    }
  }
  for (const r of GREETING_REGISTERS) {
    const n = perRegister.get(r) ?? 0;
    const min = r === 'MOURNING' ? MIN_MOURNING : MIN_PER_REGISTER;
    if (n < min) problems.push(`регистр ${r}: ${n} сюжетов, нужно ≥ ${min}`);
  }
  return problems;
}

/** Имя (одно или два слова) стоит в тексте словами подряд. */
function hasWords(text: string, name: string): boolean {
  const t = normalizeWords(text);
  const n = normalizeWords(name);
  for (let i = 0; i + n.length <= t.length; i++) {
    if (n.every((w, k) => t[i + k] === w)) return true;
  }
  return false;
}

export function validateSpeechSet(set: readonly SpeechPhrase[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const texts = new Set<string>();
  const perLang = new Map<SpeechLanguage, SpeechPhrase[]>();
  for (const p of set) {
    if (ids.has(p.id)) problems.push(`${p.id}: повтор id`);
    ids.add(p.id);
    if (!p.id.startsWith(`${p.lang}-`)) {
      problems.push(`${p.id}: id не начинается с языка`);
    }
    if (texts.has(p.text)) problems.push(`${p.id}: повтор текста`);
    texts.add(p.text);
    perLang.set(p.lang, [...(perLang.get(p.lang) ?? []), p]);

    if (normalizeWords(p.text).length < 2) {
      problems.push(`${p.id}: меньше двух слов`);
    }
    // Эталон — то, что произносится: числа словами (их читает синтез).
    if (/\d/.test(p.text)) {
      problems.push(`${p.id}: цифры в произносимом тексте — числа словами`);
    }
    if (LATIN.test(p.text)) problems.push(`${p.id}: латиница в фразе`);
    if (!p.tags.includes('surzhyk')) {
      const script = scriptProblem(p.lang, p.text);
      if (script) problems.push(`${p.id}: ${script} (не помечено суржиком)`);
    }
    for (const alt of p.alt ?? []) {
      if (alt === p.text) problems.push(`${p.id}: alt совпадает с текстом`);
      if (!/\d/.test(alt)) {
        problems.push(`${p.id}: alt «${alt}» без цифр — зачем он`);
      }
    }
    if ((p.tags.includes('date') || p.tags.includes('age')) && !p.alt) {
      // Дата словами без чисел («послезавтра») — законна, но тогда в ней
      // нет числа: пусть это будет видно по тексту.
      if (/(дцат|сорок|тысяч|надцят|десят|двадц|тридц)/i.test(p.text)) {
        problems.push(`${p.id}: число словами без записи цифрами (alt)`);
      }
    }
    const names = p.names ?? [];
    if (p.tags.includes('name') && names.length === 0) {
      problems.push(`${p.id}: помечено «name», а имён нет`);
    }
    for (const n of names) {
      if (!hasWords(p.text, n)) {
        problems.push(`${p.id}: имени «${n}» нет в тексте`);
      }
    }
    for (const h of p.hints ?? []) {
      if (!h.trim()) problems.push(`${p.id}: пустая подсказка имени`);
    }
  }
  for (const lang of ['ru', 'uk'] as const) {
    const list = perLang.get(lang) ?? [];
    if (list.length < SPEECH_PER_LANGUAGE) {
      problems.push(
        `${lang}: фраз ${list.length}, нужно ≥ ${SPEECH_PER_LANGUAGE}`,
      );
    }
    for (const [tag, min] of Object.entries(MIN_SPEECH_TAGS)) {
      const n = list.filter((p) => p.tags.includes(tag as SpeechTag)).length;
      if (n < (min ?? 0)) {
        problems.push(`${lang}: с меткой ${tag} ${n} фраз, нужно ≥ ${min}`);
      }
    }
  }
  return problems;
}
