/**
 * Цели в кабинете — A (ТЗ §5-тер.1, §5-тер.14): CRUD (≤ 30 на сайт),
 * WYSIWYG-выбор (токен — строка assist_site_preview_tokens purpose=goal,
 * 30 мин, одноразовый; результат пишет загрузчик в `result`, TMA опрашивает),
 * «Проверить цель» (последние 20), удаление событий по orderId (запрос
 * субъекта через заказчика, §5-тер.15). Права: цели — assist: manager;
 * удаление событий — владелец. SitesDb.forAccount, чужой сайт — 404.
 *
 * Уточнения A:
 *  - умолчания (`defaultGoals`: «Заявка» builtin + tel + мессенджеры)
 *    создаются при первом чтении списка и свёрткой (у сайта с
 *    опубликованным видом) — признак «уже засеяно» — цель с детектором
 *    builtin; поэтому её нельзя удалить и нельзя лишить детектора builtin
 *    (только пауза) — иначе свёртка засеет умолчания заново;
 *  - PATCH — та же форма GoalInput (ключ не меняется — по нему уже
 *    размечена вёрстка и шлёт бэкенд) + необязательный `status`
 *    `active|paused`;
 *  - токен выбора — как ссылка «посмотреть на сайте» Э2 (sha256 в базе,
 *    сам токен — только в ссылке), только https verified-хост без льготы;
 *    обмен на сессию и запись `result` — W (`/widget/v1/goal-picker/*`).
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { WIDGET_GOAL_PICKER_PARAM } from '../../brand';
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { analyticsError, forbidden, notFoundSite } from './analytics-errors';
import type {
  GoalPickerStatusView,
  GoalPickerTokenView,
  GoalRecentEventView,
  GoalView,
} from './api-types';
import {
  ORDER_ID,
  defaultGoals,
  parseDescriptor,
  parseGoalInput,
  storedDetectors,
  type GoalAttribution,
  type GoalInput,
  type GoalTemplate,
  type GoalTrust,
} from './goal-types';

/** Срок одноразовой ссылки выбора цели (§5-тер.1: 30 мин). */
export const GOAL_PICKER_TTL_MS = 30 * 60 * 1000;
const PICKER_PATH = /^\/[^\s?#]{0,299}$/;

type Db = ReturnType<SitesDb['forAccount']>;

interface GoalRow {
  id: string;
  key: string;
  template: string;
  name: string;
  detectors: unknown;
  valueMode: string;
  fixedValue: Prisma.Decimal | null;
  currency: string | null;
  status: string;
  lastFiredAt: Date | null;
  createdAt: Date;
}

const GOAL_SELECT = {
  id: true,
  key: true,
  template: true,
  name: true,
  detectors: true,
  valueMode: true,
  fixedValue: true,
  currency: true,
  status: true,
  lastFiredAt: true,
  createdAt: true,
} as const;

export function goalView(r: GoalRow): GoalView {
  return {
    id: r.id,
    key: r.key,
    template: r.template as GoalTemplate,
    name: r.name,
    detectors: storedDetectors(r.detectors, r.template),
    valueMode:
      r.valueMode === 'fixed' || r.valueMode === 'event' ? r.valueMode : 'none',
    fixedValue: r.fixedValue === null ? null : Number(r.fixedValue),
    currency: r.currency,
    status: r.status === 'paused' || r.status === 'stale' ? r.status : 'active',
    lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

function hasBuiltin(g: Pick<GoalRow, 'detectors' | 'template'>): boolean {
  return storedDetectors(g.detectors, g.template).some(
    (d) => d.kind === 'builtin',
  );
}

function invalid(errors: Array<{ path: string; code: string }>) {
  return analyticsError(
    HttpStatus.BAD_REQUEST,
    'GOAL_INVALID',
    'Проверьте настройки цели',
    { errors },
  );
}

/**
 * Засеять цели-умолчания сайта, если их ещё не сеяли (нет цели с builtin).
 * Гонка двух первых чтений — уникальный (siteId, key) + skipDuplicates.
 */
export async function seedDefaultGoals(
  client: Db | PrismaService,
  accountId: string,
  siteId: string,
): Promise<number> {
  // Оба клиента — один и тот же PrismaClient (forAccount лишь подставляет
  // кабинет), поэтому достаточно типов основного.
  const db = client as PrismaService;
  const rows = await db.assistSiteGoal.findMany({
    where: { siteId },
    select: { key: true, template: true, detectors: true },
  });
  if (rows.some(hasBuiltin)) return 0;
  const taken = new Set(rows.map((r) => r.key));
  const data = defaultGoals()
    .filter((g) => !taken.has(g.key))
    .slice(0, Math.max(0, ANALYTICS_DEFAULTS.goalsPerSite - rows.length))
    // Порядок на экране — как в defaultGoals (createdAt с шагом 1 мс).
    .map((g, i) => ({
      createdAt: new Date(Date.now() + i),
      accountId,
      siteId,
      key: g.key,
      template: g.template,
      name: g.name,
      detectors: g.detectors as unknown as Prisma.InputJsonValue,
      valueMode: g.valueMode,
      fixedValue: g.fixedValue,
      currency: g.currency,
    }));
  if (!data.length) return 0;
  const r = await db.assistSiteGoal.createMany({
    data,
    skipDuplicates: true,
  });
  return r.count;
}

@Injectable()
export class GoalsService {
  private readonly logger = new Logger(GoalsService.name);
  now: () => Date = () => new Date();

  constructor(private readonly sitesDb: SitesDb) {}

  private async site(m: AccountMembership, siteId: string): Promise<Db> {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    return db;
  }

  private async goal(db: Db, siteId: string, goalId: string): Promise<GoalRow> {
    const g = await db.assistSiteGoal.findFirst({
      where: { id: goalId, siteId },
      select: GOAL_SELECT,
    });
    if (!g) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'GOAL_NOT_FOUND',
        'Цель не найдена',
      );
    }
    return g;
  }

  async list(m: AccountMembership, siteId: string): Promise<GoalView[]> {
    const db = await this.site(m, siteId);
    await seedDefaultGoals(db, m.accountId, siteId);
    const rows = await db.assistSiteGoal.findMany({
      where: { siteId },
      select: GOAL_SELECT,
      orderBy: [{ createdAt: 'asc' }, { key: 'asc' }],
    });
    return rows.map(goalView);
  }

  async create(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<GoalView> {
    const db = await this.site(m, siteId);
    const parsed = parseGoalInput(body);
    if (!parsed.ok) throw invalid(parsed.errors);
    const g = parsed.goal;
    const existing = await db.assistSiteGoal.findMany({
      where: { siteId },
      select: { key: true, template: true, detectors: true },
    });
    if (existing.length >= ANALYTICS_DEFAULTS.goalsPerSite) {
      throw analyticsError(
        HttpStatus.CONFLICT,
        'GOAL_LIMIT',
        `Не больше ${ANALYTICS_DEFAULTS.goalsPerSite} целей на сайт`,
      );
    }
    if (existing.some((e) => e.key === g.key)) throw keyTaken();
    if (
      g.detectors.some((d) => d.kind === 'builtin') &&
      existing.some(hasBuiltin)
    ) {
      throw invalid([{ path: 'detectors', code: 'builtin_exists' }]);
    }
    try {
      const row = await db.assistSiteGoal.create({
        data: {
          accountId: m.accountId,
          siteId,
          ...goalData(g),
          createdByTelegramId: m.telegramId,
        },
        select: GOAL_SELECT,
      });
      this.logger.log(`цель ${row.id} создана (site ${siteId})`);
      return goalView(row);
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw keyTaken();
      }
      throw e;
    }
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    goalId: string,
    body: unknown,
  ): Promise<GoalView> {
    const db = await this.site(m, siteId);
    const cur = await this.goal(db, siteId, goalId);
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : null;
    if (!b) throw invalid([{ path: '', code: 'type' }]);
    let status: 'active' | 'paused' | undefined;
    if (b.status !== undefined) {
      if (b.status !== 'active' && b.status !== 'paused') {
        throw invalid([{ path: 'status', code: 'enum' }]);
      }
      status = b.status;
      delete b.status;
    }
    const cv = goalView(cur);
    const merged = {
      key: cv.key,
      template: cv.template,
      name: cv.name,
      detectors: cv.detectors,
      valueMode: cv.valueMode,
      fixedValue: cv.fixedValue,
      currency: cv.currency,
      ...b,
    };
    const parsed = parseGoalInput(merged);
    if (!parsed.ok) throw invalid(parsed.errors);
    const g = parsed.goal;
    if (g.key !== cur.key) throw invalid([{ path: 'key', code: 'immutable' }]);
    const wasBuiltin = hasBuiltin(cur);
    const isBuiltin = g.detectors.some((d) => d.kind === 'builtin');
    if (wasBuiltin && !isBuiltin) {
      throw invalid([{ path: 'detectors', code: 'builtin_required' }]);
    }
    if (!wasBuiltin && isBuiltin) {
      const others = await db.assistSiteGoal.findMany({
        where: { siteId, id: { not: goalId } },
        select: { template: true, detectors: true },
      });
      if (others.some(hasBuiltin)) {
        throw invalid([{ path: 'detectors', code: 'builtin_exists' }]);
      }
    }
    const row = await db.assistSiteGoal.update({
      where: { id: goalId },
      data: {
        ...goalData(g),
        // Правка детекторов «чинит» stale: ждём срабатывания заново.
        ...(status
          ? { status }
          : cur.status === 'stale'
            ? { status: 'active' }
            : {}),
      },
      select: GOAL_SELECT,
    });
    return goalView(row);
  }

  async remove(
    m: AccountMembership,
    siteId: string,
    goalId: string,
  ): Promise<void> {
    const db = await this.site(m, siteId);
    const cur = await this.goal(db, siteId, goalId);
    if (hasBuiltin(cur)) {
      throw invalid([{ path: '', code: 'builtin_goal' }]);
    }
    await db.assistSiteGoal.deleteMany({ where: { id: goalId, siteId } });
    this.logger.log(`цель ${goalId} удалена (site ${siteId})`);
  }

  async pickerToken(
    m: AccountMembership,
    siteId: string,
    body: { hostId: string; path: string | null },
  ): Promise<GoalPickerTokenView> {
    const db = await this.site(m, siteId);
    const b = (body ?? {}) as { hostId?: unknown; path?: unknown };
    if (typeof b.hostId !== 'string' || !b.hostId) {
      throw invalid([{ path: 'hostId', code: 'required' }]);
    }
    let path = '/';
    if (b.path !== undefined && b.path !== null) {
      if (typeof b.path !== 'string' || !PICKER_PATH.test(b.path)) {
        throw invalid([{ path: 'path', code: 'format' }]);
      }
      path = b.path;
    }
    const now = this.now();
    const host = await db.siteHost.findFirst({
      where: { id: b.hostId, siteId },
      select: {
        id: true,
        accountId: true,
        scheme: true,
        host: true,
        port: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
        reverifyBlockedAt: true,
      },
    });
    const access = host ? evaluateHostAccess(host, 'assist-widget', now) : null;
    if (!host || !access?.ok || access.grace || host.scheme !== 'https') {
      throw analyticsError(
        HttpStatus.BAD_REQUEST,
        'HOST_NOT_VERIFIED',
        'Выбор цели — только на подтверждённом хосте (https)',
      );
    }
    const origin = `https://${host.host}${host.port === 443 ? '' : `:${host.port}`}`;
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + GOAL_PICKER_TTL_MS);
    const row = await db.assistSitePreviewToken.create({
      data: {
        accountId: m.accountId,
        siteId,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        purpose: 'goal',
        origin,
        createdByTelegramId: m.telegramId,
        expiresAt,
      },
      select: { id: true },
    });
    const url = new URL(path, origin);
    url.searchParams.set(WIDGET_GOAL_PICKER_PARAM, token);
    return {
      tokenId: row.id,
      url: url.toString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async pickerStatus(
    m: AccountMembership,
    siteId: string,
    tokenId: string,
  ): Promise<GoalPickerStatusView> {
    const db = await this.site(m, siteId);
    const row = await db.assistSitePreviewToken.findFirst({
      where: { id: tokenId, siteId, purpose: 'goal' },
      select: { result: true, expiresAt: true, sessionExpiresAt: true },
    });
    if (!row) {
      throw analyticsError(
        HttpStatus.NOT_FOUND,
        'PICKER_EXPIRED',
        'Ссылка выбора не найдена — получите новую',
      );
    }
    const result = parsePickResult(row.result);
    if (result) return { status: 'picked', result };
    const now = this.now().getTime();
    const alive =
      row.expiresAt.getTime() > now ||
      (row.sessionExpiresAt !== null && row.sessionExpiresAt.getTime() > now);
    return { status: alive ? 'waiting' : 'expired', result: null };
  }

  async recent(
    m: AccountMembership,
    siteId: string,
    goalId: string,
  ): Promise<GoalRecentEventView[]> {
    const db = await this.site(m, siteId);
    await this.goal(db, siteId, goalId);
    const rows = await db.assistSiteGoalEvent.findMany({
      where: { siteId, goalId },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: {
        id: true,
        occurredAt: true,
        source: true,
        trust: true,
        attribution: true,
        path: true,
        orderId: true,
        value: true,
        currency: true,
        status: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      source: r.source,
      trust: r.trust as GoalTrust,
      attribution: r.attribution as GoalAttribution,
      path: r.path,
      orderId: r.orderId,
      value: r.value === null ? null : Number(r.value),
      currency: r.currency,
      status:
        r.status === 'refunded' || r.status === 'cancelled'
          ? r.status
          : 'completed',
    }));
  }

  async deleteEventsByOrder(
    m: AccountMembership,
    siteId: string,
    orderId: string,
  ): Promise<{ deleted: number }> {
    if (m.role !== 'owner') {
      throw forbidden(
        'Удалять события по заказу может только владелец кабинета',
      );
    }
    const db = await this.site(m, siteId);
    if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) {
      throw invalid([{ path: 'orderId', code: 'format' }]);
    }
    const r = await db.assistSiteGoalEvent.deleteMany({
      where: { siteId, orderId },
    });
    // Без orderId в логе (псевдонимный ПД, §6.6).
    this.logger.log(`события по заказу удалены: ${r.count} (site ${siteId})`);
    return { deleted: r.count };
  }
}

function keyTaken() {
  return analyticsError(
    HttpStatus.CONFLICT,
    'GOAL_KEY_TAKEN',
    'Цель с таким ключом уже есть',
  );
}

function goalData(g: GoalInput) {
  return {
    key: g.key,
    template: g.template,
    name: g.name,
    detectors: g.detectors as unknown as Prisma.InputJsonValue,
    valueMode: g.valueMode,
    fixedValue: g.fixedValue,
    currency: g.currency,
  };
}

/** Результат выбора из базы (его пишет загрузчик — проверяем заново). */
export function parsePickResult(raw: unknown): GoalPickerStatusView['result'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const descriptor = parseDescriptor(o.descriptor, 'descriptor', []);
  if (!descriptor) return null;
  if (o.kind !== 'click' && o.kind !== 'form_submit') return null;
  if (typeof o.path !== 'string' || !PICKER_PATH.test(o.path)) return null;
  const label =
    typeof o.label === 'string'
      ? o.label.replace(/\s+/g, ' ').trim().slice(0, 80)
      : '';
  return { descriptor, path: o.path, label, kind: o.kind };
}
