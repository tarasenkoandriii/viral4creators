/**
 * Контракт `GET /api/internal/client-site-tutorial/memo-steps/:siteId/:draftId`
 * (Э6-тер (к)): настоящий Nest, настоящий `SitesMemoHmacGuard`, подписи —
 * тем же общим кодом, что у sites-backend; подменена только база.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import {
  SITES_CALLER_MEMO,
  SITES_CALLER_TUTORIAL,
  sitesSignatureHeaders,
} from '../../common/sites-internal-signature';
import { SitesMemoHmacGuard } from '../sites-internal/sites-memo-hmac.guard';
import { MemoStepsController } from './memo-steps.controller';

const SECRET = 's'.repeat(40);
const SITE = 'site_1';

const DRAFTS: Record<string, Record<string, unknown>> = {
  dr_ok: {
    id: 'dr_ok',
    status: 'APPROVED',
    siteMode: 'A',
    clientSiteId: SITE,
    baseUrl: 'https://shop.example.com',
    lastUrl: 'https://shop.example.com/cart',
    title: 'Кошик',
    steps: [
      { kind: 'goto', route: 'https://shop.example.com/catalog' },
      { kind: 'fill', selector: '#login', value: 'boss' },
      { kind: 'fill', selector: '#password', value: '' },
      { kind: 'click', selector: '#enter' },
      { kind: 'click', selector: '#add' },
      { kind: 'fill', selector: '#qty', value: '3' },
    ],
    stepsPerRound: [1, 3, 2],
    loginUsedAt: new Date(),
    credentialsEnc: 'v1:CIPHERTEXT',
    requiresLiveLoginReplay: false,
    storeHasCredentials: false,
  },
  dr_b: {
    id: 'dr_b',
    status: 'APPROVED',
    siteMode: 'B',
    clientSiteId: SITE,
    baseUrl: 'https://shop.example.com',
    steps: [{ kind: 'click', selector: '#a' }],
  },
};

const prisma = {
  clientSiteTutorialDraft: {
    findUnique: jest.fn(
      async (a: { where: { id: string } }) => DRAFTS[a.where.id] ?? null,
    ),
  },
};

function signed(path: string, caller = SITES_CALLER_MEMO, secret = SECRET) {
  return sitesSignatureHeaders(secret, {
    caller,
    method: 'GET',
    path,
    body: '',
    unixSeconds: Math.floor(Date.now() / 1000),
    requestId: randomUUID(),
  });
}

describe('GET /api/internal/client-site-tutorial/memo-steps (e2e)', () => {
  let app: INestApplication;
  let guard: SitesMemoHmacGuard;
  const OLD = process.env.SITES_TUTORIAL_HMAC_SECRET;
  beforeAll(async () => {
    process.env.SITES_TUTORIAL_HMAC_SECRET = SECRET;
    const moduleRef = await Test.createTestingModule({
      controllers: [MemoStepsController],
      providers: [
        SitesMemoHmacGuard,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    guard = moduleRef.get(SitesMemoHmacGuard);
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    if (OLD === undefined) delete process.env.SITES_TUTORIAL_HMAC_SECRET;
    else process.env.SITES_TUTORIAL_HMAC_SECRET = OLD;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    guard.env = { SITES_TUTORIAL_HMAC_SECRET: SECRET };
  });

  const P = (site: string, draft: string) =>
    `/api/internal/client-site-tutorial/memo-steps/${site}/${draft}`;

  it('подписанный запрос: шаги после входа, без значений и данных входа', async () => {
    const res = await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(signed(P(SITE, 'dr_ok')))
      .expect(200);
    expect(res.body.data.steps).toEqual([
      { kind: 'click', selector: '#add' },
      { kind: 'fill', selector: '#qty', field: 'number' },
    ]);
    expect(res.body.data.requiresLogin).toBe(true);
    const json = JSON.stringify(res.body);
    for (const leak of ['boss', '#password', '#login', 'CIPHERTEXT', '"3"'])
      expect(json).not.toContain(leak);
  });

  it('без подписи — 401, база не тронута', async () => {
    await request(app.getHttpServer()).get(P(SITE, 'dr_ok')).expect(401);
    expect(prisma.clientSiteTutorialDraft.findUnique).not.toHaveBeenCalled();
  });

  it('подпись прямого направления (generator-tutorial) сюда не подходит', async () => {
    const res = await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(signed(P(SITE, 'dr_ok'), SITES_CALLER_TUTORIAL))
      .expect(401);
    expect(res.body.error.code).toBe('INTERNAL_SIGNATURE_CALLER');
  });

  it('чужой секрет — 401; подпись другого пути — 401', async () => {
    await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(signed(P(SITE, 'dr_ok'), SITES_CALLER_MEMO, 'x'.repeat(40)))
      .expect(401);
    await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(signed(P('site_other', 'dr_ok')))
      .expect(401);
    expect(prisma.clientSiteTutorialDraft.findUnique).not.toHaveBeenCalled();
  });

  it('повтор того же подписанного запроса — 401 INTERNAL_REPLAY', async () => {
    const h = signed(P(SITE, 'dr_ok'));
    await request(app.getHttpServer()).get(P(SITE, 'dr_ok')).set(h).expect(200);
    const res = await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(h)
      .expect(401);
    expect(res.body.error.code).toBe('INTERNAL_REPLAY');
  });

  it('нет секрета — 503 (закрыто, а не открыто)', async () => {
    guard.env = {};
    await request(app.getHttpServer())
      .get(P(SITE, 'dr_ok'))
      .set(signed(P(SITE, 'dr_ok')))
      .expect(503);
  });

  it('черновик чужого сайта — 404, как несуществующий', async () => {
    const a = await request(app.getHttpServer())
      .get(P('site_other', 'dr_ok'))
      .set(signed(P('site_other', 'dr_ok')))
      .expect(404);
    const b = await request(app.getHttpServer())
      .get(P(SITE, 'dr_none'))
      .set(signed(P(SITE, 'dr_none')))
      .expect(404);
    expect(a.body.error.code).toBe('MEMO_STEPS_NOT_FOUND');
    expect(b.body.error.code).toBe('MEMO_STEPS_NOT_FOUND');
  });

  it('режим B — 422 с причиной', async () => {
    const res = await request(app.getHttpServer())
      .get(P(SITE, 'dr_b'))
      .set(signed(P(SITE, 'dr_b')))
      .expect(422);
    expect(res.body.error.code).toBe('MEMO_STEPS_NOT_ELIGIBLE');
    expect(res.body.error.details.reason).toBe('mode_b');
  });
});
