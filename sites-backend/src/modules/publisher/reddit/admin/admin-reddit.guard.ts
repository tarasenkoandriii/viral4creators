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
 *
 * Когда пишется строка (аудит 15.10.2026, adm-1): ДО завершения ответа —
 * `res.end` откладывается до записи (как журнал «Помощника»: функция Node
 * живёт, пока обработчик не ответил), так что строка есть у любого ответа —
 * конверта, CSV, ошибки фильтра, `@Res()`-обработчиков `rx/*`/`cx/*`.
 * Заголовки уходят сразу (`headersSent` — как без журнала), тело — после
 * записи; запись ограничена `ACCESS_LOG_WAIT_MS`, сбой — предупреждение.
 * Клиент ушёл раньше ответа (`close` без завершения: backend оборвал запрос
 * по таймауту) — строка со статусом 499 сразу; поздний ответ обработчика её
 * не дублирует (одна строка на запрос).
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
/** Статус строки журнала, если клиент закрыл соединение до ответа. */
export const CLIENT_CLOSED_STATUS = 499;
/** Сколько ответ ждёт запись журнала (база недоступна — не дольше). */
export const ACCESS_LOG_WAIT_MS = 3000;

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
    this.journal(req, res, actor, path, route);
    return true;
  }

  /** Одна строка журнала на запрос: до конца ответа или 499 при обрыве. */
  private journal(
    req: Request,
    res: Response,
    actor: string,
    path: string,
    route: string,
  ): void {
    let pending: Promise<void> | null = null;
    const write = (status: number): Promise<void> => {
      if (!pending) {
        this.logger.log(`admin:${actor} ${req.method} ${path} → ${status}`);
        // Журнал доступа в базе (Р-RD-ADM-7): шаблон маршрута, без id и тел.
        pending = bounded(
          this.log.write({
            actor: adminActor(actor),
            method: req.method,
            route,
            status,
          }),
          ACCESS_LOG_WAIT_MS,
        );
      }
      return pending;
    };
    type End = (...args: unknown[]) => Response;
    const end = (res.end as End).bind(res);
    (res as unknown as { end: End }).end = (...args: unknown[]) => {
      // Статус и заголовки — сейчас (обработчики сверяют `headersSent`),
      // тело и завершение ответа — после записи журнала.
      if (!res.headersSent) res.flushHeaders();
      void write(res.statusCode).then(() => end(...args));
      return res;
    };
    res.once('close', () => {
      if (!res.writableFinished) void write(CLIENT_CLOSED_STATUS);
    });
  }
}

/** Промис, но не дольше `ms` (таймер не держит процесс). */
function bounded(p: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** id оператора Админки (после `AdminRedditGuard`). */
export const AdminRedditUser = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string => {
    const u = ctx.switchToHttp().getRequest<AdminReq>().adminRedditUser;
    if (!u) throw new Error('@AdminRedditUser() без AdminRedditGuard');
    return u;
  },
);
