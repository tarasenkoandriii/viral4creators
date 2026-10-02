/**
 * Вовлечение и цели в публичном конфиге (Э3, W) — разбор НА КЛИЕНТЕ.
 * Повтор форм `PublicEngagementConfig` (T, `assist-site-setup/engagement-config.ts`),
 * `PublicGoal` (A, `assist-analytics/goal-types.ts`) и `handoff`
 * (`WidgetPublicConfig`, W). Правило то же, что у вида (config.ts): код
 * исполняется в origin заказчика, поэтому значение не по форме —
 * отбрасывается (триггер/цель/детектор целиком), тексты — только данные
 * (в DOM — textContent), маски путей — только `/…` (сопоставление —
 * `pathMatches`, не RegExp).
 *
 * Разбор триггеров и целей — в бюджете загрузчика 12 КБ, поэтому нарочно
 * коротко (каждая проверка — один вызов `str`/`key`/`mask`). Сценарии
 * разбирает только iframe (`scenarios.ts`), передачу — `parseHandoff`.
 */
import { LIMITS, UI_LANGS, isObj, type UiLang } from './config';

export const ENG_KEY = /^[a-z0-9_-]{1,32}$/;
export const GOAL_KEY = /^[a-z0-9_-]{1,40}$/;
/** orderId (§5-тер.1): e-mail и телефон с «+»/пробелами формат не проходят. */
export const ORDER_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export type LangText = Partial<Record<UiLang, string>>;

export type TriggerCond =
  | { kind: 'time_on_page'; seconds: number }
  | { kind: 'scroll_depth'; percent: number }
  | { kind: 'exit_intent' }
  | { kind: 'url_match'; pathMask: string; seconds: number };

export interface Trigger {
  key: string;
  cond: TriggerCond;
  pathMasks: string[];
  text: LangText;
  accept:
    | { kind: 'prefill'; question: LangText }
    | { kind: 'scenario'; scenarioKey: string }
    | { kind: 'open' };
}

export interface Engagement {
  triggers: Trigger[];
  /** §5-тер.12: сигналов за визит — 1 (по умолчанию) или 2. */
  perVisit: 1 | 2;
  excludedPaths: string[];
}

/** Дескриптор элемента цели (A, ElementDescriptor); text — без регистра. */
export interface Descriptor {
  assistGoal: string | null;
  assistId: string | null;
  role: string | null;
  text: string | null;
}

export type GoalDetector =
  | { kind: 'url'; pathMask: string; fromPathMask: string | null }
  | { kind: 'click'; descriptor: Descriptor; pathMask: string | null }
  | { kind: 'auto'; auto: 'tel' | 'messenger' }
  | { kind: 'form_submit'; descriptor: Descriptor; pathMask: string | null }
  | { kind: 'js' };

export interface Goal {
  key: string;
  detectors: GoalDetector[];
}

export interface HandoffInfo {
  enabled: boolean;
  etaMinutes: number | null;
  etaText: LangText;
}

/** Минимум §5-тер.12 п.3 — не раньше 10 с на странице (второй замок к разбору T). */
export const MIN_TRIGGER_SECONDS = 10;
/** Шаг оплаты — исключён всегда, даже если конфиг его забыл (§5-тер.12 п.5). */
export const ALWAYS_EXCLUDED = ['/checkout*', '/cart/checkout*', '/payment*'];

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Строка ≤ max без управляющих символов (перевод строки и таб — можно), иначе null. */
export function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max && !CONTROL.test(v)
    ? v
    : null;
}

export function key(v: unknown, re = ENG_KEY): string | null {
  return typeof v === 'string' && re.test(v) ? v : null;
}

function mask(v: unknown): string | null {
  const s = str(v, LIMITS.pathMask);
  return s && s.charAt(0) === '/' ? s : null;
}

function masks(v: unknown): string[] {
  return Array.isArray(v)
    ? (v.slice(0, LIMITS.pathMasks).map(mask).filter(Boolean) as string[])
    : [];
}

/** Тексты по языкам интерфейса: только непустые строки ≤ max. */
export function langText(v: unknown, max: number): LangText {
  const out: LangText = {};
  if (isObj(v))
    for (const l of UI_LANGS) {
      const t = str(v[l], max);
      if (t && t.trim()) out[l] = t;
    }
  return out;
}

/** Секунды условия: целое ≤ 600, не меньше 10 (§5-тер.12 п.3). */
function secs(v: unknown): number {
  return typeof v === 'number' && v <= 600
    ? Math.max(Math.floor(v), MIN_TRIGGER_SECONDS)
    : NaN;
}

