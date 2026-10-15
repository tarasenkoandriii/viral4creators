/**
 * AI Publisher, P-R-ADM — вход внутреннего API вкладки «Reddit» Админки
 * (Р-RD-ADM-2, Р-RD-ADM-6): секрет `X-Sites-Internal-Secret` (общий
 * `assertInternalSecret`: нет env — 503, нет/неверный — 401 одинаково),
 * затем `X-Admin-Actor` — id пользователя backend (`ADMIN_USER_ID_RE`);
 * нет или не тот формат — 400 `ADMIN_ACTOR_REQUIRED` (оператор уже
 * проверен backend-ом: это ошибка вызывающего кода, не входа).
 *
 * Журнал доступа Админки (Р-RD-ADM-7) на каждый запрос с актором: строка
 * `pub_reddit_admin_access_log` (актор, метод, шаблон маршрута, статус) и строка
 * журнала процесса; тела и query не пишутся. Секрет до разбора тела
 * проверяет ещё и middleware `app.setup.ts` (v1.2).
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  createParamDecorator,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ADMIN_ACTOR_HEADER,
  INTERNAL_SECRET_HEADER,
  assertInternalSecret,
  headerOf,
} from '../../../../common/internal-secret.guard';
import { ADMIN_USER_ID_RE, adminActor } from '../../contracts/common';
import { AdminAccessLog, accessRouteOf } from './admin-access-log';
import { PUB_NO_STORE } from '../../core/errors';

export const ADMIN_ACTOR_REQUIRED = 'ADMIN_ACTOR_REQUIRED';

type AdminReq = Request & { adminRedditUser?: string };

@Injectable()
export class AdminRedditGuard implements CanActivate {
  private readonly logger = new Logger('AdminReddit');

  constructor(private readonly log: AdminAccessLog) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const req = http.getRequest<AdminReq>();
    const res = http.getResponse<Response>();
    res.setHeader('Cache-Control', PUB_NO_STORE);
    assertInternalSecret(headerOf(req, INTERNAL_SECRET_HEADER));
    const actor = headerOf(req, ADMIN_ACTOR_HEADER)?.trim();
    if (!actor || !ADMIN_USER_ID_RE.test(actor)) {
      throw new BadRequestException({
        error: ADMIN_ACTOR_REQUIRED,
        message: 'Нет X-Admin-Actor (id оператора Админки)',
      });
    }
    req.adminRedditUser = actor;
    const path = req.path ?? (req.url ?? '').split('?')[0];
    const route = accessRouteOf(req.method, path);
    res.once('finish', () => {
      this.logger.log(
        `admin:${actor} ${req.method} ${path} → ${res.statusCode}`,
      );
      // Журнал доступа в базе (Р-RD-ADM-7): шаблон маршрута, без id и тел.
      void this.log.write({
        actor: adminActor(actor),
        method: req.method,
        route,
        status: res.statusCode,
      });
    });
    return true;
  }
}

/** id оператора Админки (после `AdminRedditGuard`). */
export const AdminRedditUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string => {
    const u = ctx.switchToHttp().getRequest<AdminReq>().adminRedditUser;
    if (!u) throw new Error('@AdminRedditUser() без AdminRedditGuard');
    return u;
  },
);
