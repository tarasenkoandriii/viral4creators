/**
 * AI Publisher — статусы интеграций и ручной импорт метрик (P-E,
 * проектный документ §6.2 `pub_integrations`, §6.6 `pub_metric_imports`,
 * §7.5; ТЗ §18; AT-CORE-12).
 *
 *  - Интеграция: `connected | degraded | disconnected` + последняя успешная
 *    синхронизация. Строки нет — экран видит `disconnected`, а не
 *    «подключено». `connected` автоматически становится `degraded`, если
 *    `now − lastSuccessAt > staleAfterHours` (задание
 *    `integrations-staleness`); гейт `purchases` (P-A1) читает то же правило
 *    сам, не дожидаясь крона.
 *  - Ручной импорт: суточные агрегаты Kyiv (Search Console, веб-аналитика),
 *    источник и дата фиксируются (append-only); метрика с иным
 *    определением — под своим именем (`extra`), подмена определения
 *    запрещена (ТЗ §15). Импорт обновляет `lastSuccessAt` своего вида; новую
 *    строку интеграции создаёт `degraded` (данные есть, проверку
 *    подключения делает человек).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PubContribution } from '../core/contributions';
import type { ListPage } from '../contracts/common';
import type { FieldIssue } from '../contracts/errors';
import type {
  IntegrationView,
  MetricImportView,
} from '../contracts/reports-api';
import {
  INTEGRATION_KINDS,
  INTEGRATION_STATUSES,
  METRIC_IMPORT_SOURCES,
  isOneOf,
  type IntegrationKind,
  type IntegrationStatus,
} from '../contracts/states';
import { PubError, validationError } from '../core/errors';
import { kyivDateOf } from '../core/kyiv-time';
import { piiIssues } from '../core/pii-guard';
import {
  PubPorts,
  type AuditInput,
  type CronJob,
  type CronResult,
  type ProductRef,
  type PubCronContext,
  type PubTx,
} from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';
import {
  INTEGRATION_MACHINE,
  assertTransition,
  type Actor,
} from '../core/state-machines';
import { SitesDb } from '../../../prisma/sites-db.service';
import { MAX_STALE_AFTER_HOURS } from './metrics/report-compute';

type IntegrationRow = Prisma.PubIntegrationGetPayload<object>;
type ImportRow = Prisma.PubMetricImportGetPayload<object>;

const HOUR_MS = 3_600_000;
export const DEFAULT_STALE_AFTER_HOURS = 48;
/**
 * Потолок `staleAfterHours` (аудит P-E S3-5): неделя. Больше — по сути
 * отключение перевода в `degraded` и гейта закупок по свежести данных;
 * значения выше потолка в старых строках расчёт тоже ограничивает.
 */
export { MAX_STALE_AFTER_HOURS };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_KEYS = [
  'sessions',
  'engagedVisits',
  'impressions',
  'clicks',
] as const;

export function isStale(
  r: Pick<IntegrationRow, 'status' | 'lastSuccessAt' | 'staleAfterHours'>,
  now: Date,
): boolean {
  return (
    r.status === 'connected' &&
    (!r.lastSuccessAt ||
      now.getTime() - r.lastSuccessAt.getTime() >
        Math.min(r.staleAfterHours, MAX_STALE_AFTER_HOURS) * HOUR_MS)
  );
}

export function integrationView(
  kind: IntegrationKind,
  r: IntegrationRow | undefined,
  now: Date,
): IntegrationView {
  if (!r) {
    return {
      kind,
      exists: false,
      status: 'disconnected',
      manual: false,
      lastSuccessAt: null,
      lastCheckedAt: null,
      staleAfterHours: DEFAULT_STALE_AFTER_HOURS,
      stale: false,
      note: null,
      revision: null,
    };
  }
  return {
    kind,
    exists: true,
    status: r.status as IntegrationStatus,
    manual: r.manual,
    lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
    lastCheckedAt: r.lastCheckedAt?.toISOString() ?? null,
    staleAfterHours: r.staleAfterHours,
    stale: isStale(r, now),
    note: r.note,
    revision: r.revision,
  };
}

