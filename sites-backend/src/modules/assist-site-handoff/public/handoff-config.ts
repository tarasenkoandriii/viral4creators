/**
 * Настройки передачи человеку — H (ТЗ §3.7): ЧИСТЫЙ модуль (без Nest,
 * Prisma, env) — его читают публичный приём передачи (под assist_public),
 * кабинет и системный код. Хранится в `assist_sites.handoffConfig`
 * (колонка открыта роли виджета — секретов здесь нет и быть не может).
 *
 * Рабочие часы — в поясе сайта (`assist_sites.timezone`, IANA), интервалы
 * `HH:MM–HH:MM` по дням недели; через полночь — двумя интервалами.
 */
import { ESCALATION_KINDS, type EscalationKind } from '../api-types';

export const WEEKDAYS = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const HANDOFF_LIMITS = {
  /** Ожидание оператора до формы заявки (§3.7 п.6), минуты. */
  waitMinutes: { min: 1, max: 60, default: 5 },
  /** Напоминание оператору без ответа, минуты. */
  remindAfterMinutes: { min: 1, max: 60, default: 3 },
  maxReminders: { min: 0, max: 5, default: 2 },
  /** Передача без ответа посетителю закрывается (диалог виден 24 ч+, §3.7 п.5). */
  idleCloseHours: { min: 1, max: 72, default: 24 },
  templates: 10,
  templateText: 500,
  etaText: 140,
  intervalsPerDay: 3,
} as const;

export interface HandoffConfig {
  schema: 1;
  enabled: boolean;
  /** Пусто у дня — не работаем в этот день. Пустая неделя + enabled — круглосуточно. */
  hours: Partial<Record<Weekday, Array<{ from: string; to: string }>>>;
  waitMinutes: number;
  remindAfterMinutes: number;
  maxReminders: number;
  idleCloseHours: number;
  /** «Обычно отвечаем за ~N минут» до накопления медианы (§3.7 п.2). */
  etaText: Partial<Record<'uk' | 'ru' | 'en', string>>;
  /** «Ответить шаблоном» (§3.7 п.3). */
  templates: Array<{ id: string; title: string; text: string }>;
  /** Язык операторов — перевод сообщений посетителя и ответа обратно (№12). */
  operatorLang: 'uk' | 'ru' | 'en';
  translate: boolean;
  /** ИИ-черновик ответа оператору из знаний (№11). */
  draft: boolean;
  /** Правила ранней эскалации (№13): какие включены. */
  escalation: Record<EscalationKind, boolean>;
}

export type HandoffConfigParse =
  | { ok: true; config: HandoffConfig }
  | { ok: false; errors: Array<{ path: string; code: string }> };

/** Умолчание: выключено (владелец включает, когда операторы нажали Start). */
export function defaultHandoffConfig(): HandoffConfig {
  return {
    schema: 1,
    enabled: false,
    hours: {},
    waitMinutes: HANDOFF_LIMITS.waitMinutes.default,
    remindAfterMinutes: HANDOFF_LIMITS.remindAfterMinutes.default,
    maxReminders: HANDOFF_LIMITS.maxReminders.default,
    idleCloseHours: HANDOFF_LIMITS.idleCloseHours.default,
    etaText: {},
    templates: [],
    operatorLang: 'uk',
    translate: true,
    draft: true,
    escalation: {
      irritation: true,
      complaint: true,
      refund: true,
      wholesale: false,
      sensitive: true,
    },
  };
}

