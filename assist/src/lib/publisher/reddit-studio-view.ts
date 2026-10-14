/**
 * AI Publisher (P-R, M2 AI Content Studio) — чистые функции экранов
 * брифа и студии (проверяет `scripts/publisher-reddit-studio.test.ts` без
 * React):
 *  - форма брифа → тела создания/правки (правка — только изменённое);
 *    comment: возможность (тред) и контекст обязательны уже при создании
 *    (A13); тезисы с источниками продукта или `needs_verification`;
 *  - «чего не хватает» словами;
 *  - выбор варианта → тело версии (у comment нет `title`);
 *  - безопасный разбор подмножества Reddit-markdown в дерево (без HTML,
 *    ссылок и картинок — их текст остаётся текстом), счётчик слов;
 *  - раскрытие (A08) — только подсказка правила, вердикт — сервер;
 *  - согласование с подтверждением WARN; доступные шаги материала;
 *  - URL отчёта о публикации — зеркало `normalizeReportedUrl` сервера;
 *  - ошибки M2 словами (`PUB_BRIEF_NOT_READY`, `warnings_not_acknowledged`,
 *    блокеры `reddit_policy`).
 */
import { ApiError } from '../../kit';
import type { PublisherDict } from '../../i18n/publisher-ru';
import type { ContentStatus } from './states';
import {
  decodeFindingParams,
  type QaCheckIn,
  type QaCheckView,
  type QaFindingParams,
  type VersionView,
} from './content-api';
import {
  changedKeys,
  describeRedditError,
  normalizeThreadUrl,
  type PublisherRedditDict,
  type RedditErrorView,
} from './reddit-view';
import type { AiCallView } from './ai-api';
import type { RedditOpportunityView } from './reddit-api';
import {
  decodeDraftOutput,
  type CreateRedditBriefIn,
  type CreateRedditVersionIn,
  type PatchRedditBriefIn,
  type PatchRedditVersionIn,
  type RedditAffiliation,
  type RedditBriefView,
  type RedditClaimSources,
  type RedditContentType,
  type RedditDraftVariant,
  type RedditKeyPoint,
  type RedditMaterialView,
  type RedditVersionMetaIn,
  type ReportRedditPublicationIn,
} from './reddit-studio-api';
import { fmtText } from './view';

const len = (s: string) => [...s].length;
const lines = (s: string) =>
  s
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);

// ── Бриф ──────────────────────────────────────────────────────────────────

export interface KeyPointForm {
  text: string;
  /** Id источников продукта через запятую/пробел. */
  sources: string;
  needsVerification: boolean;
}

export interface BriefForm {
  contentType: RedditContentType | '';
  opportunityId: string;
  communityId: string;
  objective: string;
  audience: string;
  context: string;
  keyPoints: KeyPointForm[];
  affiliation: RedditAffiliation | '';
  /** Имя продукта/бренда в раскрытии (2..64; пусто — по умолчанию сервера). */
  brand: string;
  linksAllowed: boolean;
  tone: string;
  language: string;
  constraints: string;
  forbiddenClaims: string;
  cta: string;
}

export const keyPointForm = (k?: RedditKeyPoint): KeyPointForm => ({
  text: k?.text ?? '',
  sources:
    !k || k.sourceIds === 'needs_verification' ? '' : k.sourceIds.join(', '),
  needsVerification: k?.sourceIds === 'needs_verification',
});

export function briefForm(b?: RedditBriefView | null): BriefForm {
  return {
    contentType: b?.contentType ?? '',
    opportunityId: b?.opportunityId ?? '',
    communityId: b?.communityId ?? '',
    objective: b?.objective ?? '',
    audience: b?.audience ?? '',
    context: b?.context ?? '',
    keyPoints: (b?.keyPoints ?? []).map(keyPointForm),
    affiliation: b?.affiliation ?? '',
    brand: b?.brand ?? '',
    linksAllowed: b?.linksAllowed ?? false,
    tone: b?.tone ?? '',
    language: b?.language ?? '',
    constraints: (b?.constraints ?? []).join('\n'),
    forbiddenClaims: (b?.forbiddenClaims ?? []).join('\n'),
    cta: b?.cta ?? '',
  };
}

const SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

