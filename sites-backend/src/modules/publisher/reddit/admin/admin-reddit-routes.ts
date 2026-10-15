/**
 * AI Publisher, P-R-ADM — закрытый список маршрутов внутреннего API вкладки
 * «Reddit» Админки (doc/ai-publisher/reddit-manual-mvp-adapted.md §«Админка»,
 * Р-RD-ADM-3; контракт `<scratchpad>/admin-reddit-internal-contract.md`).
 *
 *  - `rx/<путь>` — ВСЕ 39 маршрутов `REDDIT_ROUTES` (путь после
 *    `/publisher/products/:pid/reddit/`): вызов ТОГО ЖЕ обработчика
 *    `PublisherRedditController` в процессе (без HTTP-петли), продукт —
 *    платформенный, членство — синтетическое (`core/admin-actor.ts`);
 *  - `cx/<путь>` — общие маршруты кабинета (путь после
 *    `/publisher/products/:pid/`), нужные Админке (v1.2, Р-RD-ADM-9…12):
 *    студия Reddit-материала (`ContentMaterialsController`: версии, QA,
 *    согласование и его отзыв, переходы `request_changes`/`unschedule`),
 *    источники контента (список, ручной `manual_text|url` без сети) и отзыв
 *    доказательств Reddit (`origin=reddit`), оффер и факты бренда
 *    (`ContentSourcesController`), снятие отметки о публикации Reddit-
 *    материала (`PublisherDistributionController`), опрос вызова
 *    `pub.reddit.draft` (`PublisherAiController`) — всё ТОЛЬКО в платформенном
 *    продукте; объекты с `scope` дополнительно проверяются (Reddit-материал,
 *    Reddit-доказательство, Reddit-публикация, вызов Reddit-генератора).
 *
 * Аргументы обработчиков — явные лямбды (tsc сверяет сигнатуры), действия
 * матрицы — из декоратора `@PubAllow` самого обработчика (не копия).
 * Произвольного проксирования нет: путь вне таблиц — 404.
 */
import type { Response } from 'express';
import {
  REDDIT_ROUTES,
  type RedditRouteName,
} from '../../contracts/reddit-api';
import type { ContentMaterialsController } from '../../content/content-materials.controller';
import type { ContentSourcesController } from '../../content/content-sources.controller';
import type { PublisherAiController } from '../../ai/ai.controller';
import type { PublisherDistributionController } from '../../distribution/distribution.controller';
import type { PubRequestCtx } from '../../core/pub-role.guard';
import type { PublisherRedditController } from '../reddit.controller';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';

export interface CallArgs {
  ctx: PubRequestCtx;
  /** Параметры пути (проверены `ID_RE`). */
  p: Record<string, string>;
  q: Record<string, unknown>;
  body: unknown;
  res: Response;
}

/** Контроллер кабинета, чей обработчик вызывается (cx). */
export type AdminCtl =
  'reddit' | 'materials' | 'sources' | 'distribution' | 'ai';

/**
 * Проверка объекта пути (cx): `cid`/`vid` — Reddit-материал этого продукта;
 * `reddit_source` — доказательство Reddit (`origin=reddit`); `reddit_publication`
 * — публикация версии Reddit-материала; `reddit_approval` — согласование
 * версии Reddit-материала; `reddit_ai_call` — вызов `pub.reddit.draft`.
 */
export type AdminScope =
  | 'cid'
  | 'vid'
  | 'reddit_source'
  | 'reddit_publication'
  | 'reddit_approval'
  | 'reddit_ai_call';

/** Сужение тела (cx). */
export type AdminNarrow =
  'qa_kind' | 'content_transition' | 'source_kind' | 'withdraw';

export interface AdminRoute<C> {
  /** Имя обработчика контроллера (= ключ метаданных `@PubAllow`). */
  name: string;
  method: HttpMethod;
  /** Путь после `rx/` или `cx/`: `projects/:id`. */
  pattern: string;
  call: (c: C, a: CallArgs) => unknown;
  /** Чей обработчик (rx — всегда `reddit`). */
  ctl: AdminCtl;
  scope?: AdminScope;
  narrow?: AdminNarrow;
}

