/**
 * Внутренний API хранилища учётных данных по HTTP на НАСТОЯЩЕМ Postgres
 * (Э-С Ш2): подпись HMAC (та же, что у Ш1), свой потолок тела (куки до
 * 256 КБ), строгий разбор тела, аренда → погашение один раз, личные записи
 * B только владельцем; секреты — только в ответах `lease/redeem` и
 * `user-sessions/read`.
 */
import {
  DynamicModule,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  SITES_CALLER_TUTORIAL,
  sitesSignatureHeaders,
} from '../../shared/sites-internal-signature';
import { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { CredentialAuditService } from '../site-credentials/credential-audit.service';
import { SiteCredentialsService } from '../site-credentials/site-credentials.service';
import {
  CabinetFixture,
  describeDb,
  dropCabinet,
  ownerPrisma,
  seedCabinet,
  testKey,
} from '../site-credentials/testing/credentials-db.testing';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
} from '../telegram-auth/test-init-data';
import { InternalSitesModule } from './internal-sites.module';
import { InternalRequestLedger } from './request-ledger';
import { TutorialHmacGuard } from './tutorial-hmac.guard';

@Module({})
class RealDbModule {
  static with(db: SitesDb): DynamicModule {
    return {
      module: RealDbModule,
      global: true,
      providers: [{ provide: SitesDb, useValue: db }],
      exports: [SitesDb],
    };
  }
}

const SECRET = 's'.repeat(48);
const BASE = '/internal/sites/credentials';
const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
  'SITES_TUTORIAL_HMAC_SECRET',
] as const;

