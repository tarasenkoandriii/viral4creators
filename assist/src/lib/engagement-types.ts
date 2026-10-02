/**
 * Вовлечение виджета (Э3, T): триггеры, лимиты навязчивости, сценарии —
 * повтор `sites-backend/src/modules/assist-site-setup/engagement-config.ts`
 * (`scripts/e3-api.test.ts` сверяет перечни и лимиты с файлом сервера).
 * Хранится внутри вида (`WidgetConfig.engagement`), публикуется вместе с ним.
 *
 * Разбор ответа — строгий, но «по элементам»: неизвестный вид условия или
 * финала (например, триггер Э3-бис из будущей версии) не рисуется и не
 * уходит обратно при сохранении, а не превращается в похожий MVP-триггер.
 */

import { arr, count, obj, strs, text } from './widget-api';
import { WIDGET_UI_LANGS, type WidgetUiLang } from './widget-types';

export const TRIGGER_KINDS = [
  'time_on_page',
  'scroll_depth',
  'exit_intent',
  'url_match',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

export const ENGAGEMENT_KEY = /^[a-z0-9_-]{1,32}$/;

export const ENGAGEMENT_LIMITS = {
  maxTriggers: 10,
  maxScenarios: 5,
  maxSteps: 8,
  maxOptions: 6,
  triggerText: 140,
  stepQuestion: 200,
  optionLabel: 60,
  scenarioTitle: 60,
  minDelaySeconds: 10,
  maxDelaySeconds: 600,
} as const;

export type Texts = Partial<Record<WidgetUiLang, string>>;

export type TriggerCondition =
  | { kind: 'time_on_page'; seconds: number }
  | { kind: 'scroll_depth'; percent: number }
  | { kind: 'exit_intent' }
  | { kind: 'url_match'; pathMask: string; seconds: number };

export type TriggerAccept =
  | { kind: 'prefill'; question: Texts }
  | { kind: 'scenario'; scenarioKey: string }
  | { kind: 'open' };

export interface TriggerConfig {
  key: string;
  enabled: boolean;
  condition: TriggerCondition;
  pathMasks: string[];
  text: Texts;
  onAccept: TriggerAccept;
}

export interface EngagementLimits {
  perVisit: 1 | 2;
  excludedPaths: string[];
  notOnFirstScreenMobile: true;
}

export const SCENARIO_ANSWER_TYPES = [
  'choice',
  'text',
  'number',
  'none',
] as const;
export type ScenarioAnswerType = (typeof SCENARIO_ANSWER_TYPES)[number];

export type ScenarioAnswer =
  | { type: 'choice'; options: Array<{ key: string; label: Texts }> }
  | { type: 'text'; maxChars: number }
  | { type: 'number'; min: number | null; max: number | null }
  | { type: 'none' };

export interface ScenarioStep {
  key: string;
  question: Texts;
  answer: ScenarioAnswer;
}

export const SCENARIO_FINALS = ['lead', 'handoff', 'link', 'ask'] as const;
export type ScenarioFinalKind = (typeof SCENARIO_FINALS)[number];

export type ScenarioFinal =
  | { kind: 'lead' }
  | { kind: 'handoff' }
  | { kind: 'link'; url: string; label: Texts }
  | { kind: 'ask' };

export interface ScenarioConfig {
  key: string;
  enabled: boolean;
  title: Texts;
  steps: ScenarioStep[];
  final: ScenarioFinal;
  showInGreeting: boolean;
}

export interface EngagementConfig {
  schema: 1;
  triggers: TriggerConfig[];
  limits: EngagementLimits;
  scenarios: ScenarioConfig[];
}

export function defaultEngagement(): EngagementConfig {
  return {
    schema: 1,
    triggers: [],
    limits: {
      perVisit: 1,
      excludedPaths: ['/checkout*', '/cart/checkout*', '/payment*'],
      notOnFirstScreenMobile: true,
    },
    scenarios: [],
  };
}

// ── Разбор ответа сервера ─────────────────────────────────────────────

export function parseTexts(v: unknown): Texts {
  const o = obj(v);
  const out: Texts = {};
  for (const lang of WIDGET_UI_LANGS) {
    if (typeof o[lang] === 'string' && o[lang]) out[lang] = o[lang] as string;
  }
  return out;
}

const key = (v: unknown): string | null =>
  typeof v === 'string' && ENGAGEMENT_KEY.test(v) ? v : null;
const int = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) ? v : null;

