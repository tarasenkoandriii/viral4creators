/**
 * AI Publisher (P-R, Reddit Manual MVP, M1) — чистые функции экранов
 * раздела «Reddit» (проверяет `scripts/publisher-reddit-view.test.ts` без
 * React):
 *  - словарь `publisher-reddit-*` по языку;
 *  - нормализация `r/name` и URL треда — зеркало `reddit/normalize.ts`
 *    сервера (подсказка до отправки; решает сервер, тест сверяет
 *    результаты на общем наборе входов);
 *  - тела мутаций из полей форм (лишнего не шлём, обязательное — есть);
 *  - факторы score: значение 0..100 или «не оценено» (не 0), `why` при
 *    значении, `policy_risk` не вводится;
 *  - доступные переходы возможности — как машина сервера (Р-RD-23);
 *  - тона: зелёный только у «можно»/«подтверждён»/«подходит»;
 *  - ошибки P-R человеческим текстом (409 `policy_block` с причинами,
 *    дубль с `existingId`).
 */
import type { Locale } from '../../kit';
import { pubRedditEn } from '../../i18n/publisher-reddit-en';
import {
  pubRedditRu,
  type PublisherRedditDict,
} from '../../i18n/publisher-reddit-ru';
import { pubRedditUk } from '../../i18n/publisher-reddit-uk';
import type { PublisherDict } from '../../i18n/publisher-ru';
import { ApiError } from '../../kit';
import { fieldIssues } from './common-api';
import { describePubError, type PubErrorView } from './errors';
import { selfReviewOf } from './permissions';
import {
  REDDIT_OPERATOR_FACTORS,
  REDDIT_POLICY_REASONS,
  type CreateRedditCommunityIn,
  type CreateRedditKeywordIn,
  type CreateRedditOpportunityIn,
  type CreateRedditProjectIn,
  type CreateRedditRulesIn,
  type PatchRedditCommunityIn,
  type PatchRedditKeywordIn,
  type PatchRedditOpportunityIn,
  type PatchRedditProjectIn,
  type RedditCommunityView,
  type RedditFactors,
  type RedditFactorsInput,
  type RedditIntent,
  type RedditKeywordView,
  type RedditLinksPolicy,
  type RedditOperatorFactor,
  type RedditOpportunityStatus,
  type RedditOpportunityView,
  type RedditPolicyReason,
  type RedditPolicyVerdict,
  type RedditProjectView,
  type RedditPromotionPolicy,
  type RedditRuleSnapshotView,
  type RedditSnapshotState,
  type RedditTransition,
} from './reddit-api';
import { fmtText, type Tone } from './view';

export type { PublisherRedditDict };

const DICTS: Record<Locale, PublisherRedditDict> = {
  uk: pubRedditUk,
  ru: pubRedditRu,
  en: pubRedditEn,
};

export function getRedditDict(locale: Locale): PublisherRedditDict {
  return DICTS[locale];
}

const len = (s: string) => [...s].length;

// ── Нормализация (зеркало sites-backend reddit/normalize.ts) ──────────────

export const SUBREDDIT_RE = /^[a-z0-9_]{2,21}$/;
const THREAD_KEY_RE = /^[a-z0-9]{1,13}$/;
const SLUG_RE = /^[^/?#\s]{1,300}$/;
const REDDIT_INPUT_HOSTS = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'sh.reddit.com',
];
export const REDDIT_ORIGIN = 'https://www.reddit.com';

function parseRedditUrl(input: string): URL | null {
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw)) {
    return null;
  }
  let u: URL;
  try {
    u = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return REDDIT_INPUT_HOSTS.includes(host) ? u : null;
}

const pathParts = (u: URL) => u.pathname.split('/').filter((x) => x !== '');

/** Сообщество-профиль `r/u_<ник>` (сервер: `PROFILE_SUBREDDIT_RE`, Р-RD-36). */
const PROFILE_SUBREDDIT_RE = /^u_/;

/** Имя по форме сообщества (без проверки `u_*`). */
function subredditCandidate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (raw === '' || raw.length > 300) return null;
  let name: string | null = null;
  if (/reddit\.com/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    const u = parseRedditUrl(raw);
    if (!u) return null;
    const parts = pathParts(u);
    if (parts.length < 2 || parts[0].toLowerCase() !== 'r') return null;
    name = parts[1];
  } else {
    const m = /^\/?r\/([^/\s]+)\/?$/i.exec(raw) ?? /^([^/\s]+)$/.exec(raw);
    name = m ? m[1] : null;
  }
  if (name === null) return null;
  const n = name.toLowerCase();
  return SUBREDDIT_RE.test(n) ? n : null;
}