function optionalIso(
  v: unknown,
  field: string,
  issues: FieldIssue[],
): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string' || !/T/.test(v) || Number.isNaN(Date.parse(v))) {
    issues.push({ field, code: 'format' });
    return undefined;
  }
  return new Date(v);
}

@Injectable()
export class IntegrationsService {
  async list(
    tx: PubTx,
    product: ProductRef,
    now: Date,
  ): Promise<IntegrationView[]> {
    const rows = await tx.pubIntegration.findMany({
      where: { productId: product.id },
    });
    const by = new Map(rows.map((r) => [r.kind, r]));
    return INTEGRATION_KINDS.map((k) => integrationView(k, by.get(k), now));
  }

  async one(
    tx: PubTx,
    product: ProductRef,
    kind: IntegrationKind,
    now: Date,
  ): Promise<IntegrationView> {
    const r = await tx.pubIntegration.findFirst({
      where: { productId: product.id, kind },
    });
    return integrationView(kind, r ?? undefined, now);
  }

  /** Ручная установка статуса (AN, PO, AD); переходы — машина §7.5. */
  async put(
    tx: PubTx,
    product: ProductRef,
    kind: unknown,
    body: Record<string, unknown>,
    actors: Actor[],
    actor: string,
    now: Date,
  ): Promise<{ kind: IntegrationKind; audit: AuditInput[] }> {
    if (!isOneOf(INTEGRATION_KINDS, kind)) throw new PubError('PUB_NOT_FOUND');
    const issues: FieldIssue[] = [];
    if (!isOneOf(INTEGRATION_STATUSES, body.status))
      issues.push({ field: 'status', code: 'enum' });
    let note: string | null | undefined;
    if (body.note !== undefined) {
      if (body.note === null) note = null;
      else if (
        typeof body.note !== 'string' ||
        !body.note.trim() ||
        [...body.note].length > 2000
      ) {
        issues.push({ field: 'note', code: 'length' });
      } else {
        note = body.note.trim();
        issues.push(...piiIssues({ note }));
      }
    }
    let stale: number | undefined;
    if (body.staleAfterHours !== undefined) {
      const n = body.staleAfterHours;
      if (
        typeof n !== 'number' ||
        !Number.isInteger(n) ||
        n < 1 ||
        n > MAX_STALE_AFTER_HOURS
      ) {
        issues.push({ field: 'staleAfterHours', code: 'range' });
      } else stale = n;
    }
    const lastSuccess = optionalIso(
      body.lastSuccessAt,
      'lastSuccessAt',
      issues,
    );
    if (lastSuccess && lastSuccess.getTime() > now.getTime())
      issues.push({ field: 'lastSuccessAt', code: 'future' });
    if (issues.length) throw validationError(issues);
    const to = body.status as IntegrationStatus;
    const cur = await tx.pubIntegration.findFirst({
      where: { productId: product.id, kind },
    });
    // `connected` — подтверждение человеком последней успешной синхронизации.
    const successAt = to === 'connected' ? (lastSuccess ?? now) : lastSuccess;
    if (!cur) {
      const row = await tx.pubIntegration.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          kind,
          status: to,
          manual: true,
          lastSuccessAt: successAt ?? null,
          lastCheckedAt: now,
          staleAfterHours: stale ?? DEFAULT_STALE_AFTER_HOURS,
          note: note ?? null,
          createdBy: actor,
        },
      });
      return {
        kind,
        audit: [
          {
            objectType: 'integration',
            objectId: row.id,
            action: 'create',
            toStatus: to,
            meta: { kind },
          },
        ],
      };
    }
    const expected = parseExpectedRevision(body.expectedRevision);
    if (cur.status !== to)
      assertTransition(
        INTEGRATION_MACHINE,
        cur.status as IntegrationStatus,
        to,
        { actors },
      );
    await casUpdate(tx.pubIntegration, cur.id, expected, {
      status: to,
      manual: true,
      lastCheckedAt: now,
      ...(successAt !== undefined ? { lastSuccessAt: successAt } : {}),
      ...(stale !== undefined ? { staleAfterHours: stale } : {}),
      ...(note !== undefined ? { note } : {}),
    });
    return {
      kind,
      audit: [
        {
          objectType: 'integration',
          objectId: cur.id,
          action: cur.status !== to ? 'transition' : 'update',
          fromStatus: cur.status,
          toStatus: to,
          meta: { kind },
        },
      ],
    };
  }

  /** Импорт обновил данные вида: `lastSuccessAt` (строки нет — `degraded`). */
  async markImported(
    tx: PubTx,
    product: ProductRef,
    kind: IntegrationKind,
    at: Date,
    actor: string,
    now: Date,
  ): Promise<void> {
    const cur = await tx.pubIntegration.findFirst({
      where: { productId: product.id, kind },
    });
    if (!cur) {
      await tx.pubIntegration.create({
        data: {
          accountId: product.accountId,
          productId: product.id,
          kind,
          status: 'degraded',
          manual: true,
          lastSuccessAt: at,
          lastCheckedAt: now,
          staleAfterHours: DEFAULT_STALE_AFTER_HOURS,
          createdBy: actor,
        },
      });
      return;
    }
    const next =
      !cur.lastSuccessAt || cur.lastSuccessAt.getTime() < at.getTime()
        ? at
        : cur.lastSuccessAt;
    await tx.pubIntegration.updateMany({
      where: { id: cur.id },
      data: {
        lastSuccessAt: next,
        lastCheckedAt: now,
        revision: { increment: 1 },
      },
    });
  }
}

