/**
 * Эксперименты сайта — кабинет и системный проход (Э3-бис; ТЗ §5-тер.2,
 * Р-42; решения «Э3-бис — сделано» плана).
 *
 *   GET  /assist/sites/:id/experiments                 (manager)
 *   POST /assist/sites/:id/experiments/preview         (manager) — мощность
 *   POST /assist/sites/:id/experiments                 (ВЛАДЕЛЕЦ) — запуск
 *   POST /assist/sites/:id/experiments/:eid/stop       (ВЛАДЕЛЕЦ)
 *
 * Правила запуска: тариф `experiments` (Business+); связанный режим включён
 * (участвуют ТОЛЬКО посетители с согласием на аналитику — решение Э3-бис:
 * «эксперименты — только с согласием»); один идущий эксперимент на сайт
 * (без взаимодействия эффектов); цель — активная, у holdout — не только
 * встроенная заявка (у группы без виджета её быть не может — смещение);
 * мощность по трафику с согласием за 28 дней: видимый эффект ≤ 30% —
 * иначе отказ «не измерить». Горизонт фиксирован (14–56 дней), итог —
 * только после него; досрочная остановка владельцем — без итога
 * (подглядывание), SRM — «испорчен», тариф/режим согласия сняты — стоп.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { CronScope } from '../../../common/cron-scope';
import { ASSIST_PLANS } from '../../assist-billing/plans';
import { readState } from '../../assist-billing/public/entitlements';
import type { AccountMembership } from '../../site-core/account/roles';
import { effectiveAnalyticsConfig } from '../analytics-config';
import {
  analyticsError,
  notFoundSite,
  type AnalyticsCode,
} from '../analytics-errors';
import { storedDetectors } from '../goal-types';
import {
  EXPERIMENT_KINDS,
  EXPERIMENT_LIMITS,
  SRM_MIN_UNITS,
  SRM_P,
  analyze,
  estimatePower,
  srmP,
  type ExperimentKind,
  type ExperimentResult,
  type PowerEstimate,
} from './experiment-math';

const DAY = 24 * 60 * 60 * 1000;
const L = EXPERIMENT_LIMITS;

export interface ExperimentRequest {
  kind: ExperimentKind;
  goalKey: string;
  share: number;
  horizonDays: number;
  variant: Record<string, unknown> | null;
}

export interface ExperimentView {
  id: string;
  kind: ExperimentKind;
  goalKey: string;
  share: number;
  status: string;
  horizonDays: number;
  startedAt: string;
  endsAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  mdeRel: number;
  minUnitsPerArm: number;
  power: unknown;
  variant: unknown;
  /** Единиц по группам — видно всегда (это не результат). */
  units: { a: number; b: number };
  srmP: number | null;
  /** Итог — только после горизонта (status done). */
  result: ExperimentResult | null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const bad = (
  code: AnalyticsCode,
  message: string,
  extra?: Record<string, unknown>,
) => analyticsError(HttpStatus.BAD_REQUEST, code, message, extra);

/** Строка владельца: без управляющих символов и угловых скобок, обрезка. */
function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const t = v
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t && Array.from(t).length <= max ? t : null;
}

/** Вариант B: greeting — { uk?, ru?, en? }; suggestions — { uk?: string[] … }. */
export function parseVariant(
  kind: ExperimentKind,
  v: unknown,
): Record<string, unknown> | null | 'invalid' {
  if (kind === 'holdout')
    return v === null || v === undefined ? null : 'invalid';
  if (!isObj(v)) return 'invalid';
  const out: Record<string, unknown> = {};
  for (const [lang, val] of Object.entries(v)) {
    if (!['uk', 'ru', 'en'].includes(lang)) return 'invalid';
    if (kind === 'greeting') {
      const t = cleanText(val, L.greetingChars);
      if (!t) return 'invalid';
      out[lang] = t;
    } else {
      if (!Array.isArray(val) || !val.length || val.length > L.suggestions) {
        return 'invalid';
      }
      const items = val.map((x) => cleanText(x, L.suggestionChars));
      if (items.some((x) => !x)) return 'invalid';
      out[lang] = items;
    }
  }
  return Object.keys(out).length ? out : 'invalid';
}

