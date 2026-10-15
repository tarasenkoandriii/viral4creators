/**
 * AI Publisher, P-R — импорт чернового исследования Reddit в раздел «Reddit»
 * (reddit-manual-mvp-adapted.md §8.1 «Импорт», Р-RD-87). Вход — CSV
 * исследования (`{сегмент}-{communities,opportunities,keywords}.csv`, формат —
 * бриф исследования); выход — план записей кабинета и их выполнение ЧЕРЕЗ
 * HTTP API кабинета (`ImportHttp` — внедряется: этот файл сам сеть не
 * открывает, правило графа `publisher-reddit-no-network-io`; CLI —
 * `publisher/cli/reddit-import.ts`).
 *
 * Правила:
 *  - правила сообществ из вторичных источников НЕ становятся проверенными:
 *    снимок создаётся `unreviewed` (проверку подтверждает владелец в кабинете),
 *    `conditions` из CSV и строка «secondary: <источник>»; `sourceUrl` —
 *    первый URL поля `source_url` (reddit.com — только хранится, сервер его
 *    не запрашивает); пометки и прочие ссылки — текстом;
 *  - возможности — только треды, которые нормализуются (`normalizeThreadUrl`),
 *    в сообществе из CSV; факторы и обоснования — из CSV (`why` вида
 *    `tf: …; itf: …`), `policy_risk` считает сервер по снимку; выдержки нет
 *    (её в CSV нет), контекст исследователя — `angle`;
 *  - ключевые запросы — все (дубли по нормальной форме — один);
 *  - тексты с контактом/ником (правило сервера) — ссылки сокращаются до
 *    хоста, длинные цифры убираются; не помогло — отказ `pii`;
 *  - идемпотентность: до записи — чтение списков (уже есть → `exists`),
 *    `opKey` — детерминированный UUID v4 от вида, ключа и тела (повтор
 *    запроса — ответ из журнала операций), 409 `{reason:'duplicate',
 *    existingId}` — `exists`; снимок правил — новый, только если текущий
 *    отличается и ещё не проверен владельцем.
 *
 * Без сети к Reddit: план строится из CSV, `ImportHttp` ходит только в API
 * кабинета.
 */
import { createHash } from 'crypto';
import { looksLikeContact } from '../core/pii-guard';
import {
  REDDIT_INTENTS,
  REDDIT_LINKS_POLICIES,
  REDDIT_PROMOTION_POLICIES,
  type RedditIntent,
  type RedditLinksPolicy,
  type RedditPromotionPolicy,
} from '../contracts/states';
import type {
  CreateRedditRulesBody,
  RedditFactorsInput,
  RedditOperatorFactor,
  RedditPolicyReason,
} from '../contracts/reddit-api';
import {
  hasProfileRef,
  normalizeSubreddit,
  normalizeThreadUrl,
  phraseNorm,
} from './normalize';
import { policyGate } from './policy';

// ── CSV ──────────────────────────────────────────────────────────────────

/** CSV (RFC 4180): кавычки, `""`, переводы строк в кавычках, CRLF, BOM. */
export function parseCsv(text: string): Array<Record<string, string | null>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closedQuote = true;
      } else cell += c;
    } else if (closedQuote && c !== ',' && c !== '\n' && c !== '\r') {
      if (c !== ' ' && c !== '\t')
        throw new Error('CSV: текст после закрывающей кавычки');
    } else if (c === '"') {
      if (cell.length) throw new Error('CSV: кавычка внутри обычного поля');
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
      closedQuote = false;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      closedQuote = false;
    } else cell += c;
  }
  if (quoted) throw new Error('CSV: незакрытая кавычка');
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const data = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (!data.length) return [];
  const head = data[0].map((h) => h.trim());
  if (head.some((h) => !h) || new Set(head).size !== head.length)
    throw new Error('CSV: пустые или повторяющиеся заголовки');
  return data.slice(1).map((r) => {
    if (r.length > head.length)
      throw new Error('CSV: полей больше, чем заголовков');
    const o: Record<string, string | null> = {};
    head.forEach((h, k) => {
      const v = (r[k] ?? '').trim();
      o[h] = v === '' || v.toLowerCase() === 'null' ? null : v;
    });
    return o;
  });
}