/** `r/Name`, `/r/name`, `name` или URL сообщества → `name`; иначе null. */
export function normalizeSubreddit(input: unknown): string | null {
  const n = subredditCandidate(input);
  return n !== null && !PROFILE_SUBREDDIT_RE.test(n) ? n : null;
}

/** Код поля, как у сервера: `format` | `profile_ref` (`r/u_<ник>`) | null. */
export function subredditIssue(
  input: unknown
): 'format' | 'profile_ref' | null {
  const n = subredditCandidate(input);
  if (n === null) return 'format';
  return PROFILE_SUBREDDIT_RE.test(n) ? 'profile_ref' : null;
}

export interface NormalizedThread {
  url: string;
  subreddit: string;
  threadKey: string;
}

function threadCandidate(input: unknown): NormalizedThread | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  const u = parseRedditUrl(input);
  if (!u) return null;
  const parts = pathParts(u);
  if (parts.length < 4) return null;
  if (parts[0].toLowerCase() !== 'r' || parts[2].toLowerCase() !== 'comments')
    return null;
  const subreddit = parts[1].toLowerCase();
  const threadKey = parts[3].toLowerCase();
  if (!SUBREDDIT_RE.test(subreddit) || !THREAD_KEY_RE.test(threadKey))
    return null;
  let slug: string | null = null;
  if (parts.length >= 5) {
    const s = parts[4].toLowerCase();
    if (!SLUG_RE.test(s)) return null;
    slug = s;
  }
  const url = `${REDDIT_ORIGIN}/r/${subreddit}/comments/${threadKey}${slug ? `/${slug}` : ''}`;
  return { url, subreddit, threadKey };
}

/** URL треда → канон (без `/`, query, fragment); иначе null (и `r/u_*`). */
export function normalizeThreadUrl(input: unknown): NormalizedThread | null {
  const t = threadCandidate(input);
  return t && !PROFILE_SUBREDDIT_RE.test(t.subreddit) ? t : null;
}

/** Код поля URL треда, как у сервера. */
export function threadUrlIssue(
  input: unknown
): 'format' | 'profile_ref' | null {
  const t = threadCandidate(input);
  if (t === null) return 'format';
  return PROFILE_SUBREDDIT_RE.test(t.subreddit) ? 'profile_ref' : null;
}

/**
 * `href` ссылки «Открыть на Reddit»: только сохранённый канонический
 * `https://www.reddit.com/r/…` (никаких `javascript:`, чужих хостов).
 */
export function redditHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== 'www.reddit.com') return null;
    if (u.username || u.password || u.port) return null;
    return /^\/r\/[a-z0-9_]{2,21}(\/|$)/.test(u.pathname) ? u.href : null;
  } catch {
    return null;
  }
}

/** `href` ссылки на первоисточник правил: только https. */
export function httpsHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'https:' && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}

// ── Тона (никакого зелёного при неизвестном) ──────────────────────────────

export function verdictTone(v: RedditPolicyVerdict | null | undefined): Tone {
  if (v === 'ok') return 'success';
  if (v === 'block') return 'danger';
  return 'warning';
}

/**
 * Тон состояния снимка: зелёный только у подтверждённого с живым
 * первоисточником; отозванный первоисточник (`rules_source_revoked`) — красный.
 */
export function snapshotStateTone(
  s: RedditSnapshotState | null | undefined,
  gateReasons: readonly string[] = [],
  sourceUsage?: string
): Tone {
  if (sourceUsage === 'revoked' || gateReasons.includes('rules_source_revoked'))
    return 'danger';
  if (s === 'reviewed') return 'success';
  return 'warning';
}

/** Исторический вердикт («на момент оценки») — без зелёного. */
export function historicVerdictTone(v: RedditPolicyVerdict): Tone {
  return v === 'block' ? 'danger' : 'neutral';
}

export function opportunityTone(s: RedditOpportunityStatus): Tone {
  switch (s) {
    case 'qualified':
      return 'success';
    case 'in_brief':
      return 'accent';
    case 'blocked':
      return 'danger';
    case 'recheck_required':
      return 'warning';
    default:
      return 'neutral';
  }
}

// ── Переходы возможности (машина Р-RD-23; решает сервер) ─────────────────