type RC = PublisherRedditController;
type Rx = (c: RC, a: CallArgs) => unknown;

/** Вызов обработчика раздела Reddit по имени `REDDIT_ROUTES` (все 39). */
export const RX_CALLS: Record<RedditRouteName, Rx> = {
  listProjects: (c, a) => c.listProjects(a.ctx, a.q, a.res),
  createProject: (c, a) => c.createProject(a.ctx, a.body, a.res),
  getProject: (c, a) => c.getProject(a.ctx, a.p.id),
  patchProject: (c, a) => c.patchProject(a.ctx, a.p.id, a.body, a.res),
  archiveProject: (c, a) => c.archiveProject(a.ctx, a.p.id, a.body, a.res),
  listCommunities: (c, a) => c.listCommunities(a.ctx, a.q, a.res),
  createCommunity: (c, a) => c.createCommunity(a.ctx, a.body, a.res),
  getCommunity: (c, a) => c.getCommunity(a.ctx, a.p.id),
  patchCommunity: (c, a) => c.patchCommunity(a.ctx, a.p.id, a.body, a.res),
  listRules: (c, a) => c.listRules(a.ctx, a.p.id),
  getRulesSource: (c, a) => c.getRulesSource(a.ctx, a.p.id, a.p.sid),
  createRules: (c, a) => c.createRules(a.ctx, a.p.id, a.body, a.res),
  reviewRules: (c, a) => c.reviewRules(a.ctx, a.p.id, a.body, a.res),
  listOpportunities: (c, a) => c.listOpportunities(a.ctx, a.q, a.res),
  createOpportunity: (c, a) => c.createOpportunity(a.ctx, a.body, a.res),
  getOpportunity: (c, a) => c.getOpportunity(a.ctx, a.p.id),
  listOpportunityExcerpts: (c, a) => c.listOpportunityExcerpts(a.ctx, a.p.id),
  patchOpportunity: (c, a) => c.patchOpportunity(a.ctx, a.p.id, a.body, a.res),
  scoreOpportunity: (c, a) => c.scoreOpportunity(a.ctx, a.p.id, a.body, a.res),
  qualifyOpportunity: (c, a) =>
    c.qualifyOpportunity(a.ctx, a.p.id, a.body, a.res),
  skipOpportunity: (c, a) => c.skipOpportunity(a.ctx, a.p.id, a.body, a.res),
  archiveOpportunity: (c, a) =>
    c.archiveOpportunity(a.ctx, a.p.id, a.body, a.res),
  listKeywords: (c, a) => c.listKeywords(a.ctx, a.q, a.res),
  createKeyword: (c, a) => c.createKeyword(a.ctx, a.body, a.res),
  patchKeyword: (c, a) => c.patchKeyword(a.ctx, a.p.id, a.body, a.res),
  listBriefs: (c, a) => c.listBriefs(a.ctx, a.q, a.res),
  createBrief: (c, a) => c.createBrief(a.ctx, a.body, a.res),
  getBrief: (c, a) => c.getBrief(a.ctx, a.p.id),
  patchBrief: (c, a) => c.patchBrief(a.ctx, a.p.id, a.body, a.res),
  briefReady: (c, a) => c.briefReady(a.ctx, a.p.id, a.body, a.res),
  archiveBrief: (c, a) => c.archiveBrief(a.ctx, a.p.id, a.body, a.res),
  generateDraft: (c, a) => c.generateDraft(a.ctx, a.p.id, a.body, a.res),
  listBriefContents: (c, a) => c.listBriefContents(a.ctx, a.p.id),
  createContent: (c, a) => c.createContent(a.ctx, a.p.id, a.body, a.res),
  getContent: (c, a) => c.getContent(a.ctx, a.p.cid),
  checkContent: (c, a) => c.checkContent(a.ctx, a.p.cid, a.body, a.res),
  copyContent: (c, a) => c.copyContent(a.ctx, a.p.cid, a.body, a.res),
  reportPublication: (c, a) =>
    c.reportPublication(a.ctx, a.p.cid, a.body, a.res),
  listPublications: (c, a) => c.listPublications(a.ctx, a.q, a.res),
};

const REDDIT_PREFIX = '/publisher/products/:pid/reddit/';

