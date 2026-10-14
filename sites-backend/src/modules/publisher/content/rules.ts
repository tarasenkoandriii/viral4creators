/**
 * AI Publisher, P-B1 — чистые правила контента (проектный документ §6.3,
 * §7.1, F01–F04, F06): проверка `meta` версии и тела (markdown без сырого
 * HTML), оценок вопроса F01, значения факта бренда F02, блокеров QA,
 * готовности брифа F03, требований адаптаций F06 при отправке, hash
 * версии оффера, «критичность» изменения (цена/гарантия), line-diff
 * версий. Без Nest, базы и env.
 */
import type {
  BriefMissing,
  QaBlocker,
  QuestionScores,
  ScoreKey,
  VersionDiff,
  VersionMeta,
} from '../contracts/content-api';
import type { FieldIssue } from '../contracts/errors';
import { QUESTION_SCORE_KEYS } from '../contracts/states';
import { redditContact } from '../reddit/markers';
import { hasProfileRef } from '../reddit/normalize';
import { canonicalJson, sha256Hex } from '../core/content-hash';
import {
  contactValuesIn,
  forbiddenKeysIn,
  looksLikeContact,
  RESPONSE_FORBIDDEN_KEYS,
} from '../core/pii-guard';

// ── Тело и meta версии ───────────────────────────────────────────────────

