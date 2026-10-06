/**
 * Защита маршрутов проверки качества демо: кого пускает и что передаёт.
 *
 * Настоящий Nest, настоящий `AdminSessionGuard`, настоящая глобальная
 * валидация; подменены база сессий, проверка оператора и сам сервис
 * (у него свои тесты). Снятый с контроллера гвард модульный тест не
 * заметит, HTTP-запрос без cookie — заметит.
 */
import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { DemoQualityAdminController } from './demo-quality-admin.controller';
import { TutorialDemoQualityService } from './demo-quality.service';

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
};
const adminPanel = {
  assertOperator: jest.fn(async (userId: string) => {
    if (!OPERATORS.has(userId)) {
      throw new ForbiddenException('Operator access required');
    }
  }),
};
const quality = {
  latestForAssets: jest.fn(),
  enqueueByOperator: jest.fn(),
  enqueueApproved: jest.fn(),
};

describe('admin/tutorial-demo-quality (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DemoQualityAdminController],
      providers: [
        AdminSessionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
        { provide: TutorialDemoQualityService, useValue: quality },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    jest.clearAllMocks();
    quality.latestForAssets.mockResolvedValue({ enabled: true, checks: {} });
    quality.enqueueByOperator.mockResolvedValue({
      created: true,
      reason: null,
      check: { id: 'c1' },
    });
    quality.enqueueApproved.mockResolvedValue({
      queued: 2,
      skipped: 0,
      remaining: 0,
      cap: 20,
    });
  });

  const server = () => app.getHttpServer();
  const routes: Array<[string, () => request.Test]> = [
    [
      'GET /',
      () =>
        request(server()).get('/api/admin/tutorial-demo-quality?assetIds=a1'),
    ],
    [
      'POST assets/:id/check',
      () =>
        request(server())
          .post('/api/admin/tutorial-demo-quality/assets/a1/check')
          .send({}),
    ],
    [
      'POST approved/check',
      () =>
        request(server()).post(
          '/api/admin/tutorial-demo-quality/approved/check',
        ),
    ],
  ];
  const untouched = () => {
    expect(quality.latestForAssets).not.toHaveBeenCalled();
    expect(quality.enqueueByOperator).not.toHaveBeenCalled();
    expect(quality.enqueueApproved).not.toHaveBeenCalled();
  };

  describe.each(routes)('%s', (_name, call) => {
    it('без cookie — 401, сервис не тронут', async () => {
      await call().expect(401);
      untouched();
    });

    it('пользовательская cookie вместо админской — 401', async () => {
      await call().set('Cookie', 'user_session=tok_operator').expect(401);
      untouched();
    });

    it('просроченная admin-сессия — 401', async () => {
      await call().set('Cookie', 'admin_session=tok_expired').expect(401);
      untouched();
    });

    it('вошёл, но не оператор — 403, сервис не тронут', async () => {
      await call().set('Cookie', 'admin_session=tok_user').expect(403);
      expect(adminPanel.assertOperator).toHaveBeenCalledWith('usr_plain');
      untouched();
    });
  });

  const asOp = (t: request.Test) =>
    t.set('Cookie', 'admin_session=tok_operator');

  it('оператор: последние проверки по списку роликов, no-store', async () => {
    const res = await asOp(
      request(server()).get(
        '/api/admin/tutorial-demo-quality?assetIds=a1, a2,,a3',
      ),
    ).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(quality.latestForAssets).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
    expect(res.body.data).toEqual({ enabled: true, checks: {} });
  });

  it('оператор: «Проверить» — ролик, автор и версия', async () => {
    await asOp(
      request(server())
        .post('/api/admin/tutorial-demo-quality/assets/a1/check')
        .send({ versionId: 'v1' }),
    ).expect(201);
    expect(quality.enqueueByOperator).toHaveBeenCalledWith(
      'a1',
      'usr_op',
      'v1',
    );
    await asOp(
      request(server())
        .post('/api/admin/tutorial-demo-quality/assets/a2/check')
        .send({}),
    ).expect(201);
    expect(quality.enqueueByOperator).toHaveBeenLastCalledWith(
      'a2',
      'usr_op',
      undefined,
    );
  });

  it('оператор: чужие поля тела отвергаются валидацией', async () => {
    await asOp(
      request(server())
        .post('/api/admin/tutorial-demo-quality/assets/a1/check')
        .send({ versionId: 5 }),
    ).expect(400);
    await asOp(
      request(server())
        .post('/api/admin/tutorial-demo-quality/assets/a1/check')
        .send({ verdict: 'ok' }),
    ).expect(400);
    expect(quality.enqueueByOperator).not.toHaveBeenCalled();
  });

  it('оператор: «Проверить все одобренные»', async () => {
    const res = await asOp(
      request(server()).post('/api/admin/tutorial-demo-quality/approved/check'),
    ).expect(201);
    expect(quality.enqueueApproved).toHaveBeenCalledWith('usr_op');
    expect(res.body.data).toEqual({
      queued: 2,
      skipped: 0,
      remaining: 0,
      cap: 20,
    });
  });
});
