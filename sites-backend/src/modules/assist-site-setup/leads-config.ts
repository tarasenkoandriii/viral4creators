/**
 * Форма лида виджета (ТЗ §3.6 п.6, §6.2): какие поля, текст согласия, канал.
 * Владелец — W4. Чистый модуль: W3 проверяет по нему отправку формы и
 * пишет в лид ТОЧНЫЙ текст согласия, который видел посетитель (приёмка Э2
 * п.7: «лид приходит в бот с текстом согласия»).
 *
 * Э2: канал — только бот Помощника (e-mail и вебхук — этап 3+/9+; почты в
 * проекте нет, §3.7 п.5).
 */
export const LEAD_FIELDS = ['name', 'phone', 'email', 'comment'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export interface LeadsConfig {
  schema: 1;
  /** Какие поля показывать и какие обязательны. Хотя бы один контакт (phone|email). */
  fields: Array<{ field: LeadField; required: boolean }>;
  /** Текст согласия по языкам интерфейса; умолчание есть, правится (≤ 1000). */
  consentText: Partial<Record<'uk' | 'ru' | 'en', string>>;
  /** Э2: ['telegram']. */
  channels: Array<'telegram'>;
}

export type LeadsConfigParse =
  | { ok: true; config: LeadsConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> };

export const LEADS_CONSENT_MAX = 1000;
const CONSENT_LANGS = ['uk', 'ru', 'en'] as const;

/** Текст согласия по умолчанию (§3.6 п.6: «умолчание есть, правится»). */
export const DEFAULT_CONSENT_TEXT: Record<'uk' | 'ru' | 'en', string> = {
  uk: 'Надсилаючи форму, я погоджуюся на обробку моїх контактних даних, щоб зі мною зв’язалися щодо мого звернення.',
  ru: 'Отправляя форму, я соглашаюсь на обработку моих контактных данных, чтобы со мной связались по моему обращению.',
  en: 'By sending this form, I agree to the processing of my contact details so that I can be contacted about my request.',
};

export function defaultLeadsConfig(): LeadsConfig {
  return {
    schema: 1,
    fields: [
      { field: 'name', required: false },
      { field: 'phone', required: false },
      { field: 'email', required: false },
      { field: 'comment', required: false },
    ],
    consentText: { ...DEFAULT_CONSENT_TEXT },
    channels: ['telegram'],
  };
}

const CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseLeadsConfig(input: unknown): LeadsConfigParse {
  const errors: Array<{ path: string; code: string }> = [];
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  }
  if (input.schema !== undefined && input.schema !== 1) {
    errors.push({ path: 'schema', code: 'schema' });
  }
  const fields: LeadsConfig['fields'] = [];
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    errors.push({ path: 'fields', code: 'type' });
  } else {
    input.fields.forEach((f, i) => {
      const p = `fields[${i}]`;
      if (
        !isObj(f) ||
        !(LEAD_FIELDS as readonly unknown[]).includes(f.field) ||
        typeof f.required !== 'boolean'
      ) {
        errors.push({ path: p, code: 'type' });
        return;
      }
      if (fields.some((x) => x.field === f.field)) {
        errors.push({ path: p, code: 'duplicate' });
        return;
      }
      fields.push({ field: f.field as LeadField, required: f.required });
    });
    // Лид без контакта бесполезен: телефон или e-mail обязан быть в форме.
    if (
      !errors.length &&
      !fields.some((f) => f.field === 'phone' || f.field === 'email')
    ) {
      errors.push({ path: 'fields', code: 'contact_required' });
    }
  }
  const consentText: LeadsConfig['consentText'] = {};
  if (!isObj(input.consentText)) {
    errors.push({ path: 'consentText', code: 'type' });
  } else {
    for (const lang of CONSENT_LANGS) {
      const v = input.consentText[lang];
      if (v === undefined || v === null || v === '') continue;
      const p = `consentText.${lang}`;
      if (typeof v !== 'string') {
        errors.push({ path: p, code: 'type' });
        continue;
      }
      const t = v.replace(/\r\n?/g, '\n').trim();
      if (CONTROL.test(t)) errors.push({ path: p, code: 'control_chars' });
      else if (Array.from(t).length > LEADS_CONSENT_MAX) {
        errors.push({ path: p, code: 'too_long' });
      } else if (t) consentText[lang] = t;
    }
    if (!errors.length && Object.keys(consentText).length === 0) {
      errors.push({ path: 'consentText', code: 'required' });
    }
  }
  const ch = input.channels ?? ['telegram'];
  if (!Array.isArray(ch) || ch.length !== 1 || ch[0] !== 'telegram') {
    // Э2: e-mail и вебхук — этап 3+/9+ (§3.7 п.5).
    errors.push({ path: 'channels', code: 'channel' });
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: { schema: 1, fields, consentText, channels: ['telegram'] },
  };
}
