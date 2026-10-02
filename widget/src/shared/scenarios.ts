/**
 * Сценарии вовлечения (Э3, №40; ТЗ §3.6 п.5) — разбор в iframe. Повтор
 * `ScenarioConfig` (T, engagement-config.ts). Сценарий — короткая ветка
 * «вопрос → тип ответа» и финал §4.9 (лид / передача / ссылка / «спросить»);
 * модель в нём не участвует. Тексты — данные (Preact экранирует), ссылка
 * финала — только https (и ещё раз — `safeHref` по разрешённым origin при
 * показе). Не по форме — сценарий отбрасывается целиком.
 */
import { isObj } from './config';
import { ENG_KEY, key, langText, str, type LangText } from './engagement';

export type ScenarioAnswer =
  | { type: 'choice'; options: Array<{ key: string; label: LangText }> }
  | { type: 'text'; maxChars: number }
  | { type: 'number'; min: number | null; max: number | null }
  | { type: 'none' };

export interface ScenarioStep {
  key: string;
  question: LangText;
  answer: ScenarioAnswer;
}

export type ScenarioFinal =
  | { kind: 'lead' }
  | { kind: 'handoff' }
  | { kind: 'link'; url: string; label: LangText }
  | { kind: 'ask' };

export interface Scenario {
  key: string;
  title: LangText;
  steps: ScenarioStep[];
  final: ScenarioFinal;
  showInGreeting: boolean;
}

const MAX_STEPS = 8;
const MAX_OPTIONS = 6;

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function answer(v: unknown): ScenarioAnswer | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'choice': {
      if (!Array.isArray(v.options)) return null;
      const options: Array<{ key: string; label: LangText }> = [];
      for (const o of v.options.slice(0, MAX_OPTIONS)) {
        const k = isObj(o) && key(o.key);
        const label = isObj(o) ? langText(o.label, 60) : {};
        if (!k || !Object.keys(label).length) return null;
        options.push({ key: k, label });
      }
      return options.length ? { type: 'choice', options } : null;
    }
    case 'text': {
      const m = v.maxChars;
      return {
        type: 'text',
        maxChars:
          typeof m === 'number' && Number.isInteger(m) && m > 0 && m <= 500
            ? m
            : 200,
      };
    }
    case 'number':
      return { type: 'number', min: num(v.min), max: num(v.max) };
    case 'none':
      return { type: 'none' };
  }
  return null;
}

function final(v: unknown): ScenarioFinal | null {
  if (!isObj(v)) return null;
  if (v.kind === 'lead' || v.kind === 'handoff' || v.kind === 'ask')
    return { kind: v.kind };
  if (v.kind === 'link') {
    const url = str(v.url, 2000);
    const label = langText(v.label, 60);
    return url && /^https:\/\//.test(url) && Object.keys(label).length
      ? { kind: 'link', url, label }
      : null;
  }
  return null;
}

function scenario(v: unknown): Scenario | null {
  if (!isObj(v) || v.enabled === false) return null;
  const k = key(v.key, ENG_KEY);
  const title = langText(v.title, 60);
  const f = final(v.final);
  if (!k || !f || !Array.isArray(v.steps) || v.steps.length > MAX_STEPS)
    return null;
  const steps: ScenarioStep[] = [];
  for (const s of v.steps) {
    const sk = isObj(s) && key(s.key, ENG_KEY);
    const q = isObj(s) ? langText(s.question, 200) : {};
    const a = isObj(s) ? answer(s.answer) : null;
    if (!sk || !a || !Object.keys(q).length) return null;
    steps.push({ key: sk, question: q, answer: a });
  }
  return {
    key: k,
    title,
    steps,
    final: f,
    showInGreeting: v.showInGreeting === true,
  };
}

/** `engagement.scenarios` публичного конфига → включённые сценарии (≤ 5). */
export function parseScenarios(engagement: unknown): Scenario[] {
  const out: Scenario[] = [];
  const list = isObj(engagement) ? engagement.scenarios : null;
  if (Array.isArray(list))
    for (const v of list.slice(0, 5)) {
      const s = scenario(v);
      if (s) out.push(s);
    }
  return out;
}
