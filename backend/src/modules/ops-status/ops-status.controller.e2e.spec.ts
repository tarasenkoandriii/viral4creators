/**
 * Контракт `GET /api/ops/demo-status`: кого пускает и что отдаёт.
 *
 * Настоящий Nest с настоящим `AdminSessionGuard` и настоящей проверкой
 * оператора — подменена только база. Модульный тест контроллера здесь
 * ничего бы не доказал: гвард вешается декоратором, и снятый декоратор
 * модульный тест не заметит, а HTTP-запрос без cookie — заметит.
 */
import { ForbiddenException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { OpsStatusController } from './ops-status.controller';
import { DemoStatusService } from './demo-status.service';

const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_operator: { userId: 'usr_op', expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
  tok_expired: { userId: 'usr_op', expiresAt: new Date(Date.now() - 1000) },
};
const OPERATORS = new Set(['usr_op']);

const prisma = {
  adminSession: {
    findUnique: jest.fn(
      async (args: { where: { token: string } }) =>
        SESSIONS[args.where.token] ?? null,
    ),
  },
  cronRunLog: { findFirst: jest.fn().mockResolvedValue(null) },
  tutorialVideoAsset: {
    findMany: jest.fn().mockResolvedValue([]),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  uiSnapshot: {
    groupBy: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
  },
};

// Та же проверка, что `AdminPanelService.assertOperator`, — без
// остального сервиса с его двумя десятками зависимостей.
const adminPanel = {
  assertOperator: jest.fn(async (userId: string) => {
    if (!OPERATORS.has(userId)) {
      throw new ForbiddenException('Operator access required');
    }
  }),
};

describe('GET /api/ops/demo-status (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OpsStatusController],
      providers: [
        AdminSessionGuard,
        DemoStatusService,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('без cookie — 401, и база сводки не тронута', async () => {
    await request(app.getHttpServer()).get('/api/ops/demo-status').expect(401);
    expect(prisma.cronRunLog.findFirst).not.toHaveBeenCalled();
  });

  it('пользовательская cookie вместо админской — 401', async () => {
    await request(app.getHttpServer())
      .get('/api/ops/demo-status')
      .set('Cookie', 'user_session=tok_operator')
      .expect(401);
  });

  it('просроченная admin-сессия — 401', async () => {
    await request(app.getHttpServer())
      .get('/api/ops/demo-status')
      .set('Cookie', 'admin_session=tok_expired')
      .expect(401);
  });

  it('вошёл, но не оператор — 403, и база сводки не тронута', async () => {
    await request(app.getHttpServer())
      .get('/api/ops/demo-status')
      .set('Cookie', 'admin_session=tok_user')
      .expect(403);
    expect(adminPanel.assertOperator).toHaveBeenCalledWith('usr_plain');
    expect(prisma.cronRunLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.tutorialVideoAsset.findMany).not.toHaveBeenCalled();
  });

  it('оператор — 200, форма ответа и no-store', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/ops/demo-status')
      .set('Cookie', 'admin_session=tok_operator')
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(
      ['crons', 'generatedAt', 'tutorials', 'uiSnapshots'].sort(),
    );
    expect(data.crons.map((c: { jobKey: string }) => c.jobKey)).toEqual([
      'tutorial-scenario-generate',
      'tutorial-scenario-run',
      'tutorial-assembly-poll',
      'ui-snapshot-run',
    ]);
    expect(Object.keys(data.crons[0]).sort()).toEqual(
      ['jobKey', 'lastFailure', 'lastRun', 'lastSkip', 'lastSuccess'].sort(),
    );
    expect(Array.isArray(data.tutorials.cells)).toBe(true);
    expect(data.tutorials.cells.length).toBeGreaterThan(0);
    expect(Object.keys(data.tutorials.cells[0]).sort()).toEqual(
      [
        'approved',
        'approvedThemes',
        'byTheme',
        'family',
        'locale',
        'pendingReview',
        'subjectKey',
      ].sort(),
    );
    expect(data.tutorials.totals).toEqual(
      expect.objectContaining({
        withApproved: 0,
        pendingReview: 0,
        withApprovedByTheme: { light: 0, dark: 0 },
      }),
    );
    expect(Object.keys(data.tutorials.cells[0].byTheme).sort()).toEqual([
      'dark',
      'light',
    ]);
    expect(data.uiSnapshots).toEqual({ sinceDays: 30, items: [] });
  });

  it('маршрут только на чтение: POST не существует', async () => {
    await request(app.getHttpServer())
      .post('/api/ops/demo-status')
      .set('Cookie', 'admin_session=tok_operator')
      .expect(404);
  });
});
