import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { LandingVisitDto } from './landing-visits.controller';
import { BadRequestException } from '@nestjs/common';
import { LandingVisitsService } from './landing-visits.service';
import { visitHash, visitOriginAllowed } from './landing-visits.contract';
import {
  LandingVisitsController,
  AdminLandingVisitsController,
} from './landing-visits.controller';
import { PrismaService } from '../../prisma/prisma.service';
const key = 'a'.repeat(64);
describe('Landing views privacy and access', () => {
  const prisma = {
    platformSetting: { findUnique: jest.fn(), upsert: jest.fn() },
    landingVisit: { createMany: jest.fn() },
    $queryRaw: jest.fn(),
  };
  const service = new LandingVisitsService(prisma as unknown as PrismaService);
  beforeEach(() => jest.resetAllMocks());
  it('does not create a visitor identifier unless IP uniqueness is explicitly enabled', () => {
    expect(visitHash('192.0.2.1', false, key)).toBeNull();
    expect(visitHash('192.0.2.1', true, undefined)).toBeNull();
    expect(visitHash('unknown', true, key)).toBeNull();
  });
  it('rejects source fields, arbitrary locales and invalid event identifiers', () => {
    const valid = {
      eventId: '6dde81f0-9390-4054-b21e-d7f79cf04f71',
      landing: 'tutorial',
      locale: 'uk',
    };
    for (const body of [
      { ...valid, referrer: 'reddit.com' },
      { ...valid, locale: 'invalid' },
      { ...valid, eventId: 'bad' },
    ]) {
      expect(
        validateSync(plainToInstance(LandingVisitDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        }).length,
      ).toBeGreaterThan(0);
    }
  });
  it('deduplicates canonical IPv6 while separating IPs and secret rotations', () => {
    expect(visitHash('2001:db8::1', true, key)).toBe(
      visitHash('2001:0db8:0:0:0:0:0:1', true, key),
    );
    expect(visitHash('192.0.2.1', true, key)).not.toBe(
      visitHash('192.0.2.2', true, key),
    );
    expect(visitHash('192.0.2.1', true, key)).not.toBe(
      visitHash('192.0.2.1', true, 'b'.repeat(64)),
    );
  });
  it('does not accept absent, lookalike, wrong-product or closed Story origins', () => {
    expect(
      visitOriginAllowed('https://tutorial.viral4creators.app', 'tutorial'),
    ).toBe(true);
    expect(visitOriginAllowed(undefined, 'tutorial')).toBe(false);
    expect(
      visitOriginAllowed(
        'https://tutorial.viral4creators.app.evil.test',
        'tutorial',
      ),
    ).toBe(false);
    expect(
      visitOriginAllowed('https://greeting.viral4creators.app', 'publisher'),
    ).toBe(false);
    expect(
      visitOriginAllowed('https://story-tales.viral4creators.app', 'main'),
    ).toBe(false);
  });
  it('stores only the permitted dimensions and deduplicates request retries', async () => {
    prisma.platformSetting.findUnique.mockResolvedValue(null);
    const body = {
      eventId: '6dde81f0-9390-4054-b21e-d7f79cf04f71',
      landing: 'tutorial',
      locale: 'uk',
    };
    await service.record(body, '192.0.2.1');
    expect(prisma.landingVisit.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: body.eventId,
          landing: 'tutorial',
          locale: 'uk',
          visitorHash: null,
        },
      ],
      skipDuplicates: true,
    });
  });
  it('refuses to enable hashing without a server secret', async () => {
    const old = process.env.LANDING_ANALYTICS_IP_HASH_SECRET;
    delete process.env.LANDING_ANALYTICS_IP_HASH_SECRET;
    prisma.platformSetting.findUnique.mockResolvedValue(null);
    try {
      await expect(service.configure(true, 'operator')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    } finally {
      if (old !== undefined) process.env.LANDING_ANALYTICS_IP_HASH_SECRET = old;
    }
    expect(prisma.platformSetting.upsert).not.toHaveBeenCalled();
  });
  it('does not sum per-landing unique counts into a misleading overall total', async () => {
    prisma.platformSetting.findUnique.mockResolvedValue(null);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ since: new Date('2026-10-16T21:00:00Z') }])
      .mockResolvedValueOnce([
        {
          landing: 'tutorial',
          locale: 'en',
          views: 2n,
          uniqueIps: 1n,
          ipCountedViews: 2n,
        },
        {
          landing: 'main',
          locale: 'en',
          views: 1n,
          uniqueIps: 1n,
          ipCountedViews: 1n,
        },
      ])
      .mockResolvedValueOnce([{ day: '2026-10-17', views: 3n }])
      .mockResolvedValueOnce([
        { views: 3n, uniqueIps: 1n, ipCountedViews: 3n },
      ]);
    const report = await service.report(7);
    expect(report.totals).toEqual({
      views: 3,
      uniqueIps: 1,
      ipCountedViews: 3,
    });
    expect(report.timezone).toBe('Europe/Kyiv');
  });
  it('rejects invalid origins before writing an event', () => {
    const record = jest.fn();
    const c = new LandingVisitsController({ record } as never);
    expect(() =>
      c.record({ eventId: 'x', landing: 'tutorial', locale: 'en' }, {
        headers: { origin: 'https://evil.test' },
      } as never),
    ).toThrow();
    expect(record).not.toHaveBeenCalled();
  });
  it('enforces operator authorization before report and setting changes', async () => {
    const admin = {
      assertOperator: jest.fn().mockRejectedValue(new Error('forbidden')),
    };
    const report = jest.fn(),
      configure = jest.fn();
    const c = new AdminLandingVisitsController(
      { report, configure } as never,
      admin as never,
    );
    await expect(
      c.report({ userId: 'user' } as never, { days: '7' }),
    ).rejects.toThrow('forbidden');
    await expect(
      c.configure({ userId: 'user' } as never, { ipUniquenessEnabled: true }),
    ).rejects.toThrow('forbidden');
    expect(report).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  });
});