export type CsvRow = Record<string, string | null>;

export interface ResearchSegment {
  segment: string;
  communities: CsvRow[];
  opportunities: CsvRow[];
  keywords: CsvRow[];
}

// ── Тексты ───────────────────────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s;,)]+/giu;

const clip = (t: string, max: number): string =>
  [...t].length <= max ? t : [...t].slice(0, max - 1).join('') + '…';

/**
 * Текст без контакта и ника по правилу сервера: ссылки → `хост/…`, длинные
 * числа → `…`, `u/ник` → `u/…`. `null` — очистить не удалось.
 */
export function safeText(
  t: string,
  max: number,
): { text: string; sanitized: boolean } | null {
  const bad = (x: string) => looksLikeContact(x) || hasProfileRef(x);
  let x = clip(t.replace(/\s+/g, ' ').trim(), max);
  if (!bad(x)) return { text: x, sanitized: false };
  // 1) ссылки, похожие на контакт или профиль, — до хоста;
  x = x.replace(URL_RE, (u) => {
    if (!bad(u)) return u;
    try {
      return `${new URL(u).host}/…`;
    } catch {
      return '…';
    }
  });
  // 2) не помогло — длинные числа и ники.
  if (bad(x))
    x = x
      .replace(/\d[\d\s().:/_–—-]{5,}\d/gu, '…')
      .replace(/(^|[^a-z0-9])(u|user)\/[\w-]+/giu, '$1$2/…');
  x = clip(x, max);
  return bad(x) ? null : { text: x, sanitized: true };
}

/** UUID v4 из ключа (детерминированный `opKey`, формат `OP_KEY_RE`). */
export function stableOpKey(...parts: string[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const v = (parseInt(h[16], 16) & 0x3) | 0x8;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v.toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const bodyHash = (b: unknown): string =>
  createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 16);

// ── План ─────────────────────────────────────────────────────────────────

export interface Rejection {
  kind: 'community' | 'rules' | 'keyword' | 'opportunity';
  ref: string;
  segment: string;
  code: string;
  detail?: string;
}

export interface PlannedCommunity {
  subreddit: string;
  segments: string[];
  body: {
    community: string;
    descriptionManual: string | null;
    topics: string[];
    language: string | null;
  };
  rules: Omit<CreateRedditRulesBody, 'opKey'>;
  /** Гейт снимка после импорта (unreviewed) и после проверки владельцем. */
  gate: { now: RedditPolicyReason[]; afterReview: RedditPolicyReason[] };
  sanitized: boolean;
}

export interface PlannedKeyword {
  phraseNorm: string;
  segment: string;
  body: {
    phrase: string;
    intent: RedditIntent;
    priority: number;
    locale: string | null;
  };
}

export interface PlannedOpportunity {
  threadKey: string;
  subreddit: string;
  segment: string;
  ref: string;
  body: {
    threadUrl: string;
    titleManual: string;
    intent: RedditIntent;
    angle: string | null;
    factors: RedditFactorsInput;
  };
  sanitized: boolean;
}

export interface ImportPlan {
  project: { title: string; locale: string; market: string };
  communities: PlannedCommunity[];
  keywords: PlannedKeyword[];
  opportunities: PlannedOpportunity[];
  rejected: Rejection[];
}

export interface PlanOptions {
  projectTitle: string;
  locale: string;
  market: string;
  now: Date;
}

const OPERATOR_FACTORS: RedditOperatorFactor[] = [
  'topic_fit',
  'intent_fit',
  'audience_fit',
  'answerability',
  'promotionality',
  'evidence_gap',
  'context_uncertainty',
];
/** Сокращения обоснований в колонке `why` исследования. */
const WHY_KEYS: Record<string, RedditOperatorFactor> = {
  tf: 'topic_fit',
  itf: 'intent_fit',
  af: 'audience_fit',
  ans: 'answerability',
  prom: 'promotionality',
  eg: 'evidence_gap',
  cu: 'context_uncertainty',
};

/** `tf: …; itf: …` → обоснования по факторам. */
export function parseWhy(
  raw: string | null,
): Partial<Record<RedditOperatorFactor, string>> {
  const out: Partial<Record<RedditOperatorFactor, string>> = {};
  for (const part of (raw ?? '').split(';')) {
    const m = /^\s*([a-z]+)\s*:\s*(.+?)\s*$/i.exec(part);
    if (!m) continue;
    const k = WHY_KEYS[m[1].toLowerCase()];
    if (k && !out[k]) out[k] = m[2];
  }
  return out;
}

const enumOr = <T extends string>(
  list: readonly T[],
  v: string | null,
  d: T,
): T =>
  v && (list as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T)
    : d;

const score = (v: string | null): number | null => {
  if (v === null || !/^\d{1,3}$/.test(v.trim())) return null;
  const n = Number(v);
  return n >= 0 && n <= 100 ? n : null;
};

function checkedAtOf(v: string | null, now: Date): string {
  const d =
    v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) && d.getTime() <= now.getTime()
    ? d.toISOString()
    : now.toISOString();
}