/** Тезис формы → тело; `null` — неверный (пусто, > 300, нет источника). */
export function keyPointBody(k: KeyPointForm): RedditKeyPoint | null {
  const text = k.text.trim();
  if (!text || len(text) > 300) return null;
  if (k.needsVerification) return { text, sourceIds: 'needs_verification' };
  const ids = k.sources
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (
    ids.length < 1 ||
    ids.length > 10 ||
    !ids.every((x) => SOURCE_ID_RE.test(x))
  )
    return null;
  return { text, sourceIds: [...new Set(ids)] };
}

export type BriefIssue =
  | 'contentType'
  | 'opportunity'
  | 'community'
  | 'objective'
  | 'brand'
  | 'context'
  | 'keyPoints'
  | 'lists'
  | 'length';

export function briefIssues(f: BriefForm): BriefIssue[] {
  const out: BriefIssue[] = [];
  if (!f.contentType) out.push('contentType');
  // A13: comment — только к треду возможности и с контекстом.
  if (f.contentType === 'comment') {
    if (!f.opportunityId) out.push('opportunity');
    if (!f.context.trim()) out.push('context');
  }
  if (f.contentType === 'post' && !f.opportunityId && !f.communityId)
    out.push('community');
  const obj = f.objective.trim();
  if (!obj || len(obj) > 500) out.push('objective');
  const brand = f.brand.trim();
  if (brand && (len(brand) < 2 || len(brand) > 64)) out.push('brand');
  if (f.keyPoints.length > 5 || f.keyPoints.some((k) => !keyPointBody(k)))
    out.push('keyPoints');
  if (lines(f.constraints).length > 10 || lines(f.forbiddenClaims).length > 20)
    out.push('lists');
  if (
    [...lines(f.constraints), ...lines(f.forbiddenClaims)].some(
      (x) => len(x) > 300
    ) ||
    len(f.audience.trim()) > 500 ||
    len(f.context.trim()) > 2000 ||
    len(f.tone.trim()) > 64 ||
    len(f.cta.trim()) > 300
  )
    out.push('length');
  return out;
}

const nn = (s: string) => (s.trim() ? s.trim() : null);

export function briefCreateBody(
  projectId: string,
  f: BriefForm
): CreateRedditBriefIn | null {
  if (!projectId || briefIssues(f).length || !f.contentType) return null;
  const keyPoints = f.keyPoints.map(keyPointBody) as RedditKeyPoint[];
  return {
    projectId,
    contentType: f.contentType,
    ...(f.opportunityId ? { opportunityId: f.opportunityId } : {}),
    ...(!f.opportunityId && f.communityId
      ? { communityId: f.communityId }
      : {}),
    objective: f.objective.trim(),
    ...(nn(f.audience) ? { audience: nn(f.audience) } : {}),
    ...(nn(f.context) ? { context: nn(f.context) } : {}),
    ...(keyPoints.length ? { keyPoints } : {}),
    ...(f.affiliation ? { affiliation: f.affiliation } : {}),
    ...(nn(f.brand) ? { brand: nn(f.brand) } : {}),
    linksAllowed: f.linksAllowed,
    ...(nn(f.tone) ? { tone: nn(f.tone) } : {}),
    ...(f.language.trim() ? { language: f.language.trim() } : {}),
    ...(lines(f.constraints).length
      ? { constraints: lines(f.constraints) }
      : {}),
    ...(lines(f.forbiddenClaims).length
      ? { forbiddenClaims: lines(f.forbiddenClaims) }
      : {}),
    ...(nn(f.cta) ? { cta: nn(f.cta) } : {}),
  };
}

/** Правка брифа: только поля, изменённые относительно `base` формы. */
export function briefPatchBody(
  b: Pick<RedditBriefView, 'revision'>,
  f: BriefForm,
  base: BriefForm
): PatchRedditBriefIn | null {
  if (briefIssues(f).length) return null;
  const out: PatchRedditBriefIn = { expectedRevision: b.revision };
  for (const k of changedKeys(base, f)) {
    switch (k) {
      case 'objective':
        out.objective = f.objective.trim();
        break;
      case 'audience':
        out.audience = nn(f.audience);
        break;
      case 'context':
        out.context = nn(f.context);
        break;
      case 'keyPoints':
        out.keyPoints = f.keyPoints.map(keyPointBody) as RedditKeyPoint[];
        break;
      case 'affiliation':
        out.affiliation = f.affiliation || null;
        break;
      case 'brand':
        out.brand = nn(f.brand);
        break;
      case 'linksAllowed':
        out.linksAllowed = f.linksAllowed;
        break;
      case 'tone':
        out.tone = nn(f.tone);
        break;
      case 'language':
        if (f.language.trim()) out.language = f.language.trim();
        break;
      case 'constraints':
        out.constraints = lines(f.constraints);
        break;
      case 'forbiddenClaims':
        out.forbiddenClaims = lines(f.forbiddenClaims);
        break;
      case 'cta':
        out.cta = nn(f.cta);
        break;
      default:
        // contentType/opportunityId/communityId неизменны после создания.
        break;
    }
  }
  return Object.keys(out).length > 1 ? out : null;
}

