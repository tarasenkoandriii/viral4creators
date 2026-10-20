/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory prisma mock */
/**
 * ST3 (Р-ST3-1/3/6/7): HTTP of the pilot — real Nest, real guards (access,
 * public, admin session), global validation, real StoryGiftsService for the
 * public gift; Prisma is an in-memory mock.
 */
import {
  ForbiddenException,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSessionGuard } from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import {
  AdminStoryPilotController,
  PublicStoryCapabilitiesController,
  StoryAccessController,
} from './story-pilot.controller';
import {
  PublicStoryGiftController,
  StoryGiftsController,
} from './story-gifts.controller';
import { StoryPilotService } from './story-pilot.service';
import { StoryGiftsService } from './story-gifts.service';
import { StoryVideoService } from './story-video.service';
import { StoryReferencesService } from './story-references.service';
import { StoryChargesService } from './story-charges.service';
import { StoryPublicHeadersModule } from './story-public-headers.module';
import { StoryAccessGuard, StoryPublicAccessGuard } from './story-access.guard';
import { STORY_TERMS_VERSION } from './story-access';
import { ResembleService } from '../tts/resemble.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';

const videos = {
  publicRelease: jest.fn(
    async (): Promise<any> => ({
      video: null,
      awaitingConsent: false,
    }),
  ),
  published: jest.fn(async () => {
    const { NotFoundException } = jest.requireActual('@nestjs/common');
    throw new NotFoundException();
  }),
};
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const DAY = 86_400_000;
const AUDIO = Buffer.from('0123456789abcdef');

