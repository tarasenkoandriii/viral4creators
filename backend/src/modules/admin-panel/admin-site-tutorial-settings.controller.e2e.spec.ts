/**
 * Защита и валидация `/api/admin/settings/site-tutorial` (П-Т9, заход 7).
 * Настоящий Nest, настоящий `AdminSessionGuard` и глобальная валидация;
 * подменены база сессий, проверка оператора и сам сервис (у него свои
 * тесты).
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
import { AdminPanelService } from './admin-panel.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { AdminSiteTutorialSettingsController } from './admin-site-tutorial-settings.controller';
import { AdminSiteTutorialSettingsService } from './admin-site-tutorial-settings.service';

const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_operator: { userId: 'usr_op', expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
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
const service = { view: jest.fn(), set: jest.fn() };

describe('admin/settings/site-tutorial (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSiteTutorialSettingsController],
      providers: [
        AdminSessionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
        { provide: AdminSiteTutorialSettingsService, useValue: service },
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
    service.view.mockResolvedValue({ paused: false });
    service.set.mockResolvedValue({ paused: true });
  });

  const server = () => app.getHttpServer();
  const URL = '/api/admin/settings/site-tutorial';
  const asOp = (t: request.Test) =>
    t.set('Cookie', 'admin_session=tok_operator');

  describe.each([
    ['GET', () => request(server()).get(URL)],
    ['PATCH', () => request(server()).patch(URL).send({ paused: true })],
  ] as Array<[string, () => request.Test]>)('%s', (_n, call) => {
    it('без cookie — 401, сервис не тронут', async () => {
      await call().expect(401);
      expect(service.view).not.toHaveBeenCalled();
      expect(service.set).not.toHaveBeenCalled();
    });

    it('не оператор — 403, сервис не тронут', async () => {
      await call().set('Cookie', 'admin_session=tok_user').expect(403);
      expect(service.view).not.toHaveBeenCalled();
      expect(service.set).not.toHaveBeenCalled();
    });
  });

  it('GET: оператор, no-store', async () => {
    const res = await asOp(request(server()).get(URL)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual({ paused: false });
  });

  it('PATCH: только присланное, null — вернуть умолчание, автор — оператор', async () => {
    await asOp(
      request(server())
        .patch(URL)
        .send({ roundsPerDay: 250, liveSessionsPerDay: null }),
    ).expect(200);
    expect(service.set).toHaveBeenCalledWith(
      { roundsPerDay: 250, liveSessionsPerDay: null },
      'usr_op',
    );
    await asOp(request(server()).patch(URL).send({ paused: false })).expect(
      200,
    );
    expect(service.set).toHaveBeenLastCalledWith({ paused: false }, 'usr_op');
  });

  it('PATCH: ноль, дробь, сверх 1e6, строка, чужое поле — 400', async () => {
    for (const body of [
      { roundsPerDay: 0 },
      { roundsPerDay: 2.5 },
      { liveSessionsPerDay: 1_000_001 },
      { roundsPerDay: '100' },
      { paused: 'yes' },
      { paused: true, extra: 1 },
    ]) {
      await asOp(request(server()).patch(URL).send(body)).expect(400);
    }
    expect(service.set).not.toHaveBeenCalled();
  });
});