/**
 * Бриф из карточки возможности: comment к её треду, контекст по умолчанию —
 * выдержка треда (сервер сделал бы то же, A13), сообщество — её.
 */
export function briefFormFromOpportunity(
  o: Pick<RedditOpportunityView, 'id' | 'communityId' | 'excerpt'>
): BriefForm {
  return {
    ...briefForm(),
    contentType: 'comment',
    opportunityId: o.id,
    communityId: o.communityId,
    context: o.excerpt && o.excerpt.usage !== 'revoked' ? o.excerpt.text : '',
  };
}

/** «Чего не хватает» словами (`key_points[N]` — «тезис N+1: …»). */
export function missingText(code: string, r: PublisherRedditDict): string {
  const m = /^key_points\[(\d+)\]$/.exec(code);
  if (m) return fmtText(r.briefs.missingPoint, { n: Number(m[1]) + 1 });
  const map = r.briefs.missing as Record<string, string>;
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : code;
}

/** Бриф готов к ready/генерации/материалу (подсказка; решает сервер). */
export const briefUsable = (b: Pick<RedditBriefView, 'status' | 'missing'>) =>
  b.status === 'ready' && b.missing.length === 0;

// ── Варианты и версия ─────────────────────────────────────────────────────

const claimSourcesOut = (s: RedditClaimSources): RedditClaimSources =>
  s === 'needs_verification' ? s : [...s];

/** Выбранный вариант → тело версии (comment — без `title`). */
export function variantVersionBody(
  contentType: RedditContentType,
  v: RedditDraftVariant,
  aiCallId: string,
  variantIndex: number
): CreateRedditVersionIn {
  const meta: RedditVersionMetaIn = {
    disclosure: v.disclosure,
    flairSuggestion: v.flair_suggestion,
    claimMap: v.claim_map.map((c) => ({
      text: c.text,
      sourceIds: claimSourcesOut(c.source_ids),
    })),
    uncertainties: [...v.uncertainties],
  };
  return {
    ...(contentType === 'post' ? { title: v.title ?? '' } : {}),
    body: v.body,
    meta,
    aiCallId,
    variantIndex,
  };
}

export interface DraftForm {
  title: string;
  body: string;
  disclosure: string;
  flair: string;
}

export function draftForm(v?: VersionView | null): DraftForm {
  return {
    title: v?.title ?? '',
    body: v?.body ?? '',
    disclosure: v?.meta.disclosure ?? '',
    flair: v?.meta.flairSuggestion ?? '',
  };
}

export type DraftIssue = 'title' | 'body' | 'disclosure' | 'flair';

export function draftIssues(
  contentType: RedditContentType,
  f: DraftForm
): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (contentType === 'post' && (!f.title.trim() || len(f.title.trim()) > 300))
    out.push('title');
  const max = contentType === 'comment' ? 10_000 : 40_000;
  if (len(f.body) > max) out.push('body');
  if (len(f.disclosure) > 300) out.push('disclosure');
  if (len(f.flair.trim()) > 64) out.push('flair');
  return out;
}

/** Новый черновик вручную (ручной путь A10). */
export function manualVersionBody(
  contentType: RedditContentType,
  f: DraftForm
): CreateRedditVersionIn | null {
  if (draftIssues(contentType, f).length || !f.body.trim()) return null;
  return {
    ...(contentType === 'post' ? { title: f.title.trim() } : {}),
    body: f.body,
    meta: {
      disclosure: f.disclosure.trim(),
      flairSuggestion: f.flair.trim() || null,
    },
  };
}

/**
 * Правка черновика: только изменённое относительно `base`; `meta`
 * отправляется целиком (сервер заменяет клиентскую часть), сохраняя
 * `claimMap`/`uncertainties` версии.
 */