export function parseExperimentRequest(
  body: unknown,
): ExperimentRequest | { errors: Array<{ path: string; code: string }> } {
  const errors: Array<{ path: string; code: string }> = [];
  if (!isObj(body)) return { errors: [{ path: '', code: 'type' }] };
  for (const k of Object.keys(body)) {
    if (!['kind', 'goalKey', 'share', 'horizonDays', 'variant'].includes(k)) {
      errors.push({ path: k, code: 'unknown' });
    }
  }
  const kind = (EXPERIMENT_KINDS as readonly unknown[]).includes(body.kind)
    ? (body.kind as ExperimentKind)
    : null;
  if (!kind) errors.push({ path: 'kind', code: 'enum' });
  const goalKey =
    typeof body.goalKey === 'string' && /^[a-z0-9_-]{1,40}$/.test(body.goalKey)
      ? body.goalKey
      : null;
  if (!goalKey) errors.push({ path: 'goalKey', code: 'format' });
  let share: number =
    kind === 'holdout' ? L.holdoutShareDefault : L.variantShare;
  if (body.share !== undefined) {
    const s = body.share;
    if (
      kind !== 'holdout' ||
      typeof s !== 'number' ||
      s < L.holdoutShareMin ||
      s > L.holdoutShareMax ||
      Math.round(s * 100) !== s * 100
    ) {
      errors.push({ path: 'share', code: 'range' });
    } else share = s;
  }
  let horizonDays: number = L.horizonDefault;
  if (body.horizonDays !== undefined) {
    const h = body.horizonDays;
    if (
      typeof h !== 'number' ||
      !Number.isInteger(h) ||
      h < L.horizonMin ||
      h > L.horizonMax
    ) {
      errors.push({ path: 'horizonDays', code: 'range' });
    } else horizonDays = h;
  }
  const variant = kind ? parseVariant(kind, body.variant) : null;
  if (variant === 'invalid') errors.push({ path: 'variant', code: 'format' });
  if (errors.length || !kind || !goalKey || variant === 'invalid') {
    return { errors };
  }
  return { kind, goalKey, share, horizonDays, variant };
}

