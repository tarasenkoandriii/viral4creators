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
 *    первый https-URL поля `source_url`, если исследование его прочитало;
 *    помечен «not readable» (или URL нет) — `sourceUrl: null`, текст
 *    источника — в «secondary: …» (Р-RD-AUD-3: такой снимок подтвердить
 *    нельзя — 400 `source_required`, нужен новый снимок с первоисточником);
 *  - сообщество, у которого уже есть текущий снимок (любой проверки), новый
 *    снимок из CSV НЕ получает — строка правил «exists», код `kept_current`
 *    (расхождение policy/links — в `detail`); сегмент дописывается в
 *    `topics` (Р-RD-AUD-2). Снимок импорт создаёт, только когда текущего нет;
 *    `opKey` правил включает id текущего снимка (или `none`); создание идёт
 *    с `ifNoCurrent: true` — снимок, созданный тем временем другим импортом,
 *    сервер оставляет (200 `kept` → тоже `kept_current`, Р-RD-AUD-9);
 *  - возможности — только треды, которые нормализуются (`normalizeThreadUrl`),
 *    в сообществе из CSV или уже заведённом в продукте (того же проекта);
 *    факторы и обоснования — из CSV (`why` вида `tf: …; itf: …`),
 *    `policy_risk` считает сервер по снимку; выдержки нет (её в CSV нет),
 *    контекст исследователя и `found_via` — `angle`;
 *  - ключевые запросы — все (дубли по нормальной форме — один);
 *  - тексты с контактом/ником (правило сервера) — ссылки сокращаются (длинные
 *    цифры пути → `…`, не помогло — до хоста), длинные цифры убираются; не
 *    помогло — отказ `pii`. Очистка, обрезка, отброшенные условия и колонки,
 *    значения по умолчанию и нераспознанный флейр — `warnings` отчёта;
 *  - идемпотентность: до записи — чтение списков (уже есть → `exists`),
 *    `opKey` — детерминированный UUID v4 от вида, ключа и тела (повтор
 *    запроса — ответ из журнала операций), 409 `{reason:'duplicate',
 *    existingId}` — `exists`, 409 `PUB_IDEMPOTENCY_REUSED` (тот же шаг
 *    выполнил другой актор) — `exists`/`other_actor`;
 *  - скорость (Р-RD-AUD-4): фазы по порядку зависимостей (проект →
 *    сообщества с правилами → запросы → возможности), строки фазы — пулом
 *    `IMPORT_CONCURRENCY`; дедлайн (`deadlineAt`) — непройденные строки
 *    `not_attempted`/`deadline`, отчёт частичный (`complete:false`), повтор
 *    безопасен.
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
/** Телефон по правилу сервера без пробелов (внутри URL пробелов нет). */
const URL_DIGITS_RE = /[0-9]([().,/_:–—-]*[0-9]){6,}/gu;

const clip = (t: string, max: number): string =>
  [...t].length <= max ? t : [...t].slice(0, max - 1).join('') + '…';

export interface SafeText {
  text: string;
  /** Ссылки/числа/ники убраны, чтобы текст прошёл правило контактов. */
  sanitized: boolean;
  /** Текст длиннее `max` — обрезан с «…». */
  clipped: boolean;
}

/**
 * Текст без контакта и ника по правилу сервера: в ссылке длинные цифры
 * пути → `…` (хост не похож на контакт), иначе ссылка → `хост/…`; длинные
 * числа → `…`, `u/ник` → `u/…`. `null` — очистить не удалось. `multiline`
 * — переводы строк сохраняются (выдержка правил), иначе пробелы сжимаются.
 */
