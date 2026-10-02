/**
 * Экран «Тестовые учётные записи» кабинета по HTTP на НАСТОЯЩЕМ Postgres
 * (Э-С Ш2): initData любого из двух ботов, права — владелец и менеджер,
 * пароль только на запись (в ответах его нет никогда).
 */
import {
  DynamicModule,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { OwnershipChecker } from '../site-core/ownership/ownership-checker';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../telegram-auth/test-init-data';
import { SiteCredentialsModule } from './site-credentials.module';
import { SiteCredentialsService } from './site-credentials.service';
import {
  CabinetFixture,
  describeDb,
  dropCabinet,
  ownerPrisma,
  seedCabinet,
  testKey,
} from './testing/credentials-db.testing';

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

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
] as const;

describeDb('кабинет: тестовые учётные записи по HTTP (Ш2)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let f: CabinetFixture;
  const cabinets: CabinetFixture[] = [];
  const saved: Record<string, string | undefined> = {};

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
        SiteCredentialsModule,
      ],
    })
      .overrideProvider(OwnershipChecker)
      .useValue({})
      .compile();
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

  const as = (tg: bigint, bot: 'assist' | 'qa' = 'assist') => ({
    'X-Telegram-App': bot,
    'X-Telegram-Init-Data': signInitData({
      botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
      userId: Number(tg),
    }),
  });
  const srv = () => app.getHttpServer();

  it('владелец: завести (пароль только на запись) → список → правка → «Забыть»', async () => {
    const base = `/sites/${f.siteId}/test-accounts`;
    const created = await request(srv())
      .post(base)
      .set(as(f.telegramId))
      .send({
        label: 'Админ',
        role: 'admin',
        plan: 'Business',
        username: 'admin@example.com',
        password: 'Top-Secret-1',
        hostIds: [f.verifiedHostId],
        products: ['tutorial', 'qa'],
        lifetimeDays: 30,
        confirmedTestAccount: true,
      })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain('Top-Secret');
    expect(created.body.data).toMatchObject({
      label: 'Админ',
      products: ['tutorial', 'qa'],
      secrets: { password: true },
      confirmedTestAccount: true,
    });
    const id = created.body.data.id as string;
    // Тот же кабинет из бота QA — тот же список (один реестр на оба продукта).
    const list = await request(srv())
      .get(base)
      .set(as(f.telegramId, 'qa'))
      .expect(200);
    expect(list.body.data.map((a: { id: string }) => a.id)).toEqual([id]);
    expect(JSON.stringify(list.body)).not.toContain('Top-Secret');
    const patched = await request(srv())
      .patch(`${base}/${id}`)
      .set(as(f.telegramId))
      .send({ plan: 'Pro', password: 'Another-2' })
      .expect(200);
    expect(patched.body.data.plan).toBe('Pro');
    expect(JSON.stringify(patched.body)).not.toContain('Another');
    await request(srv())
      .delete(`${base}/${id}`)
      .set(as(f.telegramId))
      .expect(200);
    const after = await request(srv())
      .get(base)
      .set(as(f.telegramId))
      .expect(200);
    expect(after.body.data).toEqual([]);
  });

  it('оператор кабинета — 403; без initData — 401; чужой сайт — 404', async () => {
    const op = await seedCabinet(prisma, { role: 'operator' });
    cabinets.push(op);
    await request(srv())
      .get(`/sites/${op.siteId}/test-accounts`)
      .set(as(op.telegramId))
      .expect(403);
    await request(srv()).get(`/sites/${f.siteId}/test-accounts`).expect(401);
    const other = await seedCabinet(prisma);
    cabinets.push(other);
    await request(srv())
      .get(`/sites/${other.siteId}/test-accounts`)
      .set(as(f.telegramId))
      .expect(404);
  });

  it('лишнее поле и хост чужого сайта — 400', async () => {
    const base = `/sites/${f.siteId}/test-accounts`;
    await request(srv())
      .post(base)
      .set(as(f.telegramId))
      .send({
        label: 'x',
        hostIds: [f.verifiedHostId],
        products: ['qa'],
        secret: 'y',
      })
      .expect(400);
    const other = await seedCabinet(prisma);
    cabinets.push(other);
    const res = await request(srv())
      .post(base)
      .set(as(f.telegramId))
      .send({ label: 'x', hostIds: [other.verifiedHostId], products: ['qa'] })
      .expect(400);
    expect(res.body.error.code).toBe('TEST_ACCOUNT_INVALID');
  });
});