/** Гейт снимка правил (без ссылок в тексте) — для отчёта «что будет BLOCK». */
function gateOf(
  promotionPolicy: RedditPromotionPolicy,
  linksPolicy: RedditLinksPolicy,
  reviewState: 'unreviewed' | 'reviewed',
  now: Date,
): RedditPolicyReason[] {
  return policyGate(
    { reviewState, checkedAt: now, promotionPolicy, linksPolicy },
    now,
    30,
    'comment',
    false,
  ).reasons;
}

const OPEN_BRACKETS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '«': '»',
  '“': '”',
};

/**
 * Условия правил из ячейки CSV (аудит Админки S3-7): разделитель — `;` с
 * пробелом после него или перевод строки, но `;` внутри скобок `()`/`[]`
 * и кавычек `"…"`, `«…»`, `“…”` условие не режет («Max 1 mention OR 3
 * links per 60 days (posts+comments; alt accounts count)» — одно условие).
 * Перевод строки делит всегда и сбрасывает незакрытые скобки/кавычки
 * (незакрытая скобка не склеивает весь столбец).
 */
export function splitConditions(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let stack: string[] = [];
  let quoted = false;
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = '';
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '\n' || ch === '\r') {
      flush();
      stack = [];
      quoted = false;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && OPEN_BRACKETS[ch]) stack.push(OPEN_BRACKETS[ch]);
    else if (!quoted && stack.length && ch === stack[stack.length - 1])
      stack.pop();
    if (
      ch === ';' &&
      !quoted &&
      stack.length === 0 &&
      /\s/.test(raw[i + 1] ?? '')
    ) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return out;
}

