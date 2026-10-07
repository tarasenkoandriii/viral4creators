/**
 * W7: маршруты привязки черновика к сайту помощника по HTTP — настоящий
 * модуль (граф DI), глобальные пайп/фильтр/интерсептор как в main.ts,
 * личность — подставная (гвард Telegram проверяется своими тестами).
 * Контракт: GET/POST → `{ linked, siteId, siteName, canLink, candidates }`,
 * 409 `ASSIST_LINK_UNAVAILABLE`, 404 чужой проект, прежний PUT жив.
 */
import {
  INestApplication,
  ValidationPipe,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { SitesInternalClient } from '../sites-internal/sites-internal.client';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { ClientSiteMediaModule } from './client-site-media.module';

type Row = Record<string, unknown>;

const draft: Row = {
  id: 'd1',
  projectId: 'p1',
  clientSiteId: null,
  baseUrl: 'https://shop.example.com/',
};

const prisma = {
  project: {
    findFirst: jest.fn(async ({ where }: { where: Row }) =>
      where.id === 'p1' && where.userId === 'u1'
        ? { id: 'p1', type: 'CLIENT_SITE' }
        : null,
    ),
    findMany: jest.fn(async () => []),
  },
  user: { findUnique: jest.fn(async () => ({ telegramId: '1001' })) },
  clientSiteTutorialDraft: {
    findUnique: jest.fn(async () => ({ ...draft })),
    findMany: jest.fn(async () => []),
    update: jest.fn(async ({ data }: { data: Row }) =>
      Object.assign(draft, data),
    ),
  },
  tutorialVideoAsset: { findMany: jest.fn(async () => []) },
  platformSetting: { upsert: jest.fn(async () => ({})) },
};

const sites = {
  configured: () => true,
  siteCandidates: jest.fn(async () => ({
    sites: [{ siteId: 'site_A', name: 'Магазин', hosts: ['shop.example.com'] }],
  })),
  linkSite: jest.fn(async (_t: string, siteId: string) => ({
    siteId,
    siteName: 'Магазин',
    hosts: [],
  })),
  syncSiteVideos: jest.fn(async (siteId: string) => ({
    siteId,
    accepted: 0,
    removed: 0,
    rejected: [],
  })),
};

class AsUser implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ telegramUserId?: string }>();
    req.telegramUserId = 'u1';
    return true;
  }
}

describe('assist-link по HTTP (W7)', () => {
  let app: INestApplication;
  const P = '/api/projects/p1/site-tutorial/assist-link';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ClientSiteMediaModule],
    })
      .overrideProvider(SitesInternalClient)
      .useValue(sites)
      .overrideGuard(TelegramIdentityGuard)
      .useClass(AsUser)
      .useMocker((token) => (token === PrismaService ? prisma : undefined))
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    draft.clientSiteId = null;
    jest.clearAllMocks();
  });

  it('GET — объект контракта', async () => {
    const res = await request(app.getHttpServer()).get(P).expect(200);
    expect(res.body.data).toEqual({
      linked: false,
      siteId: null,
      siteName: null,
      canLink: true,
      candidates: [{ siteId: 'site_A', name: 'Магазин' }],
    });
  });

  it('POST { siteId } — привязка, тот же объект; набор сайта отправлен', async () => {
    const res = await request(app.getHttpServer())
      .post(P)
      .send({ siteId: 'site_A' })
      .expect(200);
    expect(res.body.data).toMatchObject({
      linked: true,
      siteId: 'site_A',
      siteName: 'Магазин',
    });
    expect(sites.syncSiteVideos).toHaveBeenCalledWith(
      'site_A',
      [],
      expect.any(Number),
    );
  });

  it('POST: нет ключа siteId, кривой id, лишнее поле — 400', async () => {
    for (const body of [
      {},
      { siteId: '../x' },
      { siteId: 5 },
      { siteId: 'site_A', extra: 1 },
    ]) {
      await request(app.getHttpServer()).post(P).send(body).expect(400);
    }
    expect(prisma.clientSiteTutorialDraft.update).not.toHaveBeenCalled();
  });

  it('POST: сайта нет среди кандидатов — 409 ASSIST_LINK_UNAVAILABLE', async () => {
    const res = await request(app.getHttpServer())
      .post(P)
      .send({ siteId: 'site_X' })
      .expect(409);
    expect(JSON.stringify(res.body)).toContain('ASSIST_LINK_UNAVAILABLE');
  });

  it('чужой проект — 404 на GET и POST', async () => {
    const other = '/api/projects/p2/site-tutorial/assist-link';
    await request(app.getHttpServer()).get(other).expect(404);
    await request(app.getHttpServer())
      .post(other)
      .send({ siteId: 'site_A' })
      .expect(404);
  });

  it('прежний PUT (deep-link) жив: { clientSiteId, siteName }', async () => {
    const res = await request(app.getHttpServer())
      .put(P)
      .send({ siteId: 'site_A' })
      .expect(200);
    expect(res.body.data).toEqual({
      clientSiteId: 'site_A',
      siteName: 'Магазин',
    });
  });
});
