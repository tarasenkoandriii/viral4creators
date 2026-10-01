/**
 * Мастер «Научите помощника» и полнота знаний (ТЗ §4-тер.9) — клиент
 * маршрутов W5 (контракт Э2 §6). Типы — повтор `sites-backend/src/modules/
 * assist-site-knowledge/wizard/wizard-types.ts` (сверяет
 * `scripts/wizard-api.test.ts` по тексту файла).
 *
 * Черновики — ДАННЫЕ, написанные моделью по чужому тексту сайта: только
 * текст (`textContent`), источники — только https-ссылки.
 */

import type { ApiClient } from '../kit';
import { arr, count, obj, oneOf, str, strs, text } from './widget-api';

export const WIZARD_BUSINESS_TYPES = ['shop', 'services', 'saas'] as const;
export type WizardBusinessType = (typeof WIZARD_BUSINESS_TYPES)[number];

export const WIZARD_TOPICS = [
  'delivery',
  'payment',
  'returns',
  'warranty',
  'hours_contacts',
  'availability',
  'wholesale_discounts',
  'must_not_promise',
  'handoff_when',
  'top_question',
  'booking',
  'pricing',
  'trial',
  'support',
] as const;
export type WizardTopic = (typeof WIZARD_TOPICS)[number];

export const WIZARD_TARGETS = [
  'golden',
  'persona_forbid',
  'handoff_rule',
] as const;
export type WizardAnswerTarget = (typeof WIZARD_TARGETS)[number];

export const WIZARD_ITEM_STATUSES = [
  'pending',
  'confirmed',
  'edited',
  'skipped',
  'saved',
] as const;
export type WizardItemStatus = (typeof WIZARD_ITEM_STATUSES)[number];

export interface WizardItemView {
  topic: WizardTopic;
  question: string;
  target: WizardAnswerTarget;
  draft: string | null;
  draftSources: Array<{ url: string | null; title: string | null }>;
  answer: string | null;
  status: WizardItemStatus;
  faqId: string | null;
}

export interface SiteSummary {
  businessType: WizardBusinessType | 'other';
  sections: string[];
  contacts: { phones: string[]; emails: string[]; address: string | null };
  hours: string | null;
  about: string | null;
  lang: string | null;
}

export interface WizardView {
  siteId: string;
  businessType: WizardBusinessType;
  status: 'in_progress' | 'done';
  items: WizardItemView[];
  draftRunsLeft: number;
  siteSummary: SiteSummary | null;
}

export const COMPLETENESS_NEXT = [
  'run_wizard',
  'answer_topics',
  'review_quarantine',
  'add_documents',
  'publish_widget',
] as const;
export type CompletenessNext = (typeof COMPLETENESS_NEXT)[number];

export interface CompletenessView {
  siteId: string;
  topics: { covered: number; total: number; missing: WizardTopic[] };
  pages: {
    read: number;
    skipped: number;
    quarantined: number;
    excluded: number;
  };
  quality: {
    lastEvalAt: string | null;
    passed: number | null;
    failed: number | null;
  };
  openGapsOlderThan7d: number;
  goldenNeedsReview: number;
  next: CompletenessNext[];
}

/** Только https-ссылка источника черновика: `javascript:` из базы не кликается. */
function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const nullableCount = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;

function parseItem(v: unknown): WizardItemView | null {
  const o = obj(v);
  if (!(WIZARD_TOPICS as readonly unknown[]).includes(o.topic)) return null;
  return {
    topic: o.topic as WizardTopic,
    question: text(o.question),
    target: oneOf(WIZARD_TARGETS, o.target, 'golden'),
    draft: str(o.draft),
    draftSources: arr(o.draftSources).map((s) => {
      const x = obj(s);
      return { url: httpsUrl(x.url), title: str(x.title) };
    }),
    answer: str(o.answer),
    status: oneOf(WIZARD_ITEM_STATUSES, o.status, 'pending'),
    faqId: str(o.faqId),
  };
}