export interface OpportunityActions {
  /** `qualified`, но гейт СЕЙЧАС не `ok`: подсветка, нужен пересчёт. */
  stale: boolean;
  qualify: boolean;
  skip: boolean;
  archive: boolean;
  edit: boolean;
  rescore: boolean;
}

export function opportunityActions(
  o: Pick<RedditOpportunityView, 'status' | 'policyNow'>
): OpportunityActions {
  const live = o.status !== 'archived';
  const stale = o.status === 'qualified' && o.policyNow !== 'ok';
  return {
    stale,
    // Сервер решает по ТЕКУЩЕМУ снимку — подсказка по `policyNow`.
    qualify: o.status === 'new' && o.policyNow === 'ok',
    // «Устаревший» отбор: подсветка и пересчёт; skip/archive сервер разрешает
    // (иначе тупик при архивном сообществе — UI-аудит S3-4).
    skip: ['new', 'qualified', 'recheck_required', 'blocked'].includes(
      o.status
    ),
    archive: live,
    edit: live,
    rescore: live,
  };
}

export function transitionBody(
  o: Pick<RedditOpportunityView, 'revision'>,
  reason: string
): { expectedRevision: number; reason?: string } {
  const r = reason.trim();
  return { expectedRevision: o.revision, ...(r ? { reason: r } : {}) };
}

/** Фильтр «нужно пересчитать»: отобранные, у которых гейт сейчас не `ok`. */
export const NEED_RESCORE = [
  { status: 'qualified', policyNow: 'recheck_required' },
  { status: 'qualified', policyNow: 'block' },
] as const;

/**
 * Коды обоснования `policy_risk` словами: `rules_missing` — как причина
 * гейта; `promotion_<p>`/`links_<p>` — «Продвижение: …», «Ссылки: …».
 * Незнакомый код — как есть (декодер их и не пропустит).
 */
export function policyRiskText(
  reasons: readonly string[] | undefined,
  r: PublisherRedditDict
): string[] {
  return (reasons ?? []).map((c) => {
    if (c === 'rules_missing') return r.gate.reasons.rules_missing;
    const pm = /^promotion_(.+)$/.exec(c);
    if (pm && Object.prototype.hasOwnProperty.call(r.rules.promotion, pm[1]))
      return `${r.rules.fields.promotionPolicy}: ${
        r.rules.promotion[pm[1] as RedditPromotionPolicy]
      }`;
    const lm = /^links_(.+)$/.exec(c);
    if (lm && Object.prototype.hasOwnProperty.call(r.rules.links, lm[1]))
      return `${r.rules.fields.linksPolicy}: ${
        r.rules.links[lm[1] as RedditLinksPolicy]
      }`;
    return c;
  });
}

// ── Выдержка возможности (PATCH `excerpt`) ────────────────────────────────

/** Правка выдержки: не у архивной и не у отозванной (409 `revoked`). */
export function excerptEditable(
  o: Pick<RedditOpportunityView, 'status' | 'excerpt'>
): boolean {
  return o.status !== 'archived' && o.excerpt?.usage !== 'revoked';
}

/**
 * Тело правки выдержки: текст — новая редакция; пусто при существующей —
 * `null` (отвязать); без изменений, > 2000 или пусто без выдержки — null.
 */
export function excerptPatchBody(
  o: Pick<RedditOpportunityView, 'revision' | 'excerpt'>,
  text: string,
  baseText: string = o.excerpt?.text ?? ''
): { expectedRevision: number; excerpt: string | null } | null {
  const t = text.trim();
  if (len(t) > 2000) return null;
  // Только если пользователь изменил текст относительно исходного (S2-1).
  if (t === baseText.trim()) return null;
  if (!t)
    return o.excerpt ? { expectedRevision: o.revision, excerpt: null } : null;
  return { expectedRevision: o.revision, excerpt: t };
}

// ── Факторы ───────────────────────────────────────────────────────────────

export type FactorForm = Record<
  RedditOperatorFactor,
  { value: string; why: string }
>;

export function factorForm(f?: RedditFactors | null): FactorForm {
  const out = {} as FactorForm;
  for (const k of REDDIT_OPERATOR_FACTORS) {
    const v = f?.[k];
    out[k] = {
      value: v && v.value !== null ? String(v.value) : '',
      why: v?.why ?? '',
    };
  }
  return out;
}