function rulesOf(
  r: CsvRow,
  subreddit: string,
  segment: string,
  now: Date,
): { rules: PlannedCommunity['rules']; sanitized: boolean } | null {
  const sourceField = r.source_url ?? '';
  const urls = [...sourceField.matchAll(URL_RE)].map((m) =>
    m[0].replace(/[.]+$/, ''),
  );
  const extra = r.rules_source ? [...r.rules_source.matchAll(URL_RE)] : [];
  const hints = [...urls.slice(1), ...extra.map((m) => m[0])];
  const sourceUrl =
    urls.find((u) => /^https:\/\//i.test(u)) ??
    `https://www.reddit.com/r/${subreddit}/about/rules`;
  let sanitized = false;
  const conditions: string[] = [];
  for (const c of splitConditions(r.conditions ?? '')) {
    if (conditions.length >= 19) continue;
    const t = safeText(c, 300);
    if (!t) continue;
    sanitized ||= t.sanitized;
    conditions.push(t.text);
  }
  const secondary = safeText(
    `secondary: ${hints.length ? hints.join(' ; ') : sourceField || 'research CSV'}`,
    300,
  );
  if (secondary) {
    sanitized ||= secondary.sanitized;
    conditions.push(secondary.text);
  }
  const excerpt = safeText(
    [
      `Imported from research CSV (segment ${segment}, checked ${r.checked_at ?? 'unknown'}).`,
      'Secondary sources only — not verified first-hand; review the rules on Reddit before relying on them.',
      `Source note: ${sourceField || '—'}`,
      r.rules_source ? `Rules source: ${r.rules_source}` : '',
      `Conditions: ${r.conditions ?? '—'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    5000,
  );
  if (!excerpt) return null;
  sanitized ||= excerpt.sanitized;
  const flair = (r.flair_required ?? '').toLowerCase();
  return {
    sanitized,
    rules: {
      sourceUrl,
      sourceExcerpt: excerpt.text,
      promotionPolicy: enumOr(
        REDDIT_PROMOTION_POLICIES,
        r.promotion_policy,
        'unknown',
      ),
      linksPolicy: enumOr(REDDIT_LINKS_POLICIES, r.links_policy, 'unknown'),
      flairRequired: flair === 'true' ? true : flair === 'false' ? false : null,
      conditions,
      checkedAt: checkedAtOf(r.checked_at, now),
    },
  };
}

/** План импорта из CSV исследования (чистая функция, без сети). */
export function buildImportPlan(
  segments: ResearchSegment[],
  o: PlanOptions,
): ImportPlan {
  const plan: ImportPlan = {
    project: { title: o.projectTitle, locale: o.locale, market: o.market },
    communities: [],
    keywords: [],
    opportunities: [],
    rejected: [],
  };
  const bySub = new Map<string, PlannedCommunity>();
  for (const seg of segments) {
    for (const [i, r] of seg.communities.entries()) {
      const ref = r.name ?? r.url ?? `row ${i + 2}`;
      const sub =
        normalizeSubreddit(r.name ?? '') ?? normalizeSubreddit(r.url ?? '');
      if (!sub) {
        plan.rejected.push({
          kind: 'community',
          ref,
          segment: seg.segment,
          code: 'format',
        });
        continue;
      }
      const have = bySub.get(sub);
      if (have) {
        if (!have.segments.includes(seg.segment)) {
          have.segments.push(seg.segment);
          if (have.body.topics.length < 20) have.body.topics.push(seg.segment);
        }
        continue;
      }
      const rules = rulesOf(r, sub, seg.segment, o.now);
      if (!rules) {
        plan.rejected.push({
          kind: 'rules',
          ref,
          segment: seg.segment,
          code: 'pii',
        });
        continue;
      }
      const desc = r.topic ? safeText(r.topic, 2000) : null;
      const pc: PlannedCommunity = {
        subreddit: sub,
        segments: [seg.segment],
        body: {
          community: `r/${sub}`,
          descriptionManual: desc?.text ?? null,
          topics: [seg.segment],
          language: null,
        },
        rules: rules.rules,
        gate: {
          now: gateOf(
            rules.rules.promotionPolicy,
            rules.rules.linksPolicy,
            'unreviewed',
            o.now,
          ),
          afterReview: gateOf(
            rules.rules.promotionPolicy,
            rules.rules.linksPolicy,
            'reviewed',
            o.now,
          ),
        },
        sanitized: rules.sanitized || !!desc?.sanitized,
      };
      bySub.set(sub, pc);
      plan.communities.push(pc);
    }
  }
  const phrases = new Set<string>();
  for (const seg of segments)
    for (const [i, r] of seg.keywords.entries()) {
      const ref = r.phrase ?? `row ${i + 2}`;
      const t = r.phrase ? safeText(r.phrase, 200) : null;
      if (!r.phrase || !t || t.sanitized) {
        plan.rejected.push({
          kind: 'keyword',
          ref,
          segment: seg.segment,
          code: r.phrase ? 'pii' : 'required',
        });
        continue;
      }
      const norm = phraseNorm(t.text);
      if (phrases.has(norm)) continue;
      phrases.add(norm);
      const p = Number(r.priority);
      plan.keywords.push({
        phraseNorm: norm,
        segment: seg.segment,
        body: {
          phrase: t.text,
          intent: enumOr(REDDIT_INTENTS, r.intent, 'other'),
          priority: Number.isInteger(p) && p >= 1 && p <= 5 ? p : 3,
          locale: o.locale || null,
        },
      });
    }
  const threads = new Set<string>();
  for (const seg of segments)
    for (const [i, r] of seg.opportunities.entries()) {
      const ref = r.id ?? r.url ?? `row ${i + 2}`;
      const reject = (code: string, detail?: string) =>
        plan.rejected.push({
          kind: 'opportunity',
          ref,
          segment: seg.segment,
          code,
          ...(detail ? { detail } : {}),
        });
      if ((r.kind ?? 'thread') !== 'thread') {
        reject('not_thread', r.kind ?? undefined);
        continue;
      }
      const t = normalizeThreadUrl(r.url ?? '');
      if (!t) {
        reject('not_thread');
        continue;
      }
      if (!bySub.has(t.subreddit)) {
        reject('community_missing', `r/${t.subreddit}`);
        continue;
      }
      if (threads.has(t.threadKey)) {
        reject('duplicate_in_csv');
        continue;
      }
      const title = r.title ? safeText(r.title, 300) : null;
      if (!title) {
        reject(r.title ? 'pii' : 'required', 'title');
        continue;
      }
      const angle = r.context ? safeText(r.context, 1000) : null;
      const why = parseWhy(r.why);
      const factors: RedditFactorsInput = {};
      let sanitized = title.sanitized || !!angle?.sanitized;
      for (const f of OPERATOR_FACTORS) {
        const value = score(r[f] ?? null);
        if (value === null) continue;
        const w = safeText(
          why[f] ?? `research CSV (${seg.segment}): no rationale given`,
          300,
        ) ?? { text: `research CSV (${seg.segment})`, sanitized: true };
        sanitized ||= w.sanitized;
        factors[f] = { value, why: w.text };
      }
      threads.add(t.threadKey);
      plan.opportunities.push({
        threadKey: t.threadKey,
        subreddit: t.subreddit,
        segment: seg.segment,
        ref,
        body: {
          threadUrl: t.url,
          titleManual: title.text,
          intent: enumOr(REDDIT_INTENTS, r.intent, 'other'),
          angle: angle?.text ?? null,
          factors,
        },
        sanitized,
      });
    }
  return plan;
}

// ── Выполнение через API кабинета ────────────────────────────────────────

/** Ответ API кабинета (конверт `{success, data | error}`). */
export interface ImportResponse {
  status: number;
  body: {
    data?: unknown;
    error?: { code?: string; details?: Record<string, unknown> };
  } | null;
}

/** HTTP к API кабинета (только пути `/publisher/…` базового адреса). */
export interface ImportHttp {
  get(path: string): Promise<ImportResponse>;
  post(path: string, body: Record<string, unknown>): Promise<ImportResponse>;
}

export type ImportOutcome =
  'created' | 'exists' | 'would_create' | 'kept_reviewed' | 'rejected';

export interface ImportItemReport {
  kind: 'project' | 'community' | 'rules' | 'keyword' | 'opportunity';
  ref: string;
  outcome: ImportOutcome;
  id?: string;
  code?: string;
  detail?: string;
}

export interface ImportReport {
  apply: boolean;
  productId: string;
  items: ImportItemReport[];
  /** Сообщества и их гейт: сейчас (unreviewed) и после проверки владельцем. */
  blocks: Array<{
    subreddit: string;
    now: RedditPolicyReason[];
    afterReview: RedditPolicyReason[];
  }>;
  summary: Record<string, Partial<Record<ImportOutcome, number>>>;
}

interface Page<T> {
  items: T[];
  nextBefore: string | null;
}

async function listAll<T>(
  http: ImportHttp,
  path: string,
  query: Record<string, string> = {},
): Promise<T[]> {
  const out: T[] = [];
  let before: string | null = null;
  const cursors = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const q = new URLSearchParams({ ...query, limit: '100' });
    if (before) q.set('before', before);
    const r = await http.get(`${path}?${q.toString()}`);
    if (r.status !== 200) throw new ImportError(path, r);
    const page = r.body?.data as Page<T> | T[];
    const items = Array.isArray(page) ? page : page?.items;
    if (!Array.isArray(items))
      throw new ImportError(path, {
        status: 502,
        body: { error: { code: 'IMPORT_INVALID_PAGE' } },
      });
    out.push(...items);
    before = Array.isArray(page) ? null : page.nextBefore;
    if (!before) return out;
    if (typeof before !== 'string' || cursors.has(before))
      throw new ImportError(path, {
        status: 502,
        body: { error: { code: 'IMPORT_INVALID_CURSOR' } },
      });
    cursors.add(before);
  }
  throw new ImportError(path, {
    status: 502,
    body: { error: { code: 'IMPORT_PAGE_LIMIT' } },
  });
}

export class ImportError extends Error {
  constructor(
    readonly path: string,
    readonly res: ImportResponse,
  ) {
    super(`${path}: HTTP ${res.status} ${res.body?.error?.code ?? ''}`.trim());
  }
}

const fieldCodes = (r: ImportResponse): string => {
  const e = r.body?.error;
  const f = e?.details?.fields as
    Array<{ field: string; code: string }> | undefined;
  return f?.length
    ? f.map((x) => `${x.field}:${x.code}`).join(',')
    : `${e?.code ?? `HTTP_${r.status}`}${e?.details?.reason ? `:${String(e.details.reason)}` : ''}`;
};

/**
 * Выполнить план: `apply=false` — только чтение (что есть, что будет
 * создано); `apply=true` — запись с детерминированными `opKey`. Ошибка
 * доступа/раздела (401/403/404 на чтении) — `ImportError`.
 */
export async function runImport(
  http: ImportHttp,
  productId: string,
  plan: ImportPlan,
  apply: boolean,
): Promise<ImportReport> {
  const P = `/publisher/products/${productId}/reddit`;
  const items: ImportItemReport[] = [];
  const add = (x: ImportItemReport) => items.push(x);
  for (const r of plan.rejected)
    add({
      kind: r.kind,
      ref: `${r.segment}: ${r.ref}`,
      outcome: 'rejected',
      code: r.code,
      ...(r.detail ? { detail: r.detail } : {}),
    });

  const create = async (
    kind: ImportItemReport['kind'],
    ref: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ outcome: ImportOutcome; id?: string; code?: string }> => {
    if (!apply) return { outcome: 'would_create' };
    const opKey = stableOpKey(
      'reddit-import',
      productId,
      kind,
      ref,
      bodyHash(body),
    );
    let r: ImportResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await http.post(path, { opKey, ...body });
      if (r.status !== 503) break;
    }
    const res = r!;
    if (res.status === 401 || res.status === 403)
      throw new ImportError(path, res);
    if (res.status === 200 || res.status === 201)
      return {
        outcome: 'created',
        id: (res.body?.data as { id?: string })?.id,
      };
    const d = res.body?.error?.details;
    if (
      res.status === 409 &&
      d?.reason === 'duplicate' &&
      typeof d.existingId === 'string'
    )
      return { outcome: 'exists', id: d.existingId };
    return { outcome: 'rejected', code: fieldCodes(res) };
  };

  // Продукт и раздел.
  const prod = await http.get(`/publisher/products/${productId}`);
  if (prod.status !== 200) throw new ImportError('product', prod);
  const features = (prod.body?.data as { features?: { reddit?: boolean } })
    ?.features;
  if (!features?.reddit)
    throw new ImportError('product', {
      status: 409,
      body: { error: { code: 'REDDIT_DISABLED' } },
    });

  // Проект — по названию (активный).
  const projects = await listAll<{ id: string; title: string; status: string }>(
    http,
    `${P}/projects`,
  );
  let projectId = projects.find(
    (p) => p.title === plan.project.title && p.status === 'active',
  )?.id;
  if (projectId)
    add({
      kind: 'project',
      ref: plan.project.title,
      outcome: 'exists',
      id: projectId,
    });
  else {
    const r = await create('project', plan.project.title, `${P}/projects`, {
      ...plan.project,
    });
    add({ kind: 'project', ref: plan.project.title, ...r });
    projectId = r.id;
  }

  // Сообщества — по имени в продукте (одно на продукт, Р-RD-2).
  const communities = await listAll<{
    id: string;
    subreddit: string;
    projectId: string;
  }>(http, `${P}/communities`);
  const commId = new Map<string, string>();
  for (const c of plan.communities) {
    const have = communities.find((x) => x.subreddit === c.subreddit);
    let id = have?.id;
    if (have && projectId && have.projectId !== projectId) {
      add({
        kind: 'community',
        ref: `r/${c.subreddit}`,
        outcome: 'rejected',
        code: 'other_project',
        id: have.id,
      });
      continue;
    }
    if (have)
      add({
        kind: 'community',
        ref: `r/${c.subreddit}`,
        outcome: 'exists',
        id,
      });
    else if (!projectId)
      add({
        kind: 'community',
        ref: `r/${c.subreddit}`,
        outcome: 'would_create',
      });
    else {
      const r = await create('community', c.subreddit, `${P}/communities`, {
        projectId,
        ...c.body,
      });
      add({ kind: 'community', ref: `r/${c.subreddit}`, ...r });
      id = r.id;
    }
    if (id) commId.set(c.subreddit, id);
    // Снимок правил: новый, только если текущий отличается и не проверен.
    let current:
      | {
          reviewState: string;
          promotionPolicy: string;
          linksPolicy: string;
          flairRequired: boolean | null;
          conditions: string[];
          status: string;
          source: { url: string };
        }
      | undefined;
    if (id && have) {
      const snaps = await listAll<NonNullable<typeof current>>(
        http,
        `${P}/communities/${id}/rules`,
      );
      current = snaps.find((s) => s.status === 'current');
    }
    const same =
      current &&
      current.promotionPolicy === c.rules.promotionPolicy &&
      current.linksPolicy === c.rules.linksPolicy &&
      current.flairRequired === (c.rules.flairRequired ?? null) &&
      JSON.stringify(current.conditions) ===
        JSON.stringify(c.rules.conditions ?? []) &&
      current.source.url === c.rules.sourceUrl;
    if (current?.reviewState === 'reviewed')
      add({ kind: 'rules', ref: `r/${c.subreddit}`, outcome: 'kept_reviewed' });
    else if (same)
      add({ kind: 'rules', ref: `r/${c.subreddit}`, outcome: 'exists' });
    else if (!id)
      add({
        kind: 'rules',
        ref: `r/${c.subreddit}`,
        outcome: apply ? 'rejected' : 'would_create',
        ...(apply ? { code: 'community_missing' } : {}),
      });
    else {
      const r = await create(
        'rules',
        c.subreddit,
        `${P}/communities/${id}/rules`,
        { ...c.rules },
      );
      add({ kind: 'rules', ref: `r/${c.subreddit}`, ...r });
    }
  }

  // Ключевые запросы — по нормальной форме в проекте.
  const keywords = projectId
    ? await listAll<{ id: string; phraseNorm: string }>(http, `${P}/keywords`, {
        projectId,
      })
    : [];
  for (const k of plan.keywords) {
    const have = keywords.find((x) => x.phraseNorm === k.phraseNorm);
    if (have)
      add({
        kind: 'keyword',
        ref: k.body.phrase,
        outcome: 'exists',
        id: have.id,
      });
    else if (!projectId)
      add({ kind: 'keyword', ref: k.body.phrase, outcome: 'would_create' });
    else
      add({
        kind: 'keyword',
        ref: k.body.phrase,
        ...(await create('keyword', k.phraseNorm, `${P}/keywords`, {
          projectId,
          ...k.body,
        })),
      });
  }

  // Возможности — по ключу треда в проекте.
  const opps = projectId
    ? await listAll<{ id: string; threadKey: string }>(
        http,
        `${P}/opportunities`,
        { projectId },
      )
    : [];
  for (const o of plan.opportunities) {
    const ref = `${o.segment}: ${o.ref}`;
    const have = opps.find((x) => x.threadKey === o.threadKey);
    const cid = commId.get(o.subreddit);
    if (have) add({ kind: 'opportunity', ref, outcome: 'exists', id: have.id });
    else if (!projectId || !cid)
      add({
        kind: 'opportunity',
        ref,
        outcome: apply ? 'rejected' : 'would_create',
        ...(apply ? { code: 'community_missing' } : {}),
      });
    else
      add({
        kind: 'opportunity',
        ref,
        ...(await create('opportunity', o.threadKey, `${P}/opportunities`, {
          projectId,
          communityId: cid,
          ...o.body,
        })),
      });
  }

  return reportOf(apply, productId, plan, items);
}

function reportOf(
  apply: boolean,
  productId: string,
  plan: ImportPlan,
  items: ImportItemReport[],
): ImportReport {
  const summary: ImportReport['summary'] = {};
  for (const it of items) {
    const s = (summary[it.kind] ??= {});
    s[it.outcome] = (s[it.outcome] ?? 0) + 1;
  }
  return {
    apply,
    productId,
    items,
    blocks: plan.communities.map((c) => ({
      subreddit: c.subreddit,
      now: c.gate.now,
      afterReview: c.gate.afterReview,
    })),
    summary,
  };
}

/** Отчёт по плану без сервера (dry-run без `--base-url`): всё «будет создано». */
export function offlineReport(plan: ImportPlan): ImportReport {
  const items: ImportItemReport[] = [
    ...plan.rejected.map((r): ImportItemReport => ({
      kind: r.kind,
      ref: `${r.segment}: ${r.ref}`,
      outcome: 'rejected',
      code: r.code,
      ...(r.detail ? { detail: r.detail } : {}),
    })),
    { kind: 'project', ref: plan.project.title, outcome: 'would_create' },
    ...plan.communities.flatMap((c): ImportItemReport[] => [
      { kind: 'community', ref: `r/${c.subreddit}`, outcome: 'would_create' },
      { kind: 'rules', ref: `r/${c.subreddit}`, outcome: 'would_create' },
    ]),
    ...plan.keywords.map((k): ImportItemReport => ({
      kind: 'keyword',
      ref: k.body.phrase,
      outcome: 'would_create',
    })),
    ...plan.opportunities.map((o): ImportItemReport => ({
      kind: 'opportunity',
      ref: `${o.segment}: ${o.ref}`,
      outcome: 'would_create',
    })),
  ];
  return reportOf(false, '(offline)', plan, items);
}
