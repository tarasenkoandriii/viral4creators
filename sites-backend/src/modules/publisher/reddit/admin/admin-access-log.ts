/**
 * AI Publisher, P-R-ADM — журнал доступа Админки к вкладке «Reddit»
 * (Р-RD-ADM-7, v1.2): таблица `pub_reddit_admin_access_log` (вне тенанта,
 * append-only): кто (`admin:<userId>`), метод, ШАБЛОН маршрута (без id,
 * query и тел), статус ответа, время. Пишется ДО завершения ответа
 * (`AdminRedditGuard`, аудит adm-1; обрыв клиентом — статус 499); сбой
 * записи — предупреждение в журнале процесса, не ошибка запроса.
 * Ретенция — 365 дней, задание `admin-access-log-retention` (daily, P-R);
 * удалить строку моложе срока не даёт и сама база.
 *
 * Таблица журнала «Помощника» (`assist_platform_access_log`) Publisher
 * недоступна по графу (`publisher-names`), поэтому своя.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../../prisma/sites-db.service';
import { PubContribution } from '../../core/contributions';
import type { CronJob, CronResult, PubCronContext } from '../../core/ports';
import { CX_ROUTES, RX_ROUTES, matchRoute } from './admin-reddit-routes';

export const ADMIN_ACCESS_LOG_RETENTION_DAYS = 365;
const BATCH = 5000;
const PREFIX = '/internal/admin/reddit/';

export interface AdminAccessEntry {
  actor: string;
  method: string;
  route: string;
  status: number;
}

/** Свои маршруты контроллера (не `rx|cx`). */
const FIXED_ROUTES = [
  'status',
  'setup',
  'params',
  'import/plan',
  'import/apply',
] as const;
const PARAM_ACTIONS = ['proposals', 'propose', 'decide'] as const;

/** Значение `route` для пути вне известных шаблонов (аудит adm-2). */
export const UNKNOWN_ROUTE = 'unknown';

/**
 * Шаблон маршрута по пути запроса: `rx/projects/:id`, `params/:key/propose`,
 * `cx/ai/calls/:callId` (регистр шаблона сохраняется — триггер журнала
 * допускает заглавные с миграции 20261024090000); путь `rx|cx` вне таблиц —
 * `rx/unknown`; прочее вне контроллера — `unknown`. Каждое значение проходит
 * проверку триггера `pub_reddit_admin_access_log_guard` (тест на все 71).
 */
export function accessRouteOf(method: string, path: string): string {
  const i = path.indexOf(PREFIX);
  if (i === -1) return UNKNOWN_ROUTE;
  const rest = path.slice(i + PREFIX.length);
  const m = /^(rx|cx)\/(.*)$/.exec(rest);
  if (m) {
    const hit = matchRoute(m[1] === 'rx' ? RX_ROUTES : CX_ROUTES, method, m[2]);
    return hit ? `${m[1]}/${hit.route.pattern}` : `${m[1]}/${UNKNOWN_ROUTE}`;
  }
  const fixed = FIXED_ROUTES.find((r) => rest === r);
  if (fixed) return fixed;
  const p = /^params\/[A-Za-z0-9_]{1,64}\/(proposals|propose|decide)$/.exec(
    rest,
  );
  return p ? `params/:key/${p[1]}` : UNKNOWN_ROUTE;
}

/**
 * Все значения `route`, которые пишет журнал: 63 шаблона `rx|cx` + 8 своих
 * маршрутов контроллера (= 71) и значения для неизвестного пути.
 */
export function accessRouteTemplates(): string[] {
  return [
    ...RX_ROUTES.map((r) => `rx/${r.pattern}`),
    ...CX_ROUTES.map((r) => `cx/${r.pattern}`),
    ...FIXED_ROUTES,
    ...PARAM_ACTIONS.map((a) => `params/:key/${a}`),
    UNKNOWN_ROUTE,
    `rx/${UNKNOWN_ROUTE}`,
    `cx/${UNKNOWN_ROUTE}`,
  ];
}

@Injectable()
export class AdminAccessLog {
  private readonly logger = new Logger('AdminReddit');

  constructor(private readonly db: SitesDb) {}

  async write(e: AdminAccessEntry): Promise<void> {
    try {
      await this.db
        .system(
          'admin-reddit: журнал доступа оператора платформы (вне кабинета)',
        )
        .pubRedditAdminAccessLog.create({
          data: {
            actor: e.actor,
            method: ['GET', 'POST', 'PATCH'].includes(e.method)
              ? e.method
              : 'GET',
            route: e.route.slice(0, 200),
            status: e.status,
          },
        });
    } catch (err) {
      this.logger.warn(
        `журнал доступа не записан: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }
}

/** Ретенция журнала доступа: строки старше 365 дней (по часам базы). */
@Injectable()
@PubContribution('cron-job')
export class AdminAccessLogRetentionJob implements CronJob {
  readonly key = 'admin-access-log-retention';
  readonly schedule = 'daily' as const;

  constructor(private readonly db: SitesDb) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher admin-access-log-retention: журнал доступа Админки (вне кабинета)',
    );
    let removed = 0;
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const n = await system.$executeRaw`
        DELETE FROM "sites"."pub_reddit_admin_access_log"
         WHERE "id" IN (SELECT "id" FROM "sites"."pub_reddit_admin_access_log"
                         WHERE "at" < now() - make_interval(days => ${ADMIN_ACCESS_LOG_RETENTION_DAYS}::int)
                         LIMIT ${BATCH})`;
      removed += n;
      if (n < BATCH) break;
    }
    return { processed: removed, details: { accessLogRemoved: removed } };
  }
}