/** «» → null (не оценено, не 0); целое 0..100; иное — `undefined`. */
export function parseFactorValue(raw: string): number | null | undefined {
  const s = raw.trim();
  if (s === '') return null;
  if (!/^\d{1,3}$/.test(s)) return undefined;
  const n = Number(s);
  return n <= 100 ? n : undefined;
}

export interface FactorIssue {
  factor: RedditOperatorFactor;
  code: 'value' | 'why' | 'whyLength';
}

/**
 * Тело факторов. Без `base` (создание) — только заданные; с `base`
 * (правка) — только факторы, изменённые относительно ИСХОДНОГО снимка
 * формы (а не свежего ответа сервера: чужая параллельная правка не
 * затирается — UI-аудит S2-1); очистка → `{value:null, why:null}`.
 */
export function factorsBody(
  form: FactorForm,
  base?: FactorForm | null
): { body: RedditFactorsInput; issues: FactorIssue[] } {
  const body: RedditFactorsInput = {};
  const issues: FactorIssue[] = [];
  for (const k of REDDIT_OPERATOR_FACTORS) {
    const value = parseFactorValue(form[k].value);
    const why = form[k].why.trim();
    if (value === undefined) {
      issues.push({ factor: k, code: 'value' });
      continue;
    }
    if (len(why) > 300) {
      issues.push({ factor: k, code: 'whyLength' });
      continue;
    }
    if (value !== null && !why) {
      issues.push({ factor: k, code: 'why' });
      continue;
    }
    const whyOut = why || null;
    if (base) {
      if (sameFactor(base[k], form[k])) continue;
      body[k] = { value, why: whyOut };
    } else if (value !== null || whyOut) {
      body[k] = { value, why: whyOut };
    }
  }
  return { body, issues };
}

function sameFactor(
  a: { value: string; why: string },
  b: { value: string; why: string }
): boolean {
  return a.value.trim() === b.value.trim() && a.why.trim() === b.why.trim();
}

// ── Формы правки: «только изменённые поля» и перебазирование после 409 ────

/** Значение поля формы для сравнения (строки — без краевых пробелов). */
function norm(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  if (v && typeof v === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([k, x]) => [
          k,
          norm(x),
        ])
      )
    );
  return JSON.stringify(v ?? null);
}

export const sameField = (a: unknown, b: unknown) => norm(a) === norm(b);

/** Поля, изменённые пользователем относительно исходного снимка формы. */
export function changedKeys<F extends object>(base: F, mine: F): (keyof F)[] {
  return (Object.keys(base) as (keyof F)[]).filter(
    (k) => !sameField(base[k], mine[k])
  );
}

export interface FieldConflict<F> {
  key: keyof F;
  mine: F[keyof F];
  theirs: F[keyof F];
}

/**
 * Перебазирование формы на свежее состояние сервера (после 409 и
 * «Перезавантажити» или после своего сохранения): нетронутые поля берут
 * свежие значения; изменённые пользователем остаются; если поле изменили
 * и пользователь, и сервер (по-разному) — конфликт, его показывают явно.
 */
export function rebaseForm<F extends object>(
  base: F,
  mine: F,
  fresh: F
): { mine: F; conflicts: FieldConflict<F>[] } {
  const out = { ...mine };
  const conflicts: FieldConflict<F>[] = [];
  for (const k of Object.keys(base) as (keyof F)[]) {
    const touched = !sameField(base[k], mine[k]);
    if (!touched) {
      out[k] = fresh[k];
      continue;
    }
    const serverChanged = !sameField(base[k], fresh[k]);
    if (serverChanged && !sameField(mine[k], fresh[k]))
      conflicts.push({ key: k, mine: mine[k], theirs: fresh[k] });
  }
  return { mine: out, conflicts };
}

// ── Проекты ───────────────────────────────────────────────────────────────

export const BCP47_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
const localeOk = (s: string) => len(s) <= 16 && BCP47_RE.test(s);

export interface ProjectForm {
  title: string;
  locale: string;
  market: string;
}

export function projectForm(p?: RedditProjectView | null): ProjectForm {
  return {
    title: p?.title ?? '',
    locale: p?.locale ?? '',
    market: p?.market ?? '',
  };
}

export function projectBody(f: ProjectForm): CreateRedditProjectIn | null {
  const title = f.title.trim();
  const locale = f.locale.trim();
  const market = f.market.trim();
  if (!title || len(title) > 120) return null;
  if (!localeOk(locale)) return null;
  if (!market || len(market) > 64) return null;
  return { title, locale, market };
}