const TOP_KEYS = new Set([
  'schema',
  'enabled',
  'hours',
  'waitMinutes',
  'remindAfterMinutes',
  'maxReminders',
  'idleCloseHours',
  'etaText',
  'templates',
  'operatorLang',
  'translate',
  'draft',
  'escalation',
]);
const LANGS = ['uk', 'ru', 'en'] as const;
/** `HH:MM`; `24:00` — только как конец интервала. */
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const TEMPLATE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const TEMPLATE_TITLE_MAX = 60;

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function minutesOf(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Строгий разбор (H): неизвестное поле, неверное время, лимиты — ошибки. */
export function parseHandoffConfig(input: unknown): HandoffConfigParse {
  const errors: Array<{ path: string; code: string }> = [];
  const err = (path: string, code: string) => errors.push({ path, code });
  if (!isObj(input)) return { ok: false, errors: [{ path: '', code: 'type' }] };
  for (const k of Object.keys(input)) if (!TOP_KEYS.has(k)) err(k, 'unknown');
  // Отсутствующее поле — умолчание: PATCH из TMA может прислать часть.
  const out = defaultHandoffConfig();
  if (input.schema !== undefined && input.schema !== 1) err('schema', 'value');

  const bool = (k: 'enabled' | 'translate' | 'draft') => {
    const v = input[k];
    if (v === undefined) return;
    if (typeof v !== 'boolean') err(k, 'type');
    else out[k] = v;
  };
  bool('enabled');
  bool('translate');
  bool('draft');

  const int = (
    k: 'waitMinutes' | 'remindAfterMinutes' | 'maxReminders' | 'idleCloseHours',
  ) => {
    const v = input[k];
    if (v === undefined) return;
    const lim = HANDOFF_LIMITS[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) err(k, 'type');
    else if (v < lim.min || v > lim.max) err(k, 'range');
    else out[k] = v;
  };
  int('waitMinutes');
  int('remindAfterMinutes');
  int('maxReminders');
  int('idleCloseHours');

  if (input.operatorLang !== undefined) {
    if (!(LANGS as readonly unknown[]).includes(input.operatorLang)) {
      err('operatorLang', 'value');
    } else {
      out.operatorLang = input.operatorLang as HandoffConfig['operatorLang'];
    }
  }

  if (input.hours !== undefined) {
    if (!isObj(input.hours)) err('hours', 'type');
    else {
      const hours: HandoffConfig['hours'] = {};
      for (const [day, list] of Object.entries(input.hours)) {
        const p = `hours.${day}`;
        if (!(WEEKDAYS as readonly string[]).includes(day)) {
          err(p, 'unknown');
          continue;
        }
        if (!Array.isArray(list)) {
          err(p, 'type');
          continue;
        }
        if (list.length > HANDOFF_LIMITS.intervalsPerDay) err(p, 'too_many');
        const parsed: Array<{ from: string; to: string }> = [];
        list.forEach((iv: unknown, i) => {
          const ip = `${p}.${i}`;
          if (!isObj(iv)) return err(ip, 'type');
          for (const k of Object.keys(iv)) {
            if (k !== 'from' && k !== 'to') err(`${ip}.${k}`, 'unknown');
          }
          const { from, to } = iv;
          if (
            typeof from !== 'string' ||
            !TIME.test(from) ||
            from === '24:00'
          ) {
            return err(`${ip}.from`, 'time');
          }
          if (typeof to !== 'string' || !TIME.test(to)) {
            return err(`${ip}.to`, 'time');
          }
          // Через полночь — двумя интервалами (шапка модуля).
          if (minutesOf(to) <= minutesOf(from)) return err(ip, 'order');
          parsed.push({ from, to });
        });
        parsed.sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
        for (let i = 1; i < parsed.length; i++) {
          if (minutesOf(parsed[i].from) < minutesOf(parsed[i - 1].to)) {
            err(p, 'overlap');
            break;
          }
        }
        hours[day as Weekday] = parsed;
      }
      out.hours = hours;
    }
  }

  if (input.etaText !== undefined) {
    if (!isObj(input.etaText)) err('etaText', 'type');
    else {
      const eta: HandoffConfig['etaText'] = {};
      for (const [lang, v] of Object.entries(input.etaText)) {
        const p = `etaText.${lang}`;
        if (!(LANGS as readonly string[]).includes(lang)) err(p, 'unknown');
        else if (typeof v !== 'string') err(p, 'type');
        else if (v.trim().length > HANDOFF_LIMITS.etaText) err(p, 'too_long');
        else if (v.trim()) eta[lang as 'uk' | 'ru' | 'en'] = v.trim();
      }
      out.etaText = eta;
    }
  }

  if (input.templates !== undefined) {
    if (!Array.isArray(input.templates)) err('templates', 'type');
    else {
      if (input.templates.length > HANDOFF_LIMITS.templates) {
        err('templates', 'too_many');
      }
      const ids = new Set<string>();
      const list: HandoffConfig['templates'] = [];
      input.templates.forEach((t: unknown, i) => {
        const p = `templates.${i}`;
        if (!isObj(t)) return err(p, 'type');
        for (const k of Object.keys(t)) {
          if (!['id', 'title', 'text'].includes(k)) err(`${p}.${k}`, 'unknown');
        }
        if (typeof t.id !== 'string' || !TEMPLATE_ID.test(t.id)) {
          return err(`${p}.id`, 'value');
        }
        if (ids.has(t.id)) return err(`${p}.id`, 'duplicate');
        ids.add(t.id);
        const title = typeof t.title === 'string' ? t.title.trim() : null;
        const text = typeof t.text === 'string' ? t.text.trim() : null;
        if (!title || title.length > TEMPLATE_TITLE_MAX) {
          return err(`${p}.title`, title ? 'too_long' : 'required');
        }
        if (!text || text.length > HANDOFF_LIMITS.templateText) {
          return err(`${p}.text`, text ? 'too_long' : 'required');
        }
        list.push({ id: t.id, title, text });
      });
      out.templates = list;
    }
  }

  if (input.escalation !== undefined) {
    if (!isObj(input.escalation)) err('escalation', 'type');
    else {
      for (const [k, v] of Object.entries(input.escalation)) {
        const p = `escalation.${k}`;
        if (!(ESCALATION_KINDS as readonly string[]).includes(k)) {
          err(p, 'unknown');
        } else if (typeof v !== 'boolean') err(p, 'type');
        else out.escalation[k as EscalationKind] = v;
      }
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, config: out };
}

/** Из колонки базы: битое/пустое — умолчание (выключено), не исключение. */
export function effectiveHandoffConfig(raw: unknown): HandoffConfig {
  if (raw === null || raw === undefined) return defaultHandoffConfig();
  const r = parseHandoffConfig(raw);
  return r.ok ? r.config : defaultHandoffConfig();
}

const KYIV = 'Europe/Kyiv';
const DAY_BY_SHORT: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

function zoned(timezone: string, now: Date): { day: Weekday; minutes: number } {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || KYIV,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    // Неизвестный пояс (опечатка в базе) — пояс рынка по умолчанию.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: KYIV,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
  }
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  return {
    day: DAY_BY_SHORT[parts.weekday] ?? 'mon',
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
  };
}

/** Рабочее ли сейчас время по поясу сайта (IANA; неизвестный пояс — Europe/Kyiv). */
export function isWithinHours(
  config: HandoffConfig,
  timezone: string,
  now: Date,
): boolean {
  const days = Object.values(config.hours).filter(
    (list) => Array.isArray(list) && list.length > 0,
  );
  if (!days.length) return true;
  const { day, minutes } = zoned(timezone, now);
  return (config.hours[day] ?? []).some(
    (iv) => minutes >= minutesOf(iv.from) && minutes < minutesOf(iv.to),
  );
}
