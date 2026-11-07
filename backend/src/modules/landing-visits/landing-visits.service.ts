import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const SETTING = 'landingVisits.ipUniqueness';
import { visitHash } from './landing-visits.contract';
@Injectable()
export class LandingVisitsService {
  constructor(private readonly prisma: PrismaService) {}
  async settings() {
    const row = await this.prisma.platformSetting.findUnique({
      where: { key: SETTING },
    });
    return {
      ipUniquenessEnabled: row?.value === 'true',
      changedAt: row?.updatedAt?.toISOString() ?? null,
      hashConfigured:
        (process.env.LANDING_ANALYTICS_IP_HASH_SECRET?.length ?? 0) >= 32,
    };
  }
  async configure(enabled: boolean, userId: string) {
    if (enabled && !(await this.settings()).hashConfigured)
      throw new BadRequestException(
        'Сначала настройте серверный ключ хеширования IP',
      );
    await this.prisma.platformSetting.upsert({
      where: { key: SETTING },
      create: { key: SETTING, value: String(enabled), updatedBy: userId },
      update: { value: String(enabled), updatedBy: userId },
    });
    return this.settings();
  }
  async record(
    body: {
      eventId: string;
      landing: string;
      locale: string;
      source?: string;
      traffic?: string;
    },
    ip: string,
  ) {
    // Old clients remain distinguishable; never infer past attribution.
    const legacy = body.source === undefined && body.traffic === undefined;
    if (
      !legacy &&
      (!['linkedin', 'unknown'].includes(body.source ?? '') ||
        !['test', 'unmarked'].includes(body.traffic ?? ''))
    ) {
      throw new BadRequestException('Недопустимые метки просмотра');
    }
    const dimensions = legacy
      ? {}
      : { source: body.source, traffic: body.traffic };
    const settings = await this.settings();
    await this.prisma.landingVisit.createMany({
      data: [
        {
          id: body.eventId,
          ...dimensions,
          landing: body.landing,
          locale: body.locale,
          visitorHash: visitHash(
            ip,
            settings.ipUniquenessEnabled,
            process.env.LANDING_ANALYTICS_IP_HASH_SECRET,
          ),
        },
      ],
      skipDuplicates: true,
    });
    return { accepted: true };
  }
  async report(days: number, traffic = 'all', source = 'all') {
    if (
      !['all', 'non-test', 'test', 'legacy'].includes(traffic) ||
      !['all', 'linkedin', 'unknown', 'legacy'].includes(source)
    ) {
      throw new BadRequestException('Недопустимый фильтр просмотров');
    }
    const now = new Date();
    // Whole Kyiv calendar days, including today; no client-controlled SQL fragments.
    const sinceRows = await this.prisma.$queryRaw<
      Array<{ since: Date }>
    >`SELECT ((date_trunc('day', ${now}::timestamptz AT TIME ZONE 'Europe/Kyiv') - (${days}::int - 1) * interval '1 day') AT TIME ZONE 'Europe/Kyiv') AS since`;
    const since = sinceRows[0].since;
    const trafficClause =
      traffic === 'test'
        ? Prisma.sql`AND traffic = 'test'`
        : traffic === 'non-test'
          ? Prisma.sql`AND traffic IS DISTINCT FROM 'test'`
          : traffic === 'legacy'
            ? Prisma.sql`AND traffic IS NULL`
            : Prisma.empty;
    const sourceClause =
      source === 'legacy'
        ? Prisma.sql`AND source IS NULL`
        : source === 'all'
          ? Prisma.empty
          : Prisma.sql`AND source = ${source}`;
    const where = Prisma.sql`"createdAt" >= ${since} AND "createdAt" <= ${now} ${trafficClause} ${sourceClause}`;
    const rows = await this.prisma.$queryRaw<
      Array<{
        landing: string;
        locale: string;
        source: string | null;
        traffic: string | null;
        views: bigint;
        uniqueIps: bigint;
        ipCountedViews: bigint;
      }>
    >`
      SELECT landing, locale, source, traffic, count(*) AS views, count(DISTINCT "visitorHash") AS "uniqueIps", count("visitorHash") AS "ipCountedViews"
      FROM landing_visits WHERE ${where} GROUP BY landing, locale, source, traffic ORDER BY count(*) DESC`;
    const timeline = await this.prisma.$queryRaw<
      Array<{ day: string; views: bigint }>
    >`
      SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv', 'YYYY-MM-DD') AS day, count(*) AS views
      FROM landing_visits WHERE ${where} GROUP BY day ORDER BY day`;
    const totals = await this.prisma.$queryRaw<
      Array<{ views: bigint; uniqueIps: bigint; ipCountedViews: bigint }>
    >`
      SELECT count(*) AS views, count(DISTINCT "visitorHash") AS "uniqueIps", count("visitorHash") AS "ipCountedViews"
      FROM landing_visits WHERE ${where}`;
    const numbers = <
      T extends { views: bigint; uniqueIps: bigint; ipCountedViews: bigint },
    >(
      r: T,
    ) => ({
      ...r,
      views: Number(r.views),
      uniqueIps: Number(r.uniqueIps),
      ipCountedViews: Number(r.ipCountedViews),
    });
    return {
      days,
      filters: { traffic, source },
      timezone: 'Europe/Kyiv',
      since: since.toISOString(),
      generatedAt: now.toISOString(),
      settings: await this.settings(),
      totals: numbers(totals[0]),
      rows: rows.map(numbers),
      timeline: timeline.map((r) => ({ ...r, views: Number(r.views) })),
    };
  }
}
