/**
 * AI Publisher — ревалидация сайта продукта (Р-PUB-Z2-8, запрос P-F 17.4
 * №1; проектный документ §13.3, §13.7, §15.1 `site-revalidate`).
 *
 * После снятия материала (материал или публикация → `withdrawn`, отзыв
 * согласования) и закрытия гейта `public_publish` (решение `rejected|
 * revoked` по его ключу, уход продукта из `live`) сайт `publisher-site`
 * должен сбросить ISR-кэш сразу, а не через окно 300 с: задание вызывает
 * `POST <PUBLISHER_SITE_URL>/api/revalidate` с
 * `Authorization: Bearer <PUBLISHER_REVALIDATE_SECRET>` (формат маршрута
 * сайта).
 *
 * Очередь — журнал аудита (transactional outbox без новой таблицы): события
 * выше пишутся в ТОЙ ЖЕ транзакции, что и изменение, — задание видит только
 * зафиксированное и ничего не делает внутри транзакции операции. Успешный
 * вызов отмечается записью аудита продукта (`system:site-revalidate`,
 * `meta.eventIds` — какие события покрыты); событие без отметки — в работе:
 * неудача (сеть, 5xx, таймаут 5 с) повторяется следующим проходом
 * (каждую минуту) в пределах окна `SITE_REVALIDATE_WINDOW_MS`; позже сайт
 * уже обновился сам (ISR 300 с, список снятых — 60 с).
 *
 * Без SSRF: адрес — только из конфигурации (https-origin, путь фиксирован,
 * переадресации не выполняются). Без конфигурации — no-op с предупреждением
 * в журнале, не ошибка прохода.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import { publisherRevalidateTarget } from '../../../config/publisher-env';
import { GATE_PARAMETER_KEYS } from '../contracts/parameters';
import { AuditService } from './audit';
import { PubContribution } from './contributions';
import type { CronJob, CronResult, PubCronContext } from './ports';

export const SITE_REVALIDATE_ACTOR = 'system:site-revalidate';
/** Окно повторов: старше — сайт уже обновился по ISR. */
export const SITE_REVALIDATE_WINDOW_MS = 60 * 60 * 1000;
export const SITE_REVALIDATE_TIMEOUT_MS = 5000;
/** Событий в одной отметке (meta ≤ 8 КБ). */
const MARK_MAX = 200;
const SCAN_MAX = 1000;

/** HTTP-вызов сайта (тест подменяет фейком). */
export type RevalidateHttp = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<{ status: number }>;
export const SITE_REVALIDATE_HTTP = 'publisher:site-revalidate-http';
/** Источник env (тест подменяет объектом). */
export const SITE_REVALIDATE_ENV = 'publisher:site-revalidate-env';

const defaultHttp: RevalidateHttp = (url, init) => fetch(url, init);

interface PendingRow {
  id: string;
  productId: string;
  accountId: string;
}

@Injectable()
@PubContribution('cron-job')
export class SiteRevalidateJob implements CronJob {
  readonly key = 'site-revalidate';
  readonly schedule = 'minute' as const;
  private readonly log = new Logger('PublisherSiteRevalidate');
  private warned = false;

