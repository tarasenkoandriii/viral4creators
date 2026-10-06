/**
 * Контракт `GET /api/admin/attention`: кого пускает и что отдаёт.
 *
 * Настоящий Nest, настоящий `AdminSessionGuard` и настоящий
 * `AdminAttentionService` — подменены только база и два сервиса-источника
 * (сводка кронов и сводка демо), у которых свои тесты. Снятый с
 * контроллера гвард модульный тест не заметит, HTTP-запрос без cookie —
 * заметит.
 */
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { AdminCronService } from '../cron/admin-cron.service';
import { DemoStatusService } from '../ops-status/demo-status.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { AdminAttentionController } from './admin-attention.controller';
import { AdminAttentionService } from './admin-attention.service';

const HOUR = 3_600_000;
const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_operator: { userId: 'usr_op', expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
  tok_expired: { userId: 'usr_op', expiresAt: new Date(Date.now() - 1000) },
};
const OPERATORS = new Set(['usr_op']);

const ago = (ms: number) => new Date(Date.now() - ms);
const emptyAgg = { _count: { _all: 0 }, _min: { createdAt: null } };

function freshPrisma() {
  return {
    adminSession: {
      findUnique: jest.fn(
        async (args: { where: { token: string } }) =>
          SESSIONS[args.where.token] ?? null,
      ),
    },
    cronRunLog: { findMany: jest.fn().mockResolvedValue([]) },
    tutorialVideoAsset: {
      findFirst: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue(emptyAgg),
    },
    tutorialVideoVersion: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      aggregate: jest.fn().mockResolvedValue(emptyAgg),
    },
    uiSnapshot: { groupBy: jest.fn().mockResolvedValue([]) },
    publicationRequest: { aggregate: jest.fn().mockResolvedValue(emptyAgg) },
    sharedVideoPage: { aggregate: jest.fn().mockResolvedValue(emptyAgg) },
    portfolioItem: { aggregate: jest.fn().mockResolvedValue(emptyAgg) },
    auctionListing: { aggregate: jest.fn().mockResolvedValue(emptyAgg) },
    blogPost: { aggregate: jest.fn().mockResolvedValue(emptyAgg) },
    clientSiteTutorialDraft: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

let prisma = freshPrisma();
const prismaProxy = new Proxy(
  {},
  { get: (_t, key: string) => (prisma as Record<string, unknown>)[key] },
);

const adminPanel = {
  assertOperator: jest.fn(async (userId: string) => {
    if (!OPERATORS.has(userId)) {
      throw new ForbiddenException('Operator access required');
    }
  }),
};

const emptySummary = () => ({ jobs: [], lockMs: 11 * 60_000 });
const adminCron = { getSummary: jest.fn() };
const emptyDemo = () => ({
  generatedAt: new Date().toISOString(),
  crons: [],
  tutorials: { locales: ['ru'], cells: [], totals: {} },
  uiSnapshots: { sinceDays: 30, items: [] },
});
const demoStatus = { get: jest.fn() };
const settings = { get: jest.fn() };

describe('GET /api/admin/attention (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminAttentionController],
      providers: [
        AdminSessionGuard,
        AdminAttentionService,
        { provide: PrismaService, useValue: prismaProxy },
        { provide: AdminPanelService, useValue: adminPanel },
        { provide: AdminCronService, useValue: adminCron },
        { provide: DemoStatusService, useValue: demoStatus },
        { provide: PlatformSettingsService, useValue: settings },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    prisma = freshPrisma();
    adminCron.getSummary.mockResolvedValue(emptySummary());
    demoStatus.get.mockResolvedValue(emptyDemo());
    settings.get.mockResolvedValue(null);
  });

  const get = () => request(app.getHttpServer()).get('/api/admin/attention');
  const asOperator = () => get().set('Cookie', 'admin_session=tok_operator');

  it('без cookie — 401, источники не тронуты', async () => {
    await get().expect(401);
    expect(adminCron.getSummary).not.toHaveBeenCalled();
    expect(prisma.publicationRequest.aggregate).not.toHaveBeenCalled();
  });

  it('пользовательская cookie вместо админской — 401', async () => {
    await get().set('Cookie', 'user_session=tok_operator').expect(401);
  });

  it('просроченная admin-сессия — 401', async () => {
    await get().set('Cookie', 'admin_session=tok_expired').expect(401);
  });

  it('вошёл, но не оператор — 403, источники не тронуты', async () => {
    await get().set('Cookie', 'admin_session=tok_user').expect(403);
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('usr_plain');
    expect(adminCron.getSummary).not.toHaveBeenCalled();
    expect(demoStatus.get).not.toHaveBeenCalled();
    expect(prisma.clientSiteTutorialDraft.findMany).not.toHaveBeenCalled();
  });

  it('оператор, всё пусто — 200, форма ответа, no-store, качество «не настроено»', async () => {
    const res = await asOperator().expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(
      ['counts', 'generatedAt', 'items', 'sources', 'truncated'].sort(),
    );
    expect(data.items).toEqual([]);
    expect(data.counts).toEqual({ blocker: 0, decision: 0, info: 0, total: 0 });
    expect(data.truncated).toBe(false);
    expect(Number.isNaN(Date.parse(data.generatedAt))).toBe(false);
    const statuses = Object.fromEntries(
      data.sources.map((s: { key: string; status: string }) => [
        s.key,
        s.status,
      ]),
    );
    expect(statuses).toEqual({
      cron: 'ok',
      demo: 'ok',
      'ui-snapshots': 'ok',
      'tutorial-review': 'ok',
      tempo: 'ok',
      moderation: 'ok',
      'client-drafts': 'ok',
      assembly: 'ok',
      quality: 'not_configured',
    });
    // Окно сводки кронов — последние сутки.
    const [{ since, until }] = adminCron.getSummary.mock.calls[0];
    expect(until.getTime() - since.getTime()).toBe(24 * HOUR);
  });

  it('критическая ошибка выше ожидающего ролика; форма карточки; без ПД', async () => {
    adminCron.getSummary.mockResolvedValue({
      lockMs: 11 * 60_000,
      jobs: [
        {
          jobKey: 'tutorial-scenario-run',
          expected: 15,
          scheduledRunsInWindow: 15,
          missed: 0,
          expectedSinceJob: ago(24 * HOUR),
          byStatus: { RUNNING: 0, SUCCESS: 3, FAILED: 2 },
          lastSuccessAt: ago(5 * HOUR),
          lastFailureAt: ago(HOUR),
          stuckRunning: 0,
          recentFailures: [
            {
              startedAt: ago(HOUR),
              summary: null,
              errorMessage: 'отказ для operator@example.com, tg 987654321',
            },
          ],
        },
      ],
    });
    prisma.tutorialVideoAsset.groupBy.mockResolvedValue([
      {
        subjectKey: '2',
        locale: 'ru',
        _count: { _all: 1 },
        _min: { createdAt: ago(48 * HOUR) },
      },
    ]);
    prisma.publicationRequest.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _min: { createdAt: ago(3 * HOUR) },
    });
    prisma.clientSiteTutorialDraft.findMany.mockResolvedValue([
      { id: 'draft_1', updatedAt: ago(25 * 24 * HOUR), framesPurgedAt: null },
    ]);

    const res = await asOperator().expect(200);
    const { items, counts } = res.body.data;
    expect(items.map((i: { kind: string }) => i.kind)).toEqual([
      'cron-failed',
      'client-draft-expiring',
      'tutorial-review',
      'publication-review',
    ]);
    expect(counts).toEqual({ blocker: 1, decision: 3, info: 0, total: 4 });
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(
        expect.arrayContaining([
          'id',
          'severity',
          'kind',
          'title',
          'reason',
          'since',
          'ageMs',
          'owner',
          'href',
        ]),
      );
      expect(['blocker', 'decision', 'info']).toContain(it.severity);
      expect(['operator', 'owner', 'system']).toContain(it.owner);
      expect(it.href.startsWith('/')).toBe(true);
      expect(it.ageMs).toBe(
        Date.parse(res.body.data.generatedAt) - Date.parse(it.since),
      );
    }
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('operator@example.com');
    expect(body).not.toContain('987654321');
    expect(body).not.toContain('usr_op');
    // Черновик заказчика читается без заголовка и адреса сайта.
    const draftSelect =
      prisma.clientSiteTutorialDraft.findMany.mock.calls[0][0].select;
    expect(draftSelect).toEqual({
      id: true,
      updatedAt: true,
      framesPurgedAt: true,
    });
  });

  it('устранённая проблема исчезает, повторный запрос не дублирует карточку', async () => {
    prisma.publicationRequest.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _min: { createdAt: ago(HOUR) },
    });
    const first = await asOperator().expect(200);
    const second = await asOperator().expect(200);
    expect(first.body.data.items).toHaveLength(1);
    expect(second.body.data.items.map((i: { id: string }) => i.id)).toEqual([
      'publication-review',
    ]);
    prisma.publicationRequest.aggregate.mockResolvedValue(emptyAgg);
    const third = await asOperator().expect(200);
    expect(third.body.data.items).toEqual([]);
  });

  it('отказ одного источника виден, остальные продолжают работать', async () => {
    adminCron.getSummary.mockRejectedValue(
      new Error('connect ECONNREFUSED https://db.internal:5432 user=admin'),
    );
    prisma.portfolioItem.aggregate.mockResolvedValue({
      _count: { _all: 4 },
      _min: { createdAt: ago(HOUR) },
    });
    const res = await asOperator().expect(200);
    const cron = res.body.data.sources.find(
      (s: { key: string }) => s.key === 'cron',
    );
    expect(cron.status).toBe('error');
    expect(cron.error).toMatch(/^не удалось проверить/);
    expect(cron.error).not.toContain('db.internal');
    expect(res.body.data.items.map((i: { kind: string }) => i.kind)).toEqual([
      'portfolio-review',
    ]);
  });

  it('версия темпа старше последней активации ролика решения не ждёт', async () => {
    prisma.tutorialVideoVersion.findMany.mockResolvedValue([
      {
        assetId: 'a1',
        createdAt: ago(5 * HOUR),
        updatedAt: ago(4 * HOUR),
        tempoFactor: 1.5,
        asset: { subjectKey: '3', locale: 'ru' },
      },
      {
        assetId: 'a2',
        createdAt: ago(2 * HOUR),
        updatedAt: ago(HOUR),
        tempoFactor: 0.4,
        asset: { subjectKey: '4', locale: 'ru' },
      },
    ]);
    prisma.tutorialVideoVersion.groupBy.mockResolvedValue([
      { assetId: 'a1', _max: { activatedAt: ago(3 * HOUR) } },
      { assetId: 'a2', _max: { activatedAt: ago(10 * HOUR) } },
    ]);
    const res = await asOperator().expect(200);
    expect(res.body.data.items.map((i: { id: string }) => i.id)).toEqual([
      'tempo-approval:a2',
    ]);
    const where = prisma.tutorialVideoVersion.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      status: 'complete',
      requiresApproval: true,
      activatedAt: null,
      kind: { not: 'source' },
    });
  });

  it('пробелы матрицы считаются по языкам из настройки', async () => {
    settings.get.mockResolvedValue('ru, uk');
    demoStatus.get.mockResolvedValue({
      ...emptyDemo(),
      tutorials: {
        locales: ['ru', 'uk', 'en'],
        cells: [
          {
            subjectKey: '1',
            locale: 'ru',
            family: 'step',
            approved: null,
            approvedThemes: [],
            pendingReview: 0,
          },
          {
            subjectKey: '1',
            locale: 'uk',
            family: 'step',
            approved: null,
            approvedThemes: [],
            pendingReview: 0,
          },
          {
            subjectKey: '1',
            locale: 'en',
            family: 'step',
            approved: null,
            approvedThemes: [],
            pendingReview: 0,
          },
        ],
        totals: {},
      },
    });
    const res = await asOperator().expect(200);
    const [missing] = res.body.data.items;
    expect(missing.kind).toBe('demo-missing');
    expect(missing.count).toBe(2);
  });
});