export function draftPatchBody(
  contentType: RedditContentType,
  v: Pick<VersionView, 'revision' | 'meta'>,
  f: DraftForm,
  base: DraftForm
): PatchRedditVersionIn | null {
  if (draftIssues(contentType, f).length) return null;
  const ch = changedKeys(base, f);
  const out: PatchRedditVersionIn = { expectedRevision: v.revision };
  if (contentType === 'post' && ch.includes('title'))
    out.title = f.title.trim();
  if (ch.includes('body')) out.body = f.body;
  if (ch.includes('disclosure') || ch.includes('flair')) {
    out.meta = {
      disclosure: f.disclosure.trim(),
      flairSuggestion: f.flair.trim() || null,
      ...(v.meta.claimMap ? { claimMap: v.meta.claimMap } : {}),
      ...(v.meta.uncertainties ? { uncertainties: v.meta.uncertainties } : {}),
    };
  }
  return Object.keys(out).length > 1 ? out : null;
}

/** Абзацы тела (для «перегенерировать абзац»): блоки через пустую строку. */
export function paragraphs(body: string): string[] {
  // Как серверный `paragraphsOf` (номер абзаца в `rewrite.paragraph`).
  return body
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Диапазоны абзацев в ИСХОДНОЙ строке (те же блоки, что `paragraphs`):
 * `[start, end)` — текст абзаца без окружающих пробелов/переводов строк.
 */
export function paragraphSpans(
  body: string
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /\n\s*\n/g;
  let from = 0;
  const push = (a: number, b: number) => {
    const block = body.slice(a, b);
    const lead = block.length - block.trimStart().length;
    const trail = block.length - block.trimEnd().length;
    if (block.trim()) out.push({ start: a + lead, end: b - trail });
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    push(from, m.index);
    from = m.index + m[0].length;
  }
  push(from, body.length);
  return out;
}

/**
 * «Перегенерировать абзац»: заменяется РОВНО диапазон абзаца `index` в
 * текущей строке; прочие символы (отступы кода, пустые строки, CRLF,
 * хвостовые пробелы) остаются байт-в-байт.
 */
export function replaceParagraph(
  body: string,
  index: number,
  text: string
): string {
  const sp = paragraphSpans(body)[index];
  if (!sp) return body;
  return body.slice(0, sp.start) + text.trim() + body.slice(sp.end);
}

/**
 * «Перегенерировать абзац»: вариант модели — вся чернетка с переписанным
 * абзацем `index` (инструкция `reddit-draft.v1`); берём только его.
 */
export function rewrittenParagraph(
  variantBody: string,
  index: number
): string | null {
  const p = paragraphs(variantBody)[index];
  return p === undefined ? null : p;
}

/** Варианты вызова `pub.reddit.draft` (`null` — вызов не `ok` или форма чужая). */
export function variantsOf(
  call: Pick<AiCallView, 'status' | 'output'> | null
): RedditDraftVariant[] | null {
  if (!call || call.status !== 'ok') return null;
  try {
    return decodeDraftOutput(call.output);
  } catch {
    return null;
  }
}

export function wordCount(text: string): { words: number; chars: number } {
  const t = text.trim();
  return {
    words: t ? t.split(/\s+/u).length : 0,
    chars: [...text].length,
  };
}

/**
 * Перенос варианта ПЕРЕПИСЫВАНИЯ абзаца в черновик (§10.9): к правке
 * черновика добавляются `aiCallId` + `variantIndex` выбранного варианта
 * (сервер записывает выбор). Раскрытие (A08, `markers@3`) клиент не судит —
 * только подсказка правила; вердикт — `reddit_policy` сервера.
 */
export function withAiChoice(
  patch: PatchRedditVersionIn | null,
  choice: { aiCallId: string; variantIndex: number } | null
): PatchRedditVersionIn | null {
  if (!patch || !choice || patch.body === undefined) return patch;
  return {
    ...patch,
    aiCallId: choice.aiCallId,
    variantIndex: choice.variantIndex,
  };
}

/** Коды проверки, относящиеся к раскрытию (панель «Розкриття звʼязку»). */
export const DISCLOSURE_CODES = [
  'reddit_disclosure_missing',
  'reddit_disclosure_negated',
  'reddit_disclosure_unclear',
] as const;

// ── Безопасный предпросмотр подмножества Reddit-markdown ───────────────────

export type MdInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'code'; v: string };
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'quote'; c: MdInline[] }
  | { t: 'ul'; items: MdInline[][] }
  | { t: 'ol'; items: MdInline[][] };

/**
 * Inline: `**жирный**`, `*курсив*`/`_курсив_`, `` `код` ``. Ссылки,
 * картинки, HTML — НЕ разбираются (остаются буквальным текстом).
 */