/** Правка проекта: только поля, изменённые относительно `base` формы. */
export function projectPatchBody(
  p: Pick<RedditProjectView, 'revision'> & Partial<RedditProjectView>,
  f: ProjectForm,
  base: ProjectForm = projectForm(p as RedditProjectView)
): PatchRedditProjectIn | null {
  const full = projectBody(f);
  if (!full) return null;
  const out: PatchRedditProjectIn = { expectedRevision: p.revision };
  for (const k of changedKeys(base, f)) out[k] = full[k];
  return Object.keys(out).length > 1 ? out : null;
}

// ── Сообщества ────────────────────────────────────────────────────────────

/** «a, b ,, c» → ['a','b','c']; > 20 тем или тема > 64 — null. */
export function topicsOf(raw: string): string[] | null {
  const xs = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (xs.length > 20 || xs.some((x) => len(x) > 64)) return null;
  return xs;
}

export interface CommunityForm {
  community: string;
  descriptionManual: string;
  language: string;
  topics: string;
}

export function communityForm(c?: RedditCommunityView | null): CommunityForm {
  return {
    community: c ? `r/${c.subreddit}` : '',
    descriptionManual: c?.descriptionManual ?? '',
    language: c?.language ?? '',
    topics: c ? c.topics.join(', ') : '',
  };
}

export function communityBody(
  projectId: string,
  f: CommunityForm
): CreateRedditCommunityIn | null {
  if (!projectId || !normalizeSubreddit(f.community)) return null;
  const d = f.descriptionManual.trim();
  const lang = f.language.trim();
  const topics = topicsOf(f.topics);
  if (len(d) > 2000 || (lang && !localeOk(lang)) || topics === null)
    return null;
  return {
    projectId,
    community: f.community.trim(),
    ...(d ? { descriptionManual: d } : {}),
    ...(lang ? { language: lang } : {}),
    ...(topics.length ? { topics } : {}),
  };
}

/** Правка сообщества: только поля, изменённые относительно `base` формы. */
export function communityPatchBody(
  c: RedditCommunityView,
  f: CommunityForm,
  base: CommunityForm = communityForm(c)
): PatchRedditCommunityIn | null {
  const d = f.descriptionManual.trim();
  const lang = f.language.trim();
  const topics = topicsOf(f.topics);
  if (len(d) > 2000 || (lang && !localeOk(lang)) || topics === null)
    return null;
  const out: PatchRedditCommunityIn = { expectedRevision: c.revision };
  const ch = changedKeys(base, f);
  if (ch.includes('descriptionManual')) out.descriptionManual = d || null;
  if (ch.includes('language')) out.language = lang || null;
  if (ch.includes('topics')) out.topics = topics;
  return Object.keys(out).length > 1 ? out : null;
}

// ── Правила ───────────────────────────────────────────────────────────────

export type Flair = 'yes' | 'no' | 'unknown';

export interface RulesForm {
  sourceUrl: string;
  sourceExcerpt: string;
  promotionPolicy: RedditPromotionPolicy | '';
  linksPolicy: RedditLinksPolicy | '';
  flair: Flair;
  conditions: string;
  /** `datetime-local` (время браузера). */
  checkedAt: string;
}

export const emptyRulesForm = (): RulesForm => ({
  sourceUrl: '',
  sourceExcerpt: '',
  promotionPolicy: '',
  linksPolicy: '',
  flair: 'unknown',
  conditions: '',
  checkedAt: '',
});

export type RulesIssue =
  'url' | 'excerpt' | 'policy' | 'date' | 'future' | 'conditions';

export function rulesBody(
  f: RulesForm,
  now: Date = new Date()
): { body: CreateRedditRulesIn | null; issues: RulesIssue[] } {
  const issues: RulesIssue[] = [];
  const url = f.sourceUrl.trim();
  if (!httpsHref(url) || len(url) > 2048) issues.push('url');
  const excerpt = f.sourceExcerpt.trim();
  if (!excerpt || len(excerpt) > 5000) issues.push('excerpt');
  if (!f.promotionPolicy || !f.linksPolicy) issues.push('policy');
  const t = f.checkedAt ? Date.parse(f.checkedAt) : NaN;
  if (!Number.isFinite(t)) issues.push('date');
  else if (t > now.getTime() + 60_000) issues.push('future');
  const conditions = f.conditions
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  if (conditions.length > 20 || conditions.some((c) => len(c) > 300))
    issues.push('conditions');
  if (issues.length || !f.promotionPolicy || !f.linksPolicy) {
    return { body: null, issues };
  }
  return {
    body: {
      sourceUrl: url,
      sourceExcerpt: excerpt,
      promotionPolicy: f.promotionPolicy,
      linksPolicy: f.linksPolicy,
      flairRequired: f.flair === 'unknown' ? null : f.flair === 'yes',
      ...(conditions.length ? { conditions } : {}),
      checkedAt: new Date(t).toISOString(),
    },
    issues,
  };
}