function parseCondition(v: unknown): TriggerCondition | null {
  const o = obj(v);
  switch (o.kind) {
    case 'time_on_page':
      return int(o.seconds) === null
        ? null
        : { kind: o.kind, seconds: o.seconds as number };
    case 'scroll_depth':
      return int(o.percent) === null
        ? null
        : { kind: o.kind, percent: o.percent as number };
    case 'exit_intent':
      return { kind: o.kind };
    case 'url_match':
      return int(o.seconds) === null || typeof o.pathMask !== 'string'
        ? null
        : { kind: o.kind, pathMask: o.pathMask, seconds: o.seconds as number };
    default:
      return null;
  }
}

function parseAccept(v: unknown): TriggerAccept | null {
  const o = obj(v);
  if (o.kind === 'open') return { kind: 'open' };
  if (o.kind === 'prefill') {
    return { kind: 'prefill', question: parseTexts(o.question) };
  }
  if (o.kind === 'scenario') {
    const k = key(o.scenarioKey);
    return k ? { kind: 'scenario', scenarioKey: k } : null;
  }
  return null;
}

function parseTrigger(v: unknown): TriggerConfig | null {
  const o = obj(v);
  const k = key(o.key);
  const condition = parseCondition(o.condition);
  const onAccept = parseAccept(o.onAccept);
  if (!k || !condition || !onAccept) return null;
  return {
    key: k,
    enabled: o.enabled === true,
    condition,
    pathMasks: strs(o.pathMasks),
    text: parseTexts(o.text),
    onAccept,
  };
}

function parseAnswer(v: unknown): ScenarioAnswer | null {
  const o = obj(v);
  switch (o.type) {
    case 'none':
      return { type: 'none' };
    case 'text':
      return { type: 'text', maxChars: count(o.maxChars) || 200 };
    case 'number':
      return { type: 'number', min: int(o.min), max: int(o.max) };
    case 'choice':
      return {
        type: 'choice',
        options: arr(o.options)
          .map((x) => {
            const p = obj(x);
            const k = key(p.key);
            return k ? { key: k, label: parseTexts(p.label) } : null;
          })
          .filter((x): x is { key: string; label: Texts } => !!x),
      };
    default:
      return null;
  }
}

function parseFinal(v: unknown): ScenarioFinal | null {
  const o = obj(v);
  if (o.kind === 'lead' || o.kind === 'handoff' || o.kind === 'ask') {
    return { kind: o.kind };
  }
  if (o.kind === 'link') {
    // Ссылку рисуем текстом; https проверяет сервер, но и здесь не верим.
    const url = text(o.url);
    return /^https:\/\//.test(url)
      ? { kind: 'link', url, label: parseTexts(o.label) }
      : null;
  }
  return null;
}

function parseScenario(v: unknown): ScenarioConfig | null {
  const o = obj(v);
  const k = key(o.key);
  const final = parseFinal(o.final);
  if (!k || !final) return null;
  const steps: ScenarioStep[] = [];
  for (const s of arr(o.steps)) {
    const p = obj(s);
    const sk = key(p.key);
    const answer = parseAnswer(p.answer);
    if (sk && answer) {
      steps.push({ key: sk, question: parseTexts(p.question), answer });
    }
  }
  return {
    key: k,
    enabled: o.enabled === true,
    title: parseTexts(o.title),
    steps,
    final,
    showInGreeting: o.showInGreeting === true,
  };
}

export function parseEngagement(v: unknown): EngagementConfig {
  const o = obj(v);
  const def = defaultEngagement();
  const l = obj(o.limits);
  return {
    schema: 1,
    triggers: arr(o.triggers)
      .map(parseTrigger)
      .filter((x): x is TriggerConfig => !!x),
    limits: {
      perVisit: l.perVisit === 2 ? 2 : 1,
      excludedPaths: Array.isArray(l.excludedPaths)
        ? strs(l.excludedPaths)
        : def.limits.excludedPaths,
      notOnFirstScreenMobile: true,
    },
    scenarios: arr(o.scenarios)
      .map(parseScenario)
      .filter((x): x is ScenarioConfig => !!x),
  };
}