/** Маршруты `rx/*` — из `REDDIT_ROUTES` (метод, путь) + вызовы. */
export const RX_ROUTES: ReadonlyArray<AdminRoute<RC>> = (
  Object.keys(REDDIT_ROUTES) as RedditRouteName[]
).map((name) => {
  const r = REDDIT_ROUTES[name];
  if (!r.path.startsWith(REDDIT_PREFIX)) {
    throw new Error(`admin-reddit: путь ${r.path} вне раздела Reddit`);
  }
  return {
    name,
    method: r.method as HttpMethod,
    pattern: r.path.slice(REDDIT_PREFIX.length),
    call: RX_CALLS[name],
    ctl: 'reddit' as const,
  };
});

type CC = ContentMaterialsController;
type SC = ContentSourcesController;
type DC = PublisherDistributionController;
type AC = PublisherAiController;

function cxRoute<C>(
  ctl: AdminCtl,
  r: Omit<AdminRoute<C>, 'ctl'>,
): AdminRoute<unknown> {
  return { ...r, ctl } as AdminRoute<unknown>;
}

/**
 * Маршруты `cx/*` (v1.2: 24). Студия Reddit-материала (контракт M2 §2), плюс
 * источники, оффер, факты бренда, публикации и опрос AI — только
 * перечисленные, с проверкой объекта (`scope`) и сужением тела (`narrow`).
 */