export function metricImportView(r: ImportRow): MetricImportView {
  const days = (r.payload as { days?: unknown[] } | null)?.days;
  return {
    id: r.id,
    source: r.source,
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    granularity: 'kyiv_day',
    days: Array.isArray(days) ? days.length : 0,
    importedBy: r.importedBy,
    importedAt: r.importedAt.toISOString(),
    fileRef: r.fileRef,
    note: r.note,
  };
}

/** Проверка тела импорта: сутки Kyiv периода, числа ≥ 0 или null (неизвестно ≠ 0). */
export function parseImportPayload(
  payload: unknown,
  periodStart: Date,
  periodEnd: Date,
  now: Date = new Date(),
): {
  days: Array<Record<string, unknown>>;
  definitions?: Record<string, string>;
} {
  const issues: FieldIssue[] = [];
  const p = payload as { days?: unknown; definitions?: unknown } | null;
  if (
    !p ||
    typeof p !== 'object' ||
    !Array.isArray(p.days) ||
    p.days.length < 1 ||
    p.days.length > 20_000
  ) {
    throw validationError([{ field: 'payload.days', code: 'format' }]);
  }
  const first = kyivDateOf(periodStart);
  // Сутки — не позже даты импорта (Kyiv): данных о будущем нет (S3-5).
  const today = kyivDateOf(now);
  const end = kyivDateOf(periodEnd);
  const last = end < today ? end : today;
  const days = p.days.map((raw, i) => {
    const d = raw as Record<string, unknown>;
    const at = `payload.days.${i}`;
    if (!d || typeof d !== 'object') {
      issues.push({ field: at, code: 'type' });
      return {};
    }
    const out: Record<string, unknown> = {};
    if (
      typeof d.date !== 'string' ||
      !DATE_RE.test(d.date) ||
      d.date < first ||
      d.date > last
    ) {
      issues.push({ field: `${at}.date`, code: 'range' });
    } else out.date = d.date;
    if (d.page !== undefined && d.page !== null) {
      if (typeof d.page !== 'string' || !/^\/[^?#\s]{0,499}$/.test(d.page))
        issues.push({ field: `${at}.page`, code: 'format' });
      else out.page = d.page;
    }
    for (const k of METRIC_KEYS) {
      const v = d[k];
      if (v === undefined) continue;
      if (
        v !== null &&
        !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)
      ) {
        issues.push({ field: `${at}.${k}`, code: 'range' });
      } else out[k] = v;
    }
    if (d.indexed !== undefined) {
      if (d.indexed !== null && typeof d.indexed !== 'boolean')
        issues.push({ field: `${at}.indexed`, code: 'type' });
      else out.indexed = d.indexed;
    }
    if (d.partial !== undefined) out.partial = d.partial === true;
    if (d.extra !== undefined) {
      const e = d.extra as Record<string, unknown>;
      if (!e || typeof e !== 'object' || Object.keys(e).length > 20)
        issues.push({ field: `${at}.extra`, code: 'format' });
      else {
        for (const [k, v] of Object.entries(e)) {
          if (
            !/^[a-z][a-zA-Z0-9_]{0,40}$/.test(k) ||
            (METRIC_KEYS as readonly string[]).includes(k)
          ) {
            // Другая метрика — под СВОИМ именем, не под именем метрики ТЗ (§15).
            issues.push({ field: `${at}.extra.${k}`, code: 'name' });
          } else if (
            v !== null &&
            !(typeof v === 'number' && Number.isFinite(v) && v >= 0)
          ) {
            issues.push({ field: `${at}.extra.${k}`, code: 'range' });
          }
        }
        out.extra = e;
      }
    }
    return out;
  });
  let definitions: Record<string, string> | undefined;
  if (p.definitions !== undefined) {
    const defs = p.definitions as Record<string, unknown>;
    if (
      !defs ||
      typeof defs !== 'object' ||
      Object.values(defs).some((v) => typeof v !== 'string' || v.length > 500)
    ) {
      issues.push({ field: 'payload.definitions', code: 'format' });
    } else definitions = defs as Record<string, string>;
  }
  if (issues.length) throw validationError(issues.slice(0, 50));
  return { days, ...(definitions ? { definitions } : {}) };
}

@Injectable()
export class MetricImportsService {
  constructor(private readonly integrations: IntegrationsService) {}

  async create(
    tx: PubTx,
    product: ProductRef,
    body: Record<string, unknown>,
    actor: string,
    now: Date,
  ): Promise<{ row: ImportRow; audit: AuditInput[] }> {
    const issues: FieldIssue[] = [];
    if (!isOneOf(METRIC_IMPORT_SOURCES, body.source))
      issues.push({ field: 'source', code: 'enum' });
    const ps = optionalIso(body.periodStart, 'periodStart', issues);
    const pe = optionalIso(body.periodEnd, 'periodEnd', issues);
    if (!ps) issues.push({ field: 'periodStart', code: 'required' });
    if (!pe) issues.push({ field: 'periodEnd', code: 'required' });
    if (ps && pe && pe.getTime() < ps.getTime())
      issues.push({ field: 'periodEnd', code: 'before_start' });
    if (pe && kyivDateOf(pe) > kyivDateOf(now))
      issues.push({ field: 'periodEnd', code: 'future' });
    const text = (k: 'fileRef' | 'note', max: number) => {
      const v = body[k];
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string' || !v.trim() || [...v].length > max) {
        issues.push({ field: k, code: 'length' });
        return null;
      }
      issues.push(...piiIssues({ [k]: v }));
      return v.trim();
    };
    const fileRef = text('fileRef', 500);
    const note = text('note', 2000);
    if (issues.length) throw validationError(issues);
    const payload = parseImportPayload(
      body.payload,
      ps as Date,
      pe as Date,
      now,
    );
    const source = body.source as (typeof METRIC_IMPORT_SOURCES)[number];
    const row = await tx.pubMetricImport.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        source,
        periodStart: ps as Date,
        periodEnd: pe as Date,
        granularity: 'kyiv_day',
        payload: payload as unknown as Prisma.InputJsonValue,
        importedBy: actor,
        importedAt: now,
        fileRef,
        note,
        createdBy: actor,
      },
    });
    if (source !== 'manual') {
      // Свежесть — по данным, а не по моменту загрузки: выгрузка прошлого
      // месяца не делает источник «синхронизированным сейчас» (S3-5).
      await this.integrations.markImported(
        tx,
        product,
        source,
        new Date(Math.min(now.getTime(), (pe as Date).getTime())),
        actor,
        now,
      );
    }
    return {
      row,
      audit: [
        {
          objectType: 'metric_import',
          objectId: row.id,
          action: 'import',
          meta: { source, days: payload.days.length },
        },
      ],
    };
  }

  async list(
    tx: PubTx,
    product: ProductRef,
    q: { before?: unknown; limit?: unknown },
  ): Promise<ListPage<MetricImportView>> {
    const where: Prisma.PubMetricImportWhereInput = { productId: product.id };
    const limit = Math.min(Math.max(Number(q.limit ?? 50) || 50, 1), 100);
    if (
      typeof q.before === 'string' &&
      /^[A-Za-z0-9_-]{1,64}$/.test(q.before)
    ) {
      const b = await tx.pubMetricImport.findFirst({
        where: { id: q.before, productId: product.id },
        select: { createdAt: true },
      });
      if (b) where.createdAt = { lt: b.createdAt };
    }
    const rows = await tx.pubMetricImport.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return {
      items: rows.map(metricImportView),
      nextBefore: rows.length === limit ? rows[rows.length - 1].id : null,
    };
  }
}