/** Сырой HTML в markdown запрещён (§6.3 «markdown без сырого HTML»). */
const RAW_HTML_RE =
  /<\/?[A-Za-z][A-Za-z0-9-]*(\s[^>]*)?\/?>|<!--|<!\[CDATA\[|<![A-Za-z]/;

export function hasRawHtml(body: string): boolean {
  return RAW_HTML_RE.test(body);
}

const META_TEXT: Record<string, number> = {
  description: 300,
  shortAnswer: 2000,
  example: 4000,
  editor: 200,
  cta: 300,
};

/** Ключи `meta` — белый список `pub_public_contents` (Р-PUB-A0-11). */
export const VERSION_META_KEYS = [
  'description',
  'shortAnswer',
  'example',
  'limitations',
  'editor',
  'cta',
  'cards',
  'scenes',
  'substantiallyUpdatedAt',
] as const;

/** Проверка `meta`; возвращает нормализованную копию или ошибки полей. */
export function checkVersionMeta(
  raw: unknown,
  field = 'meta',
): { meta: VersionMeta; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const meta: Record<string, unknown> = {};
  if (raw === undefined || raw === null) return { meta: {}, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { meta: {}, issues: [{ field, code: 'type' }] };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const f = `${field}.${k}`;
    if (!(VERSION_META_KEYS as readonly string[]).includes(k)) {
      issues.push({ field: f, code: 'unknown_key' });
      continue;
    }
    if (k in META_TEXT) {
      if (typeof v !== 'string' || [...v].length > META_TEXT[k]) {
        issues.push({ field: f, code: 'type' });
      } else if (v.trim()) meta[k] = v.trim();
      continue;
    }
    if (k === 'limitations') {
      if (
        !Array.isArray(v) ||
        v.length > 20 ||
        !v.every(
          (x) => typeof x === 'string' && x.trim() && [...x].length <= 500,
        )
      ) {
        issues.push({ field: f, code: 'type' });
      } else meta[k] = (v as string[]).map((x) => x.trim());
      continue;
    }
    if (k === 'cards' || k === 'scenes') {
      const keys =
        k === 'cards' ? ['title', 'text'] : ['visual', 'voice', 'caption'];
      const ok =
        Array.isArray(v) &&
        v.length >= 1 &&
        v.length <= 30 &&
        v.every(
          (x) =>
            x !== null &&
            typeof x === 'object' &&
            !Array.isArray(x) &&
            Object.keys(x as object).every((kk) => keys.includes(kk)) &&
            keys.every((kk) => {
              const s = (x as Record<string, unknown>)[kk];
              return (
                typeof s === 'string' &&
                s.trim() !== '' &&
                [...s].length <= 2000
              );
            }),
        );
      if (!ok) issues.push({ field: f, code: 'type' });
      else meta[k] = v;
      continue;
    }
    if (k === 'substantiallyUpdatedAt') {
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
        issues.push({ field: f, code: 'format' });
      } else meta[k] = new Date(v).toISOString();
    }
  }
  // Подпись редактора — имя для подписи, не контакт.
  if (typeof meta.editor === 'string' && looksLikeContact(meta.editor)) {
    issues.push({ field: `${field}.editor`, code: 'pii' });
  }
  return { meta: meta as VersionMeta, issues };
}

// ── Reddit-версии (P-R M2, §M2.1) ────────────────────────────────────────

/**
 * Ключи `meta` Reddit-версии, которые присылает клиент. Остальные ключи
 * ставит сервер (`REDDIT_SERVER_META_KEYS`); весь `meta` входит в hash
 * (Р-RD-7). Это не белый список публичного чтения: Reddit-материалы на
 * сайте не показываются (`pub_public_contents` — только `article`).
 */
export const REDDIT_VERSION_META_KEYS = [
  'disclosure',
  'flairSuggestion',
  'claimMap',
  'uncertainties',
] as const;
export const REDDIT_SERVER_META_KEYS = [
  'ruleSnapshotId',
  'affiliation',
  'threadUrl',
] as const;

const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

export interface RedditClientMeta {
  disclosure?: string;
  flairSuggestion?: string | null;
  claimMap?: Array<{
    text: string;
    sourceIds: string[] | 'needs_verification';
  }>;
  uncertainties?: string[];
}

/** Проверка клиентской части `meta` Reddit-версии; серверные ключи — `derived`. */
export function checkRedditVersionMeta(
  raw: unknown,
  field = 'meta',
): { meta: RedditClientMeta; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];
  const meta: RedditClientMeta = {};
  if (raw === undefined || raw === null) return { meta, issues };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { meta, issues: [{ field, code: 'type' }] };
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = `${field}.${k}`;
    if ((REDDIT_SERVER_META_KEYS as readonly string[]).includes(k)) {
      issues.push({ field: f, code: 'derived' });
      continue;
    }
    if (!(REDDIT_VERSION_META_KEYS as readonly string[]).includes(k)) {
      issues.push({ field: f, code: 'unknown_key' });
      continue;
    }
    if (v === undefined) continue;
    if (k === 'disclosure') {
      if (typeof v !== 'string' || [...v].length > 300)
        issues.push({ field: f, code: 'type' });
      else meta.disclosure = v.trim();
    } else if (k === 'flairSuggestion') {
      if (v === null) meta.flairSuggestion = null;
      else if (typeof v !== 'string' || [...v].length > 64)
        issues.push({ field: f, code: 'type' });
      else meta.flairSuggestion = v.trim() || null;
    } else if (k === 'uncertainties') {
      if (
        !Array.isArray(v) ||
        v.length > 20 ||
        !v.every(
          (x) => typeof x === 'string' && x.trim() && [...x].length <= 500,
        )
      )
        issues.push({ field: f, code: 'type' });
      else meta.uncertainties = (v as string[]).map((x) => x.trim());
    } else if (k === 'claimMap') {
      if (!Array.isArray(v) || v.length > 30) {
        issues.push({ field: f, code: 'type' });
        continue;
      }
      const out: NonNullable<RedditClientMeta['claimMap']> = [];
      v.forEach((x, i) => {
        const o = x as Record<string, unknown> | null;
        const fi = `${f}[${i}]`;
        if (
          !o ||
          typeof o !== 'object' ||
          Array.isArray(o) ||
          Object.keys(o).some((kk) => kk !== 'text' && kk !== 'sourceIds')
        ) {
          issues.push({ field: fi, code: 'type' });
          return;
        }
        const text = typeof o.text === 'string' ? o.text.trim() : '';
        if (!text || [...text].length > 500) {
          issues.push({ field: `${fi}.text`, code: 'length' });
          return;
        }
        const sid = o.sourceIds;
        if (sid === 'needs_verification') {
          out.push({ text, sourceIds: 'needs_verification' });
        } else if (
          Array.isArray(sid) &&
          sid.length >= 1 &&
          sid.length <= 10 &&
          sid.every((y) => typeof y === 'string' && SOURCE_ID_RE.test(y))
        ) {
          out.push({ text, sourceIds: [...new Set(sid as string[])] });
        } else {
          issues.push({ field: `${fi}.sourceIds`, code: 'type' });
        }
      });
      meta.claimMap = out;
    }
  }
  // Контакты и ники (аудит M2 S3-7): все строки meta, включая пункты
  // claimMap и uncertainties; контакт — правило Reddit-текста (раунд 2,
  // Р-RD-81: `@scope/pkg`, `pkg@1.2.3` — не контакт).
  const strings: Array<[string, string]> = [
    ['disclosure', meta.disclosure ?? ''],
    ['flairSuggestion', meta.flairSuggestion ?? ''],
    ...(meta.claimMap ?? []).map((c, i): [string, string] => [
      `claimMap[${i}].text`,
      c.text,
    ]),
    ...(meta.uncertainties ?? []).map((u, i): [string, string] => [
      `uncertainties[${i}]`,
      u,
    ]),
  ];
  for (const [k, t] of strings) {
    if (!t) continue;
    if (redditContact(t)) issues.push({ field: `${field}.${k}`, code: 'pii' });
    else if (hasProfileRef(t))
      issues.push({ field: `${field}.${k}`, code: 'profile_ref' });
  }
  return { meta, issues };
}