export const flairOf = (v: boolean | null): Flair =>
  v === null ? 'unknown' : v ? 'yes' : 'no';

/** Кнопка «Подтвердить проверку»: только текущий неподтверждённый снимок. */
export function canReviewSnapshot(
  s: Pick<RedditRuleSnapshotView, 'status' | 'reviewState'>
): boolean {
  return s.status === 'current' && s.reviewState === 'unreviewed';
}

/** Подтверждает автор снимка — сервер пометит `selfReview`. */
export function isOwnSnapshot(
  s: Pick<RedditRuleSnapshotView, 'createdBy'>,
  memberId: string
): boolean {
  return selfReviewOf('reddit.rules.review', s.createdBy, memberId);
}

// ── Возможности ───────────────────────────────────────────────────────────

export interface OpportunityForm {
  communityId: string;
  threadUrl: string;
  titleManual: string;
  excerpt: string;
  intent: RedditIntent | '';
  angle: string;
  keywordIds: string[];
  factors: FactorForm;
}

export const emptyOpportunityForm = (communityId = ''): OpportunityForm => ({
  communityId,
  threadUrl: '',
  titleManual: '',
  excerpt: '',
  intent: '',
  angle: '',
  keywordIds: [],
  factors: factorForm(null),
});

export type OpportunityIssue =
  | 'community'
  | 'thread'
  | 'mismatch'
  | 'title'
  | 'excerpt'
  | 'intent'
  | 'angle'
  | 'keywords'
  | 'factors';

/** Сообщество треда по ссылке и выбранное — для подсказки A15. */
export function threadMismatch(
  threadUrl: string,
  community: Pick<RedditCommunityView, 'subreddit'> | null | undefined
): { url: string; picked: string } | null {
  const t = normalizeThreadUrl(threadUrl);
  if (!t || !community || t.subreddit === community.subreddit) return null;
  return { url: t.subreddit, picked: community.subreddit };
}

export function opportunityBody(
  projectId: string,
  f: OpportunityForm,
  community: Pick<RedditCommunityView, 'id' | 'subreddit'> | null | undefined
): {
  body: CreateRedditOpportunityIn | null;
  issues: OpportunityIssue[];
  factorIssues: FactorIssue[];
} {
  const issues: OpportunityIssue[] = [];
  if (!projectId || !community || community.id !== f.communityId)
    issues.push('community');
  const thread = normalizeThreadUrl(f.threadUrl);
  if (!thread) issues.push('thread');
  else if (community && thread.subreddit !== community.subreddit)
    issues.push('mismatch');
  const title = f.titleManual.trim();
  if (!title || len(title) > 300) issues.push('title');
  const excerpt = f.excerpt.trim();
  if (len(excerpt) > 2000) issues.push('excerpt');
  if (!f.intent) issues.push('intent');
  const angle = f.angle.trim();
  if (len(angle) > 1000) issues.push('angle');
  if (f.keywordIds.length > 10) issues.push('keywords');
  const fx = factorsBody(f.factors);
  if (fx.issues.length) issues.push('factors');
  if (issues.length || !f.intent) {
    return { body: null, issues, factorIssues: fx.issues };
  }
  return {
    body: {
      projectId,
      communityId: f.communityId,
      threadUrl: f.threadUrl.trim(),
      titleManual: title,
      ...(excerpt ? { excerpt } : {}),
      intent: f.intent,
      ...(angle ? { angle } : {}),
      ...(f.keywordIds.length ? { keywordIds: [...f.keywordIds] } : {}),
      ...(Object.keys(fx.body).length ? { factors: fx.body } : {}),
    },
    issues,
    factorIssues: [],
  };
}

export interface OpportunityEditForm {
  titleManual: string;
  intent: RedditIntent;
  angle: string;
  keywordIds: string[];
}

export function opportunityEditForm(
  o: Pick<
    RedditOpportunityView,
    'titleManual' | 'intent' | 'angle' | 'keywordIds'
  >
): OpportunityEditForm {
  return {
    titleManual: o.titleManual,
    intent: o.intent,
    angle: o.angle ?? '',
    keywordIds: [...o.keywordIds],
  };
}

