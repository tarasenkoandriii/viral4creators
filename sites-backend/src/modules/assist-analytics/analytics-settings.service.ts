/**
 * Настройки аналитики и подписка на отчёты — A (ТЗ §5-тер.14, §5-тер.7):
 *   GET|PATCH /assist/sites/:id/analytics-settings  { config?, timezone?, currency? }
 *   GET|PATCH /assist/sites/:id/reports/subscription { weekly?, digest? }
 * Права: assist: manager (контроллер). Подписка — своя (telegramId
 * участника); получатели — владелец и assist: manager, по умолчанию
 * подписаны на оба (§5-тер.7 «каждый может отписаться»).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import {
  effectiveAnalyticsConfig,
  parseAnalyticsConfig,
} from './analytics-config';
import { analyticsError, notFoundSite } from './analytics-errors';
import type {
  AnalyticsSettingsView,
  ReportSubscriptionView,
} from './api-types';
import { CURRENCY } from './goal-types';
import { siteTz, validTimezone } from './site-time';

@Injectable()
export class AnalyticsSettingsService {
  constructor(private readonly sitesDb: SitesDb) {}

  private async row(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    let a = await db.assistSite.findFirst({
      where: { siteId },
      select: { id: true, analytics: true, timezone: true, currency: true },
    });
    if (!a) {
      try {
        await db.assistSite.create({
          data: { accountId: m.accountId, siteId },
        });
      } catch (e) {
        if (
          !(e instanceof Prisma.PrismaClientKnownRequestError) ||
          e.code !== 'P2002'
        ) {
          throw e;
        }
      }
      a = await db.assistSite.findFirstOrThrow({
        where: { siteId },
        select: { id: true, analytics: true, timezone: true, currency: true },
      });
    }
    return { db, a };
  }

  async get(
    m: AccountMembership,
    siteId: string,
  ): Promise<AnalyticsSettingsView> {
    const { a } = await this.row(m, siteId);
    return {
      config: effectiveAnalyticsConfig(a.analytics),
      timezone: siteTz(a.timezone),
      currency: a.currency,
    };
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<AnalyticsSettingsView> {
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const bad = (errors: Array<{ path: string; code: string }>) =>
      analyticsError(
        HttpStatus.BAD_REQUEST,
        'ANALYTICS_CONFIG_INVALID',
        'Проверьте настройки аналитики',
        { errors },
      );
    if (!b) throw bad([{ path: '', code: 'type' }]);
    const errors: Array<{ path: string; code: string }> = [];
    for (const k of Object.keys(b)) {
      if (!['config', 'timezone', 'currency'].includes(k)) {
        errors.push({ path: k, code: 'unknown' });
      }
    }
    const data: Prisma.AssistSiteUpdateInput = {};
    if (b.config !== undefined) {
      const r = parseAnalyticsConfig(b.config);
      if (!r.ok) {
        errors.push(
          ...r.errors.map((e) => ({ ...e, path: `config.${e.path}` })),
        );
      } else data.analytics = r.config as unknown as Prisma.InputJsonValue;
    }
    if (b.timezone !== undefined) {
      if (!validTimezone(b.timezone)) {
        errors.push({ path: 'timezone', code: 'format' });
      } else data.timezone = b.timezone;
    }
    if (b.currency !== undefined) {
      if (typeof b.currency !== 'string' || !CURRENCY.test(b.currency)) {
        errors.push({ path: 'currency', code: 'format' });
      } else data.currency = b.currency;
    }
    if (errors.length) throw bad(errors);
    const { db, a } = await this.row(m, siteId);
    if (Object.keys(data).length) {
      await db.assistSite.update({
        where: { id: a.id },
        data,
        select: { id: true },
      });
    }
    return this.get(m, siteId);
  }

  async subscription(
    m: AccountMembership,
    siteId: string,
  ): Promise<ReportSubscriptionView> {
    const { db } = await this.row(m, siteId);
    const rows = await db.assistSiteReportSubscription.findMany({
      where: { siteId, telegramId: m.telegramId },
      select: { kind: true, enabled: true },
    });
    const of = (k: string) => rows.find((r) => r.kind === k)?.enabled ?? true;
    return { weekly: of('weekly'), digest: of('digest') };
  }

  async patchSubscription(
    m: AccountMembership,
    siteId: string,
    body: unknown,
  ): Promise<ReportSubscriptionView> {
    const b =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    for (const k of Object.keys(b)) {
      if (!['weekly', 'digest'].includes(k) || typeof b[k] !== 'boolean') {
        throw analyticsError(
          HttpStatus.BAD_REQUEST,
          'BAD_REQUEST',
          'Ожидается { weekly?: boolean, digest?: boolean }',
        );
      }
    }
    const { db } = await this.row(m, siteId);
    for (const kind of ['weekly', 'digest'] as const) {
      if (typeof b[kind] !== 'boolean') continue;
      await db.assistSiteReportSubscription.upsert({
        where: {
          siteId_telegramId_kind: { siteId, telegramId: m.telegramId, kind },
        },
        create: {
          accountId: m.accountId,
          siteId,
          telegramId: m.telegramId,
          kind,
          enabled: b[kind] as boolean,
        },
        update: { enabled: b[kind] as boolean },
      });
    }
    return this.subscription(m, siteId);
  }
}