/** id источников пунктов claimMap (связи версии `pub_version_sources`). */
export function claimMapSourceIds(
  claimMap: RedditClientMeta['claimMap'] | undefined,
): string[] {
  const out = new Set<string>();
  for (const c of claimMap ?? [])
    if (Array.isArray(c.sourceIds)) c.sourceIds.forEach((x) => out.add(x));
  return [...out].sort();
}

/**
 * Требования формата при отправке на проверку (F06): у адаптации свой
 * заголовок и следующий шаг (CTA); карточки — `meta.cards`, сценарий —
 * `meta.scenes`; у статьи — тело.
 */
export function formatIssues(
  format: string,
  v: { title: string; body: string; meta: VersionMeta },
  parentTitle: string | null,
): FieldIssue[] {
  const out: FieldIssue[] = [];
  if (format === 'article' || format === 'post' || format === 'checklist') {
    if (!v.body.trim()) out.push({ field: 'body', code: 'required' });
  }
  if (format === 'cards' && !(v.meta.cards && v.meta.cards.length > 0)) {
    out.push({ field: 'meta.cards', code: 'required' });
  }
  if (
    format === 'video_script' &&
    !(v.meta.scenes && v.meta.scenes.length > 0)
  ) {
    out.push({ field: 'meta.scenes', code: 'required' });
  }
  if (format === 'reddit_post' || format === 'reddit_comment') {
    // P-R M2: заголовок поста и тело; CTA и отличие от родителя не нужны.
    if (!v.body.trim()) out.push({ field: 'body', code: 'required' });
    if (format === 'reddit_comment' && [...v.body].length > 10_000)
      out.push({ field: 'body', code: 'length' });
    if (format === 'reddit_post' && [...v.body].length > 40_000)
      out.push({ field: 'body', code: 'length' });
    return out;
  }
  if (format !== 'article') {
    if (!v.meta.cta) out.push({ field: 'meta.cta', code: 'required' });
    if (parentTitle !== null && v.title.trim() === parentTitle.trim()) {
      out.push({ field: 'title', code: 'same_as_parent' });
    }
  }
  return out;
}

// ── Вопросы F01 ──────────────────────────────────────────────────────────

