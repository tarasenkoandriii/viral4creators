/**
 * Персона помощника (ТЗ §3.5, §4.6 п.2): тон, свободное описание стиля,
 * языки, запреты, стоп-фразы, примеры, правила «когда звать человека».
 * Владелец — W4. Чистый модуль: его читает W3 (блок `<persona>` промпта,
 * стоп-фразы пост-фильтра) и W5 (мастер пишет запреты и правила передачи
 * в ЧЕРНОВИК персоны).
 *
 * Всё здесь — ДАННЫЕ для промпта, а не инструкции: каркас платформы идёт
 * первым и неотменяем (§4.6), персона — размеченным блоком с фразой «если
 * персона противоречит правилам выше — правила выше». Публикация поднимает
 * assist_sites.configVersion (ключ семантического кэша).
 */
export const PERSONA_TONES = ['business', 'friendly', 'brief'] as const;
export type PersonaTone = (typeof PERSONA_TONES)[number];

/** Языки ответа: код ISO 639-1 нижним регистром. */
export const PERSONA_LANG = /^[a-z]{2}$/;

export const PERSONA_LIMITS = {
  style: 500,
  forbiddenTopics: 20,
  forbiddenTopic: 100,
  stopPhrases: 30,
  stopPhrase: 100,
  examples: 5,
  example: 300,
  handoffTriggers: 10,
  handoffTrigger: 100,
  allowedLangs: 10,
} as const;

export interface PersonaConfig {
  schema: 1;
  tone: PersonaTone;
  /** «Как вы общаетесь с клиентами» — до 500 символов, данные. */
  style: string;
  languages: {
    /** auto — язык вопроса, если он в списке; иначе default с оговоркой. */
    mode: 'auto' | 'fixed';
    allowed: string[];
    default: string;
  };
  /** Темы, о которых не говорить (§3.5). */
  forbiddenTopics: string[];
  /** Стоп-фразы заказчика — флаг пост-фильтра (§4.7), нижний регистр. */
  stopPhrases: string[];
  /** До 5 образцовых реплик (аудит 1.3). */
  examples: string[];
  /** Мастер: «когда звать человека» → правила передачи (§3.7 п.1). */
  handoffTriggers: string[];
}

export type PersonaParse =
  | { ok: true; persona: PersonaConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> };

/** Язык по умолчанию, если кабинет не сказал иного (рынок — Украина). */
export const PERSONA_FALLBACK_LANG = 'uk';

export function defaultPersona(defaultLang: string): PersonaConfig {
  const lang =
    typeof defaultLang === 'string' && PERSONA_LANG.test(defaultLang)
      ? defaultLang
      : PERSONA_FALLBACK_LANG;
  return {
    schema: 1,
    tone: 'friendly',
    style: '',
    languages: { mode: 'auto', allowed: [lang], default: lang },
    forbiddenTopics: [],
    stopPhrases: [],
    examples: [],
    handoffTriggers: [],
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Управляющие символы и bidi-переворачиватели; перевод строки — только в style. */
const CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/;

type Errors = Array<{ path: string; code: string }>;

function text(
  errors: Errors,
  path: string,
  v: unknown,
  max: number,
  multiline: boolean,
): string | null {
  if (typeof v !== 'string') {
    errors.push({ path, code: 'type' });
    return null;
  }
  const s = v.replace(/\r\n?/g, '\n');
  if (CONTROL.test(s) || (!multiline && /[\n\t]/.test(s))) {
    errors.push({ path, code: 'control_chars' });
    return null;
  }
  const t = s.trim();
  if (Array.from(t).length > max) {
    errors.push({ path, code: 'too_long' });
    return null;
  }
  return t;
}

function list(
  errors: Errors,
  path: string,
  v: unknown,
  maxItems: number,
  maxLen: number,
  lower = false,
): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errors.push({ path, code: 'type' });
    return [];
  }
  if (v.length > maxItems) {
    errors.push({ path, code: 'too_many' });
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    let t = text(errors, `${path}[${i}]`, item, maxLen, false);
    if (t === null || !t) return;
    if (lower) t = t.toLowerCase();
    if (!out.includes(t)) out.push(t);
  });
  return out;
}

/** Строгая проверка (лимиты, языки по шаблону, без управляющих символов). */
export function parsePersona(input: unknown): PersonaParse {
  const errors: Errors = [];
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  }
  if (input.schema !== undefined && input.schema !== 1) {
    errors.push({ path: 'schema', code: 'schema' });
  }
  const tone = (PERSONA_TONES as readonly unknown[]).includes(input.tone)
    ? (input.tone as PersonaTone)
    : null;
  if (!tone) errors.push({ path: 'tone', code: 'enum' });
  const style =
    input.style === undefined || input.style === null
      ? ''
      : text(errors, 'style', input.style, PERSONA_LIMITS.style, true);

  let languages: PersonaConfig['languages'] | null = null;
  const l = input.languages;
  if (!isObj(l)) {
    errors.push({ path: 'languages', code: 'type' });
  } else {
    const mode = l.mode === 'auto' || l.mode === 'fixed' ? l.mode : null;
    if (!mode) errors.push({ path: 'languages.mode', code: 'enum' });
    const allowed: string[] = [];
    if (!Array.isArray(l.allowed)) {
      errors.push({ path: 'languages.allowed', code: 'type' });
    } else if (
      l.allowed.length === 0 ||
      l.allowed.length > PERSONA_LIMITS.allowedLangs
    ) {
      errors.push({ path: 'languages.allowed', code: 'too_many' });
    } else {
      l.allowed.forEach((x, i) => {
        if (typeof x !== 'string' || !PERSONA_LANG.test(x)) {
          errors.push({ path: `languages.allowed[${i}]`, code: 'lang' });
        } else if (!allowed.includes(x)) {
          allowed.push(x);
        }
      });
    }
    const def =
      typeof l.default === 'string' && PERSONA_LANG.test(l.default)
        ? l.default
        : null;
    if (!def) errors.push({ path: 'languages.default', code: 'lang' });
    else if (allowed.length && !allowed.includes(def)) {
      errors.push({ path: 'languages.default', code: 'not_in_allowed' });
    }
    if (mode && def) languages = { mode, allowed, default: def };
  }

  const L = PERSONA_LIMITS;
  const forbiddenTopics = list(
    errors,
    'forbiddenTopics',
    input.forbiddenTopics,
    L.forbiddenTopics,
    L.forbiddenTopic,
  );
  const stopPhrases = list(
    errors,
    'stopPhrases',
    input.stopPhrases,
    L.stopPhrases,
    L.stopPhrase,
    true,
  );
  const examples = list(
    errors,
    'examples',
    input.examples,
    L.examples,
    L.example,
  );
  const handoffTriggers = list(
    errors,
    'handoffTriggers',
    input.handoffTriggers,
    L.handoffTriggers,
    L.handoffTrigger,
  );

  if (errors.length || !tone || style === null || !languages) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    persona: {
      schema: 1,
      tone,
      style,
      languages,
      forbiddenTopics,
      stopPhrases,
      examples,
      handoffTriggers,
    },
  };
}