export function safeText(
  t: string,
  max: number,
  multiline = false,
): SafeText | null {
  const bad = (x: string) => looksLikeContact(x) || hasProfileRef(x);
  const flat = multiline
    ? t
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : t.replace(/\s+/g, ' ').trim();
  let x = clip(flat, max);
  const clipped = x !== flat;
  if (!bad(x)) return { text: x, sanitized: false, clipped };
  // 1) ссылки, похожие на контакт или профиль: цифры пути → `…`, не помогло
  //    (или хост сам похож на контакт) — до хоста;
  x = x.replace(URL_RE, (u) => {
    if (!bad(u)) return u;
    try {
      const host = new URL(u).host;
      const trimmed = u.replace(URL_DIGITS_RE, '…');
      return !bad(host) && !bad(trimmed) ? trimmed : `${host}/…`;
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
  return bad(x) ? null : { text: x, sanitized: true, clipped };
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

/**
 * Предупреждение импорта (строка записана, но не дословно):
 *  - `sanitized` — из поля убраны похожие на контакт ссылки/числа/ники;
 *  - `clipped` — поле обрезано до лимита сервера (`detail` — лимит);
 *  - `dropped_conditions` — условия сверх 19 или не очищенные (`detail` — число);
 *  - `enum_default` — значение вне списка заменено (`detail` — исходное);
 *  - `flair_unparsed` — `flair_required` не распознан (→ null);
 *  - `dropped_columns` — колонки CSV, которые импорт не переносит (`detail`);
 *  - `merged` — строка сообщества из следующего сегмента/дубль: правила взяты
 *    из первой строки (`detail` — её сегмент), сегмент — в `topics`.
 */
export type ImportWarningCode =
  | 'sanitized'
  | 'clipped'
  | 'dropped_conditions'
  | 'enum_default'
  | 'flair_unparsed'
  | 'dropped_columns'
  | 'merged';

export interface ImportWarning {
  kind: Rejection['kind'] | 'file';
  /** `<сегмент>: <строка>` (для `file` — `<сегмент>: <вид файла>`). */
  ref: string;
  code: ImportWarningCode;
  field?: string;
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
  /** Сообщество описано в CSV; иначе — ищется среди сообществ продукта. */
  communityInPlan: boolean;
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
  warnings: ImportWarning[];
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

/** Колонки CSV, которые импорт переносит (остальные — `dropped_columns`). */
const USED_COLUMNS: Record<
  'communities' | 'opportunities' | 'keywords',
  string[]
> = {
  communities: [
    'name',
    'url',
    'topic',
    'size',
    'promotion_policy',
    'links_policy',
    'flair_required',
    'conditions',
    'source_url',
    'checked_at',
    'rules_source',
  ],
  opportunities: [
    'id',
    'url',
    'title',
    'subreddit',
    'context',
    'intent',
    'kind',
    'why',
    'found_via',
    ...OPERATOR_FACTORS,
  ],
  keywords: ['phrase', 'intent', 'priority'],
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

/**
 * `flair_required` исследования: `true/yes/y/1/required …` → true (в том
 * числе «yes (self-promo flair; …)»), `false/no/n/0/none/not required …` →
 * false, пусто/`unknown` → null; прочее — null и `parsed:false`.
 */
export function parseFlair(raw: string | null): {
  value: boolean | null;
  parsed: boolean;
} {
  const v = (raw ?? '').trim();
  if (!v || /^(unknown|n\/a|na|null|none known|-|—)$/i.test(v))
    return { value: null, parsed: true };
  if (/^(not\s+required|false|no|n|0|none|optional)(?![\w])/i.test(v))
    return { value: false, parsed: true };
  if (/^(true|yes|y|1|required|mandatory)(?![\w])/i.test(v))
    return { value: true, parsed: true };
  return { value: null, parsed: false };
}

/** Значение для отчёта: коротко, одной строкой. */
const shortVal = (v: string): string => clip(v.replace(/\s+/g, ' ').trim(), 80);

const enumIn = <T extends string>(
  list: readonly T[],
  v: string | null | undefined,
) =>
  v != null && (list as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T)
    : null;

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

/** «… (not readable[: причина])» в `source_url` — страница правил не прочитана. */
const NOT_READABLE_RE = /\(\s*not\s+readable\b\s*:?\s*([^)]*)\)/i;

type Warn = (code: ImportWarningCode, field?: string, detail?: string) => void;

/** `safeText` + предупреждения `sanitized`/`clipped` по полю. */
function cleanText(
  raw: string,
  max: number,
  field: string,
  warn: Warn,
  multiline = false,
): SafeText | null {
  const t = safeText(raw, max, multiline);
  if (t?.sanitized) warn('sanitized', field);
  if (t?.clipped) warn('clipped', field, `≤ ${max}`);
  return t;
}

function rulesOf(
  r: CsvRow,
  subreddit: string,
  segment: string,
  now: Date,
  warn: Warn,
): { rules: PlannedCommunity['rules']; sanitized: boolean } | null {
  const sourceField = r.source_url ?? '';
  const urls = [...sourceField.matchAll(URL_RE)].map((m) =>
    m[0].replace(/[.]+$/, ''),
  );
  const extra = r.rules_source ? [...r.rules_source.matchAll(URL_RE)] : [];
  // Р-RD-AUD-3: первоисточник — только прочитанная исследованием страница.
  const notReadable = NOT_READABLE_RE.exec(sourceField);
  const sourceUrl = notReadable
    ? null
    : (urls.find((u) => /^https:\/\//i.test(u)) ?? null);
  const hints = [
    ...(notReadable ? urls.slice(1) : urls.filter((u) => u !== sourceUrl)),
    ...extra.map((m) => m[0]),
  ];
  let sanitized = false;
  const conditions: string[] = [];
  let dropped = 0;
  for (const [i, c] of splitConditions(r.conditions ?? '').entries()) {
    if (conditions.length >= 19) {
      dropped++;
      continue;
    }
    const t = cleanText(c, 300, `conditions[${i}]`, warn);
    if (!t) {
      dropped++;
      continue;
    }
    sanitized ||= t.sanitized;
    conditions.push(t.text);
  }
  if (dropped) warn('dropped_conditions', 'conditions', String(dropped));
  const why = notReadable
    ? `rules page not readable${notReadable[1]?.trim() ? ` (${notReadable[1].trim()})` : ''}; `
    : '';
  const secondary = cleanText(
    `secondary: ${why}${hints.length ? hints.join(' ; ') : notReadable || sourceUrl ? 'research CSV' : sourceField || 'research CSV'}`,
    300,
    'conditions[secondary]',
    warn,
  );
  if (secondary) {
    sanitized ||= secondary.sanitized;
    conditions.push(secondary.text);
  }
  const flair = parseFlair(r.flair_required);
  if (!flair.parsed)
    warn('flair_unparsed', 'flair_required', shortVal(r.flair_required ?? ''));
  const excerpt = cleanText(
    [
      `Imported from research CSV (segment ${segment}, checked ${r.checked_at ?? 'unknown'}).`,
      sourceUrl
        ? 'Secondary sources only — not verified first-hand; review the rules on Reddit before relying on them.'
        : 'Secondary sources only — the rules page was not read; add a snapshot from the first-hand rules page before review.',
      `Source note: ${sourceField || '—'}`,
      r.rules_source ? `Rules source: ${r.rules_source}` : '',
      r.size ? `Size: ${r.size}` : '',
      r.flair_required && !/^(true|false)$/i.test(r.flair_required.trim())
        ? `Flair: ${r.flair_required}`
        : '',
      `Conditions: ${r.conditions ?? '—'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    5000,
    'sourceExcerpt',
    warn,
    true,
  );
  if (!excerpt) return null;
  sanitized ||= excerpt.sanitized;
  const policy = (
    field: 'promotion_policy' | 'links_policy',
    list: readonly string[],
  ) => {
    const v = enumIn(list, r[field]);
    if (v === null && r[field] != null)
      warn('enum_default', field, `${shortVal(r[field] ?? '')} → unknown`);
    return v ?? 'unknown';
  };
  return {
    sanitized,
    rules: {
      sourceUrl,
      sourceExcerpt: excerpt.text,
      promotionPolicy: policy(
        'promotion_policy',
        REDDIT_PROMOTION_POLICIES,
      ) as RedditPromotionPolicy,
      linksPolicy: policy(
        'links_policy',
        REDDIT_LINKS_POLICIES,
      ) as RedditLinksPolicy,
      flairRequired: flair.value,
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
    warnings: [],
  };
  const warnFor =
    (kind: ImportWarning['kind'], ref: string): Warn =>
    (code, field, detail) =>
      plan.warnings.push({
        kind,
        ref,
        code,
        ...(field ? { field } : {}),
        ...(detail ? { detail } : {}),
      });
  for (const seg of segments)
    for (const file of ['communities', 'opportunities', 'keywords'] as const) {
      const cols = new Set(seg[file].flatMap((r) => Object.keys(r)));
      const dropped = [...cols].filter((c) => !USED_COLUMNS[file].includes(c));
      if (dropped.length)
        warnFor('file', `${seg.segment}: ${file}`)(
          'dropped_columns',
          undefined,
          dropped.join(', '),
        );
    }
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
        warnFor('rules', `${seg.segment}: r/${sub}`)(
          'merged',
          undefined,
          `rules from segment ${have.segments[0]}`,
        );
        continue;
      }
      const warn = warnFor('rules', `${seg.segment}: r/${sub}`);
      const rules = rulesOf(r, sub, seg.segment, o.now, warn);
      if (!rules) {
        plan.rejected.push({
          kind: 'rules',
          ref,
          segment: seg.segment,
          code: 'pii',
        });
        continue;
      }
      const desc = r.topic
        ? cleanText(
            r.topic,
            2000,
            'descriptionManual',
            warnFor('community', `${seg.segment}: r/${sub}`),
          )
        : null;
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
      const warn = warnFor('keyword', `${seg.segment}: ${t.text}`);
      if (t.clipped) warn('clipped', 'phrase', '≤ 200');
      const intent = enumIn(REDDIT_INTENTS, r.intent);
      if (intent === null && r.intent != null)
        warn('enum_default', 'intent', `${shortVal(r.intent)} → other`);
      const p = Number(r.priority);
      const priority = Number.isInteger(p) && p >= 1 && p <= 5 ? p : null;
      if (priority === null && r.priority != null)
        warn('enum_default', 'priority', `${shortVal(r.priority)} → 3`);
      plan.keywords.push({
        phraseNorm: norm,
        segment: seg.segment,
        body: {
          phrase: t.text,
          intent: intent ?? 'other',
          priority: priority ?? 3,
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
      if (threads.has(t.threadKey)) {
        reject('duplicate_in_csv');
        continue;
      }
      const warn = warnFor('opportunity', `${seg.segment}: ${ref}`);
      const title = r.title
        ? cleanText(r.title, 300, 'titleManual', warn)
        : null;
      if (!title) {
        reject(r.title ? 'pii' : 'required', 'title');
        continue;
      }
      const angleRaw = [
        r.context ?? '',
        r.found_via ? `Found via: ${r.found_via}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const angle = angleRaw ? cleanText(angleRaw, 1000, 'angle', warn) : null;
      if (angleRaw && !angle) warn('sanitized', 'angle', 'dropped');
      const why = parseWhy(r.why);
      const factors: RedditFactorsInput = {};
      let sanitized = title.sanitized || !!angle?.sanitized;
      for (const f of OPERATOR_FACTORS) {
        const value = score(r[f] ?? null);
        if (value === null) {
          if ((r[f] ?? null) !== null)
            warn('enum_default', f, `${shortVal(r[f]!)} → not set`);
          continue;
        }
        const w = cleanText(
          why[f] ?? `research CSV (${seg.segment}): no rationale given`,
          300,
          `factors.${f}.why`,
          warn,
        ) ?? {
          text: `research CSV (${seg.segment})`,
          sanitized: true,
          clipped: false,
        };
        sanitized ||= w.sanitized;
        factors[f] = { value, why: w.text };
      }
      const intent = enumIn(REDDIT_INTENTS, r.intent);
      if (intent === null && r.intent != null)
        warn('enum_default', 'intent', `${shortVal(r.intent)} → other`);
      threads.add(t.threadKey);
      plan.opportunities.push({
        threadKey: t.threadKey,
        subreddit: t.subreddit,
        segment: seg.segment,
        ref,
        communityInPlan: bySub.has(t.subreddit),
        body: {
          threadUrl: t.url,
          titleManual: title.text,
          intent: intent ?? 'other',
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
  patch(path: string, body: Record<string, unknown>): Promise<ImportResponse>;
}

export type ImportOutcome =
  'created' | 'exists' | 'would_create' | 'rejected' | 'not_attempted';

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
  /** false — часть строк не выполнялась (`not_attempted`), см. `stoppedBy`. */
  complete: boolean;
  /** Почему остановлено: дедлайн запроса или отказ создания проекта. */
  stoppedBy?: 'deadline' | 'project_rejected';
  items: ImportItemReport[];
  /** Сообщества и их гейт: сейчас (unreviewed) и после проверки владельцем. */
  blocks: Array<{
    subreddit: string;
    now: RedditPolicyReason[];
    afterReview: RedditPolicyReason[];
    /** false — первоисточника нет (`sourceUrl: null`): проверка — 400 `source_required`. */
    firstHandSource: boolean;
  }>;
  /** Что записано не дословно (очистка, обрезка, отброшенное). */
  warnings: ImportWarning[];
  summary: Record<string, Partial<Record<ImportOutcome, number>>>;
}

export interface RunImportOptions {
  /** Строк фазы одновременно (по умолчанию `IMPORT_CONCURRENCY`). */
  concurrency?: number;
  /** Момент (мс эпохи), после которого новые строки не начинаются. */
  deadlineAt?: number;
  /** Часы (тесты). */
  clock?: () => number;
}

/** Пул строк одной фазы импорта (Р-RD-AUD-4). */
export const IMPORT_CONCURRENCY = 4;

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
 * Пул: `fn` по элементам, не больше `n` одновременно; результат — по индексу
 * (порядок отчёта не зависит от порядка завершения). Первая ошибка
 * останавливает выдачу новых элементов; начатые дожидаются, затем ошибка
 * пробрасывается.
 */
async function pool<T, R>(
  xs: T[],
  n: number,
  fn: (x: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(xs.length);
  let next = 0;
  let failed: { e: unknown } | null = null;
  const worker = async () => {
    while (!failed && next < xs.length) {
      const i = next++;
      try {
        out[i] = await fn(xs[i], i);
      } catch (e) {
        failed ??= { e };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, n), xs.length) }, worker),
  );
  if (failed) throw (failed as { e: unknown }).e;
  return out;
}

interface CommunityRow {
  id: string;
  subreddit: string;
  projectId: string;
  topics?: string[];
  revision?: number;
  rules?: {
    snapshotId: string;
    reviewState: string;
    promotionPolicy: string;
    linksPolicy: string;
  } | null;
}

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
  opts: RunImportOptions = {},
): Promise<ImportReport> {
  const P = `/publisher/products/${productId}/reddit`;
  const conc = opts.concurrency ?? IMPORT_CONCURRENCY;
  const clock = opts.clock ?? Date.now;
  let stoppedBy: ImportReport['stoppedBy'];
  /** Пора остановиться: дедлайн прошёл (или уже остановлено). */
  const stop = (): boolean => {
    if (
      !stoppedBy &&
      opts.deadlineAt !== undefined &&
      clock() >= opts.deadlineAt
    )
      stoppedBy = 'deadline';
    return !!stoppedBy;
  };
  const skipped = (
    kind: ImportItemReport['kind'],
    ref: string,
  ): ImportItemReport => ({
    kind,
    ref,
    outcome: 'not_attempted',
    code: stoppedBy,
  });
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

  const send = async (
    method: 'post' | 'patch',
    kind: string,
    key: string[],
    path: string,
    body: Record<string, unknown>,
  ): Promise<{
    outcome: ImportOutcome;
    id?: string;
    code?: string;
    data?: unknown;
  }> => {
    const opKey = stableOpKey(
      'reddit-import',
      productId,
      kind,
      ...key,
      bodyHash(body),
    );
    let r: ImportResponse | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await http[method](path, { opKey, ...body });
      if (r.status !== 503) break;
    }
    const res = r!;
    if (res.status === 401 || res.status === 403)
      throw new ImportError(path, res);
    if (res.status === 200 || res.status === 201)
      return {
        outcome: 'created',
        id: (res.body?.data as { id?: string })?.id,
        data: res.body?.data,
      };
    const d = res.body?.error?.details;
    if (
      res.status === 409 &&
      d?.reason === 'duplicate' &&
      typeof d.existingId === 'string'
    )
      return { outcome: 'exists', id: d.existingId };
    // Тот же шаг с тем же телом уже выполнил другой актор (ключ — общий).
    if (
      res.status === 409 &&
      res.body?.error?.code === 'PUB_IDEMPOTENCY_REUSED'
    )
      return { outcome: 'exists', code: 'other_actor' };
    return { outcome: 'rejected', code: fieldCodes(res) };
  };
  const create = async (
    kind: ImportItemReport['kind'],
    key: string[],
    path: string,
    body: Record<string, unknown>,
  ): Promise<{ outcome: ImportOutcome; id?: string; code?: string }> => {
    if (!apply) return { outcome: 'would_create' };
    const { outcome, id, code } = await send('post', kind, key, path, body);
    return { outcome, ...(id ? { id } : {}), ...(code ? { code } : {}) };
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
  else if (stop()) add(skipped('project', plan.project.title));
  else {
    const r = await create('project', [plan.project.title], `${P}/projects`, {
      ...plan.project,
    });
    add({ kind: 'project', ref: plan.project.title, ...r });
    projectId = r.id;
    // Проект не создан — дальше писать некуда: остальное не выполнялось.
    if (apply && !projectId) stoppedBy = 'project_rejected';
  }

  // Сообщества (одно на продукт, Р-RD-2) и их правила — пулом.
  const communities = stop()
    ? []
    : await listAll<CommunityRow>(http, `${P}/communities`);
  const commId = new Map<string, string>();
  const communityRows = await pool(plan.communities, conc, async (c) => {
    const ref = `r/${c.subreddit}`;
    if (stop()) return [skipped('community', ref), skipped('rules', ref)];
    const out: ImportItemReport[] = [];
    const have = communities.find((x) => x.subreddit === c.subreddit);
    let id = have?.id;
    if (have && projectId && have.projectId !== projectId) {
      out.push({
        kind: 'community',
        ref,
        outcome: 'rejected',
        code: 'other_project',
        id: have.id,
      });
      return out;
    }
    if (have) {
      // Р-RD-AUD-2: сегменты этого импорта — в `topics` существующего.
      const topics = have.topics ?? [];
      const missing = c.segments.filter((s) => !topics.includes(s));
      const merged = [...topics, ...missing].slice(0, 20);
      const row: ImportItemReport = {
        kind: 'community',
        ref,
        outcome: 'exists',
        id,
      };
      if (missing.length && merged.length > topics.length) {
        row.detail = `topics +${missing.join(',')}`;
        if (!apply) row.code = 'topics_pending';
        else if (typeof have.revision !== 'number')
          row.code = 'topics_not_merged';
        else {
          const r = await send(
            'patch',
            'community-topics',
            [c.subreddit, String(have.revision)],
            `${P}/communities/${have.id}`,
            { expectedRevision: have.revision, topics: merged },
          );
          row.code =
            r.outcome === 'created' || r.code === 'other_actor'
              ? 'topics_merged'
              : `topics_not_merged:${r.code ?? r.outcome}`;
        }
      }
      out.push(row);
    } else if (!projectId)
      out.push({ kind: 'community', ref, outcome: 'would_create' });
    else {
      const r = await create('community', [c.subreddit], `${P}/communities`, {
        projectId,
        ...c.body,
      });
      out.push({ kind: 'community', ref, ...r });
      id = r.id;
    }
    if (id) commId.set(c.subreddit, id);
    // Снимок правил (Р-RD-AUD-2): текущий есть (любой проверки) — остаётся;
    // новый — только если текущего нет.
    const current = have?.rules ?? null;
    const keptRow = (cur: {
      snapshotId: string;
      reviewState: string;
      promotionPolicy: string;
      linksPolicy: string;
    }): ImportItemReport => {
      const diff = [
        cur.promotionPolicy !== c.rules.promotionPolicy
          ? `promotion ${cur.promotionPolicy}, csv ${c.rules.promotionPolicy}`
          : '',
        cur.linksPolicy !== c.rules.linksPolicy
          ? `links ${cur.linksPolicy}, csv ${c.rules.linksPolicy}`
          : '',
      ].filter(Boolean);
      return {
        kind: 'rules',
        ref,
        outcome: 'exists',
        id: cur.snapshotId,
        code: 'kept_current',
        detail: `${cur.reviewState}${diff.length ? `; differs: ${diff.join('; ')}` : ''}`,
      };
    };
    if (current) out.push(keptRow(current));
    else if (!id)
      out.push({
        kind: 'rules',
        ref,
        outcome: apply ? 'rejected' : 'would_create',
        ...(apply ? { code: 'community_missing' } : {}),
      });
    else if (!apply) out.push({ kind: 'rules', ref, outcome: 'would_create' });
    else {
      // Р-RD-AUD-9: сервер сам проверяет «текущего нет» под блокировкой
      // сообщества — параллельный импорт другого сегмента (вторая вкладка)
      // успел создать снимок → 200 `kept`, второго снимка нет.
      const r = await send(
        'post',
        'rules',
        [c.subreddit, 'none'],
        `${P}/communities/${id}/rules`,
        { ...c.rules, ifNoCurrent: true },
      );
      const v = r.data as
        | {
            id?: string;
            kept?: boolean;
            reviewState?: string;
            promotionPolicy?: string;
            linksPolicy?: string;
          }
        | undefined;
      if (r.outcome === 'created' && v?.kept === true && v.id)
        out.push(
          keptRow({
            snapshotId: v.id,
            reviewState: String(v.reviewState),
            promotionPolicy: String(v.promotionPolicy),
            linksPolicy: String(v.linksPolicy),
          }),
        );
      else
        out.push({
          kind: 'rules',
          ref,
          outcome: r.outcome,
          ...(r.id ? { id: r.id } : {}),
          ...(r.code ? { code: r.code } : {}),
        });
    }
    return out;
  });
  communityRows.forEach((rows) => rows.forEach(add));

  // Ключевые запросы — по нормальной форме в проекте.
  const keywords =
    projectId && !stop()
      ? await listAll<{ id: string; phraseNorm: string }>(
          http,
          `${P}/keywords`,
          { projectId },
        )
      : [];
  (
    await pool(plan.keywords, conc, async (k): Promise<ImportItemReport> => {
      const ref = k.body.phrase;
      if (stop()) return skipped('keyword', ref);
      const have = keywords.find((x) => x.phraseNorm === k.phraseNorm);
      if (have) return { kind: 'keyword', ref, outcome: 'exists', id: have.id };
      if (!projectId) return { kind: 'keyword', ref, outcome: 'would_create' };
      return {
        kind: 'keyword',
        ref,
        ...(await create('keyword', [k.phraseNorm], `${P}/keywords`, {
          projectId,
          ...k.body,
        })),
      };
    })
  ).forEach(add);

  // Возможности — по ключу треда в проекте; сообщество — из плана или уже
  // заведённое в продукте (того же проекта, аудит imp-6).
  const opps =
    projectId && !stop()
      ? await listAll<{ id: string; threadKey: string }>(
          http,
          `${P}/opportunities`,
          { projectId },
        )
      : [];
  (
    await pool(
      plan.opportunities,
      conc,
      async (o): Promise<ImportItemReport> => {
        const ref = `${o.segment}: ${o.ref}`;
        if (stop()) return skipped('opportunity', ref);
        const have = opps.find((x) => x.threadKey === o.threadKey);
        if (have)
          return { kind: 'opportunity', ref, outcome: 'exists', id: have.id };
        const known = communities.find((x) => x.subreddit === o.subreddit);
        const cid =
          commId.get(o.subreddit) ??
          (known && (!projectId || known.projectId === projectId)
            ? known.id
            : undefined);
        if (!o.communityInPlan && !cid)
          return {
            kind: 'opportunity',
            ref,
            outcome: 'rejected',
            code: known ? 'other_project' : 'community_missing',
            detail: `r/${o.subreddit}`,
          };
        if (!projectId || !cid)
          return {
            kind: 'opportunity',
            ref,
            outcome: apply ? 'rejected' : 'would_create',
            ...(apply ? { code: 'community_missing' } : {}),
          };
        return {
          kind: 'opportunity',
          ref,
          ...(await create('opportunity', [o.threadKey], `${P}/opportunities`, {
            projectId,
            communityId: cid,
            ...o.body,
          })),
        };
      },
    )
  ).forEach(add);

  return reportOf(apply, productId, plan, items, stoppedBy);
}

function reportOf(
  apply: boolean,
  productId: string,
  plan: ImportPlan,
  items: ImportItemReport[],
  stoppedBy?: ImportReport['stoppedBy'],
): ImportReport {
  const summary: ImportReport['summary'] = {};
  for (const it of items) {
    const s = (summary[it.kind] ??= {});
    s[it.outcome] = (s[it.outcome] ?? 0) + 1;
  }
  const complete = !items.some((i) => i.outcome === 'not_attempted');
  return {
    apply,
    productId,
    complete,
    ...(stoppedBy && !complete ? { stoppedBy } : {}),
    items,
    blocks: plan.communities.map((c) => ({
      subreddit: c.subreddit,
      now: c.gate.now,
      afterReview: c.gate.afterReview,
      firstHandSource: c.rules.sourceUrl !== null,
    })),
    warnings: plan.warnings,
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
    ...plan.opportunities.map((o): ImportItemReport =>
      o.communityInPlan
        ? {
            kind: 'opportunity',
            ref: `${o.segment}: ${o.ref}`,
            outcome: 'would_create',
          }
        : {
            // Без сервера сообщества продукта неизвестны.
            kind: 'opportunity',
            ref: `${o.segment}: ${o.ref}`,
            outcome: 'rejected',
            code: 'community_missing',
            detail: `r/${o.subreddit}`,
          },
    ),
  ];
  return reportOf(false, '(offline)', plan, items);
}