function trigger(t: unknown): Trigger | null {
  if (!isObj(t) || t.enabled === false) return null;
  const k = key(t.key);
  const c = t.condition;
  const a = t.onAccept;
  const text = langText(t.text, 140);
  if (!k || !isObj(c) || !isObj(a) || !Object.keys(text).length) return null;
  let cond: TriggerCond | null = null;
  const s = secs(c.seconds);
  const m = mask(c.pathMask);
  const p = c.percent;
  if (c.kind === 'time_on_page' && s) cond = { kind: c.kind, seconds: s };
  if (c.kind === 'url_match' && s && m)
    cond = { kind: c.kind, pathMask: m, seconds: s };
  if (c.kind === 'exit_intent') cond = { kind: c.kind };
  if (c.kind === 'scroll_depth' && typeof p === 'number' && p > 0 && p <= 100)
    cond = { kind: c.kind, percent: p };
  const sk = key(a.scenarioKey);
  const accept: Trigger['accept'] | null =
    a.kind === 'prefill'
      ? { kind: a.kind, question: langText(a.question, 600) }
      : a.kind === 'scenario' && sk
        ? { kind: a.kind, scenarioKey: sk }
        : a.kind === 'open'
          ? { kind: a.kind }
          : null;
  return cond && accept
    ? { key: k, cond, pathMasks: masks(t.pathMasks), text, accept }
    : null;
}

/** `engagement` публичного конфига → триггеры и лимиты (сценарии — scenarios.ts). */
export function parseEngagement(raw: unknown): Engagement {
  const e: Engagement = {
    triggers: [],
    perVisit: 1,
    excludedPaths: ALWAYS_EXCLUDED.concat(
      isObj(raw) && isObj(raw.limits) ? masks(raw.limits.excludedPaths) : []
    ),
  };
  if (!isObj(raw)) return e;
  if (isObj(raw.limits) && raw.limits.perVisit === 2) e.perVisit = 2;
  if (Array.isArray(raw.triggers))
    e.triggers = raw.triggers
      .slice(0, 10)
      .map(trigger)
      .filter(Boolean) as Trigger[];
  return e;
}

function descriptor(v: unknown): Descriptor | null {
  if (!isObj(v)) return null;
  const id = /^[A-Za-z0-9_-]{1,64}$/;
  const t = str(v.text, 80);
  const d: Descriptor = {
    assistGoal: key(v.assistGoal, id),
    assistId: key(v.assistId, id),
    role: key(v.role, /^[a-z]{1,20}$/),
    text: t && (t.replace(/\s+/g, ' ').trim().toLowerCase() || null),
  };
  return d.assistGoal || d.assistId || d.text ? d : null;
}

function detector(v: unknown): GoalDetector | null {
  if (!isObj(v) || !isObj(v.config)) return null;
  const c = v.config;
  const m = mask(c.pathMask);
  const d = descriptor(c.descriptor);
  return v.kind === 'url'
    ? m
      ? { kind: v.kind, pathMask: m, fromPathMask: mask(c.fromPathMask) }
      : null
    : v.kind === 'js'
      ? { kind: v.kind }
      : v.kind === 'click' && (c.auto === 'tel' || c.auto === 'messenger')
        ? { kind: 'auto', auto: c.auto }
        : (v.kind === 'click' || v.kind === 'form_submit') && d
          ? { kind: v.kind, descriptor: d, pathMask: m }
          : null;
}

/** `goals` публичного конфига (A: только url/click/form_submit/js). */
export function parseGoals(raw: unknown): Goal[] {
  const out: Goal[] = [];
  if (Array.isArray(raw))
    for (const g of raw.slice(0, 30)) {
      const k = isObj(g) && key(g.key, GOAL_KEY);
      const detectors =
        k && Array.isArray(g.detectors)
          ? (g.detectors
              .slice(0, 5)
              .map(detector)
              .filter(Boolean) as GoalDetector[])
          : [];
      if (k && detectors.length) out.push({ key: k, detectors });
    }
  return out;
}

/** `handoff` публичного конфига (iframe): null — сервер Э2 или сбой у H. */
export function parseHandoff(raw: unknown): HandoffInfo | null {
  if (!isObj(raw)) return null;
  const eta = raw.etaMinutes;
  return {
    enabled: raw.enabled === true,
    etaMinutes:
      typeof eta === 'number' && Number.isInteger(eta) && eta > 0 && eta < 1440
        ? eta
        : null,
    etaText: langText(raw.etaText, 60),
  };
}

/** Ссылки мессенджеров (ТЗ §5-тер.1 шаблон «Переход в мессенджер»). */
export const MESSENGER_HREF =
  /^(?:https?:\/\/(?:www\.)?(?:t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|m\.me)\/|https?:\/\/(?:www\.)?instagram\.com\/direct|viber:|tg:|whatsapp:)/i;