/** Оценки 0–2 с пояснением (пояснение — к каждому из четырёх критериев). */
export function checkScores(
  raw: unknown,
  field = 'scores',
): { scores: QuestionScores; issues: FieldIssue[] } {
  if (raw === undefined || raw === null) return { scores: {}, issues: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { scores: {}, issues: [{ field, code: 'type' }] };
  }
  const issues: FieldIssue[] = [];
  const scores: QuestionScores = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = `${field}.${k}`;
    if (!(QUESTION_SCORE_KEYS as readonly string[]).includes(k)) {
      issues.push({ field: f, code: 'unknown_key' });
      continue;
    }
    const e = v as { score?: unknown; why?: unknown } | null;
    if (!e || typeof e !== 'object') {
      issues.push({ field: f, code: 'type' });
      continue;
    }
    const score = e.score;
    if (!(score === null || score === 0 || score === 1 || score === 2)) {
      issues.push({ field: `${f}.score`, code: 'range' });
      continue;
    }
    const why = e.why;
    if (
      why !== undefined &&
      why !== null &&
      (typeof why !== 'string' || [...why].length > 2000)
    ) {
      issues.push({ field: `${f}.why`, code: 'type' });
      continue;
    }
    if (typeof why === 'string' && looksLikeContact(why)) {
      issues.push({ field: `${f}.why`, code: 'pii' });
      continue;
    }
    scores[k as ScoreKey] = {
      score,
      why: typeof why === 'string' && why.trim() ? why.trim() : null,
    };
  }
  return { scores, issues };
}

/** Чего не хватает вопросу для `selected` (F01): пояснения и источник. */
export function selectionMissing(
  scores: QuestionScores,
  allowedSources: number,
): string[] {
  const out: string[] = [];
  for (const k of QUESTION_SCORE_KEYS) {
    if (!scores[k as ScoreKey]?.why) out.push(`scores.${k}.why`);
  }
  if (allowedSources < 1) out.push('sources.allowed');
  return out;
}

/** Сумма оценок для ранжирования (неизвестное — не 0, а отдельный счёт). */
export function scoreSummary(scores: QuestionScores): {
  total: number;
  unknown: number;
} {
  let total = 0;
  let unknown = 0;
  for (const k of QUESTION_SCORE_KEYS) {
    const s = scores[k as ScoreKey]?.score;
    if (s === null || s === undefined) unknown++;
    else total += s;
  }
  return { total, unknown };
}

/** Слова формулировки (для подсказки «общие слова ≠ одна задача»). */
function words(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .normalize('NFKC')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Пары вопросов с большой долей общих слов (Жаккар ≥ 0.5) — подсказка
 * исследователю при ручной группировке (AT-F01-02). Система по ней
 * ничего не склеивает: группа создаётся только человеком.
 */
export function sameWordsPairs(
  qs: ReadonlyArray<{ id: string; text: string }>,
  threshold = 0.5,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const ws = qs.map((q) => words(q.text));
  for (let i = 0; i < qs.length; i++) {
    for (let j = i + 1; j < qs.length; j++) {
      const a = ws[i];
      const b = ws[j];
      const inter = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      if (union > 0 && inter / union >= threshold)
        out.push([qs[i].id, qs[j].id]);
    }
  }
  return out;
}

// ── Факты бренда F02 ─────────────────────────────────────────────────────

/**
 * Значение факта по виду: `price` — `{amountMinor, currency, note?}`;
 * `faq` — `{question, answer}`; прочие — `{text}`. Ключей ПД нет
 * (ответ мутации и журнал не должны их нести).
 */
export function checkFactValue(
  kind: string,
  raw: unknown,
  field = 'value',
): FieldIssue[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [{ field, code: 'type' }];
  }
  const v = raw as Record<string, unknown>;
  const allowed =
    kind === 'price'
      ? ['amountMinor', 'currency', 'note']
      : kind === 'faq'
        ? ['question', 'answer']
        : ['text'];
  const out: FieldIssue[] = [];
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k))
      out.push({ field: `${field}.${k}`, code: 'unknown_key' });
  }
  if (kind === 'price') {
    if (!Number.isSafeInteger(v.amountMinor) || (v.amountMinor as number) < 0) {
      out.push({ field: `${field}.amountMinor`, code: 'range' });
    }
    if (typeof v.currency !== 'string' || !/^[A-Z]{3}$/.test(v.currency)) {
      out.push({ field: `${field}.currency`, code: 'format' });
    }
    if (
      v.note !== undefined &&
      v.note !== null &&
      (typeof v.note !== 'string' || [...v.note].length > 2000)
    ) {
      out.push({ field: `${field}.note`, code: 'type' });
    }
  } else {
    for (const k of allowed) {
      const s = v[k];
      if (typeof s !== 'string' || !s.trim() || [...s].length > 4000) {
        out.push({ field: `${field}.${k}`, code: 'required' });
      }
    }
  }
  if (forbiddenKeysIn(v, RESPONSE_FORBIDDEN_KEYS).length) {
    out.push({ field, code: 'pii_key' });
  }
  // Контакт бренда (kind=contact) — публичный адрес компании: текст не
  // проверяется правилом «похоже на контакт»; остальные виды — проверяются.
  if (kind !== 'contact') {
    for (const p of contactValuesIn(v, field))
      out.push({ field: p, code: 'pii' });
  }
  return out;
}