export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ t: 'text', v: s.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] });
    else if (m[2] !== undefined) out.push({ t: 'strong', v: m[2] });
    else out.push({ t: 'em', v: (m[3] ?? m[4]) as string });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ t: 'text', v: s.slice(last) });
  return out;
}

export function parseMarkdownSubset(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const chunk of text.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    const ls = chunk.split('\n').filter((l) => l.trim() !== '');
    if (!ls.length) continue;
    if (ls.every((l) => /^\s*[-*+]\s+/.test(l))) {
      blocks.push({
        t: 'ul',
        items: ls.map((l) => parseInline(l.replace(/^\s*[-*+]\s+/, ''))),
      });
    } else if (ls.every((l) => /^\s*\d{1,3}[.)]\s+/.test(l))) {
      blocks.push({
        t: 'ol',
        items: ls.map((l) => parseInline(l.replace(/^\s*\d{1,3}[.)]\s+/, ''))),
      });
    } else if (ls.every((l) => /^\s*>/.test(l))) {
      blocks.push({
        t: 'quote',
        c: parseInline(ls.map((l) => l.replace(/^\s*>\s?/, '')).join('\n')),
      });
    } else {
      blocks.push({ t: 'p', c: parseInline(ls.join('\n')) });
    }
  }
  return blocks;
}

// ── Проверка, согласование, шаги материала ────────────────────────────────

/** Согласование: все WARN свежей проверки отмечены человеком. */
export function allAcknowledged(
  check: Pick<QaCheckView, 'warnings'> | null,
  acked: ReadonlySet<string>
): boolean {
  return (check?.warnings ?? []).every((w) => acked.has(w.code));
}

export function approveRedditBody(
  versionHash: string,
  reason: string,
  check: Pick<QaCheckView, 'warnings'> | null,
  acked: ReadonlySet<string>
): {
  versionHash: string;
  reason?: string;
  acknowledgedWarnings?: string[];
} | null {
  if (!allAcknowledged(check, acked)) return null;
  const codes = [...new Set((check?.warnings ?? []).map((w) => w.code))];
  const r = reason.trim();
  return {
    versionHash,
    ...(r ? { reason: r } : {}),
    ...(codes.length ? { acknowledgedWarnings: codes } : {}),
  };
}

const COPYABLE: readonly ContentStatus[] = [
  'approved',
  'scheduled',
  'published',
  'revised',
];
const REPORTABLE: readonly ContentStatus[] = [
  'scheduled',
  'published',
  'revised',
];

export interface MaterialSteps {
  /** Черновик правится (версия `draft`, материал не `scheduled`). */
  editDraft: boolean;
  /** Новый черновик (нет черновика; не `scheduled`/на проверке/отозван). */
  newDraft: boolean;
  submit: boolean;
  approve: boolean;
  copy: boolean;
  report: boolean;
  /** Материал в `scheduled`: правка — только после «снять с плана». */
  unscheduleFirst: boolean;
}

export function materialSteps(
  m: Pick<RedditMaterialView, 'content' | 'currentVersion' | 'approvedVersion'>
): MaterialSteps {
  const st = m.content.status;
  const cur = m.currentVersion;
  const scheduled = st === 'scheduled';
  const draft = cur?.status === 'draft';
  return {
    editDraft: draft && !scheduled,
    // На проверке (`editorial_review`) — сначала «вернуть на доработку».
    newDraft:
      !draft && !scheduled && st !== 'withdrawn' && st !== 'editorial_review',
    submit: draft && !scheduled,
    approve: cur?.status === 'submitted' && !!cur.hash,
    copy: COPYABLE.includes(st) && !!m.approvedVersion,
    report: REPORTABLE.includes(st),
    unscheduleFirst: scheduled,
  };
}

/**
 * Какие панели действий студии видны (подсказка; решает сервер, §1):
 * правка/генерация — `version.manage`, согласование — `version.approve`
 * (PO), копирование и отметка — `reddit.handoff` (PO/OP).
 */
export function studioPanels(
  steps: MaterialSteps,
  can: { canVersion: boolean; canApprove: boolean; canHandoff: boolean }
): { write: boolean; approve: boolean; copy: boolean; report: boolean } {
  return {
    write: can.canVersion && (steps.newDraft || steps.editDraft),
    approve: can.canApprove && steps.approve,
    copy: can.canHandoff && steps.copy,
    report: can.canHandoff && steps.report,
  };
}