/** Правка возможности: только поля, изменённые относительно `base` формы. */
export function opportunityPatchBody(
  o: RedditOpportunityView,
  f: OpportunityEditForm,
  base: OpportunityEditForm = opportunityEditForm(o)
): PatchRedditOpportunityIn | null {
  const title = f.titleManual.trim();
  const angle = f.angle.trim();
  if (!title || len(title) > 300 || len(angle) > 1000) return null;
  if (f.keywordIds.length > 10) return null;
  const out: PatchRedditOpportunityIn = { expectedRevision: o.revision };
  const ch = changedKeys(base, f);
  if (ch.includes('titleManual')) out.titleManual = title;
  if (ch.includes('intent')) out.intent = f.intent;
  if (ch.includes('angle')) out.angle = angle || null;
  if (ch.includes('keywordIds')) out.keywordIds = [...f.keywordIds];
  return Object.keys(out).length > 1 ? out : null;
}

// ── Запросы ───────────────────────────────────────────────────────────────

export interface KeywordForm {
  phrase: string;
  intent: RedditIntent | '';
  locale: string;
  priority: string;
}

export const emptyKeywordForm = (): KeywordForm => ({
  phrase: '',
  intent: '',
  locale: '',
  priority: '3',
});

export function keywordBody(
  projectId: string,
  f: KeywordForm
): CreateRedditKeywordIn | null {
  const phrase = f.phrase.trim();
  const locale = f.locale.trim();
  const priority = Number(f.priority);
  if (!projectId || !phrase || len(phrase) > 200 || !f.intent) return null;
  if (locale && !localeOk(locale)) return null;
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) return null;
  return {
    projectId,
    phrase,
    intent: f.intent,
    ...(locale ? { locale } : {}),
    priority,
  };
}

export function keywordForm(k: RedditKeywordView): KeywordForm {
  return {
    phrase: k.phrase,
    intent: k.intent,
    locale: k.locale ?? '',
    priority: String(k.priority),
  };
}

/** Правка запроса: только поля, изменённые относительно `base` формы. */
export function keywordPatchBody(
  k: RedditKeywordView,
  f: KeywordForm,
  base: KeywordForm = keywordForm(k)
): PatchRedditKeywordIn | null {
  const full = keywordBody(k.projectId, f);
  if (!full) return null;
  const out: PatchRedditKeywordIn = { expectedRevision: k.revision };
  const ch = changedKeys(base, f);
  if (ch.includes('phrase')) out.phrase = full.phrase;
  if (ch.includes('intent')) out.intent = full.intent;
  if (ch.includes('locale')) out.locale = full.locale ?? null;
  if (ch.includes('priority')) out.priority = full.priority;
  return Object.keys(out).length > 1 ? out : null;
}

// ── Подписи полей для 400 `PUB_VALIDATION` (UI-аудит S3-3) ────────────────

/** Имя поля API → подпись формы; неизвестное — «поле форми». */
export function fieldLabel(field: string, r: PublisherRedditDict): string {
  const f = field.trim();
  const fm = /^factors\.([a-z_]+)(?:\.(value|why))?$/.exec(f);
  if (
    fm &&
    Object.prototype.hasOwnProperty.call(r.opportunities.factors, fm[1])
  ) {
    const name =
      r.opportunities.factors[fm[1] as keyof typeof r.opportunities.factors];
    if (fm[2] === 'why') return `${name}: ${r.opportunities.why}`;
    if (fm[2] === 'value') return `${name}: ${r.opportunities.value}`;
    return name;
  }
  const lm = /^(conditions|topics|keywordIds)\.(\d+)$/.exec(f);
  if (lm)
    return `${fieldLabel(lm[1], r)}, ${fmtText(r.common.line, { n: Number(lm[2]) + 1 })}`;
  const map: Record<string, string> = {
    title: r.projects.fields.title,
    locale: r.projects.fields.locale,
    market: r.projects.fields.market,
    community: r.communities.fields.community,
    descriptionManual: r.communities.fields.descriptionManual,
    language: r.communities.fields.language,
    topics: r.communities.fields.topics,
    sourceUrl: r.rules.fields.sourceUrl,
    sourceExcerpt: r.rules.fields.sourceExcerpt,
    promotionPolicy: r.rules.fields.promotionPolicy,
    linksPolicy: r.rules.fields.linksPolicy,
    flairRequired: r.rules.fields.flairRequired,
    conditions: r.rules.fields.conditions,
    checkedAt: r.rules.fields.checkedAt,
    communityId: r.opportunities.fields.community,
    projectId: r.common.project,
    threadUrl: r.opportunities.fields.threadUrl,
    titleManual: r.opportunities.fields.titleManual,
    excerpt: r.opportunities.fields.excerpt,
    intent: r.opportunities.fields.intent,
    angle: r.opportunities.fields.angle,
    keywordIds: r.opportunities.fields.keywords,
    factors: r.opportunities.factorsTitle,
    phrase: r.keywords.fields.phrase,
    priority: r.keywords.fields.priority,
    reason: r.common.reason,
    status: r.common.status,
    policyNow: r.opportunities.policyFilter,
    q: r.common.search,
  };
  return Object.prototype.hasOwnProperty.call(map, f)
    ? map[f]
    : r.common.formField;
}