function makeDb() {
  const db: any = {
    users: [
      { id: 'owner', telegramId: 'owner-tg', username: 'boss' },
      { id: 'm1', telegramId: 't-m1', username: 'mom' },
      { id: 'u2', telegramId: 't-u2', username: null },
    ],
    members: [] as any[],
    apps: [] as any[],
    terms: [] as any[],
    journal: [] as any[],
    gifts: [] as any[],
  };
  const ok = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === 'OR') return v.some((w: any) => ok(row, w));
      if (k === 'AND') return v.every((w: any) => ok(row, w));
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v instanceof Date) return +row[k] === +v;
      if (typeof v === 'object') {
        if ('not' in v)
          return v.not === null ? row[k] != null : row[k] !== v.not;
        if ('in' in v) return v.in.includes(row[k]);
        if ('gt' in v) return row[k] != null && +row[k] > +v.gt;
        if ('lte' in v) return row[k] != null && +row[k] <= +v.lte;
      }
      return row[k] === v;
    });
  const table = (rows: () => any[], defaults: object = {}) => ({
    findUnique: jest.fn(async ({ where }: any) => {
      const w = where.userId_termsVersion ?? where;
      return rows().find((r) => ok(r, w)) ?? null;
    }),
    findFirst: jest.fn(
      async ({ where }: any) => rows().find((r) => ok(r, where)) ?? null,
    ),
    findMany: jest.fn(async ({ where }: any = {}) =>
      rows().filter((r) => ok(r, where)),
    ),
    count: jest.fn(
      async ({ where }: any = {}) => rows().filter((r) => ok(r, where)).length,
    ),
    create: jest.fn(async ({ data }: any) => {
      const row = {
        id: `id${rows().length + 1}`,
        createdAt: new Date(),
        ...defaults,
        ...data,
      };
      rows().push(row);
      return row;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows().find((r) => ok(r, where));
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows().filter((r) => ok(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    upsert: jest.fn(async ({ where, create }: any) => {
      const w = where.userId_termsVersion ?? where;
      const row = rows().find((r) => ok(r, w));
      if (row) return row;
      rows().push({ ...create });
      return create;
    }),
    groupBy: jest.fn(async () => []),
  });
  const prisma: any = {
    user: table(() => db.users),
    storyPilotMember: table(() => db.members, {
      since: new Date(),
      revokedAt: null,
      freeGiftUsedAt: null,
      freeGiftId: null,
    }),
    storyPilotApplication: table(() => db.apps, { status: 'pending' }),
    storyTermsAcceptance: table(() => db.terms),
    storyOperatorAction: table(() => db.journal),
    storyGift: table(() => db.gifts),
    storyVideoRender: {
      groupBy: jest.fn(async () => []),
      findFirst: jest.fn(async (): Promise<any> => null),
    },
    storyCreditCharge: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    adminSession: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.token === 'tok_op'
          ? { userId: 'op', expiresAt: new Date(Date.now() + 3600e3) }
          : null,
      ),
    },
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  // `user` relation of applications/members (the admin overview).
  const withUser = (find: jest.Mock) =>
    jest.fn(async (args: any) =>
      (await find(args)).map((r: any) => ({
        ...r,
        user: db.users.find((u: any) => u.id === r.userId) ?? null,
      })),
    );
  prisma.storyPilotApplication.findMany = withUser(
    prisma.storyPilotApplication.findMany,
  );
  prisma.storyPilotMember.findMany = withUser(prisma.storyPilotMember.findMany);
  return { db, prisma };
}

describe('Story-Tales pilot HTTP (ST3)', () => {
  let app: INestApplication;
  const { db, prisma } = makeDb();
  const saved = { ...process.env };
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StoryPublicHeadersModule],
      controllers: [
        StoryAccessController,
        StoryGiftsController,
        PublicStoryGiftController,
        AdminStoryPilotController,
        PublicStoryCapabilitiesController,
      ],
      providers: [
        StoryPilotService,
        StoryGiftsService,
        StoryChargesService,
        StoryAccessGuard,
        StoryPublicAccessGuard,
        AdminSessionGuard,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AdminPanelService,
          useValue: {
            assertOperator: jest.fn(async (id: string) => {
              if (id !== 'op') throw new ForbiddenException();
            }),
          },
        },
        {
          provide: StoryVideoService,
          useValue: videos,
        },
        { provide: StoryReferencesService, useValue: {} },
        { provide: ResembleService, useValue: {} },
        { provide: PlanService, useValue: {} },
        { provide: AiUsageService, useValue: {} },
        { provide: SonioxSttClient, useValue: {} },
        {
          provide: (await import('../credit-ledger/credit-ledger.service'))
            .CreditLedgerService,
          useValue: {},
        },
      ],
    })
      .overrideGuard(TelegramIdentityGuard)
      .useValue({
        canActivate: (ctx: any) => {
          const req = ctx.switchToHttp().getRequest();
          req.telegramUserId = req.headers['x-user'];
          return !!req.telegramUserId;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });
  afterAll(async () => {
    process.env = saved;
    await app.close();
  });
  beforeEach(() => {
    process.env.STORY_TALES_OWNER_TELEGRAM_ID = 'owner-tg';
    process.env.API_PUBLIC_URL = 'https://api.example.test/api';
    delete process.env.STORY_PILOT_MAX_MEMBERS;
    process.env.STORY_TALES_ACCESS = 'pilot';
  });
  const http = () => request(app.getHttpServer());
  const as = (t: request.Test, user: string) => t.set('x-user', user);

  describe('access, application, rules', () => {
    it('owner mode: GET access is not swallowed by GET :id; non-owner — closed', async () => {
      process.env.STORY_TALES_ACCESS = 'owner';
      const res = await as(http().get('/api/story-gifts/access'), 'u2').expect(
        200,
      );
      expect(res.body.data).toMatchObject({
        mode: 'owner',
        allowed: false,
        reason: 'closed',
      });
      expect(res.headers['cache-control']).toBe('private, no-store');
      await as(http().get('/api/story-gifts'), 'u2').expect(404);
      await as(
        http().post('/api/story-gifts/pilot/apply').send({}),
        'u2',
      ).expect(404);
    });
    it('pilot: apply (idempotent, ≤500, no extra fields), then pending', async () => {
      await as(
        http()
          .post('/api/story-gifts/pilot/apply')
          .send({ scenario: 'x'.repeat(501) }),
        'm1',
      ).expect(400);
      await as(
        http()
          .post('/api/story-gifts/pilot/apply')
          .send({ scenario: 'a', childName: 'Аня' }),
        'm1',
      ).expect(400);
      const first = await as(
        http()
          .post('/api/story-gifts/pilot/apply')
          .send({ scenario: '  Сказка на ночь  ' }),
        'm1',
      ).expect(200);
      expect(first.body.data.application.status).toBe('pending');
      await as(
        http()
          .post('/api/story-gifts/pilot/apply')
          .send({ scenario: 'другое' }),
        'm1',
      ).expect(200);
      expect(db.apps).toHaveLength(1);
      expect(db.apps[0].scenario).toBe('Сказка на ночь');
      const access = await as(
        http().get('/api/story-gifts/access'),
        'm1',
      ).expect(200);
      expect(access.body.data).toMatchObject({
        mode: 'pilot',
        allowed: false,
        role: 'user',
        reason: 'application_pending',
        seatsLeft: 15,
        maxMembers: 15,
      });
    });
    it('pilot full: 409 STORY_PILOT_FULL for a new application', async () => {
      process.env.STORY_PILOT_MAX_MEMBERS = '0';
      const res = await as(
        http().post('/api/story-gifts/pilot/apply').send({}),
        'u2',
      ).expect(409);
      expect(res.body.error.details.code).toBe('STORY_PILOT_FULL');
    });
    it('admin: 401 without session; overview; approve → member; the journal gets the action', async () => {
      await http().get('/api/admin/story-tales/pilot').expect(401);
      const over = await http()
        .get('/api/admin/story-tales/pilot')
        .set('Cookie', 'admin_session=tok_op')
        .expect(200);
      expect(over.body.data).toMatchObject({ mode: 'pilot', maxMembers: 15 });
      const app1 = over.body.data.applications[0];
      expect(app1).toMatchObject({
        userId: 'm1',
        shortId: 'm1',
        status: 'pending',
        scenario: 'Сказка на ночь',
      });
      await http()
        .post(`/api/admin/story-tales/pilot/applications/${app1.id}/approve`)
        .set('Cookie', 'admin_session=tok_op')
        .send({ reason: 'x', requestId: 'not-a-uuid' })
        .expect(400);
      const ok = await http()
        .post(`/api/admin/story-tales/pilot/applications/${app1.id}/approve`)
        .set('Cookie', 'admin_session=tok_op')
        .send({})
        .expect(200);
      expect(ok.body.data).toMatchObject({
        action: 'pilot.approve',
        replayed: false,
      });
      expect(db.members).toEqual([
        expect.objectContaining({ userId: 'm1', applicationId: app1.id }),
      ]);
      expect(db.journal[0]).toMatchObject({
        actorKind: 'admin',
        actorUserId: 'op',
        targetType: 'pilot-application',
        action: 'pilot.approve',
      });
      await http()
        .post(`/api/admin/story-tales/pilot/applications/${app1.id}/approve`)
        .set('Cookie', 'admin_session=tok_op')
        .send({})
        .expect(409);
    });
    it('member: rules required (403 STORY_TERMS_REQUIRED on POST), then allowed', async () => {
      const before = await as(
        http().get('/api/story-gifts/access'),
        'm1',
      ).expect(200);
      expect(before.body.data).toMatchObject({
        role: 'member',
        allowed: false,
        reason: 'terms_required',
        freeGiftAvailable: true,
      });
      const denied = await as(
        http().post('/api/story-gifts').send({ catalogId: 'x' }),
        'm1',
      ).expect(403);
      expect(denied.body.error.details.code).toBe('STORY_TERMS_REQUIRED');
      await as(
        http()
          .post('/api/story-gifts/terms/accept')
          .send({ termsVersion: STORY_TERMS_VERSION, adult: false }),
        'm1',
      ).expect(400);
      const outdated = await as(
        http()
          .post('/api/story-gifts/terms/accept')
          .send({ termsVersion: 'story-rules-old', adult: true }),
        'm1',
      ).expect(409);
      expect(outdated.body.error.details.code).toBe('STORY_TERMS_OUTDATED');
      const after = await as(
        http()
          .post('/api/story-gifts/terms/accept')
          .send({ termsVersion: STORY_TERMS_VERSION, adult: true }),
        'm1',
      ).expect(200);
      expect(after.body.data).toMatchObject({ role: 'member', allowed: true });
      expect(db.terms).toEqual([
        expect.objectContaining({
          userId: 'm1',
          termsVersion: STORY_TERMS_VERSION,
          adult: true,
        }),
      ]);
      await as(http().get('/api/story-gifts'), 'm1').expect(200);
    });
  });

  describe('publication by link (Р-ST3-3)', () => {
    let token = '';
    beforeAll(() => {
      db.gifts.push({
        id: 'g1',
        userId: 'm1',
        status: 'APPROVED',
        locale: 'ru',
        title: 'Рукавичка',
        chapters: [{ title: 'Глава', text: 'Текст', scene: 'forest' }],
        occasion: null,
        giftNote: null,
        giftNotePosition: null,
        hasGiftPhoto: false,
        audio: AUDIO,
        shareHash: null,
        sharedAt: null,
        shareExpiresAt: null,
        updatedAt: new Date(),
      });
    });
    const expectPrivateHeaders = (res: request.Response) => {
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    };
    it('share needs acknowledgePublic: true; another user — 404', async () => {
      await as(http().post('/api/story-gifts/g1/share').send({}), 'm1').expect(
        400,
      );
      await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: false }),
        'm1',
      ).expect(400);
      await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: true }),
        'u2',
      ).expect(404);
      const res = await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: true }),
        'm1',
      ).expect(201);
      expect(res.body.data.url).toMatch(
        /^https:\/\/api\.example\.test\/api\/story-gift\/[A-Za-z0-9_-]{43}$/,
      );
      expect(Date.parse(res.body.data.expiresAt) - Date.now()).toBeGreaterThan(
        89 * DAY,
      );
      token = res.body.data.url.split('/').pop();
      expect(db.gifts[0].shareHash).toBe(sha(token));
    });
    it('pilot: page and media 200 with noindex + no-referrer; Range on audio', async () => {
      const page = await http().get(`/api/story-gift/${token}`).expect(200);
      expectPrivateHeaders(page);
      expect(page.text).toContain(
        '<meta name="robots" content="noindex,nofollow,noarchive">',
      );
      expect(page.text).toContain('ссылка действует до');
      const audio = await http()
        .get(`/api/story-gift/${token}/audio`)
        .expect(200);
      expectPrivateHeaders(audio);
      expect(audio.headers['accept-ranges']).toBe('bytes');
      const part = await http()
        .get(`/api/story-gift/${token}/audio`)
        .set('Range', 'bytes=2-5')
        .expect(206);
      expectPrivateHeaders(part);
      expect(part.headers['content-range']).toBe(`bytes 2-5/${AUDIO.length}`);
      const bad = await http()
        .get(`/api/story-gift/${token}/audio`)
        .set('Range', 'bytes=99-')
        .expect(416);
      expectPrivateHeaders(bad);
    });
    it('owner mode: the same link is 404, still with the headers', async () => {
      process.env.STORY_TALES_ACCESS = 'owner';
      for (const path of ['', '/audio', '/video', '/photo']) {
        const res = await http()
          .get(`/api/story-gift/${token}${path}`)
          .expect(404);
        expectPrivateHeaders(res);
      }
      await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: true }),
        'owner',
      ).expect(404);
    });
    it('a foreign/unknown token — 404 with headers', async () => {
      const res = await http()
        .get(`/api/story-gift/${'x'.repeat(43)}`)
        .expect(404);
      expectPrivateHeaders(res);
      await http().get('/api/story-gift/short').expect(404);
    });
    it('expired after 90 days — 404', async () => {
      const g = db.gifts[0];
      const keep = g.shareExpiresAt;
      g.shareExpiresAt = new Date(Date.now() - 1000);
      expectPrivateHeaders(
        await http().get(`/api/story-gift/${token}`).expect(404),
      );
      await http().get(`/api/story-gift/${token}/audio`).expect(404);
      g.shareExpiresAt = keep;
      await http().get(`/api/story-gift/${token}`).expect(200);
    });
    it('withdrawn (DELETE) — 404 at once; the card shows no link', async () => {
      await as(http().delete('/api/story-gifts/g1/share'), 'u2').expect(404);
      await as(http().delete('/api/story-gifts/g1/share'), 'm1').expect(200);
      expectPrivateHeaders(
        await http().get(`/api/story-gift/${token}`).expect(404),
      );
      await http()
        .get(`/api/story-gift/${token}/audio`)
        .set('Range', 'bytes=0-1')
        .expect(404);
      const card = await as(http().get('/api/story-gifts/g1'), 'm1').expect(
        200,
      );
      expect(card.body.data.retention).toMatchObject({
        basis: 'finished',
        shareExpiresAt: null,
      });
    });
    it('revocation withdraws the member’s links and keeps read access, no new builds', async () => {
      const shared = await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: true }),
        'm1',
      ).expect(201);
      const t = shared.body.data.url.split('/').pop();
      await http().get(`/api/story-gift/${t}`).expect(200);
      await http()
        .delete('/api/admin/story-tales/pilot/members/m1')
        .set('Cookie', 'admin_session=tok_op')
        .send({ reason: 'Нарушение правил' })
        .expect(200);
      await http().get(`/api/story-gift/${t}`).expect(404);
      await as(http().get('/api/story-gifts/g1'), 'm1').expect(200);
      await as(
        http()
          .post('/api/story-gifts/g1/share')
          .send({ acknowledgePublic: true }),
        'm1',
      ).expect(404);
      expect(db.journal.at(-1)).toMatchObject({
        action: 'pilot.revoke',
        targetType: 'pilot-member',
        result: { revoked: true, linksWithdrawn: 1 },
      });
      const access = await as(
        http().get('/api/story-gifts/access'),
        'm1',
      ).expect(200);
      // ST3-U-01: read-only, own data still readable.
      expect(access.body.data).toMatchObject({
        allowed: false,
        role: 'revoked',
        reason: 'pilot_revoked',
        readOnly: true,
      });
    });
  });

  describe('ST3 audit fixes on the public page', () => {
    let token = '';
    beforeAll(async () => {
      process.env.STORY_TALES_ACCESS = 'pilot';
      db.gifts.push({
        ...db.gifts[0],
        id: 'g3',
        userId: 'owner',
        shareHash: null,
        sharedAt: null,
        shareExpiresAt: null,
      });
      const res = await as(
        http()
          .post('/api/story-gifts/g3/share')
          .send({ acknowledgePublic: true }),
        'owner',
      ).expect(201);
      token = res.body.data.url.split('/').pop();
    });
    const privateHeaders = (res: request.Response) => {
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    };
    it('ST3-S-06: unknown sub-paths and other methods — 404 with noindex + no-referrer', async () => {
      privateHeaders(
        await http().get(`/api/story-gift/${token}/foo`).expect(404),
      );
      privateHeaders(
        await http().get(`/api/story-gift/${token}/audio/x`).expect(404),
      );
      privateHeaders(await http().post(`/api/story-gift/${token}`).expect(404));
      privateHeaders(
        await http().delete(`/api/story-gift/${token}/video`).expect(404),
      );
      privateHeaders(await http().get('/api/story-gift').expect(404));
    });
    it('ST3-S-07/S-03: a revoked narrator — page, audio and photo 404, no audio substitute', async () => {
      const { NotFoundException } = jest.requireActual('@nestjs/common');
      videos.publicRelease.mockRejectedValue(
        new NotFoundException('Ссылка недоступна'),
      );
      const page = await http().get(`/api/story-gift/${token}`).expect(404);
      privateHeaders(page);
      expect(page.text).not.toMatch(/Аудиоподарок|отозван/);
      await http().get(`/api/story-gift/${token}/audio`).expect(404);
      videos.publicRelease.mockResolvedValue({
        video: null,
        awaitingConsent: false,
      });
    });
    it('ST3-S-04: a release waiting for the narrator consent — page without video', async () => {
      videos.publicRelease.mockResolvedValueOnce({
        video: null,
        awaitingConsent: true,
      });
      const page = await http().get(`/api/story-gift/${token}`).expect(200);
      expect(page.text).toContain(
        'Видео к этой сказке появится после подтверждения создателя',
      );
      expect(page.text).not.toContain('<video');
      expect(page.text).not.toContain('Аудиоподарок');
    });
    it('ST3-S-04: a live link + consent for a NEW release → 200 and the consent moves; without it — 409', async () => {
      prisma.storyVideoRender.findFirst.mockResolvedValue({
        id: 'r-new',
        userVoiceId: 'v1',
        segments: null,
      });
      await as(
        http()
          .post('/api/story-gifts/g3/share')
          .send({ acknowledgePublic: true, narratorPublicConsent: false }),
        'owner',
      ).expect(400);
      const moved = await as(
        http()
          .post('/api/story-gifts/g3/share')
          .send({ acknowledgePublic: true, narratorPublicConsent: true }),
        'owner',
      ).expect(200);
      expect(moved.body.data).toMatchObject({
        url: null,
        narratorConsentUpdated: true,
      });
      const g3 = db.gifts.find((g: any) => g.id === 'g3');
      expect(g3.narratorPublicConsentRenderId).toBe('r-new');
      expect(g3.shareHash).not.toBeNull();
      prisma.storyVideoRender.findFirst.mockResolvedValue(null);
      await as(
        http()
          .post('/api/story-gifts/g3/share')
          .send({ acknowledgePublic: true }),
        'owner',
      ).expect(409);
    });
    it('ST3-S-12: expectedCredits is validated (non-negative integer)', async () => {
      await as(
        http().post('/api/story-gifts/g3/render').send({ expectedCredits: -1 }),
        'owner',
      ).expect(400);
      await as(
        http()
          .post('/api/story-gifts/g3/render')
          .send({ expectedCredits: 'five' }),
        'owner',
      ).expect(400);
    });
    it('ST3-S-10: an expired application may be filed again (pending, new text)', async () => {
      db.apps.push({
        id: 'a-exp',
        userId: 'u2',
        status: 'expired',
        scenario: null,
        decidedAt: new Date(),
        createdAt: new Date(Date.now() - 100 * 864e5),
      });
      process.env.STORY_PILOT_MAX_MEMBERS = '15';
      const res = await as(
        http().post('/api/story-gifts/pilot/apply').send({ scenario: 'Снова' }),
        'u2',
      ).expect(200);
      expect(res.body.data.application.status).toBe('pending');
      expect(db.apps.find((x: any) => x.id === 'a-exp')).toMatchObject({
        status: 'pending',
        decidedAt: null,
        scenario: 'Снова',
      });
    });
    it('ST3-S-11: admin overview — every pending first, applicant Telegram name', async () => {
      const over = await http()
        .get('/api/admin/story-tales/pilot')
        .set('Cookie', 'admin_session=tok_op')
        .expect(200);
      const apps = over.body.data.applications;
      expect(apps[0]).toMatchObject({ userId: 'u2', status: 'pending' });
      expect(apps[0].telegramUsername).toBeUndefined();
      expect(apps.find((a: any) => a.userId === 'm1')).toMatchObject({
        status: 'approved',
        telegramUsername: 'mom',
      });
      const calls = prisma.storyPilotApplication.findMany.mock.calls.map(
        ([a]: any) => a,
      );
      // Pending without a limit; decided — the last 200.
      expect(calls.at(-2)).toMatchObject({ where: { status: 'pending' } });
      expect(calls.at(-2).take).toBeUndefined();
      expect(calls.at(-1)).toMatchObject({ take: 200 });
    });
  });

  describe('§11.1 narrator consent on share', () => {
    beforeAll(() => {
      db.gifts.push({
        ...db.gifts[0],
        id: 'g2',
        userId: 'owner',
        shareHash: null,
        sharedAt: null,
        shareExpiresAt: null,
      });
    });
    it('a clone-narrated release: card flag, 400 without consent, 201 with it', async () => {
      prisma.storyVideoRender.findFirst.mockResolvedValue({
        userVoiceId: 'v1',
        segments: null,
      });
      const card = await as(http().get('/api/story-gifts/g2'), 'owner').expect(
        200,
      );
      expect(card.body.data.narratorPublicConsentRequired).toBe(true);
      const denied = await as(
        http()
          .post('/api/story-gifts/g2/share')
          .send({ acknowledgePublic: true }),
        'owner',
      ).expect(400);
      expect(denied.body.error.details.code).toBe(
        'STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED',
      );
      await as(
        http()
          .post('/api/story-gifts/g2/share')
          .send({ acknowledgePublic: true, narratorPublicConsent: 'yes' }),
        'owner',
      ).expect(400);
      await as(
        http()
          .post('/api/story-gifts/g2/share')
          .send({ acknowledgePublic: true, narratorPublicConsent: true }),
        'owner',
      ).expect(201);
      const g2 = db.gifts.find((g: any) => g.id === 'g2');
      expect(g2.narratorPublicConsentVersion).toBe(STORY_TERMS_VERSION);
      prisma.storyVideoRender.findFirst.mockResolvedValue(null);
    });
  });

  describe('GET /public/story-capabilities', () => {
    it('owner mode — 404', async () => {
      process.env.STORY_TALES_ACCESS = 'owner';
      await http().get('/api/public/story-capabilities').expect(404);
    });
    it('pilot — cacheable, no PII, ru/uk tales with formats and price from', async () => {
      const res = await http()
        .get('/api/public/story-capabilities')
        .expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=300');
      const data = res.body.data;
      expect(data).toMatchObject({
        mode: 'pilot',
        languages: ['ru', 'uk'],
        priceFromUsd: 3.38,
      });
      expect(data.tales.length).toBeGreaterThan(0);
      for (const t of data.tales) {
        expect(t.slug).toMatch(/^[a-z0-9-]+$/);
        expect(t.languages.every((l: string) => ['ru', 'uk'].includes(l))).toBe(
          true,
        );
      }
      expect(
        data.tales.find((t: any) => t.slug === 'turnip-ushinsky')?.formats ??
          data.formats,
      ).toContain('audio');
      expect(JSON.stringify(data)).not.toMatch(/userId|telegram|scenario/i);
    });
  });
});
