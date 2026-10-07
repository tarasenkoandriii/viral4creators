/**
 * Защита и валидация `/api/admin/users/:id/persona-age` (В-4, заход 8).
 * Настоящий Nest, настоящий `AdminSessionGuard` и глобальная валидация;
 * подменены база сессий, проверка оператора и сам сервис персоны (у него
 * свои тесты в `persona.service.spec.ts`).
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
import { PersonaAdminController } from './persona-admin.controller';
import { PersonaService } from './persona.service';

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
const personas = { ageMarkState: jest.fn(), clearAgeMark: jest.fn() };

const STATE = {
  userId: 'usr_target',
  personaEnabled: true,
  persona: null,
  clears: [],
};

describe('admin/users/:id/persona-age (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PersonaAdminController],
      providers: [
        AdminSessionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
        { provide: PersonaService, useValue: personas },
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
    personas.ageMarkState.mockResolvedValue(STATE);
    personas.clearAgeMark.mockResolvedValue(STATE);
  });

  const server = () => app.getHttpServer();
  const URL = '/api/admin/users/usr_target/persona-age';
  const asOp = (t: request.Test) =>
    t.set('Cookie', 'admin_session=tok_operator');

  describe.each([
    ['GET', () => request(server()).get(URL)],
    [
      'POST clear',
      () =>
        request(server())
          .post(`${URL}/clear`)
          .send({ reason: 'паспорт показан в поддержке' }),
    ],
  ] as Array<[string, () => request.Test]>)('%s', (_n, call) => {
    it('без cookie — 401, сервис не тронут', async () => {
      await call().expect(401);
      expect(personas.ageMarkState).not.toHaveBeenCalled();
      expect(personas.clearAgeMark).not.toHaveBeenCalled();
    });

    it('не оператор — 403, сервис не тронут', async () => {
      await call().set('Cookie', 'admin_session=tok_user').expect(403);
      expect(personas.ageMarkState).not.toHaveBeenCalled();
      expect(personas.clearAgeMark).not.toHaveBeenCalled();
    });
  });

  it('GET: оператор, no-store, пользователь из адреса', async () => {
    const res = await asOp(request(server()).get(URL)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toEqual(STATE);
    expect(personas.ageMarkState).toHaveBeenCalledWith('usr_target');
  });

  it('POST clear: причина обрезана, автор — оператор из сессии, а не из тела', async () => {
    await asOp(
      request(server())
        .post(`${URL}/clear`)
        .send({ reason: '  апелляция: возраст подтверждён  ' }),
    ).expect(201);
    expect(personas.clearAgeMark).toHaveBeenCalledWith(
      'usr_target',
      'usr_op',
      'апелляция: возраст подтверждён',
    );
  });

  it('POST clear: без причины, короче 3 (после обрезки), длиннее 500, не строка, чужое поле — 400', async () => {
    for (const body of [
      {},
      { reason: '' },
      { reason: '  ab  ' },
      { reason: 'x'.repeat(501) },
      { reason: 123 },
      { reason: 'годная причина', verified: true },
    ]) {
      await asOp(request(server()).post(`${URL}/clear`).send(body)).expect(400);
    }
    expect(personas.clearAgeMark).not.toHaveBeenCalled();
  });

  it('POST clear: ровно 3 и ровно 500 символов — принято', async () => {
    for (const reason of ['abc', 'y'.repeat(500)]) {
      await asOp(
        request(server()).post(`${URL}/clear`).send({ reason }),
      ).expect(201);
    }
    expect(personas.clearAgeMark).toHaveBeenCalledTimes(2);
  });
});
