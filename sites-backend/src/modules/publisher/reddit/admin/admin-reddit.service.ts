/**
 * AI Publisher, P-R-ADM — сервис внутреннего API вкладки «Reddit» Админки
 * (doc/ai-publisher/reddit-manual-mvp-adapted.md §«Админка», Р-RD-ADM-1…5).
 *
 *  - платформенный продукт: продукт сайта `publisherPlatformSiteId()`
 *    (первый из `ASSIST_INTERNAL_SITE_IDS`); других продуктов Админка не
 *    видит — id продукта в пути нет вовсе, подставляет сервер;
 *  - `dispatch` — вызов ТЕХ ЖЕ обработчиков кабинета в процессе (контроллеры
 *    берутся из контейнера Nest — те же экземпляры), с синтетическим
 *    членством и закрытым списком действий (`core/admin-actor.ts`); проверки
 *    гварда кабинета повторены: действие маршрута (`@PubAllow` обработчика)
 *    и вид продукта;
 *  - импорт CSV — чистая логика `reddit/research-import.ts` с `ImportHttp`
 *    поверх того же `dispatch` (без HTTP-петли и без сети).
 *
 * Сети нет (Р-RD-0): ни один путь не обращается к Reddit.
 */
import { Injectable, HttpException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Response } from 'express';
import { SitesDb } from '../../../../prisma/sites-db.service';
import {
  publisherAiUnevaluatedAllowed,
  publisherPlatformSiteId,
  publisherRedditAiEnabled,
  publisherRedditEnabled,
  publisherStandFakeAi,
} from '../../../../config/publisher-env';
import type {
  GateResult,
  ParameterView,
  ProductCtx,
} from '../../contracts/common';
import { ContentMaterialsController } from '../../content/content-materials.controller';
import { ContentSourcesController } from '../../content/content-sources.controller';
import { PublisherAiController } from '../../ai/ai.controller';
import { PublisherDistributionController } from '../../distribution/distribution.controller';
import {
  ADMIN_CONTENT_KINDS,
  ADMIN_GENERATORS,
  ADMIN_PARAMETER_KEYS,
  ADMIN_REDDIT_ACTIONS,
  ADMIN_SETUP_ACTIONS,
  adminMembership,
  adminRedditAccess,
  isAdminParameterKey,
} from '../../core/admin-actor';
import { PubError, validationError } from '../../core/errors';
import { looksLikeContact } from '../../core/pii-guard';
import { hasProfileRef } from '../normalize';
import { evaluateGate } from '../../core/gates';
import { kyivMonthOf } from '../../core/kyiv-time';
import { REDDIT_DRAFT } from '../../ai/generators/reddit-draft.generator';
import { GATE_PARAMETER_KEYS } from '../../contracts/parameters';
import {
  aiGateState,
  aiMonthState,
  platformBudgetHint,
  type AdminAiGate,
  type AdminAiMonth,
  type PlatformBudgetHint,
} from './admin-ai-state';
import { PubOperations } from '../../core/operation';
import { toProductCtx } from '../../core/product-access.service';
import { PublisherCoreController } from '../../core/product.controller';
import { ProductService } from '../../core/product.service';
import { PUB_ACTIONS_KEY, type PubRequestCtx } from '../../core/pub-role.guard';
import type { PubTx } from '../../core/ports';
import { can, deniedForKind, type PubAction } from '../../core/roles';
import { CONTENT_MACHINE, findTransition } from '../../core/state-machines';
import { sendEnvelope } from '../../distribution/http';
import { PublisherRedditController } from '../reddit.controller';
import {
  buildImportPlan,
  parseCsv,
  runImport,
  stableOpKey,
  type ImportHttp,
  type ImportReport,
  type ImportResponse,
} from '../research-import';
import {
  ADMIN_CONTENT_TRANSITIONS,
  ADMIN_QA_KINDS,
  ADMIN_SOURCE_KINDS,
  CX_ROUTES,
  RX_ROUTES,
  matchRoute,
  type AdminCtl,
  type AdminRoute,
  type CallArgs,
} from './admin-reddit-routes';