export const CX_ROUTES: ReadonlyArray<AdminRoute<unknown>> = [
  // ── Студия Reddit-материала (ContentMaterialsController) ──────────────
  cxRoute<CC>('materials', {
    name: 'listVersions',
    method: 'GET',
    pattern: 'contents/:cid/versions',
    scope: 'cid',
    call: (c, a) => c.listVersions(a.ctx, a.p.cid),
  }),
  cxRoute<CC>('materials', {
    name: 'createVersion',
    method: 'POST',
    pattern: 'contents/:cid/versions',
    scope: 'cid',
    call: (c, a) => c.createVersion(a.ctx, a.p.cid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'getVersion',
    method: 'GET',
    pattern: 'contents/:cid/versions/:vid',
    scope: 'cid',
    call: (c, a) => c.getVersion(a.ctx, a.p.cid, a.p.vid),
  }),
  cxRoute<CC>('materials', {
    name: 'patchVersion',
    method: 'PATCH',
    pattern: 'contents/:cid/versions/:vid',
    scope: 'cid',
    call: (c, a) => c.patchVersion(a.ctx, a.p.cid, a.p.vid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'submitVersion',
    method: 'POST',
    pattern: 'contents/:cid/versions/:vid/submit',
    scope: 'cid',
    call: (c, a) => c.submitVersion(a.ctx, a.p.cid, a.p.vid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'diff',
    method: 'GET',
    pattern: 'contents/:cid/versions/:a/diff/:b',
    scope: 'cid',
    call: (c, a) => c.diff(a.ctx, a.p.cid, a.p.a, a.p.b),
  }),
  cxRoute<CC>('materials', {
    name: 'transition',
    method: 'POST',
    pattern: 'contents/:cid/transition',
    scope: 'cid',
    narrow: 'content_transition',
    call: (c, a) => c.transition(a.ctx, a.p.cid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'listQa',
    method: 'GET',
    pattern: 'versions/:vid/qa-checks',
    scope: 'vid',
    call: (c, a) => c.listQa(a.ctx, a.p.vid),
  }),
  cxRoute<CC>('materials', {
    name: 'qaCheck',
    method: 'POST',
    pattern: 'versions/:vid/qa-checks',
    scope: 'vid',
    narrow: 'qa_kind',
    call: (c, a) => c.qaCheck(a.ctx, a.p.vid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'approve',
    method: 'POST',
    pattern: 'versions/:vid/approve',
    scope: 'vid',
    call: (c, a) => c.approve(a.ctx, a.p.vid, a.body, a.res),
  }),
  cxRoute<CC>('materials', {
    name: 'revokeApproval',
    method: 'POST',
    pattern: 'approvals/:id/revoke',
    scope: 'reddit_approval',
    call: (c, a) => c.revokeApproval(a.ctx, a.p.id, a.body, a.res),
  }),
  // ── Источники, оффер, факты бренда (ContentSourcesController) ─────────
  cxRoute<SC>('sources', {
    name: 'listSources',
    method: 'GET',
    pattern: 'sources',
    call: (c, a) => c.listSources(a.ctx, a.q, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'createSource',
    method: 'POST',
    pattern: 'sources',
    narrow: 'source_kind',
    call: (c, a) => c.createSource(a.ctx, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'revokeSource',
    method: 'POST',
    pattern: 'sources/:id/revoke',
    scope: 'reddit_source',
    call: (c, a) => c.revokeSource(a.ctx, a.p.id, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'listOffers',
    method: 'GET',
    pattern: 'offers',
    call: (c, a) => c.listOffers(a.ctx, a.q),
  }),
  cxRoute<SC>('sources', {
    name: 'createOffer',
    method: 'POST',
    pattern: 'offers',
    call: (c, a) => c.createOffer(a.ctx, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'activateOffer',
    method: 'POST',
    pattern: 'offers/:id/activate',
    call: (c, a) => c.activateOffer(a.ctx, a.p.id, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'listFacts',
    method: 'GET',
    pattern: 'brand-facts',
    call: (c, a) => c.listFacts(a.ctx, a.q, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'createFact',
    method: 'POST',
    pattern: 'brand-facts',
    call: (c, a) => c.createFact(a.ctx, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'activateFact',
    method: 'POST',
    pattern: 'brand-facts/:id/activate',
    call: (c, a) => c.activateFact(a.ctx, a.p.id, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'resolveFact',
    method: 'POST',
    pattern: 'brand-facts/:id/resolve',
    call: (c, a) => c.resolveFact(a.ctx, a.p.id, a.body, a.res),
  }),
  cxRoute<SC>('sources', {
    name: 'retireFact',
    method: 'POST',
    pattern: 'brand-facts/:id/retire',
    call: (c, a) => c.retireFact(a.ctx, a.p.id, a.body, a.res),
  }),
  // ── Публикации и AI ───────────────────────────────────────────────────
  cxRoute<DC>('distribution', {
    name: 'publicationTransition',
    method: 'POST',
    pattern: 'publications/:id/transition',
    scope: 'reddit_publication',
    narrow: 'withdraw',
    call: (c, a) => c.publicationTransition(a.ctx, a.p.id, a.body, a.res),
  }),
  cxRoute<AC>('ai', {
    name: 'getCall',
    method: 'GET',
    pattern: 'ai/calls/:callId',
    scope: 'reddit_ai_call',
    call: (c, a) => c.getCall(a.ctx, a.p.callId),
  }),
];

/** Ручные переходы материала, доступные Админке (Р-RD-ADM-3, v1.2). */
export const ADMIN_CONTENT_TRANSITIONS = [
  'request_changes',
  'unschedule',
] as const;
/** Ручные источники Админки — без загрузки по сети (Р-RD-ADM-11). */
export const ADMIN_SOURCE_KINDS = ['manual_text', 'url'] as const;

/** QA человека, доступный Админке (Р-RD-ADM-2). */
export const ADMIN_QA_KINDS = ['editorial', 'technical'] as const;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Найти маршрут по методу и пути (сегменты `:x` — id `[A-Za-z0-9_-]{1,64}`).
 * null — нет в списке (или id не того формата: тоже «нет»).
 */
export function matchRoute<C>(
  routes: ReadonlyArray<AdminRoute<C>>,
  method: string,
  path: string,
): { route: AdminRoute<C>; params: Record<string, string> } | null {
  const segs = path.split('/').filter((s) => s !== '');
  for (const route of routes) {
    if (route.method !== method) continue;
    const pat = route.pattern.split('/');
    if (pat.length !== segs.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pat.length && ok; i++) {
      if (pat[i].startsWith(':')) {
        let v: string;
        try {
          v = decodeURIComponent(segs[i]);
        } catch {
          ok = false;
          break;
        }
        if (!ID_RE.test(v)) ok = false;
        else params[pat[i].slice(1)] = v;
      } else if (pat[i] !== segs[i]) ok = false;
    }
    if (ok) return { route, params };
  }
  return null;
}