@Injectable()
export class ExperimentsService {
  private readonly logger = new Logger(ExperimentsService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const s = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!s) throw notFoundSite();
    const a = await db.assistSite.findFirst({
      where: { siteId },
      select: { analytics: true },
    });
    return { db, analytics: a?.analytics ?? null };
  }

  private owner(m: AccountMembership): void {
    if (m.role !== 'owner') {
      throw analyticsError(
        HttpStatus.FORBIDDEN,
        'EXPERIMENT_OWNER_ONLY',
        'Эксперимент запускает и останавливает только владелец кабинета',
      );
    }
  }

  private async units(id: string): Promise<{
    a: number;
    b: number;
    xa: number;
    xb: number;
  }> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ arm: string; n: bigint; x: bigint }>
    >(
      `SELECT "arm", count(*) AS n, count(*) FILTER (WHERE "converted") AS x
         FROM "sites"."assist_site_experiment_units" WHERE "experimentId" = $1
        GROUP BY "arm"`,
      id,
    );
    const of = (arm: string) => rows.find((r) => r.arm === arm);
    return {
      a: Number(of('a')?.n ?? 0),
      b: Number(of('b')?.n ?? 0),
      xa: Number(of('a')?.x ?? 0),
      xb: Number(of('b')?.x ?? 0),
    };
  }

  async list(m: AccountMembership, siteId: string): Promise<ExperimentView[]> {
    const { db } = await this.site(m, siteId);
    const rows = await db.assistSiteExperiment.findMany({
      where: { siteId },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });
    const out: ExperimentView[] = [];
    for (const r of rows) {
      const u = await this.units(r.id);
      out.push({
        id: r.id,
        kind: r.kind as ExperimentKind,
        goalKey: r.goalKey,
        share: r.share,
        status: r.status,
        horizonDays: r.horizonDays,
        startedAt: r.startedAt.toISOString(),
        endsAt: r.endsAt.toISOString(),
        stoppedAt: r.stoppedAt ? r.stoppedAt.toISOString() : null,
        stopReason: r.stopReason,
        mdeRel: r.mdeRel,
        minUnitsPerArm: r.minUnitsPerArm,
        power: r.power,
        variant: r.variant,
        units: { a: u.a, b: u.b },
        srmP: r.srmP,
        // Без подглядывания: итог есть только у завершённого по горизонту.
        result:
          r.status === 'done'
            ? (r.result as unknown as ExperimentResult)
            : null,
      });
    }
    return out;
  }

  /** Мощность по трафику с согласием за 28 дней (§5-тер.2 «что стоит»). */
  async power(
    siteId: string,
    req: Pick<ExperimentRequest, 'kind' | 'goalKey' | 'share' | 'horizonDays'>,
    now: Date,
  ): Promise<PowerEstimate> {
    const from = new Date(now.getTime() - L.powerWindowDays * DAY);
    const [ev] = await this.prisma.$queryRawUnsafe<
      Array<{
        visits: bigint | null;
        opens: bigint | null;
        views: bigint | null;
      }>
    >(
      `SELECT sum("count") FILTER (WHERE "kind" = 'visit_new') AS visits,
              sum("count") FILTER (WHERE "kind" = 'open') AS opens,
              sum("count") FILTER (WHERE "kind" = 'widget_view') AS views
         FROM "sites"."assist_site_event_counts"
        WHERE "siteId" = $1 AND "day" >= $2`,
      siteId,
      from.toISOString().slice(0, 10),
    );
    const visits = Number(ev?.visits ?? 0);
    // Варианты приветствия/подсказок — единица включается при открытии чата.
    const openRate =
      Number(ev?.views ?? 0) > 0
        ? Math.min(1, Number(ev?.opens ?? 0) / Number(ev?.views ?? 1))
        : 0;
    const units28 =
      req.kind === 'holdout' ? visits : Math.floor(visits * openRate);
    const [cv] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(DISTINCT e."visitHash") AS n
         FROM "sites"."assist_site_goal_events" e
         JOIN "sites"."assist_site_goals" g ON g."id" = e."goalId"
        WHERE e."siteId" = $1 AND g."key" = $2 AND e."status" = 'completed'
          AND e."visitHash" IS NOT NULL AND e."occurredAt" >= $3`,
      siteId,
      req.goalKey,
      from,
    );
    return estimatePower({
      units28,
      conversions28: Math.min(Number(cv?.n ?? 0), units28),
      share: req.share,
      horizonDays: req.horizonDays,
    });
  }

  async preview(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<PowerEstimate> {
    await this.site(m, siteId);
    const req = parseExperimentRequest(body);
    if ('errors' in req) {
      throw bad('EXPERIMENT_INVALID', 'Проверьте параметры эксперимента', {
        errors: req.errors,
      });
    }
    return this.power(siteId, req, this.now());
  }

  async start(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<ExperimentView> {
    this.owner(m);
    const { db, analytics } = await this.site(m, siteId);
    const req = parseExperimentRequest(body);
    if ('errors' in req) {
      throw bad('EXPERIMENT_INVALID', 'Проверьте параметры эксперимента', {
        errors: req.errors,
      });
    }
    const now = this.now();
    const st = await readState(this.prisma, m.accountId, now);
    if (!st.planId || !ASSIST_PLANS[st.planId].experiments) {
      throw analyticsError(
        HttpStatus.FORBIDDEN,
        'EXPERIMENT_PLAN',
        'Эксперименты — на тарифах Business и Pro',
      );
    }
    if (!effectiveAnalyticsConfig(analytics).linked) {
      throw bad(
        'EXPERIMENT_NEEDS_CONSENT',
        'Эксперименты идут только на посетителях с согласием: включите связанный режим (баннер согласия сайта)',
      );
    }
    const running = await db.assistSiteExperiment.findFirst({
      where: { siteId, status: 'running' },
      select: { id: true },
    });
    if (running) {
      throw analyticsError(
        HttpStatus.CONFLICT,
        'EXPERIMENT_RUNNING',
        'На сайте уже идёт эксперимент — дождитесь итога или остановите его',
      );
    }
    const goal = await db.assistSiteGoal.findFirst({
      where: { siteId, key: req.goalKey, status: { in: ['active', 'stale'] } },
      select: { detectors: true, template: true },
    });
    if (!goal) throw bad('EXPERIMENT_GOAL', 'Нет такой активной цели');
    const kinds = storedDetectors(goal.detectors, goal.template).map(
      (d) => d.kind,
    );
    if (req.kind === 'holdout' && kinds.every((k) => k === 'builtin')) {
      throw bad(
        'EXPERIMENT_GOAL',
        'Для контрольной группы нужна цель сайта (не только заявка помощника): у группы без виджета заявки помощника нет',
      );
    }
    const power = await this.power(siteId, req, now);
    if (!power.ok) {
      throw bad(
        'EXPERIMENT_UNDERPOWERED',
        'На вашем трафике с согласием эффект статистически не измерить — смотрите прямые конверсии и закрытые без человека диалоги',
        { power },
      );
    }
    const row = await db.assistSiteExperiment.create({
      data: {
        accountId: m.accountId,
        siteId,
        kind: req.kind,
        goalKey: req.goalKey,
        share: req.share,
        salt: randomBytes(9).toString('base64url'),
        variant: (req.variant ?? Prisma.DbNull) as Prisma.InputJsonValue,
        status: 'running',
        horizonDays: req.horizonDays,
        mdeRel: power.mdeRel,
        minUnitsPerArm: power.minUnitsPerArm,
        power: power as unknown as Prisma.InputJsonValue,
        startedAt: now,
        endsAt: new Date(now.getTime() + req.horizonDays * DAY),
        startedBy: String(m.telegramId),
      },
    });
    this.logger.log(
      `эксперимент ${row.id} запущен (site ${siteId}, ${req.kind})`,
    );
    return (await this.list(m, siteId)).find(
      (x) => x.id === row.id,
    ) as ExperimentView;
  }

  async stop(
    m: AccountMembership,
    siteId: string,
    eid: string,
  ): Promise<ExperimentView> {
    this.owner(m);
    const { db } = await this.site(m, siteId);
    const n = await db.assistSiteExperiment.updateMany({
      where: { id: eid, siteId, status: 'running' },
      data: { status: 'stopped', stopReason: 'owner', stoppedAt: this.now() },
    });
    if (n.count !== 1) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'EXPERIMENT_NOT_FOUND',
        'Нет идущего эксперимента',
      );
    }
    return (await this.list(m, siteId)).find(
      (x) => x.id === eid,
    ) as ExperimentView;
  }

  // ── системный проход (крон assist-analytics-run) ─────────────────────

  /**
   * Горизонт → итог; SRM → «испорчен» (тревога в лог платформы); тариф или
   * связанный режим сняты → стоп; единицы законченных — удаляются через
   * 30 дней (итог остаётся в `result`).
   */
  async tick(
    now: Date,
    scope?: CronScope,
  ): Promise<{
    done: number;
    invalid: number;
    stopped: number;
    purged: number;
  }> {
    const out = { done: 0, invalid: 0, stopped: 0, purged: 0 };
    const rows = await this.prisma.assistSiteExperiment.findMany({
      where: {
        status: 'running',
        ...(scope ? { siteId: { in: scope.siteIds } } : {}),
      },
      take: 200,
    });
    const plans = new Map<string, boolean>();
    for (const e of rows) {
      let allowed = plans.get(e.accountId);
      if (allowed === undefined) {
        const st = await readState(this.prisma, e.accountId, now);
        allowed = !!st.planId && ASSIST_PLANS[st.planId].experiments;
        plans.set(e.accountId, allowed);
      }
      const site = await this.prisma.assistSite.findUnique({
        where: { siteId: e.siteId },
        select: { analytics: true },
      });
      if (!allowed || !effectiveAnalyticsConfig(site?.analytics).linked) {
        await this.finish(
          e.id,
          { status: 'stopped', stopReason: allowed ? 'consent_off' : 'plan' },
          now,
        );
        out.stopped++;
        continue;
      }
      const u = await this.units(e.id);
      const p = u.a + u.b >= SRM_MIN_UNITS ? srmP(u.a, u.b, e.share) : null;
      if (p !== null && p < SRM_P) {
        await this.finish(
          e.id,
          { status: 'invalid', stopReason: 'srm', srmP: p },
          now,
        );
        // Тревога оператору платформы (§5-тер.2): обычно кэш, блокировщик
        // или ошибка загрузчика — разбирать по логам.
        this.logger.error(
          `SRM: эксперимент ${e.id} (site ${e.siteId}) испорчен: a=${u.a} b=${u.b} доля=${e.share} p=${p.toExponential(2)}`,
        );
        out.invalid++;
        continue;
      }
      if (now.getTime() >= e.endsAt.getTime()) {
        const result = analyze({
          nA: u.a,
          nB: u.b,
          xA: u.xa,
          xB: u.xb,
          minUnitsPerArm: e.minUnitsPerArm,
        });
        await this.finish(
          e.id,
          {
            status: 'done',
            stopReason: 'horizon',
            srmP: p,
            result: result as unknown as Prisma.InputJsonValue,
          },
          now,
        );
        out.done++;
      } else if (p !== null) {
        await this.prisma.assistSiteExperiment.update({
          where: { id: e.id },
          data: { srmP: p },
        });
      }
    }
    // Хранение: единицы законченных — 30 дней после конца (агрегат в result).
    out.purged = await this.prisma.$executeRawUnsafe(
      `DELETE FROM "sites"."assist_site_experiment_units" u
        USING "sites"."assist_site_experiments" e
        WHERE e."id" = u."experimentId" AND e."status" <> 'running'
          AND COALESCE(e."stoppedAt", e."endsAt") < $1
          AND ($2::text[] IS NULL OR e."siteId" = ANY($2::text[]))`,
      new Date(now.getTime() - L.unitsRetentionDays * DAY),
      scope ? scope.siteIds : null,
    );
    return out;
  }

  private async finish(
    id: string,
    data: {
      status: string;
      stopReason: string;
      srmP?: number | null;
      result?: Prisma.InputJsonValue;
    },
    now: Date,
  ): Promise<void> {
    await this.prisma.assistSiteExperiment.updateMany({
      where: { id, status: 'running' },
      data: { ...data, stoppedAt: now },
    });
  }
}