/** Имя платформенного продукта при `setup`. */
export const PLATFORM_PRODUCT_NAME = 'Платформа (Reddit)';
/** Потолок тела импорта (Р-RD-ADM-4; парсер — app.setup.ts). */
export const ADMIN_IMPORT_MAX_BYTES = 1024 * 1024;
/**
 * Внутренний дедлайн импорта (Р-RD-AUD-4): после него новые строки не
 * начинаются — остаток `not_attempted`/`deadline`, ответ 200 с частичным
 * отчётом (backend ждёт 240 с, Max Duration функций ≥ 300 с — DEPLOYMENT).
 */
export const ADMIN_IMPORT_DEADLINE_MS = 200_000;
/** Поля проекта в импорте — как у создания проекта (projects.service). */
export const ADMIN_IMPORT_TITLE_MAX = 120;
export const ADMIN_IMPORT_MARKET_MAX = 64;

export interface AdminRedditStatus {
  enabled: boolean;
  aiEnabled: boolean;
  platformSiteId: string | null;
  product: {
    id: string;
    siteId: string;
    kind: ProductCtx['kind'];
    mode: ProductCtx['mode'];
    status: ProductCtx['status'];
  } | null;
  gate: { open: boolean; missing: GateResult['missing'] } | null;
  /** v1.4 (Р-RD-ADM-14): гейт `ai_use` и генератор `pub.reddit.draft`. */
  aiGate: AdminAiGate | null;
  /** v1.4: месяц AI (Kyiv) — открыт ли и почему нет. */
  aiMonth: AdminAiMonth | null;
}

export type AdminTarget = 'rx' | 'cx';

/** Ответ-«пустышка» для вызовов без HTTP (импорт): то, что пишут обработчики. */
export class CaptureResponse {
  statusCode = 200;
  headersSent = false;
  body: unknown = undefined;
  readonly headers: Record<string, string> = {};
  status(n: number): this {
    this.statusCode = n;
    return this;
  }
  setHeader(k: string, v: string): this {
    this.headers[k.toLowerCase()] = v;
    return this;
  }
  set(h: Record<string, string>): this {
    for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
    return this;
  }
  json(b: unknown): this {
    this.body = b;
    this.headersSent = true;
    return this;
  }
  send(b: unknown): this {
    return this.json(b);
  }
}

type Q = Record<string, unknown>;

/** Текст отчёта импорта, похожий на контакт или ник, — не возвращается. */
export const IMPORT_REDACTED = '(приховано: схоже на контакт)';

/**
 * Отчёт импорта без контактов: строки CSV, отклонённые как `pii`/
 * `profile_ref`, CLI печатает как есть (ввод оператора на его машине), а
 * внутренний API их не возвращает (ответы Publisher без ПД, AT-CORE-09).
 */
export function redactReport(r: ImportReport): ImportReport {
  const bad = (t: string | undefined) =>
    !!t && (looksLikeContact(t) || hasProfileRef(t));
  return {
    ...r,
    items: r.items.map((i) => ({
      ...i,
      ref: bad(i.ref) ? IMPORT_REDACTED : i.ref,
      ...(i.detail !== undefined
        ? { detail: bad(i.detail) ? IMPORT_REDACTED : i.detail }
        : {}),
    })),
    warnings: (r.warnings ?? []).map((w) => ({
      ...w,
      ref: bad(w.ref) ? IMPORT_REDACTED : w.ref,
      ...(w.detail !== undefined
        ? { detail: bad(w.detail) ? IMPORT_REDACTED : w.detail }
        : {}),
    })),
  };
}

function sentOf(res: Response | CaptureResponse): boolean {
  return res.headersSent === true;
}

@Injectable()
export class AdminRedditService {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Флаг раздела: выключен — 404 без `details` (как `RedditEnabledGuard`). */
  assertEnabled(): void {
    if (!publisherRedditEnabled()) throw new PubError('PUB_NOT_FOUND');
  }

  private sys() {
    return this.db.system(
      'admin-reddit: платформенный сайт по ASSIST_INTERNAL_SITE_IDS (внутренний API Админки)',
    );
  }