describeDb('internal-sites: хранилище учётных данных по HTTP (Ш2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: CabinetFixture;
  const cabinets: CabinetFixture[] = [];
  const saved: Record<string, string | undefined> = {};
  const owners: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    delete process.env.ALLOW_DEV_AUTH;
    prisma = ownerPrisma();
    const mod = await Test.createTestingModule({
      imports: [
        RealDbModule.with(new SitesDb(prisma)),
        TelegramAuthModule,
        InternalSitesModule,
      ],
    })
      .overrideProvider(OwnershipChecker)
      .useValue({})
      .overrideProvider(InternalRequestLedger)
      .useValue({ claim: () => Promise.resolve(true) })
      .compile();
    mod.get(TutorialHmacGuard).env = { SITES_TUTORIAL_HMAC_SECRET: SECRET };
    mod.get(SiteCredentialsService).env = {
      SITE_CREDENTIALS_KEYS: `v1:${testKey()}`,
    };
    app = mod.createNestApplication();
    configureApp(app, loadConfiguration({}));
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    for (const c of cabinets) await dropCabinet(prisma, c);
    for (const o of owners) {
      await app
        .get(SiteCredentialsService)
        .listUserSessions(o)
        .then((list) =>
          Promise.all(
            list.map((x) =>
              app.get(SiteCredentialsService).deleteUserSession(o, x.id),
            ),
          ),
        )
        .catch(() => undefined);
    }
    await prisma.$disconnect();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  beforeEach(async () => {
    f = await seedCabinet(prisma);
    cabinets.push(f);
  });

  function call(route: string, payload: unknown, secret = SECRET) {
    const path = `${BASE}/${route}`;
    const body = JSON.stringify(payload);
    const headers = sitesSignatureHeaders(secret, {
      caller: SITES_CALLER_TUTORIAL,
      method: 'POST',
      path,
      body,
      unixSeconds: Math.floor(Date.now() / 1000),
      requestId: randomUUID(),
    });
    return request(app.getHttpServer())
      .post(path)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(body);
  }

  it('без подписи — 401; статус хранилища — настроено, v1', async () => {
    await request(app.getHttpServer())
      .post(`${BASE}/status`)
      .set('Content-Type', 'application/json')
      .send('{}')
      .expect(401);
    const res = await call('status', {}).expect(200);
    expect(res.body.data).toEqual({
      configured: true,
      currentKeyVersion: 'v1',
    });
  });

  it('учётка обучалки по черновику → куки 200 КБ → аренда → погашение один раз', async () => {
    const tg = f.telegramId.toString();
    const up = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      clientRef: 'project:p1',
      account: { label: 'Обучалка: shop' },
    }).expect(200);
    const acc = up.body.data as {
      id: string;
      products: string[];
      hostIds: string[];
    };
    expect(acc.products).toEqual(['tutorial']);
    expect(acc.hostIds).toEqual([f.verifiedHostId]);
    const again = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      clientRef: 'project:p1',
      account: { label: 'Обучалка: shop' },
    }).expect(200);
    expect(again.body.data.id).toBe(acc.id);

    const cookies = JSON.stringify([
      { name: 'sid', value: 'x'.repeat(200_000) },
    ]);
    const put = await call('test-accounts/put-secret', {
      telegramId: tg,
      testAccountId: acc.id,
      purpose: 'session-cookies',
      secret: cookies,
    }).expect(200);
    expect(put.body.data.secrets).toEqual({
      password: false,
      loginFields: false,
      session: true,
    });
    expect(JSON.stringify(put.body)).not.toContain('xxxx');

    const lease = await call('lease', {
      telegramId: tg,
      testAccountId: acc.id,
      hostId: f.verifiedHostId,
      product: 'tutorial',
      runRef: 'draft:d1',
    }).expect(200);
    const leaseId = lease.body.data.leaseId as string;
    const got = await call('lease/redeem', { telegramId: tg, leaseId }).expect(
      200,
    );
    expect(got.body.data.secrets['session-cookies']).toBe(cookies);
    const twice = await call('lease/redeem', {
      telegramId: tg,
      leaseId,
    }).expect(403);
    expect(twice.body.error.code).toBe('CREDENTIAL_LEASE_INVALID');
  });

  it('аренда для QA или на неподтверждённом хосте — 403 с причиной', async () => {
    const tg = f.telegramId.toString();
    const up = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'x', hostIds: [f.pendingHostId] },
    }).expect(200);
    const id = up.body.data.id as string;
    const qa = await call('lease', {
      telegramId: tg,
      testAccountId: id,
      hostId: f.verifiedHostId,
      product: 'qa',
    }).expect(403);
    expect(qa.body.error).toMatchObject({ code: 'CREDENTIAL_LEASE_DENIED' });
    const pend = await call('lease', {
      telegramId: tg,
      testAccountId: id,
      hostId: f.pendingHostId,
      product: 'tutorial',
    }).expect(403);
    expect(pend.body.error.code).toBe('CREDENTIAL_LEASE_DENIED');
  });

  it('аудит Ш2: канал обучалки не арендует для QA учётку, разрешённую и обучалке, и QA', async () => {
    const tg = f.telegramId.toString();
    const up = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'both', products: ['tutorial', 'qa'] },
    }).expect(200);
    const qa = await call('lease', {
      telegramId: tg,
      testAccountId: up.body.data.id,
      hostId: f.verifiedHostId,
      product: 'qa',
    }).expect(403);
    expect(qa.body.error).toMatchObject({
      code: 'CREDENTIAL_LEASE_DENIED',
      details: { reason: 'product' },
    });
  });

  it('чужой человек не видит и не арендует учётку кабинета', async () => {
    const tg = f.telegramId.toString();
    const up = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'x' },
    }).expect(200);
    const stranger = await seedCabinet(prisma);
    cabinets.push(stranger);
    await call('test-accounts/list', {
      telegramId: stranger.telegramId.toString(),
      hostId: f.verifiedHostId,
    }).expect(403);
    await call('lease', {
      telegramId: stranger.telegramId.toString(),
      testAccountId: up.body.data.id,
      hostId: f.verifiedHostId,
      product: 'tutorial',
    }).expect(404);
  });

  it('строгое тело: лишнее поле, чужое назначение, кривой ownerRef — 400', async () => {
    const tg = f.telegramId.toString();
    await call('test-accounts/list', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      extra: 1,
    }).expect(400);
    await call('test-accounts/put-secret', {
      telegramId: tg,
      testAccountId: 'abc',
      purpose: 'totp',
      secret: 'x',
    }).expect(400);
    await call('user-sessions/list', { ownerRef: 'user:1' }).expect(400);
  });

  it('режим B: запись → чтение только владельцем → удаление', async () => {
    const me = `gen:${randomUUID().slice(0, 12)}`;
    const other = `gen:${randomUUID().slice(0, 12)}`;
    owners.push(me, other);
    const up = await call('user-sessions/upsert', {
      ownerRef: me,
      origin: 'https://shop.example.com/login?x=1',
      clientRef: 'project:p2',
      label: 'shop',
    }).expect(200);
    const id = up.body.data.id as string;
    expect(up.body.data.origin).toBe('https://shop.example.com');
    await call('user-sessions/put-secret', {
      ownerRef: me,
      sessionId: id,
      purpose: 'login-fields',
      secret: '[{"selector":"#pw","value":"p@ss"}]',
    }).expect(200);
    const list = await call('user-sessions/list', { ownerRef: me }).expect(200);
    expect(JSON.stringify(list.body)).not.toContain('p@ss');
    const read = await call('user-sessions/read', {
      ownerRef: me,
      sessionId: id,
      runRef: 'draft:d2',
    }).expect(200);
    expect(read.body.data.secrets['login-fields']).toContain('p@ss');
    await call('user-sessions/read', { ownerRef: other, sessionId: id }).expect(
      404,
    );
    const del = await call('user-sessions/delete', {
      ownerRef: me,
      sessionId: id,
    }).expect(200);
    expect(del.body.data).toEqual({ deleted: true });
    await call('user-sessions/read', { ownerRef: me, sessionId: id }).expect(
      404,
    );
  });
  it('аудит захода 10 (P3-3): пустые продукты генератора — можно, если у учётки остаётся невидимый ему продукт', async () => {
    const tg = f.telegramId.toString();
    const creds = app.get(SiteCredentialsService);
    const adminOnly = await creds.create(
      f.accountId,
      f.siteId,
      {
        label: 'Менеджер',
        hostIds: [f.verifiedHostId],
        products: ['assist-admin'],
        confirmedTestAccount: true,
      },
      `tma:${tg}`,
    );
    const saved = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      testAccountId: adminOnly.id,
      account: { label: 'Менеджер 2', products: [] },
    }).expect(200);
    expect(saved.body.data.products).toEqual(['assist-admin']);
    expect(saved.body.data.label).toBe('Менеджер 2');

    const tutorialOnly = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'Обучалка' },
    }).expect(200);
    const emptied = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      testAccountId: tutorialOnly.body.data.id,
      account: { products: [] },
    }).expect(400);
    expect(emptied.body.error.code).toBe('TEST_ACCOUNT_INVALID');
    const createdEmpty = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'Пусто', products: [] },
    }).expect(400);
    expect(createdEmpty.body.error.code).toBe('TEST_ACCOUNT_INVALID');
  });

  it('Ш2-хвост (7): forget — своя учётка черновика удаляется целиком, чужая — 409 и цела', async () => {
    const tg = f.telegramId.toString();
    const own = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      clientRef: 'project:pf1',
      account: { label: 'Обучалка: shop' },
    }).expect(200);
    const ownId = own.body.data.id as string;
    await call('test-accounts/put-secret', {
      telegramId: tg,
      testAccountId: ownId,
      purpose: 'login-fields',
      secret: '[{"selector":"#pw","value":"Forget-me-0123456789"}]',
    }).expect(200);
    // Учётка, заведённая руками (без ключа черновика), — с паролем.
    const manual = await call('test-accounts/upsert', {
      telegramId: tg,
      hostId: f.verifiedHostId,
      account: { label: 'Покупатель', password: 'Manual-pass-0123456789' },
    }).expect(200);
    const manualId = manual.body.data.id as string;

    await call('forget', { telegramId: tg, testAccountId: ownId }).expect(400);
    await call('forget', {
      telegramId: tg,
      testAccountId: ownId,
      clientRef: 'bad ref',
    }).expect(400);
    const foreign = await call('forget', {
      telegramId: tg,
      testAccountId: manualId,
      clientRef: 'project:pf1',
    }).expect(409);
    expect(foreign.body.error.code).toBe('TEST_ACCOUNT_NOT_OWN');
    const otherDraft = await call('forget', {
      telegramId: tg,
      testAccountId: ownId,
      clientRef: 'project:pf2',
    }).expect(409);
    expect(otherDraft.body.error.code).toBe('TEST_ACCOUNT_NOT_OWN');
    const stranger = await seedCabinet(prisma);
    cabinets.push(stranger);
    await call('forget', {
      telegramId: stranger.telegramId.toString(),
      testAccountId: ownId,
      clientRef: 'project:pf1',
    }).expect(404);

    const done = await call('forget', {
      telegramId: tg,
      testAccountId: ownId,
      clientRef: 'project:pf1',
    }).expect(200);
    expect(done.body.data).toEqual({ deleted: true });
    expect(JSON.stringify(done.body)).not.toContain('Forget-me');
    // Через сервис (правило графа: имён таблиц хранилища здесь нет).
    const left = await app
      .get(SiteCredentialsService)
      .list(f.accountId, f.siteId);
    expect(left.map((a) => a.id)).toEqual([manualId]);
    // Ручная учётка и её пароль на месте.
    expect(left[0].secrets.password).toBe(true);
    const audit = app.get(CredentialAuditService);
    const journal = [
      ...(await audit.recent({ accountId: f.accountId, subjectId: manualId })),
      ...(await audit.recent({ accountId: f.accountId, subjectId: ownId })),
    ].filter((r) => r.action === 'delete');
    expect(journal.map((r) => [r.subjectId, r.result]).sort()).toEqual(
      [
        [manualId, 'denied:not_own'],
        [ownId, 'denied:not_own'],
        [ownId, 'ok'],
      ].sort(),
    );
    // Повтор — учётки уже нет: 404 (генератор считает это «уже стёрто»).
    await call('forget', {
      telegramId: tg,
      testAccountId: ownId,
      clientRef: 'project:pf1',
    }).expect(404);
  });
});
