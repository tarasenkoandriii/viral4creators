import {
  Controller,
  Get,
  Req,
  UseGuards,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import {
  TelegramIdentityGuard,
  IdentifiedRequest,
} from './telegram-identity.guard';
import { TelegramIdentityMiddleware } from './telegram-identity.middleware';
import { registerTelegramIdentity } from './register-telegram-identity';

@Controller('projects/:projectId/items/:itemId/sessions')
@UseGuards(TelegramIdentityGuard)
class IdentityProbeController {
  @Get()
  get(@Req() req: IdentifiedRequest) {
    return { userId: req.telegramUserId };
  }
}

describe('bootstrap identity registration with real Nest/Express and guard', () => {
  let app: INestApplication;
  const upsert = jest.fn();
  const saved = {
    token: process.env.FIXTURE_USER_TOKEN,
    id: process.env.FIXTURE_TELEGRAM_ID,
  };
  const route = '/api/projects/fixture-project/items/fixture-item/sessions';
  beforeAll(async () => {
    process.env.FIXTURE_USER_TOKEN = 'integration-secret';
    process.env.FIXTURE_TELEGRAM_ID = '42';
    const mod = await Test.createTestingModule({
      controllers: [IdentityProbeController],
      providers: [
        {
          provide: TelegramIdentityMiddleware,
          useValue: new TelegramIdentityMiddleware({
            user: { upsert },
          } as never),
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    registerTelegramIdentity(app);
    configureApp(app, { cors: { origins: [] } });
    await app.init();
  });
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({ id: 'fixture-user' });
  });
  afterAll(async () => {
    await app.close();
    if (saved.token === undefined) delete process.env.FIXTURE_USER_TOKEN;
    else process.env.FIXTURE_USER_TOKEN = saved.token;
    if (saved.id === undefined) delete process.env.FIXTURE_TELEGRAM_ID;
    else process.env.FIXTURE_TELEGRAM_ID = saved.id;
  });
  it('identifies exactly once before the guard on a deeply nested API route', async () => {
    const response = await request(app.getHttpServer())
      .get(route)
      .set('X-Fixture-Token', 'integration-secret')
      .expect(200);
    expect(response.body.data.userId).toBe('fixture-user');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { telegramId: '42' } }),
    );
  });
  it('keeps missing and invalid fixture credentials unauthorized', async () => {
    await request(app.getHttpServer()).get(route).expect(401);
    await request(app.getHttpServer())
      .get(route)
      .set('X-Fixture-Token', 'invalid')
      .expect(401);
    expect(upsert).not.toHaveBeenCalled();
  });
  it('forwards asynchronous identity failures to Express instead of hanging', async () => {
    upsert.mockRejectedValue(new Error('test database unavailable'));
    await request(app.getHttpServer())
      .get(route)
      .set('X-Fixture-Token', 'integration-secret')
      .expect(500);
  });
});
