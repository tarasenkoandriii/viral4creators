/**
 * WP1: защита и валидация `/api/admin/story-tales/*` — настоящий Nest,
 * настоящий `AdminSessionGuard` и глобальная валидация; сервисы подменены
 * (у них свои тесты).
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
import { AdminStoryTalesController } from './story-operator.controller';
import { StoryOperatorService } from './story-operator.service';
import { StoryRetentionService } from './story-retention.service';

const SESSIONS: Record<string, { userId: string; expiresAt: Date }> = {
  tok_operator: { userId: 'usr_op', expiresAt: new Date(Date.now() + 3600e3) },
  tok_user: { userId: 'usr_plain', expiresAt: new Date(Date.now() + 3600e3) },
};
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
    if (userId !== 'usr_op')
      throw new ForbiddenException('Operator access required');
  }),
};
const ok = { replayed: false, result: {} };
const operator = {
  queue: jest.fn().mockResolvedValue({
    gifts: [],
    renders: [],
    references: [],
    segments: [],
  }),
  journal: jest.fn().mockResolvedValue([]),
  closeGift: jest.fn().mockResolvedValue(ok),
  reopenGift: jest.fn().mockResolvedValue(ok),
  resetGiftQa: jest.fn().mockResolvedValue(ok),
  bindRenderJob: jest.fn().mockResolvedValue(ok),
  closeRender: jest.fn().mockResolvedValue(ok),
  resetRenderQa: jest.fn().mockResolvedValue(ok),
  closeReference: jest.fn().mockResolvedValue(ok),
  deleteReference: jest.fn().mockResolvedValue(ok),
  closeSegment: jest.fn().mockResolvedValue(ok),
};
const retention = { run: jest.fn().mockResolvedValue({ dryRun: true }) };
const REQ = '0f8fad5b-d9cb-469f-a165-70867728950e';
const body = { reason: 'Сверено с кабинетом', requestId: REQ };

describe('admin/story-tales (e2e)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminStoryTalesController],
      providers: [
        AdminSessionGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: AdminPanelService, useValue: adminPanel },
        { provide: StoryOperatorService, useValue: operator },
        { provide: StoryRetentionService, useValue: retention },
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
  beforeEach(() => jest.clearAllMocks());
  const server = () => app.getHttpServer();
  const URL = '/api/admin/story-tales';
  const asOp = (t: request.Test) =>
    t.set('Cookie', 'admin_session=tok_operator');

  const calls: Array<[string, () => request.Test]> = [
    ['GET queue', () => request(server()).get(`${URL}/queue`)],
    ['GET journal', () => request(server()).get(`${URL}/journal`)],
    ['GET retention', () => request(server()).get(`${URL}/retention`)],
    [
      'POST gift close',
      () => request(server()).post(`${URL}/gifts/g/close`).send(body),
    ],
    [
      'POST render bind',
      () =>
        request(server())
          .post(`${URL}/renders/r/bind-job`)
          .send({ ...body, jobId: 'job-1' }),
    ],
    [
      'POST segment close',
      () =>
        request(server())
          .post(`${URL}/segments/s/close`)
          .send({ ...body, providerChargeConfirmedAbsent: true }),
    ],
    [
      'POST reference delete',
      () => request(server()).post(`${URL}/references/x/delete`).send(body),
    ],
  ];
  describe.each(calls)('%s', (_n, call) => {
    it('без cookie — 401, сервисы не тронуты', async () => {
      await call().expect(401);
      expect(Object.values(operator).some((f) => f.mock.calls.length)).toBe(
        false,
      );
      expect(retention.run).not.toHaveBeenCalled();
    });
    it('не оператор — 403, сервисы не тронуты', async () => {
      await call().set('Cookie', 'admin_session=tok_user').expect(403);
      expect(Object.values(operator).some((f) => f.mock.calls.length)).toBe(
        false,
      );
      expect(retention.run).not.toHaveBeenCalled();
    });
  });

  it('очередь и превью сроков хранения: no-store, превью — всегда dry-run', async () => {
    const res = await asOp(request(server()).get(`${URL}/queue`)).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    await asOp(request(server()).get(`${URL}/retention`)).expect(200);
    expect(retention.run).toHaveBeenCalledWith({
      dryRun: true,
      withCandidates: true,
    });
  });

  it('пустая причина, без requestId, лишнее поле — 400 до сервиса', async () => {
    for (const bad of [
      { ...body, reason: '' },
      { ...body, reason: '     ' },
      { reason: body.reason },
      { ...body, requestId: 'abc' },
      { ...body, providerChargeConfirmedAbsent: true },
    ])
      await asOp(
        request(server()).post(`${URL}/gifts/g/close`).send(bad),
      ).expect(400);
    expect(operator.closeGift).not.toHaveBeenCalled();
  });

  it('повтор в DRAFT и сброс QA требуют providerChargeConfirmedAbsent: true', async () => {
    for (const path of [
      'gifts/g/reopen',
      'gifts/g/qa-reset',
      'renders/r/qa-reset',
      'segments/s/close',
    ]) {
      await asOp(request(server()).post(`${URL}/${path}`).send(body)).expect(
        400,
      );
      await asOp(
        request(server())
          .post(`${URL}/${path}`)
          .send({ ...body, providerChargeConfirmedAbsent: false }),
      ).expect(400);
    }
    await asOp(
      request(server())
        .post(`${URL}/gifts/g/reopen`)
        .send({ ...body, providerChargeConfirmedAbsent: true }),
    ).expect(200);
    expect(operator.reopenGift).toHaveBeenCalledWith('usr_op', 'g', {
      ...body,
      providerChargeConfirmedAbsent: true,
    });
    expect(operator.closeSegment).not.toHaveBeenCalled();
    await asOp(
      request(server())
        .post(`${URL}/segments/s/close`)
        .send({ ...body, providerChargeConfirmedAbsent: true }),
    ).expect(200);
    expect(operator.closeSegment).toHaveBeenCalledWith('usr_op', 's', {
      ...body,
      providerChargeConfirmedAbsent: true,
    });
  });

  it('закрытие сборки требует явного releaseReserve', async () => {
    await asOp(
      request(server()).post(`${URL}/renders/r/close`).send(body),
    ).expect(400);
    await asOp(
      request(server())
        .post(`${URL}/renders/r/close`)
        .send({ ...body, releaseReserve: false }),
    ).expect(200);
    expect(operator.closeRender).toHaveBeenCalledWith('usr_op', 'r', {
      ...body,
      releaseReserve: false,
    });
  });

  it('привязка задания и действия с референсами передают автора-оператора', async () => {
    await asOp(
      request(server()).post(`${URL}/renders/r/bind-job`).send(body),
    ).expect(400);
    await asOp(
      request(server())
        .post(`${URL}/renders/r/bind-job`)
        .send({ ...body, jobId: 'job-1' }),
    ).expect(200);
    expect(operator.bindRenderJob).toHaveBeenCalledWith('usr_op', 'r', {
      ...body,
      jobId: 'job-1',
    });
    await asOp(
      request(server()).post(`${URL}/references/ref1/close`).send(body),
    ).expect(200);
    expect(operator.closeReference).toHaveBeenCalledWith(
      'usr_op',
      'ref1',
      body,
    );
  });
});
