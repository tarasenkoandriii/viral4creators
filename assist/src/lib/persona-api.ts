/**
 * Клиент персоны и формы лида Э2 (контракт Э2 §6): черновик, публикация
 * с воротами (PersonaGate W3), откат; форма лида действует сразу.
 * Разбор строгий (см. `widget-api.ts`).
 */

import type { ApiClient } from '../kit';
import {
  arr,
  count,
  obj,
  oneOf,
  parseHistory,
  str,
  strs,
  text,
} from './widget-api';
import {
  LEAD_FIELDS,
  PERSONA_LANG,
  PERSONA_TONES,
  type LeadField,
  type LeadsConfig,
  type LeadsConfigView,
  type PersonaConfig,
  type PersonaGateView,
  type PersonaSettingsView,
} from './widget-types';

export function parsePersona(v: unknown): PersonaConfig {
  const o = obj(v);
  const l = obj(o.languages);
  const langs = strs(l.allowed).filter((x) => PERSONA_LANG.test(x));
  const def =
    typeof l.default === 'string' && PERSONA_LANG.test(l.default)
      ? l.default
      : (langs[0] ?? 'uk');
  return {
    schema: 1,
    tone: oneOf(PERSONA_TONES, o.tone, 'friendly'),
    style: text(o.style),
    languages: {
      mode: l.mode === 'fixed' ? 'fixed' : 'auto',
      allowed: langs.length ? langs : [def],
      default: def,
    },
    forbiddenTopics: strs(o.forbiddenTopics),
    stopPhrases: strs(o.stopPhrases),
    examples: strs(o.examples),
    handoffTriggers: strs(o.handoffTriggers),
  };
}

function parseGate(v: unknown): PersonaGateView | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  return {
    ran: o.ran === true,
    invariantsPassed: o.invariantsPassed === true,
    // Неясный ответ — «заблокировано»: лучше лишняя проверка, чем ложный зелёный.
    blocked: o.blocked !== false,
    notes: strs(o.notes),
  };
}

export function parsePersonaSettings(v: unknown): PersonaSettingsView {
  const o = obj(v);
  return {
    siteId: text(o.siteId),
    configVersion: count(o.configVersion),
    published: o.published ? parsePersona(o.published) : null,
    draft: parsePersona(o.draft),
    history: parseHistory(o.history),
    lastGate: parseGate(o.lastGate),
  };
}

export function parseLeadsConfig(v: unknown): LeadsConfig {
  const o = obj(v);
  const fields: LeadsConfig['fields'] = [];
  for (const f of arr(o.fields)) {
    const x = obj(f);
    if (
      (LEAD_FIELDS as readonly unknown[]).includes(x.field) &&
      !fields.some((y) => y.field === x.field)
    ) {
      fields.push({
        field: x.field as LeadField,
        required: x.required === true,
      });
    }
  }
  const c = obj(o.consentText);
  const consentText: LeadsConfig['consentText'] = {};
  for (const lang of ['uk', 'ru', 'en'] as const) {
    const t = str(c[lang]);
    if (t) consentText[lang] = t;
  }
  return { schema: 1, fields, consentText, channels: ['telegram'] };
}

export interface PersonaApi {
  get(siteId: string): Promise<PersonaSettingsView>;
  saveDraft(
    siteId: string,
    persona: PersonaConfig
  ): Promise<PersonaSettingsView>;
  publish(siteId: string): Promise<PersonaSettingsView>;
  rollback(siteId: string, version: number): Promise<PersonaSettingsView>;
  getLeads(siteId: string): Promise<LeadsConfigView>;
  saveLeads(siteId: string, config: LeadsConfig): Promise<LeadsConfigView>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!ID.test(id)) throw new Error('bad id');
  return id;
}

export function createPersonaApi(client: ApiClient): PersonaApi {
  const p = (id: string) => `/assist/sites/${seg(id)}/persona`;
  const view = async (x: Promise<unknown>) => parsePersonaSettings(await x);
  const leads = async (id: string, x: Promise<unknown>) => {
    const o = obj(await x);
    return { siteId: text(o.siteId) || id, config: parseLeadsConfig(o.config) };
  };
  return {
    get: async (id) => view(client.request('GET', p(id))),
    saveDraft: async (id, persona) =>
      view(client.request('PATCH', p(id), { persona })),
    publish: async (id) => view(client.request('POST', `${p(id)}/publish`)),
    rollback: async (id, ver) =>
      view(client.request('POST', `${p(id)}/rollback/${count(ver)}`)),
    getLeads: async (id) =>
      leads(id, client.request('GET', `/assist/sites/${seg(id)}/leads-config`)),
    saveLeads: async (id, config) =>
      leads(
        id,
        client.request('PATCH', `/assist/sites/${seg(id)}/leads-config`, {
          config,
        })
      ),
  };
}