export function parseSiteSummary(v: unknown): SiteSummary | null {
  if (!v || typeof v !== 'object') return null;
  const o = obj(v);
  const c = obj(o.contacts);
  return {
    businessType: oneOf(
      [...WIZARD_BUSINESS_TYPES, 'other'] as const,
      o.businessType,
      'other'
    ),
    sections: strs(o.sections).slice(0, 8),
    contacts: {
      phones: strs(c.phones),
      emails: strs(c.emails),
      address: str(c.address),
    },
    hours: str(o.hours),
    about: str(o.about),
    lang: str(o.lang),
  };
}

export function parseWizard(v: unknown): WizardView {
  const o = obj(v);
  return {
    siteId: text(o.siteId),
    businessType: oneOf(WIZARD_BUSINESS_TYPES, o.businessType, 'shop'),
    // Неизвестный статус — «идёт»: «готово» без подтверждения — ложь.
    status: o.status === 'done' ? 'done' : 'in_progress',
    items: arr(o.items)
      .map(parseItem)
      .filter((x): x is WizardItemView => !!x),
    draftRunsLeft: count(o.draftRunsLeft),
    siteSummary: parseSiteSummary(o.siteSummary),
  };
}

export function parseCompleteness(v: unknown): CompletenessView {
  const o = obj(v);
  const t = obj(o.topics);
  const p = obj(o.pages);
  const q = obj(o.quality);
  return {
    siteId: text(o.siteId),
    topics: {
      covered: count(t.covered),
      total: count(t.total),
      missing: strs(t.missing).filter((x): x is WizardTopic =>
        (WIZARD_TOPICS as readonly string[]).includes(x)
      ),
    },
    pages: {
      read: count(p.read),
      skipped: count(p.skipped),
      quarantined: count(p.quarantined),
      excluded: count(p.excluded),
    },
    quality: {
      lastEvalAt: str(q.lastEvalAt),
      passed: nullableCount(q.passed),
      failed: nullableCount(q.failed),
    },
    openGapsOlderThan7d: count(o.openGapsOlderThan7d),
    goldenNeedsReview: count(o.goldenNeedsReview),
    next: strs(o.next).filter((x): x is CompletenessNext =>
      (COMPLETENESS_NEXT as readonly string[]).includes(x)
    ),
  };
}

export interface WizardApi {
  get(siteId: string): Promise<WizardView>;
  start(siteId: string, businessType?: WizardBusinessType): Promise<WizardView>;
  drafts(siteId: string): Promise<WizardView>;
  answer(
    siteId: string,
    topic: WizardTopic,
    body: { status: 'confirmed' | 'edited' | 'skipped'; answer?: string }
  ): Promise<WizardView>;
  complete(siteId: string): Promise<WizardView>;
  completeness(siteId: string): Promise<CompletenessView>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
function seg(id: string): string {
  if (!ID.test(id)) throw new Error('bad id');
  return id;
}

export function createWizardApi(client: ApiClient): WizardApi {
  const base = (id: string) =>
    `/assist/sites/${seg(id)}/learning/site/onboarding`;
  const w = async (x: Promise<unknown>) => parseWizard(await x);
  return {
    get: async (id) => w(client.request('GET', base(id))),
    start: async (id, businessType) =>
      w(
        client.request(
          'POST',
          `${base(id)}/start`,
          businessType ? { businessType } : {}
        )
      ),
    drafts: async (id) => w(client.request('POST', `${base(id)}/drafts`)),
    answer: async (id, topic, body) => {
      if (!(WIZARD_TOPICS as readonly string[]).includes(topic)) {
        throw new Error('bad topic');
      }
      return w(client.request('PATCH', `${base(id)}/items/${topic}`, body));
    },
    complete: async (id) => w(client.request('POST', `${base(id)}/complete`)),
    completeness: async (id) =>
      parseCompleteness(
        await client.request(
          'GET',
          `/assist/sites/${seg(id)}/learning/site/completeness`
        )
      ),
  };
}