/** Строка «проверки P-R пройдены на снимке правил vN от <дата>». */
export function rulesBasis(
  m: Pick<RedditMaterialView, 'rules'>,
  r: PublisherRedditDict,
  fmtDate: (iso: string) => string
): string {
  if (!m.rules) return r.studio.rulesNone;
  return fmtText(r.studio.rulesBasis, {
    v: m.rules.version,
    date: fmtDate(m.rules.checkedAt),
  });
}

/**
 * QA человека (editorial/technical) для согласования Reddit-версии:
 * «не пройдено» — с текстом причины (код `other`); `null` — форма неполна.
 */
export function humanQaBody(
  kind: 'editorial' | 'technical',
  pass: boolean,
  text: string
): QaCheckIn | null {
  if (pass) return { kind, result: 'pass' };
  const t = text.trim();
  if (!t || len(t) > 1000) return null;
  return { kind, result: 'fail', blockers: [{ code: 'other', text: t }] };
}

// ── Отчёт о публикации ────────────────────────────────────────────────────

const REDDIT_HOSTS = [
  'reddit.com',
  'www.reddit.com',
  'old.reddit.com',
  'new.reddit.com',
  'np.reddit.com',
  'm.reddit.com',
  'sh.reddit.com',
];
const SUB_RE = /^[a-z0-9_]{2,21}$/;
const KEY_RE = /^[a-z0-9]{1,13}$/;

export interface ReportedUrl {
  url: string;
  subreddit: string;
  threadKey: string;
  commentId: string | null;
}