  constructor(
    private readonly db: SitesDb,
    private readonly audit: AuditService,
    @Optional()
    @Inject(SITE_REVALIDATE_HTTP)
    private readonly http: RevalidateHttp = defaultHttp,
    @Optional()
    @Inject(SITE_REVALIDATE_ENV)
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** События, требующие ревалидации и ещё не покрытые отметкой. */
  async pending(
    ctx: Pick<PubCronContext, 'now' | 'scope'>,
  ): Promise<PendingRow[]> {
    const system = this.db.system(
      'крон publisher site-revalidate: события снятия всех кабинетов',
    );
    const since = new Date(ctx.now.getTime() - SITE_REVALIDATE_WINDOW_MS);
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const keys = [...GATE_PARAMETER_KEYS.public_publish] as string[];
    return system.$queryRaw<PendingRow[]>`
      SELECT e."id", e."productId", p."accountId"
        FROM "sites"."pub_products" p
        JOIN "sites"."pub_audit_events" e ON e."productId" = p."id"
       WHERE p."kind" IN ('working', 'test') ${scope}
         AND e."occurredAt" > ${since}
         AND (   (e."objectType" IN ('content', 'publication') AND e."toStatus" = 'withdrawn')
              OR (e."objectType" = 'approval' AND e."toStatus" = 'revoked')
              OR (e."objectType" = 'product' AND e."action" = 'transition'
                  AND e."fromStatus" = 'live' AND e."meta" ->> 'field' = 'mode')
              OR (e."objectType" = 'parameter' AND e."action" IN ('reject', 'revoke')
                  AND e."meta" ->> 'parameterKey' = ANY(${keys}::text[])))
         AND NOT EXISTS (
               SELECT 1 FROM "sites"."pub_audit_events" m
                WHERE m."productId" = e."productId" AND m."occurredAt" > ${since}
                  AND m."actor" = ${SITE_REVALIDATE_ACTOR}
                  AND m."meta" -> 'eventIds' @> jsonb_build_array(e."id"))
       ORDER BY e."occurredAt", e."id"
       LIMIT ${SCAN_MAX}`;
  }

  async run(ctx: PubCronContext): Promise<CronResult> {
    const rows = await this.pending(ctx);
    if (rows.length === 0) return { processed: 0, details: { pending: 0 } };
    const { target, problem } = publisherRevalidateTarget(this.env);
    if (!target) {
      // Не ошибка: сайт обновится сам по ISR; владелец видит предупреждение.
      if (!this.warned) {
        this.log.warn(
          `ревалидация сайта не настроена (${problem}) — ${rows.length} событий снятия ждут окна ISR`,
        );
        this.warned = true;
      }
      return {
        processed: 0,
        details: { pending: rows.length, configured: false },
      };
    }
    if (Date.now() > ctx.deadline.getTime()) {
      return { processed: 0, details: { pending: rows.length, skipped: true } };
    }
    let status = 0;
    try {
      const r = await this.http(target.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.secret}`,
          'content-type': 'application/json',
        },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(SITE_REVALIDATE_TIMEOUT_MS),
      });
      status = r.status;
    } catch (e) {
      const err = e instanceof Error ? e.name : 'error';
      this.log.warn(
        `ревалидация сайта: сбой вызова (${err}) — повтор следующим проходом`,
      );
      return {
        processed: 0,
        details: { pending: rows.length, failed: true, error: err },
      };
    }
    if (status < 200 || status >= 300) {
      this.log.warn(
        `ревалидация сайта: ответ ${status} — повтор следующим проходом`,
      );
      return {
        processed: 0,
        details: { pending: rows.length, failed: true, status },
      };
    }
    // Отметки — по продукту, короткой транзакцией кабинета (не в операции).
    const byProduct = new Map<string, { accountId: string; ids: string[] }>();
    for (const r of rows) {
      const g = byProduct.get(r.productId) ?? {
        accountId: r.accountId,
        ids: [],
      };
      g.ids.push(r.id);
      byProduct.set(r.productId, g);
    }
    for (const [productId, g] of byProduct) {
      for (let i = 0; i < g.ids.length; i += MARK_MAX) {
        const eventIds = g.ids.slice(i, i + MARK_MAX);
        await this.db.forAccount(g.accountId).$transaction((tx) =>
          this.audit.write(tx, {
            accountId: g.accountId,
            productId,
            actor: SITE_REVALIDATE_ACTOR,
            objectType: 'product',
            objectId: productId,
            action: 'update',
            meta: { field: 'siteRevalidate', status, eventIds },
          }),
        );
      }
    }
    return {
      processed: rows.length,
      details: { products: byProduct.size, status },
    };
  }
}