// ── Ошибки P-R ────────────────────────────────────────────────────────────

export interface RedditErrorView extends PubErrorView {
  /** 409 дубль: id существующей записи (ссылка «открыть»). */
  existingId: string | null;
}

const reasonList = (v: unknown): RedditPolicyReason[] =>
  Array.isArray(v)
    ? v.filter((x): x is RedditPolicyReason =>
        (REDDIT_POLICY_REASONS as readonly string[]).includes(String(x))
      )
    : [];

/**
 * Ошибка сервера → строки: общий разбор `describePubError` и поверх —
 * причины P-R словами (сырые коды `policy_block`/`rules_unreviewed` не
 * показываются).
 */
export function describeRedditError(
  e: unknown,
  t: PublisherDict,
  r: PublisherRedditDict,
  statusLabels: Record<string, string> = {}
): RedditErrorView {
  const base = describePubError(e, t);
  const d =
    e instanceof ApiError ? ((e.details ?? {}) as Record<string, unknown>) : {};
  const reason = typeof d.reason === 'string' ? d.reason : '';
  let lines = base.lines;
  let existingId: string | null = null;
  const generic = fmtText(t.errors.reasons, { reason });
  if (base.code === 'PUB_TRANSITION_INVALID') {
    const tr = r.errors.transition as Record<string, string>;
    if (Object.prototype.hasOwnProperty.call(tr, reason)) {
      const reasons = reasonList(d.reasons)
        .map((x) => r.gate.reasons[x])
        .join('; ');
      const from = typeof d.from === 'string' ? d.from : '';
      lines = [
        fmtText(tr[reason], {
          reasons: reasons || r.common.unknown,
          from: statusLabels[from] ?? (from || '?'),
        }),
      ];
    }
  } else if (base.code === 'PUB_VALIDATION') {
    const issues = fieldIssues(e);
    if (issues.length) {
      const codes = t.errors.fieldCodes as Record<string, string>;
      lines = [
        fmtText(t.errors.fields, {
          list: issues
            .map(
              (x) =>
                `${fieldLabel(x.field, r)} — ${
                  Object.prototype.hasOwnProperty.call(codes, x.code)
                    ? codes[x.code]
                    : x.code
                }`
            )
            .join('; '),
        }),
      ];
    }
  } else if (base.code === 'PUB_SOURCE_NOT_ALLOWED' && reason === 'revoked') {
    lines = [r.errors.excerptRevoked];
  } else if (base.code === 'PUB_CONFLICT' && reason) {
    if (reason === 'duplicate') {
      existingId = typeof d.existingId === 'string' ? d.existingId : null;
      lines = [r.errors.duplicate];
    } else if (reason === 'unique') {
      lines = [r.errors.unique];
    } else {
      lines = base.lines.filter((l) => l !== generic);
    }
  }
  return {
    ...base,
    lines,
    existingId,
    // Дубль — не «устаревшая версия»: перезагрузка не нужна, нужна ссылка.
    conflict: base.conflict && reason !== 'duplicate',
  };
}

/** Подсказки создания при дубле (сообщество/тред/запрос) — экран выбирает. */
export function isDuplicate(e: unknown): boolean {
  return (
    e instanceof ApiError &&
    e.code === 'PUB_CONFLICT' &&
    (e.details as Record<string, unknown> | undefined)?.reason === 'duplicate'
  );
}

export const TRANSITIONS: readonly RedditTransition[] = [
  'qualify',
  'skip',
  'archive',
];