  /** Платформенный сайт (id + кабинет) или null. */
  private async platformSite(): Promise<{
    id: string;
    accountId: string;
  } | null> {
    const siteId = publisherPlatformSiteId();
    if (!siteId) return null;
    return this.sys().site.findFirst({
      where: { id: siteId },
      select: { id: true, accountId: true },
    });
  }

  /** Продукт платформенного сайта или null (только этот сайт, Р-RD-ADM-1). */
  async findProduct(): Promise<ProductCtx | null> {
    const site = await this.platformSite();
    if (!site) return null;
    const row = await this.db.forAccount(site.accountId).pubProduct.findFirst({
      where: { siteId: site.id },
      select: {
        id: true,
        accountId: true,
        siteId: true,
        kind: true,
        mode: true,
        status: true,
        revision: true,
      },
    });
    return row ? toProductCtx(row) : null;
  }

  /** Продукт для маршрутов раздела: нет — 404 `PUB_PRODUCT_NONE`. */
  async product(): Promise<ProductCtx> {
    const p = await this.findProduct();
    if (!p) throw new PubError('PUB_PRODUCT_NONE');
    return p;
  }

  private tenant(p: ProductCtx): PubTx {
    return this.db.forAccount(p.accountId) as unknown as PubTx;
  }

  async status(): Promise<AdminRedditStatus> {
    const enabled = publisherRedditEnabled();
    const base = {
      enabled,
      aiEnabled: publisherRedditAiEnabled(),
      platformSiteId: publisherPlatformSiteId(),
    };
    const none = { product: null, gate: null, aiGate: null, aiMonth: null };
    if (!enabled) return { ...base, ...none };
    const p = await this.findProduct();
    if (!p) return { ...base, ...none };
    const db = this.tenant(p);
    const now = new Date();
    const g = await evaluateGate(db, p.id, 'reddit_publish', now);
    const ai = await this.aiState(db, p, now);
    return {
      ...base,
      product: {
        id: p.id,
        siteId: p.siteId,
        kind: p.kind,
        mode: p.mode,
        status: p.status,
      },
      gate: { open: g.open, missing: g.missing },
      ...ai,
    };
  }

  /**
   * Гейт `ai_use` (как у шлюза без контекста вызова: модель, инструкция и
   * покрытие набором проверяются при генерации; допуск без eval на стенде
   * снимает пункты `ai_config` так же, как шлюз) и месяц AI (Р-RD-ADM-14).
   */
  private async aiState(
    db: PubTx,
    p: ProductCtx,
    now: Date,
  ): Promise<{ aiGate: AdminAiGate; aiMonth: AdminAiMonth }> {
    const raw = await evaluateGate(db, p.id, 'ai_use', now);
    const missing = publisherAiUnevaluatedAllowed()
      ? raw.missing.filter((m) => m.kind !== 'ai_config')
      : raw.missing;
    const aiGate = aiGateState({
      flagOn: publisherRedditAiEnabled(),
      generatorEnabled:
        REDDIT_DRAFT.enabledInP0 || publisherStandFakeAi().enabled,
      gate: { open: missing.length === 0, missing },
    });
    const month = kyivMonthOf(now);
    const row = await db.pubAiBudgetMonth.findFirst({
      where: { productId: p.id, month },
      select: {
        capMicroUsd: true,
        spentMicroUsd: true,
        reservedMicroUsd: true,
      },
    });
    const aiKeys = GATE_PARAMETER_KEYS.ai_use as readonly string[];
    const aiParamsMissing = raw.missing.filter(
      (m) => m.kind === 'parameter' && aiKeys.includes(m.key),
    );
    const spend =
      row || aiParamsMissing.length
        ? null
        : await evaluateGate(db, p.id, 'spend', now, { category: 'tools' });
    return {
      aiGate,
      aiMonth: aiMonthState({ month, row, aiParamsMissing, spend }),
    };
  }

