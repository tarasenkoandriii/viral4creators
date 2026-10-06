/**
 * SiteAccountGuard — кабинет и права для маршрутов ядра и продуктов.
 *
 * Идёт ПОСЛЕ глобального `TelegramIdentityGuard` (агент C, telegram-auth):
 * тот проверил initData своего бота и положил `req.identity`; здесь по
 * `telegramId` находится участник кабинета и проверяются:
 *  - `@RequireAccountRoles('owner', 'manager')` — роль в кабинете;
 *  - `@RequireProductRoles({ assistAdmin: ['owner'] })` — права по
 *    продукту (К-9: маршруты `…/knowledge/admin/*` и прочее «Админки»
 *    требуют `assistAdmin`, оператор помощника получает 403).
 *
 * Переиспользуется модулями помощника и QA: `@UseGuards(SiteAccountGuard)`
 * на контроллере + декораторы на маршрутах. Участник — в `@Membership()`.
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { IdentifiedRequest } from '../../telegram-auth/identity';
import { forbidden } from '../site-core.constants';
import { AccountService } from './account.service';
import {
  AccountMembership,
  AccountRole,
  ProductRoleRequirement,
  satisfiesProductRoles,
} from './roles';

export const ACCOUNT_ROLES_KEY = 'sites:account-roles';
export const PRODUCT_ROLES_KEY = 'sites:product-roles';

/**
 * Какой кабинет открыть, если человек состоит в нескольких (агентство +
 * свой). Без заголовка — свой (`owner`), иначе самый ранний по членству
 * (`defaultMembership`, аудит Н-1), но не последний, куда добавили.
 */
export const SITE_ACCOUNT_HEADER = 'x-site-account';

export function RequireAccountRoles(...roles: AccountRole[]) {
  if (roles.length === 0) {
    throw new Error('@RequireAccountRoles(): укажите хотя бы одну роль');
  }
  return SetMetadata(ACCOUNT_ROLES_KEY, roles);
}

export function RequireProductRoles(req: ProductRoleRequirement) {
  if (Object.keys(req).length === 0) {
    throw new Error('@RequireProductRoles(): пустое требование');
  }
  return SetMetadata(PRODUCT_ROLES_KEY, req);
}

export type MemberRequest = IdentifiedRequest & {
  siteMember?: AccountMembership;
};

/** Участник кабинета текущего запроса (после SiteAccountGuard). */
export const Membership = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccountMembership => {
    const req = ctx.switchToHttp().getRequest<MemberRequest>();
    if (!req.siteMember) {
      // Маршрут без SiteAccountGuard — ошибка в коде, не в запросе.
      throw new Error('@Membership() без SiteAccountGuard');
    }
    return req.siteMember;
  },
);

export function requestedAccountId(
  req: Pick<IdentifiedRequest, 'headers'>,
): string | undefined {
  const raw = req.headers[SITE_ACCOUNT_HEADER];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
    ? v
    : undefined;
}

@Injectable()
export class SiteAccountGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accounts: AccountService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MemberRequest>();
    if (!req.identity) {
      // Глобальный гвард не отработал (маршрут объявлен публичным?) —
      // кабинетный маршрут без личности открывать нельзя.
      throw new UnauthorizedException('Откройте приложение из бота в Telegram');
    }
    const membership = await this.accounts.resolveMembership(
      req.identity.telegramId,
      requestedAccountId(req),
    );
    if (!membership) {
      throw forbidden(
        'ACCOUNT_REQUIRED',
        'Кабинет не найден — откройте приложение заново',
      );
    }
    const targets = [context.getHandler(), context.getClass()];
    const roles = this.reflector.getAllAndOverride<AccountRole[] | undefined>(
      ACCOUNT_ROLES_KEY,
      targets,
    );
    if (roles && !roles.includes(membership.role)) {
      throw forbidden(
        'ACCOUNT_ROLE_REQUIRED',
        'Недостаточно прав в кабинете для этого действия',
      );
    }
    const product = this.reflector.getAllAndOverride<
      ProductRoleRequirement | undefined
    >(PRODUCT_ROLES_KEY, targets);
    if (product && !satisfiesProductRoles(membership, product)) {
      throw forbidden(
        'PRODUCT_ROLE_REQUIRED',
        'Нет доступа к этому разделу — попросите владельца кабинета выдать права',
      );
    }
    req.siteMember = membership;
    return true;
  }
}