// ── Правка (чистые функции для экрана) ────────────────────────────────

/** Свободный ключ `prefix`, `prefix-2`, … (ключи — латиница, сервер проверит). */
export function freeKey(prefix: string, taken: string[]): string {
  if (!taken.includes(prefix)) return prefix;
  for (let i = 2; i < 100; i++) {
    const k = `${prefix}-${i}`;
    if (!taken.includes(k)) return k;
  }
  return `${prefix}-${Date.now().toString(36).slice(-6)}`;
}

export function newTrigger(taken: string[]): TriggerConfig {
  return {
    key: freeKey('trigger', taken),
    enabled: true,
    condition: { kind: 'time_on_page', seconds: 30 },
    pathMasks: [],
    text: {},
    onAccept: { kind: 'open' },
  };
}

export function newScenario(taken: string[]): ScenarioConfig {
  return {
    key: freeKey('scenario', taken),
    enabled: true,
    title: {},
    steps: [],
    final: { kind: 'lead' },
    showInGreeting: true,
  };
}

/** Условие по виду — с разумными значениями (не раньше 10 с, §5-тер.12 п.3). */
export function conditionOf(kind: TriggerKind): TriggerCondition {
  switch (kind) {
    case 'time_on_page':
      return { kind, seconds: 30 };
    case 'scroll_depth':
      return { kind, percent: 50 };
    case 'exit_intent':
      return { kind };
    case 'url_match':
      return { kind, pathMask: '/', seconds: 15 };
  }
}

export function answerOf(type: ScenarioAnswerType): ScenarioAnswer {
  switch (type) {
    case 'choice':
      return { type, options: [] };
    case 'text':
      return { type, maxChars: 200 };
    case 'number':
      return { type, min: null, max: null };
    case 'none':
      return { type };
  }
}

/**
 * Сценарий удалён — триггеры, что вели в него, становятся «открыть чат»
 * (иначе сервер отверг бы весь черновик кодом scenario_unknown).
 */
export function removeScenario(
  e: EngagementConfig,
  scenarioKey: string
): EngagementConfig {
  return {
    ...e,
    scenarios: e.scenarios.filter((s) => s.key !== scenarioKey),
    triggers: e.triggers.map((t) =>
      t.onAccept.kind === 'scenario' && t.onAccept.scenarioKey === scenarioKey
        ? { ...t, onAccept: { kind: 'open' } }
        : t
    ),
  };
}

/** Есть ли текст хотя бы на одном языке (сервер: `required`). */
export function hasText(t: Texts): boolean {
  return WIDGET_UI_LANGS.some((l) => !!t[l]?.trim());
}

/**
 * Проблемы до сохранения — подсказка у поля (сервер всё равно проверит):
 * пустые тексты, задержка < 10 с, выбор без вариантов.
 */
export function engagementIssues(e: EngagementConfig): string[] {
  const out: string[] = [];
  e.triggers.forEach((t, i) => {
    if (!hasText(t.text)) out.push(`triggers[${i}].text`);
    const c = t.condition;
    if (
      (c.kind === 'time_on_page' || c.kind === 'url_match') &&
      (c.seconds < ENGAGEMENT_LIMITS.minDelaySeconds ||
        c.seconds > ENGAGEMENT_LIMITS.maxDelaySeconds)
    ) {
      out.push(`triggers[${i}].condition.seconds`);
    }
    if (t.onAccept.kind === 'prefill' && !hasText(t.onAccept.question)) {
      out.push(`triggers[${i}].onAccept.question`);
    }
  });
  e.scenarios.forEach((s, i) => {
    if (!hasText(s.title)) out.push(`scenarios[${i}].title`);
    s.steps.forEach((st, j) => {
      if (!hasText(st.question)) {
        out.push(`scenarios[${i}].steps[${j}].question`);
      }
      if (st.answer.type === 'choice' && st.answer.options.length === 0) {
        out.push(`scenarios[${i}].steps[${j}].answer.options`);
      }
    });
    if (s.final.kind === 'link' && !/^https:\/\//.test(s.final.url)) {
      out.push(`scenarios[${i}].final.url`);
    }
  });
  return out;
}
