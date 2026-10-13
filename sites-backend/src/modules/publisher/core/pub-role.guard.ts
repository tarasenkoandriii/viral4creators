/**
 * AI Publisher — гвард ролей продукта и декораторы маршрутов кабинета
 * (P-A1, проектный документ §4, §11.1).
 *
 *   @PubCabinetController('products/:pid/parameters')
 *   class X { @Post() @PubAllow('parameter.propose') … }
 *
 * `PubCabinetController` = `@Controller('publisher/…')` + `@AllowApps('assist')`
 * + `@UseGuards(SiteAccountGuard, PubRoleGuard)` + `@RequireProductRoles(
 * REQUIRE_PUBLISHER_ANY)` + `@UseFilters(PubExceptionFilter)`.
 *
 * `PubRoleGuard` (после `SiteAccountGuard`, который нашёл членство):
 *  - продукт из `:pid` (или `:siteId`) — только кабинета участника, иначе
 *    404 `PUB_NOT_FOUND` одинаково для «нет» и «чужой» (AT-CORE-08);
 *  - права — гранты на КАЖДОМ запросе (AT-CORE-11), матрица §4.2;
 *  - маршрут без `@PubAllow` — отказ (а тест матрицы роняет сборку раньше).
 * Результат — `@PubRequest()`: продукт, права, действие.
 */
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UseFilters,
  UseGuards,
  applyDecorators,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PUBLISHER_ANY } from '../../site-core/account/roles';
import {
  RequireProductRoles,
  SiteAccountGuard,
  type MemberRequest,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type { AccountMembership } from '../../site-core/account/roles';
import type { ProductCtx } from '../contracts/common';
import { PUB_NO_STORE, PubError, PubExceptionFilter } from './errors';
import { ProductAccessService } from './product-access.service';
import {
  PUB_PERMISSIONS,
  can,
  deniedForKind,
  isPubAction,
  type PubAccess,
  type PubAction,
} from './roles';

export const PUB_ACTIONS_KEY = 'publisher:actions';
/** Префикс маршрутов кабинета Publisher (§11.3). */
export const PUBLISHER_ROUTE_PREFIX = 'publisher';

/**
 * Действие(я) матрицы маршрута; несколько — «любое из» (тонкую проверку,
 * например `retention_review` для продаж, делает сервис).
 */
export function PubAllow(...actions: PubAction[]) {
  if (actions.length === 0) throw new Error('@PubAllow(): укажите действие');
  for (const a of actions) {
    if (!isPubAction(a)) {
      throw new Error(
        `@PubAllow(): действия «${String(a)}» нет в матрице §4.2`,
      );
    }
  }
  return SetMetadata(PUB_ACTIONS_KEY, [...actions]);
}

/**
 * `Cache-Control: private, no-store` на КАЖДОМ ответе кабинета (аудит
 * P3-3, §11.3): журнал, параметры с ответственными, карточки заявок и
 * раскрытие контакта (P-D) не должны оседать в кэше браузера и прокси.
 * Ставится первым «гвардом» — до проверки членства, поэтому заголовок
 * есть и у отказов 401/403/404; ничего не запрещает.
 */
@Injectable()
export class PubNoStoreGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx
      .switchToHttp()
      .getResponse<{ setHeader(k: string, v: string): void }>()
      .setHeader('Cache-Control', PUB_NO_STORE);
    return true;
  }
}

export function PubCabinetController(path = '') {
  const full = [PUBLISHER_ROUTE_PREFIX, path].filter(Boolean).join('/');
  return applyDecorators(
    Controller(full),
    AllowApps('assist'),
    UseGuards(PubNoStoreGuard, SiteAccountGuard, PubRoleGuard),
    RequireProductRoles(REQUIRE_PUBLISHER_ANY),
    UseFilters(PubExceptionFilter),
  );
}

export interface PubRequestCtx {
  m: AccountMembership;
  /** null — маршрут уровня сайта, продукта ещё нет. */
  product: ProductCtx | null;
  access: PubAccess;
  actions: PubAction[];
}

export type PubHttpRequest = MemberRequest & {
  params?: Record<string, string>;
  pub?: PubRequestCtx;
};

export const PubRequest = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PubRequestCtx => {
    const req = ctx.switchToHttp().getRequest<PubHttpRequest>();
    if (!req.pub) throw new Error('@PubRequest() без PubRoleGuard');
    return req.pub;
  },
);

@Injectable()
export class PubRoleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly products: ProductAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PubHttpRequest>();
    const m = req.siteMember;
    if (!m) throw new Error('PubRoleGuard без SiteAccountGuard');
    const actions = this.reflector.getAllAndOverride<PubAction[] | undefined>(
      PUB_ACTIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!actions || actions.length === 0) {
      // Маршрут Publisher без действия матрицы — закрыт (и тест роняет его).
      throw new PubError('PUB_ROLE_REQUIRED', { action: null });
    }
    const params = req.params ?? {};
    let product: ProductCtx | null = null;
    if (params.pid !== undefined) {
      product = await this.products.resolveProduct(m, params.pid);
    } else if (params.siteId !== undefined) {
      product = await this.products.resolveProductBySite(m, params.siteId);
    } else {
      throw new Error('PubRoleGuard: маршрут без :pid и :siteId');
    }
    const siteLevel = actions.every(
      (a) => (PUB_PERMISSIONS[a] as { siteLevel?: boolean }).siteLevel === true,
    );
    if (!product && !siteLevel) throw new PubError('PUB_NOT_FOUND');
    const access = await this.products.accessFor(m, product);
    // Продукта ещё нет: «продукт сайта» читает любой допущенный к Publisher
    // участник (ответ — PUB_PRODUCT_NONE), ролей продукта у него быть не может.
    const ok = actions.some(
      (a) => can(access, a) || (a === 'site.product.read' && product === null),
    );
    if (!ok) {
      throw new PubError('PUB_ROLE_REQUIRED', { action: actions[0] });
    }
    // Р-PUB-Z2-2: действие, запрещённое для вида продукта, — 403 всем,
    // включая владельца кабинета (неявные роли), до решения владельца.
    if (product && actions.every((a) => deniedForKind(a, product.kind))) {
      throw new PubError('PUB_ROLE_REQUIRED', {
        action: actions[0],
        reason: 'product_kind',
        kind: product.kind,
      });
    }
    req.pub = { m, product, access, actions };
    return true;
  }
}