/**
 * Задание `integrations-staleness` (tick, §15.1): `connected` без свежей
 * синхронизации → `degraded` (система, аудит). Продукты `restored|eval` и
 * архивные не обрабатываются.
 */
@Injectable()
@PubContribution('cron-job')
export class IntegrationsStalenessJob implements CronJob {
  readonly key = 'integrations-staleness';
  readonly schedule = 'tick' as const;

  constructor(
    private readonly db: SitesDb,
    private readonly ports: PubPorts,
  ) {}

  async run(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher integrations-staleness: интеграции всех кабинетов',
    );
    const rows = await system.$queryRaw<
      Array<{ id: string; accountId: string; productId: string }>
    >`
      SELECT i."id", i."accountId", i."productId"
        FROM "sites"."pub_integrations" i
        JOIN "sites"."pub_products" p ON p."id" = i."productId"
       WHERE i."status" = 'connected'
         AND p."kind" IN ('working', 'test') AND p."status" = 'active'
         AND (i."lastSuccessAt" IS NULL
              OR i."lastSuccessAt" < ${ctx.now}::timestamptz - make_interval(hours => i."staleAfterHours"))
         ${ctx.scope ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])` : Prisma.empty}
       LIMIT 500`;
    let processed = 0;
    for (const r of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      await this.db.forAccount(r.accountId).$transaction(async (tx) => {
        const n = await tx.pubIntegration.updateMany({
          where: { id: r.id, status: 'connected' },
          data: {
            status: 'degraded',
            lastCheckedAt: ctx.now,
            revision: { increment: 1 },
          },
        });
        if (n.count !== 1) return;
        await this.ports.audit().write(tx, {
          accountId: r.accountId,
          productId: r.productId,
          actor: 'system:integrations-staleness',
          objectType: 'integration',
          objectId: r.id,
          action: 'transition',
          fromStatus: 'connected',
          toStatus: 'degraded',
          reason: 'Немає успішної синхронізації довше за staleAfterHours',
          occurredAt: ctx.now,
        });
        processed++;
      });
    }
    return { processed, details: { degraded: processed } };
  }
}