  /**
   * Завести платформенный продукт (идемпотентно): есть — 200 и он; нет —
   * `kind=working`, `mode=closed`, параметры-допущения — как при создании из
   * кабинета (`ProductService.create`, шаги пакетов), актор `admin:<id>`.
   */
  async setup(
    userId: string,
    raw: unknown,
  ): Promise<{
    status: number;
    body: AdminRedditStatus & { created: boolean };
  }> {
    if (raw !== undefined && raw !== null) {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw validationError([{ field: '$', code: 'type' }]);
      }
      const extra = Object.keys(raw);
      if (extra.length) {
        throw validationError(
          extra.map((field) => ({ field, code: 'unknown_field' })),
        );
      }
    }
    if (!publisherPlatformSiteId()) {
      throw new PubError('PUB_CONFLICT', {
        reason: 'platform_site_not_configured',
      });
    }
    const site = await this.platformSite();
    if (!site) {
      throw new PubError('PUB_CONFLICT', { reason: 'platform_site_missing' });
    }
    if (await this.findProduct()) {
      return {
        status: 200,
        body: { ...(await this.status()), created: false },
      };
    }
    const products = this.moduleRef.get(ProductService, { strict: false });
    const access = {
      ...adminRedditAccess(userId, ADMIN_SETUP_ACTIONS),
      admin: true,
    };
    try {
      await this.ops.run<{ productId: string }>(
        {
          m: adminMembership(site.accountId, userId),
          access,
          product: null,
          siteId: site.id,
          action: 'product.create',
          opKey: stableOpKey('reddit-admin-setup', site.id),
          scope: 'admin.reddit.setup',
          pathParams: { siteId: site.id },
          body: {},
        },
        async (tx, step) => {
          const p = await products.create(
            tx,
            site.accountId,
            site.id,
            { name: PLATFORM_PRODUCT_NAME, kind: 'working' },
            step.actor,
            step.now,
          );
          return { status: 201, body: { productId: p.id }, audit: [] };
        },
      );
    } catch (e) {
      // Гонка двух операторов (или повтор ключа другим): продукт уже есть.
      if (!(await this.findProduct())) throw e;
      return {
        status: 200,
        body: { ...(await this.status()), created: false },
      };
    }
    return { status: 201, body: { ...(await this.status()), created: true } };
  }

  // ── Вызов обработчиков кабинета ─────────────────────────────────────────

  private ctxFor(
    p: ProductCtx,
    userId: string,
    actions: PubAction[],
  ): PubRequestCtx {
    return {
      m: adminMembership(p.accountId, userId),
      product: p,
      access: adminRedditAccess(userId, ADMIN_REDDIT_ACTIONS),
      actions,
    };
  }

  /**
   * Те же проверки, что `PubRoleGuard` для маршрута: действие обработчика
   * (любое из `@PubAllow`) разрешено синтетическому доступу и не запрещено
   * для вида продукта.
   */
  private actionsOf(
    proto: object,
    name: string,
    ctx: Pick<PubRequestCtx, 'access' | 'product'>,
  ): PubAction[] {
    const fn = (proto as Record<string, unknown>)[name];
    const actions = (
      typeof fn === 'function'
        ? Reflect.getMetadata(PUB_ACTIONS_KEY, fn)
        : undefined
    ) as PubAction[] | undefined;
    if (!actions || actions.length === 0) {
      throw new Error(`admin-reddit: у обработчика ${name} нет @PubAllow`);
    }
    if (!actions.some((a) => can(ctx.access, a))) {
      throw new PubError('PUB_ROLE_REQUIRED', {
        action: actions[0],
        reason: 'admin_scope',
      });
    }
    if (
      ctx.product &&
      actions.every((a) => deniedForKind(a, ctx.product!.kind))
    ) {
      throw new PubError('PUB_ROLE_REQUIRED', {
        action: actions[0],
        reason: 'product_kind',
        kind: ctx.product.kind,
      });
    }
    return actions;
  }

  /** Reddit-материал этого продукта (вид), иначе 404 (как «нет»). */
  private async redditContent(
    db: PubTx,
    p: ProductCtx,
    contentId: string | null | undefined,
  ): Promise<{ status: string; revision: number }> {
    if (!contentId) throw new PubError('PUB_NOT_FOUND');
    const c = await db.pubContent.findFirst({
      where: { id: contentId, productId: p.id },
      select: { kind: true, status: true, revision: true },
    });
    if (!c || !(ADMIN_CONTENT_KINDS as readonly string[]).includes(c.kind)) {
      throw new PubError('PUB_NOT_FOUND');
    }
    return { status: c.status, revision: c.revision };
  }

  private async contentOfVersion(
    db: PubTx,
    p: ProductCtx,
    versionId: string | null | undefined,
  ): Promise<string | null> {
    if (!versionId) return null;
    const v = await db.pubContentVersion.findFirst({
      where: { id: versionId, productId: p.id },
      select: { contentId: true },
    });
    return v?.contentId ?? null;
  }

  /**
   * cx: объект пути — платформенного продукта И того вида, что открыт
   * Админке (`scope` маршрута); иначе 404, как несуществующий. Для
   * материала возвращает его статус (сужение перехода).
   */
  private async scopeObject(
    p: ProductCtx,
    route: AdminRoute<unknown>,
    params: Record<string, string>,
  ): Promise<{ status: string; revision: number } | null> {
    const db = this.tenant(p);
    switch (route.scope) {
      case undefined:
        return null;
      case 'cid':
        return this.redditContent(db, p, params.cid);
      case 'vid':
        return this.redditContent(
          db,
          p,
          await this.contentOfVersion(db, p, params.vid),
        );
      case 'reddit_source': {
        const src = await db.pubSource.findFirst({
          where: { id: params.id, productId: p.id, origin: 'reddit' },
          select: { id: true },
        });
        if (!src) throw new PubError('PUB_NOT_FOUND');
        return null;
      }
      case 'reddit_publication': {
        const pub = await db.pubPublication.findFirst({
          where: { id: params.id, productId: p.id },
          select: { versionId: true },
        });
        await this.redditContent(
          db,
          p,
          await this.contentOfVersion(db, p, pub?.versionId),
        );
        return null;
      }
      case 'reddit_approval': {
        const a = await db.pubApproval.findFirst({
          where: {
            id: params.id,
            productId: p.id,
            objectType: 'content_version',
          },
          select: { objectId: true },
        });
        await this.redditContent(
          db,
          p,
          await this.contentOfVersion(db, p, a?.objectId),
        );
        return null;
      }
      case 'reddit_ai_call': {
        const call = await db.pubAiCall.findFirst({
          where: {
            id: params.callId,
            productId: p.id,
            generator: { in: [...ADMIN_GENERATORS] },
          },
          select: { id: true },
        });
        if (!call) throw new PubError('PUB_NOT_FOUND');
        return null;
      }
    }
  }

  private narrow(
    route: AdminRoute<unknown>,
    body: unknown,
    content: { status: string } | null,
  ): void {
    const b = (
      body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    ) as Q;
    switch (route.narrow) {
      case 'qa_kind':
        if (!(ADMIN_QA_KINDS as readonly unknown[]).includes(b.kind)) {
          throw validationError([{ field: 'kind', code: 'enum' }]);
        }
        return;
      case 'source_kind':
        if (!(ADMIN_SOURCE_KINDS as readonly unknown[]).includes(b.kind)) {
          throw validationError([{ field: 'kind', code: 'enum' }]);
        }
        return;
      case 'withdraw':
        if (b.to !== 'withdrawn') {
          throw new PubError('PUB_TRANSITION_INVALID', {
            reason: 'admin_scope',
            allowed: ['withdrawn'],
          });
        }
        return;
      case 'content_transition': {
        const t =
          content && typeof b.to === 'string'
            ? findTransition(
                CONTENT_MACHINE,
                content.status as never,
                b.to as never,
              )
            : undefined;
        if (
          !t ||
          !(ADMIN_CONTENT_TRANSITIONS as readonly string[]).includes(t.action)
        ) {
          throw new PubError('PUB_TRANSITION_INVALID', {
            reason: 'admin_scope',
            allowed: [...ADMIN_CONTENT_TRANSITIONS],
          });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Экземпляр контроллера кабинета (тот же, что обслуживает кабинет). */
  private controller(ctl: AdminCtl): object {
    const get = <T>(cls: new (...a: never[]) => T): T =>
      this.moduleRef.get(cls, { strict: false });
    switch (ctl) {
      case 'reddit':
        return get(PublisherRedditController);
      case 'materials':
        return get(ContentMaterialsController);
      case 'sources':
        return get(ContentSourcesController);
      case 'distribution':
        return get(PublisherDistributionController);
      case 'ai':
        return get(PublisherAiController);
    }
  }

  /**
   * Вызвать обработчик кабинета по `rx/…` или `cx/…`. Ответ пишется в `res`
   * (как у кабинета: конверт или CSV); статус — тот, что выставил
   * обработчик. Путь вне списка — 404. `product` — уже найденный продукт
   * (импорт: один раз на весь импорт, Р-RD-AUD-4), иначе — поиск.
   */
  async dispatch(input: {
    userId: string;
    target: AdminTarget;
    method: string;
    path: string;
    query: Q;
    body: unknown;
    res: Response | CaptureResponse;
    product?: ProductCtx;
  }): Promise<void> {
    this.assertEnabled();
    const p = input.product ?? (await this.product());
    const res = input.res as Response;
    if (input.target === 'rx') {
      const hit = matchRoute(RX_ROUTES, input.method, input.path);
      if (!hit) throw new PubError('PUB_NOT_FOUND');
      const c = this.moduleRef.get(PublisherRedditController, {
        strict: false,
      });
      await this.invoke(c, hit.route, hit.params, p, input, res);
      return;
    }
    const hit = matchRoute(CX_ROUTES, input.method, input.path);
    if (!hit) throw new PubError('PUB_NOT_FOUND');
    await this.invoke(
      this.controller(hit.route.ctl),
      hit.route,
      hit.params,
      p,
      input,
      res,
    );
  }

  private async invoke<C extends object>(
    c: C,
    route: AdminRoute<C>,
    params: Record<string, string>,
    p: ProductCtx,
    input: { userId: string; query: Q; body: unknown },
    res: Response,
  ): Promise<void> {
    const base = this.ctxFor(p, input.userId, []);
    const actions = this.actionsOf(Object.getPrototypeOf(c), route.name, base);
    const ctx: PubRequestCtx = { ...base, actions };
    const content = await this.scopeObject(
      p,
      route as AdminRoute<unknown>,
      params,
    );
    this.narrow(route as AdminRoute<unknown>, input.body, content);
    const args: CallArgs = {
      ctx,
      p: params,
      q: input.query,
      body: input.body,
      res,
    };
    const out = await route.call(c, args);
    if (sentOf(res)) return;
    sendEnvelope(res, out ?? null, res.statusCode || 200);
  }

  // ── Параметры гейта (Р-RD-ADM-5) ───────────────────────────────────────

  private core(): PublisherCoreController {
    return this.moduleRef.get(PublisherCoreController, { strict: false });
  }

  private paramCtx(p: ProductCtx, userId: string, name: string): PubRequestCtx {
    const base = this.ctxFor(p, userId, []);
    const actions = this.actionsOf(
      PublisherCoreController.prototype,
      name,
      base,
    );
    return { ...base, actions };
  }

  private paramKey(key: string): string {
    if (!isAdminParameterKey(key)) throw new PubError('PUB_NOT_FOUND');
    return key;
  }

  /**
   * Ключи гейта и P-R, гейт `reddit_publish` и подсказки для значений, которые
   * Админка сама не знает: активная версия оффера (оффер ведёт кабинет) и id
   * владельца кабинета платформы (`responsibles`). Имён участников нет.
   * v1.4: ключи `ai_use` и бюджета (Р-RD-ADM-14) и подсказка бюджета «только
   * AI» из текущих значений `ai_budget_usd_month` × `ai_fx_rate`.
   */
  async params(userId: string): Promise<{
    items: ParameterView[];
    keys: string[];
    gate: { open: boolean; missing: GateResult['missing'] };
    hints: {
      offerActiveVersion: { offerVersionId: string; version: number } | null;
      accountOwnerMemberId: string | null;
      /** v1.4: бюджетные ключи «только AI» (закупок нет). */
      budget: PlatformBudgetHint;
    };
  }> {
    this.assertEnabled();
    const p = await this.product();
    const ctx = this.paramCtx(p, userId, 'listParameters');
    const all = (await this.core().listParameters(ctx)) as {
      items: ParameterView[];
    };
    const db = this.tenant(p);
    const g = await evaluateGate(db, p.id, 'reddit_publish', new Date());
    const offer = await db.pubOfferVersion.findFirst({
      where: { productId: p.id, status: 'active' },
      orderBy: { version: 'desc' },
      select: { id: true, version: true },
    });
    const owner = await db.siteAccountMember.findFirst({
      where: { role: 'owner' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    const items = all.items.filter((x) => isAdminParameterKey(x.key));
    const valueOf = (k: string) => items.find((x) => x.key === k)?.value;
    return {
      items,
      keys: [...ADMIN_PARAMETER_KEYS],
      gate: { open: g.open, missing: g.missing },
      hints: {
        offerActiveVersion: offer
          ? { offerVersionId: offer.id, version: offer.version }
          : null,
        accountOwnerMemberId: owner?.id ?? null,
        budget: platformBudgetHint({
          ai_budget_usd_month: valueOf('ai_budget_usd_month'),
          ai_fx_rate: valueOf('ai_fx_rate'),
          budget_total: valueOf('budget_total'),
        }),
      },
    };
  }

  async proposals(userId: string, key: string, q: Q): Promise<unknown> {
    this.assertEnabled();
    const p = await this.product();
    const k = this.paramKey(key);
    const ctx = this.paramCtx(p, userId, 'listProposals');
    const s = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return this.core().listProposals(
      ctx,
      k,
      s(q.status),
      s(q.before),
      s(q.limit),
    );
  }

  async propose(
    userId: string,
    key: string,
    body: unknown,
    res: Response,
  ): Promise<unknown> {
    this.assertEnabled();
    const p = await this.product();
    const k = this.paramKey(key);
    return this.core().propose(
      this.paramCtx(p, userId, 'propose'),
      k,
      body,
      res,
    );
  }

  async decide(
    userId: string,
    key: string,
    body: unknown,
    res: Response,
  ): Promise<unknown> {
    this.assertEnabled();
    const p = await this.product();
    const k = this.paramKey(key);
    return this.core().decide(this.paramCtx(p, userId, 'decide'), k, body, res);
  }

  // ── Импорт исследования (Р-RD-ADM-4) ───────────────────────────────────

  /** Тело импорта → сегмент и опции плана (400 по полям). */
  importInput(raw: unknown): {
    segment: string;
    communities: string;
    opportunities: string;
    keywords: string;
    projectTitle: string;
    locale: string;
    market: string;
  } {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw validationError([{ field: '$', code: 'type' }]);
    }
    const b = raw as Q;
    const issues: Array<{ field: string; code: string }> = [];
    const allowed = [
      'communitiesCsv',
      'opportunitiesCsv',
      'keywordsCsv',
      'projectTitle',
      'locale',
      'market',
      'segment',
    ];
    for (const k of Object.keys(b))
      if (!allowed.includes(k))
        issues.push({ field: k, code: 'unknown_field' });
    const csv = (k: string, required: boolean): string => {
      const v = b[k];
      if (v === undefined || v === null || v === '') {
        if (required) issues.push({ field: k, code: 'required' });
        return '';
      }
      if (typeof v !== 'string') {
        issues.push({ field: k, code: 'type' });
        return '';
      }
      return v;
    };
    const text = (
      k: string,
      max: number,
      re?: RegExp,
      def?: string,
    ): string => {
      const v = b[k] ?? def;
      if (v === undefined || v === null || v === '') {
        issues.push({ field: k, code: 'required' });
        return '';
      }
      if (typeof v !== 'string') {
        issues.push({ field: k, code: 'type' });
        return '';
      }
      const t = v.trim();
      if (t.length < 1 || [...t].length > max) {
        issues.push({ field: k, code: 'length' });
        return '';
      }
      if (re && !re.test(t)) issues.push({ field: k, code: 'format' });
      return t;
    };
    const out = {
      communities: csv('communitiesCsv', true),
      opportunities: csv('opportunitiesCsv', false),
      keywords: csv('keywordsCsv', false),
      // ui-2: границы и правило контактов — как у создания проекта.
      projectTitle: text('projectTitle', ADMIN_IMPORT_TITLE_MAX),
      locale: text('locale', 16, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
      market: text('market', ADMIN_IMPORT_MARKET_MAX),
      segment: text('segment', 40, /^[A-Za-z0-9_-]+$/, 'admin'),
    };
    for (const k of ['projectTitle', 'market'] as const)
      if (out[k] && looksLikeContact(out[k]))
        issues.push({ field: k, code: 'pii' });
      else if (out[k] && hasProfileRef(out[k]))
        issues.push({ field: k, code: 'profile_ref' });
    const bytes =
      Buffer.byteLength(out.communities) +
      Buffer.byteLength(out.opportunities) +
      Buffer.byteLength(out.keywords);
    if (bytes > ADMIN_IMPORT_MAX_BYTES) {
      throw new PubError('PUB_PAYLOAD_TOO_LARGE');
    }
    if (issues.length) throw validationError(issues);
    return out;
  }

  /**
   * План (`apply=false`, только чтение) или выполнение (`apply=true`) —
   * `runImport` с `ImportHttp` поверх `dispatch` (те же обработчики, тот же
   * актор, детерминированные `opKey`): повтор — «уже есть». Продукт —
   * один раз на импорт; строки фазы — пулом; дедлайн
   * `ADMIN_IMPORT_DEADLINE_MS` — частичный отчёт (Р-RD-AUD-4).
   */
  async importResearch(
    userId: string,
    raw: unknown,
    apply: boolean,
    opts: { deadlineMs?: number } = {},
  ): Promise<ImportReport> {
    const deadlineAt =
      Date.now() + (opts.deadlineMs ?? ADMIN_IMPORT_DEADLINE_MS);
    this.assertEnabled();
    const p = await this.product();
    const input = this.importInput(raw);
    const plan = buildImportPlan(
      [
        {
          segment: input.segment,
          communities: parseCsv(input.communities),
          opportunities: input.opportunities
            ? parseCsv(input.opportunities)
            : [],
          keywords: input.keywords ? parseCsv(input.keywords) : [],
        },
      ],
      {
        projectTitle: input.projectTitle,
        locale: input.locale,
        market: input.market,
        now: new Date(),
      },
    );
    return redactReport(
      await runImport(this.importHttp(p, userId), p.id, plan, apply, {
        deadlineAt,
      }),
    );
  }

  /** `ImportHttp` без сети: пути кабинета → `dispatch` в процессе. */
  importHttp(p: ProductCtx, userId: string): ImportHttp {
    const productPath = `/publisher/products/${p.id}`;
    const call = async (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      body?: Record<string, unknown>,
    ): Promise<ImportResponse> => {
      const u = new URL(path, 'http://in-process.invalid');
      if (method === 'GET' && u.pathname === productPath) {
        return {
          status: 200,
          body: {
            data: { id: p.id, features: { reddit: publisherRedditEnabled() } },
          },
        };
      }
      const prefix = `${productPath}/reddit/`;
      if (!u.pathname.startsWith(prefix)) {
        return { status: 404, body: { error: { code: 'PUB_NOT_FOUND' } } };
      }
      const res = new CaptureResponse();
      try {
        await this.dispatch({
          userId,
          target: 'rx',
          method,
          path: u.pathname.slice(prefix.length),
          query: Object.fromEntries(u.searchParams.entries()),
          body,
          res,
          product: p,
        });
        return {
          status: res.statusCode,
          body: (res.body ?? null) as ImportResponse['body'],
        };
      } catch (e) {
        if (e instanceof PubError) {
          return {
            status: e.getStatus(),
            body: { error: { code: e.code, details: e.details } },
          };
        }
        if (e instanceof HttpException) {
          return { status: e.getStatus(), body: { error: { code: 'HTTP' } } };
        }
        throw e;
      }
    };
    return {
      get: (path) => call('GET', path),
      post: (path, body) => call('POST', path, body),
      patch: (path, body) => call('PATCH', path, body),
    };
  }
}