/** Одинаковые значения факта (для конфликта «второе значение ключа»). */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/**
 * Изменение «критично» (`criticalStale`, §7.1; ТЗ §194 «цены, условий»;
 * аудит P-B1 S2-5): цена и условия (`kind ∈ price|condition`), гарантия,
 * возврат, сроки и условия по ключу факта.
 */
export const CRITICAL_FACT_KEY_RE =
  /guarant|warrant|refund|terms|condition|гарант|поверн|возвр|умов|строк|термін/i;

export function isCriticalFact(f: { kind: string; factKey: string }): boolean {
  return (
    f.kind === 'price' ||
    f.kind === 'condition' ||
    CRITICAL_FACT_KEY_RE.test(f.factKey)
  );
}

/**
 * Смена версии оффера критична (S2-5): изменились цена (`priceNote`), текст
 * условий или набор/значения критических фактов оффера.
 */
export function isCriticalOfferChange(
  prev: {
    text: string;
    priceNote: string | null;
    facts: ReadonlyArray<{ kind: string; factKey: string; value: unknown }>;
  },
  next: {
    text: string;
    priceNote: string | null;
    facts: ReadonlyArray<{ kind: string; factKey: string; value: unknown }>;
  },
): boolean {
  const crit = (x: typeof prev) =>
    x.facts
      .filter(isCriticalFact)
      .map((f) => [f.factKey, f.value] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return (
    (prev.priceNote ?? null) !== (next.priceNote ?? null) ||
    prev.text.trim() !== next.text.trim() ||
    !sameValue(crit(prev), crit(next))
  );
}

/** Hash версии оффера: заголовок, текст, цена и связанные факты. */
export function offerHash(o: {
  title: string;
  text: string;
  priceNote: string | null;
  facts: ReadonlyArray<{ id: string; version: number; value: unknown }>;
}): string {
  return sha256Hex(
    canonicalJson({
      title: o.title,
      text: o.text,
      priceNote: o.priceNote,
      facts: [...o.facts]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((f) => [f.id, f.version, f.value ?? null]),
    }),
  );
}

// ── Брифы F03 ────────────────────────────────────────────────────────────

export function briefMissing(b: {
  ownContribution: string | null;
  cta: string | null;
  ctaIntentNote: string | null;
  allowedSources: number;
  offerActive: boolean;
}): BriefMissing[] {
  const out: BriefMissing[] = [];
  if (!b.ownContribution?.trim()) out.push('own_contribution');
  if (!b.cta?.trim()) out.push('cta');
  if (!b.ctaIntentNote?.trim()) out.push('cta_intent_note');
  if (b.allowedSources < 1) out.push('allowed_source');
  if (!b.offerActive) out.push('offer_active');
  return out;
}

// ── QA F04 ───────────────────────────────────────────────────────────────

export function checkBlockers(
  raw: unknown,
  field = 'blockers',
): { blockers: QaBlocker[]; issues: FieldIssue[] } {
  if (raw === undefined || raw === null) return { blockers: [], issues: [] };
  if (!Array.isArray(raw) || raw.length > 100) {
    return { blockers: [], issues: [{ field, code: 'type' }] };
  }
  const issues: FieldIssue[] = [];
  const blockers: QaBlocker[] = [];
  raw.forEach((x, i) => {
    const f = `${field}[${i}]`;
    const o = x as Record<string, unknown> | null;
    if (
      !o ||
      typeof o !== 'object' ||
      typeof o.code !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(o.code) ||
      typeof o.text !== 'string' ||
      !o.text.trim() ||
      [...o.text].length > 2000 ||
      (o.claimId !== undefined &&
        o.claimId !== null &&
        typeof o.claimId !== 'string') ||
      Object.keys(o).some((k) => !['code', 'text', 'claimId'].includes(k))
    ) {
      issues.push({ field: f, code: 'type' });
      return;
    }
    if (looksLikeContact(o.text)) {
      issues.push({ field: `${f}.text`, code: 'pii' });
      return;
    }
    blockers.push({
      code: o.code,
      text: o.text.trim(),
      ...(typeof o.claimId === 'string' ? { claimId: o.claimId } : {}),
    });
  });
  return { blockers, issues };
}

// ── Diff версий ──────────────────────────────────────────────────────────

/** Предел LCS (строк × строк): больше — грубый блок «было/стало». */
const DIFF_CELLS_MAX = 4_000_000;

export function lineDiff(
  a: string,
  b: string,
): { lines: VersionDiff['body']; coarse: boolean } {
  const x = a.split('\n');
  const y = b.split('\n');
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (
    suf < x.length - pre &&
    suf < y.length - pre &&
    x[x.length - 1 - suf] === y[y.length - 1 - suf]
  ) {
    suf++;
  }
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  const head = x.slice(0, pre).map((text) => ({ op: 'eq' as const, text }));
  const tail = x
    .slice(x.length - suf)
    .map((text) => ({ op: 'eq' as const, text }));
  if (xm.length * ym.length > DIFF_CELLS_MAX) {
    return {
      lines: [
        ...head,
        ...xm.map((text) => ({ op: 'del' as const, text })),
        ...ym.map((text) => ({ op: 'add' as const, text })),
        ...tail,
      ],
      coarse: true,
    };
  }
  const n = xm.length;
  const m = ym.length;
  const dp: Uint32Array[] = Array.from(
    { length: n + 1 },
    () => new Uint32Array(m + 1),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        xm[i] === ym[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const mid: VersionDiff['body'] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (xm[i] === ym[j]) {
      mid.push({ op: 'eq', text: xm[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      mid.push({ op: 'del', text: xm[i++] });
    } else {
      mid.push({ op: 'add', text: ym[j++] });
    }
  }
  while (i < n) mid.push({ op: 'del', text: xm[i++] });
  while (j < m) mid.push({ op: 'add', text: ym[j++] });
  return { lines: [...head, ...mid, ...tail], coarse: false };
}

export function setDiff(
  a: readonly string[],
  b: readonly string[],
): { added: string[]; removed: string[] } {
  const sa = new Set(a);
  const sb = new Set(b);
  return {
    added: b.filter((x) => !sa.has(x)).sort(),
    removed: a.filter((x) => !sb.has(x)).sort(),
  };
}

export function metaChangedKeys(a: unknown, b: unknown): string[] {
  const oa = (a ?? {}) as Record<string, unknown>;
  const ob = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(oa), ...Object.keys(ob)])]
    .filter(
      (k) => canonicalJson(oa[k] ?? null) !== canonicalJson(ob[k] ?? null),
    )
    .sort();
}

// ── CSV (§11.1: выгрузка без формул) ─────────────────────────────────────

/** Значение ячейки: `=`, `+`, `-`, `@`, TAB, CR в начале — префикс `'`. */
export function csvCell(v: unknown): string {
  let s =
    v === null || v === undefined
      ? ''
      : typeof v === 'string'
        ? v
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<readonly unknown[]>,
): string {
  return (
    [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
  );
}
