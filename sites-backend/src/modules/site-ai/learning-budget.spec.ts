/**
 * Бюджет обучения (Р-58): доля сайта — чистая функция; резерв/поправка —
 * на НАСТОЯЩЕМ Postgres (условный UPDATE нельзя проверить фейком честно).
 */
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  budgetPeriod,
  LearningBudget,
  siteShareMicroUsd,
} from './learning-budget';

describe('доля бюджета обучения сайта', () => {
  it('поровну между сайтами без явной доли', () => {
    const sites = [
      { siteId: 'a', learningShareBp: null },
      { siteId: 'b', learningShareBp: null },
    ];
    expect(siteShareMicroUsd(500_000, 'a', sites)).toBe(250_000);
  });

  it('явная доля — от потолка; остальные делят остаток', () => {
    const sites = [
      { siteId: 'a', learningShareBp: 6_000 },
      { siteId: 'b', learningShareBp: null },
      { siteId: 'c', learningShareBp: null },
    ];
    expect(siteShareMicroUsd(500_000, 'a', sites)).toBe(300_000);
    expect(siteShareMicroUsd(500_000, 'b', sites)).toBe(100_000);
  });

  it('сайт без включённого помощника тоже считается в «поровну»', () => {
    expect(
      siteShareMicroUsd(500_000, 'new', [
        { siteId: 'a', learningShareBp: null },
      ]),
    ).toBe(250_000);
  });

  it('период — месяц UTC', () => {
    expect(budgetPeriod(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
  });
});

const RAW_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

if (!RAW_URL) {
  describe('бюджет обучения на реальном Postgres (нет базы)', () => {
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет SITES_DIRECT_URL — проверка идёт в CI',
      () => {
        throw new Error('CI=true, но SITES_DIRECT_URL не задана');
      },
    );
  });
} else {
  describe('бюджет обучения на реальном Postgres', () => {
    let prisma: PrismaService;
    let budget: LearningBudget;
    let accountId: string;
    let siteA: string;
    let siteB: string;

    beforeAll(async () => {
      const u = new URL(RAW_URL);
      u.searchParams.delete('schema');
      process.env.SITES_DATABASE_URL = u.toString();
      prisma = new PrismaService();
      budget = new LearningBudget(new SitesDb(prisma));
      const acc = await prisma.siteAccount.create({
        data: { verifyToken: `lb-${randomUUID()}` },
      });
      accountId = acc.id;
      siteA = (await prisma.site.create({ data: { accountId, name: 'A' } })).id;
      siteB = (await prisma.site.create({ data: { accountId, name: 'B' } })).id;
      for (const siteId of [siteA, siteB]) {
        await prisma.assistSite.create({
          data: { accountId, siteId, enabled: true },
        });
      }
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    it('резерв в пределах доли; сверх — отказ без списания; поправка на факт', async () => {
      // $0.5 на кабинет, два сайта → $0.25 = 250 000 микро на сайт.
      expect(await budget.reserve(accountId, siteA, 200_000)).toBe(true);
      expect(await budget.reserve(accountId, siteA, 60_000)).toBe(false);
      expect((await budget.status(accountId, siteA)).spentMicroUsd).toBe(
        200_000,
      );
      await budget.adjust(accountId, siteA, -50_000);
      expect(await budget.reserve(accountId, siteA, 100_000)).toBe(true);
      const st = await budget.status(accountId, siteA);
      expect(st).toMatchObject({
        capMicroUsd: 250_000,
        spentMicroUsd: 250_000,
      });
      // Сайт B — своя доля.
      expect(await budget.reserve(accountId, siteB, 250_000)).toBe(true);
      expect(await budget.reserve(accountId, siteB, 1)).toBe(false);
    });

    it('возврат не уводит счётчик ниже нуля; факт дороже оценки — списывается', async () => {
      await budget.adjust(accountId, siteA, -10_000_000);
      expect((await budget.status(accountId, siteA)).spentMicroUsd).toBe(0);
      await budget.adjust(accountId, siteA, 30);
      expect((await budget.status(accountId, siteA)).spentMicroUsd).toBe(30);
      expect(await budget.reserve(accountId, siteA, 0)).toBe(true);
    });

    it('параллельные резервы не превышают долю (атомарный условный UPDATE)', async () => {
      await budget.adjust(accountId, siteA, -10_000_000);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          budget.reserve(accountId, siteA, 50_000),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(5);
      expect((await budget.status(accountId, siteA)).spentMicroUsd).toBe(
        250_000,
      );
    });

    it('новый месяц — новый счётчик', async () => {
      budget.now = () => new Date('2099-01-15T00:00:00Z');
      try {
        expect((await budget.status(accountId, siteA)).spentMicroUsd).toBe(0);
        expect(await budget.reserve(accountId, siteA, 250_000)).toBe(true);
      } finally {
        budget.now = () => new Date();
      }
    });
  });
}