/** Зеркало `normalizeReportedUrl` (`reddit/normalize.ts`), паритет — тест. */
export function normalizeReportedUrl(
  input: unknown
): { ok: ReportedUrl } | { issue: 'format' | 'profile_ref' } {
  if (typeof input !== 'string' || input.length > 2048)
    return { issue: 'format' };
  const raw = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https:\/\//i.test(raw))
    return { issue: 'format' };
  let u: URL;
  try {
    u = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { issue: 'format' };
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    return { issue: 'format' };
  if (!REDDIT_HOSTS.includes(u.hostname.toLowerCase().replace(/\.$/, '')))
    return { issue: 'format' };
  const parts = u.pathname.split('/').filter((x) => x !== '');
  if (
    parts.length < 4 ||
    parts[0].toLowerCase() !== 'r' ||
    parts[2].toLowerCase() !== 'comments'
  )
    return { issue: 'format' };
  const subreddit = parts[1].toLowerCase();
  const threadKey = parts[3].toLowerCase();
  if (!SUB_RE.test(subreddit) || !KEY_RE.test(threadKey))
    return { issue: 'format' };
  if (/^u_/.test(subreddit)) return { issue: 'profile_ref' };
  if (parts.length >= 6) {
    // `…/comments/<id>/<slug>/comment/<cid>`: «comment» — не id (Р-RD-72).
    const raw = parts[5].toLowerCase() === 'comment' ? parts[6] : parts[5];
    if (!raw) return { issue: 'format' };
    const cid = raw.toLowerCase();
    if (!KEY_RE.test(cid)) return { issue: 'format' };
    return {
      ok: {
        url: `https://www.reddit.com/r/${subreddit}/comments/${threadKey}/comment/${cid}`,
        subreddit,
        threadKey,
        commentId: cid,
      },
    };
  }
  const t = normalizeThreadUrl(input);
  if (!t) return { issue: 'format' };
  return { ok: { url: t.url, subreddit, threadKey, commentId: null } };
}

export type ReportIssue =
  | 'format'
  | 'profile_ref'
  | 'community_mismatch'
  | 'comment_required'
  | 'thread_mismatch'
  | 'date'
  | 'future'
  | 'before_material'
  | 'notes';

/** Проверка формы «Отметить опубликованным» (подсказка; решает сервер). */
export function reportIssues(
  m: Pick<RedditMaterialView, 'contentType' | 'subreddit' | 'threadUrl'>,
  url: string,
  postedAtLocal: string,
  notes: string,
  now: Date = new Date(),
  /** Нижняя граница: заморозка согласованной версии (сервер — создание материала). */
  notBefore: string | null = null
): { issues: ReportIssue[]; canon: string | null } {
  const issues: ReportIssue[] = [];
  const n = normalizeReportedUrl(url);
  let canon: string | null = null;
  if ('issue' in n) issues.push(n.issue);
  else {
    canon = n.ok.url;
    if (n.ok.subreddit !== m.subreddit) issues.push('community_mismatch');
    if (m.contentType === 'comment') {
      if (!n.ok.commentId) issues.push('comment_required');
      const t = m.threadUrl ? normalizeThreadUrl(m.threadUrl) : null;
      if (t && t.threadKey !== n.ok.threadKey) issues.push('thread_mismatch');
    }
  }
  const t = postedAtLocal ? Date.parse(postedAtLocal) : NaN;
  if (!Number.isFinite(t)) issues.push('date');
  else if (t > now.getTime() + 5 * 60_000) issues.push('future');
  else if (notBefore && t < Date.parse(notBefore) - 60_000)
    issues.push('before_material');
  if (len(notes.trim()) > 1000) issues.push('notes');
  return { issues, canon };
}

/** Тело отчёта: `postedAt` из локального datetime-local → ISO (UTC). */
export function reportBody(
  url: string,
  postedAtLocal: string,
  notes: string
): ReportRedditPublicationIn | null {
  const t = Date.parse(postedAtLocal);
  if (!url.trim() || !Number.isFinite(t)) return null;
  const n = notes.trim();
  return {
    url: url.trim(),
    postedAt: new Date(t).toISOString(),
    ...(n ? { notes: n } : {}),
  };
}

// ── Находки проверки словами (§12.1: текст — по коду и параметрам) ────────

export function findingText(
  f: { code: string; params?: QaFindingParams },
  kind: 'blocker' | 'warning',
  r: PublisherRedditDict
): string {
  const map = (
    kind === 'blocker' ? r.studio.blockers : r.studio.warnings
  ) as Record<string, string>;
  const base = Object.prototype.hasOwnProperty.call(map, f.code)
    ? map[f.code]
    : r.studio.findings.other;
  const p = f.params ?? {};
  const extra: string[] = [];
  const reason = typeof p.reason === 'string' ? p.reason : null;
  const reasons = r.studio.findings.disclosure as Record<string, string>;
  if (reason && Object.prototype.hasOwnProperty.call(reasons, reason))
    extra.push(
      fmtText(reasons[reason], {
        brand: typeof p.brand === 'string' ? p.brand : '',
      })
    );
  if (Array.isArray(p.found) && p.found.length)
    extra.push(
      fmtText(r.studio.findings.found, {
        list: (p.found as Array<string | number>).slice(0, 10).join(', '),
      })
    );
  if (Array.isArray(p.claims) && p.claims.length)
    extra.push(
      fmtText(r.studio.findings.claims, {
        list: (p.claims as Array<string | number>)
          .filter((x): x is number => typeof x === 'number')
          .map((x) => x + 1)
          .join(', '),
      })
    );
  return extra.length ? `${base}: ${extra.join('; ')}` : base;
}

// ── Ошибки M2 словами ─────────────────────────────────────────────────────

const strList = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string').slice(0, 30)
    : [];

const label = (map: Record<string, string>, k: string) =>
  Object.prototype.hasOwnProperty.call(map, k) ? map[k] : k;

export function describeStudioError(
  e: unknown,
  t: PublisherDict,
  r: PublisherRedditDict,
  statusLabels: Record<string, string> = {}
): RedditErrorView {
  const v = describeRedditError(e, t, r, statusLabels);
  if (!(e instanceof ApiError)) return v;
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (e.code === 'PUB_BRIEF_NOT_READY') {
    const ms = strList(d.missing);
    if (ms.length)
      return {
        ...v,
        lines: [r.briefs.notReady, ...ms.map((x) => missingText(x, r))],
      };
  }
  if (e.code === 'PUB_CONFLICT' && d.reason === 'warnings_not_acknowledged') {
    // Не «є новіша версія»: изменился набор WARN проверки (S2-1).
    const ack = ackWarningsOf(e);
    return {
      ...v,
      title: r.studio.approve.warnTitle,
      conflict: false,
      lines: [
        r.studio.approve.warnHint,
        ...(ack?.warnings ?? []).map((w) => findingText(w, 'warning', r)),
      ],
    };
  }
  if (e.code === 'PUB_CONFLICT' && d.reason === 'already_published') {
    return {
      ...v,
      conflict: false,
      lines: [
        label(
          t.errors.conflictReasons as Record<string, string>,
          'already_published'
        ),
      ],
    };
  }
  if (e.code === 'PUB_BLOCKERS_OPEN' && Array.isArray(d.blockers)) {
    const extra: string[] = [];
    for (const b of d.blockers.slice(0, 30)) {
      const c =
        b && typeof b === 'object' ? (b as Record<string, unknown>).code : null;
      if (
        typeof c === 'string' &&
        c.startsWith('reddit_') &&
        c !== 'reddit_policy_block'
      )
        extra.push(label(r.studio.blockers, c));
      // `reddit_policy_block {codes}` (§9.6): причины проверки словами.
      if (c === 'reddit_policy_block')
        for (const x of strList((b as Record<string, unknown>).codes))
          extra.push(label(r.studio.blockers, x));
    }
    if (extra.length) return { ...v, lines: [...v.lines, ...extra] };
  }
  if (e.code === 'PUB_TRANSITION_INVALID' && d.reason === 'not_copied')
    return { ...v, lines: [r.studio.notCopied] };
  if (e.code === 'PUB_TRANSITION_INVALID' && d.reason === 'manual_only')
    return { ...v, lines: [r.studio.manualOnly] };
  // Задача AI брифа закрыта (вариант принят) — новой генерации нет.
  if (e.code === 'PUB_TRANSITION_INVALID' && d.machine === 'ai_task')
    return { ...v, lines: [r.studio.generate.taskClosed] };
  if (e.code === 'PUB_TRANSITION_INVALID' && d.hint === 'submit_first')
    return { ...v, lines: [r.studio.submitFirst] };
  return v;
}

/**
 * Копирование: 409 `warnings_not_acknowledged` (WARN появились после
 * согласования, §9.7) → коды для подтверждения; иначе `null`.
 */
export function copyWarningCodes(e: unknown): string[] | null {
  return ackWarningsOf(e)?.codes ?? null;
}

/**
 * 409 `warnings_not_acknowledged` (согласование и копирование, §12.2):
 * коды для подтверждения (`details.codes` — их и отправить), WARN с
 * параметрами для чекбоксов и id свежей проверки (сохранена сервером).
 */
export function ackWarningsOf(e: unknown): {
  codes: string[];
  warnings: Array<{ code: string; params?: QaFindingParams }>;
  policyCheckId: string | null;
} | null {
  if (!(e instanceof ApiError) || e.code !== 'PUB_CONFLICT') return null;
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (d.reason !== 'warnings_not_acknowledged') return null;
  const codes = [...new Set(strList(d.codes))];
  if (!codes.length) return null;
  const raw = Array.isArray(d.warnings) ? d.warnings.slice(0, 30) : [];
  const warnings: Array<{ code: string; params?: QaFindingParams }> = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    if (typeof o.code !== 'string') continue;
    let params: QaFindingParams | undefined;
    try {
      params =
        o.params === undefined ? undefined : decodeFindingParams(o.params);
    } catch {
      params = undefined;
    }
    warnings.push({ code: o.code, ...(params ? { params } : {}) });
  }
  // Каждый код — чекбокс (если сервер не прислал деталь — по коду).
  for (const c of codes)
    if (!warnings.some((w) => w.code === c)) warnings.push({ code: c });
  return {
    codes,
    warnings: warnings.filter((w) => codes.includes(w.code)),
    policyCheckId: typeof d.policyCheckId === 'string' ? d.policyCheckId : null,
  };
}

/** Повтор согласования после 409: РОВНО `details.codes`, все отмечены. */
export function approveAckBody(
  versionHash: string,
  reason: string,
  codes: readonly string[],
  acked: ReadonlySet<string>
): {
  versionHash: string;
  reason?: string;
  acknowledgedWarnings: string[];
} | null {
  if (!codes.length || !codes.every((c) => acked.has(c))) return null;
  const r = reason.trim();
  return {
    versionHash,
    ...(r ? { reason: r } : {}),
    acknowledgedWarnings: [...codes],
  };
}

/**
 * Показывать подсказку ручного пути «написати самому»: генерация брифа
 * недоступна заранее (`ai.available=false`) или вызов отказал (`isManualPath`).
 */
export function manualPathShown(
  ai: Pick<RedditBriefView['ai'], 'available'>,
  error: unknown
): boolean {
  return !ai.available || isManualPath(error);
}

/** Ручной путь (`PUB_AI_DISABLED` и пр.): показывать редактор «написать самому». */
export const isManualPath = (e: unknown) =>
  e instanceof ApiError &&
  [
    'PUB_AI_DISABLED',
    'PUB_AI_UNAVAILABLE',
    'PUB_AI_SCHEMA_INVALID',
    'PUB_AI_NOT_EVALUATED',
    'PUB_AI_LIMIT',
    'PUB_AI_BUDGET',
    'PUB_AI_UNPRICED',
  ].includes(e.code);
