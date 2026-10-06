/**
 * Аудит безопасности, находка Н-1 (P2): приглашение принималось само при
 * запуске и переключало человека в чужой кабинет. Приёмка исправления по
 * HTTP (настоящее приложение: глобальный TelegramIdentityGuard, конверт,
 * фильтр; настоящая база):
 *  - `GET /sites/account/invites/:token/preview` — что будет, если
 *    принять: хвост id и тип кабинета, имя пригласившего (если известно),
 *    роль и права, срок, «уже участник». Ничего не пишет, токен не тратит,
 *    новичку кабинет не создаёт; полного id кабинета, токена кабинета и
 *    токена приглашения в ответе нет;
 *  - недействительное (битое, чужое, использованное, просроченное) — тот
 *    же 403 `INVITE_INVALID`, что у принятия; лимит частоты — 429;
 *  - принятие по-прежнему работает (по кнопке экрана);
 *  - без `X-Site-Account` сервер открывает СВОЙ кабинет (`owner`), а не
 *    последний, куда добавили; своего нет — самый ранний по членству.
 */
import {
  DynamicModule,
  Global,
  INestApplication,
  Logger,
  Module,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import { configureApp } from '../../app.setup';
import { loadConfiguration } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  describeDb,
  ownerPrisma,
} from '../../modules/assist-sandbox/testing/k3-stack.testing';
import {
  accountTail,
  defaultMembership,
} from '../../modules/site-core/account/account.service';
import { INVITE_PREVIEW_LIMIT } from '../../modules/site-core/account/invite-preview.controller';
import {
  OWNER_PRODUCT_ROLES,
  type AccountMembership,
} from '../../modules/site-core/account/roles';
import { SITE_ACCOUNT_HEADER } from '../../modules/site-core/account/site-account.guard';
import { SiteCoreModule } from '../../modules/site-core/site-core.module';
import { TelegramAuthModule } from '../../modules/telegram-auth/telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from '../../modules/telegram-auth/test-init-data';

jest.setTimeout(120_000);

// ── Чистая логика выбора кабинета (без базы) ────────────────────────────

function mem(
  accountId: string,
  role: AccountMembership['role'],
): AccountMembership {
  return {
    accountId,
    memberId: `m-${accountId}`,
    telegramId: 1n,
    role,
    productRoles: { ...OWNER_PRODUCT_ROLES },
  };
}

describe('Н-1: кабинет по умолчанию (defaultMembership)', () => {
  // memberships() отдаёт новые первыми: [последний, …, самый ранний].
  it('свой (owner) важнее чужого, куда добавили позже', () => {
    expect(
      defaultMembership([mem('foreign', 'manager'), mem('own', 'owner')])
        ?.accountId,
    ).toBe('own');
    expect(
      defaultMembership([mem('own', 'owner'), mem('foreign', 'manager')])
        ?.accountId,
    ).toBe('own');
  });
  it('своего нет — самый ранний, не последний', () => {
    expect(
      defaultMembership([
        mem('latest', 'manager'),
        mem('middle', 'operator'),
        mem('earliest', 'manager'),
      ])?.accountId,
    ).toBe('earliest');
  });
  it('нет членств — null', () => {
    expect(defaultMembership([])).toBeNull();
  });
});

// ── HTTP + настоящая база ───────────────────────────────────────────────

@Global()
@Module({})
class AuditInfra {
  static with(prisma: PrismaService): DynamicModule {
    return {
      module: AuditInfra,
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: SitesDb, useValue: new SitesDb(prisma) },
      ],
      exports: [PrismaService, SitesDb],
    };
  }
}

const ENV_KEYS = [
  'ASSIST_BOT_TOKEN',
  'QA_BOT_TOKEN',
  'ALLOW_DEV_AUTH',
] as const;

describeDb(
  'Аудит Н-1: превью приглашения и кабинет по умолчанию (HTTP)',
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    const saved: Record<string, string | undefined> = {};
    const people: bigint[] = [];
    let tgNext = 7_900_000_000 + Math.floor(Math.random() * 1_000_000) * 10;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      for (const k of ENV_KEYS) saved[k] = process.env[k];
      process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
      process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
      delete process.env.ALLOW_DEV_AUTH;
      prisma = ownerPrisma();
      const mod = await Test.createTestingModule({
        imports: [AuditInfra.with(prisma), TelegramAuthModule, SiteCoreModule],
      }).compile();
      app = mod.createNestApplication();
      configureApp(app, loadConfiguration({}));
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
      if (people.length) {
        const rows = await prisma.siteAccountMember.findMany({
          where: { telegramId: { in: people } },
          select: { accountId: true },
        });
        await prisma.siteAccount.deleteMany({
          where: { id: { in: rows.map((r) => r.accountId) } },
        });
        await prisma.siteWebSession.deleteMany({
          where: { telegramId: { in: people } },
        });
      }
      await prisma.$disconnect();
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    const srv = () => app.getHttpServer();

    function person(): number {
      const id = tgNext++;
      people.push(BigInt(id));
      return id;
    }

    function as(userId: number, bot: 'assist' | 'qa' = 'assist') {
      return {
        'X-Telegram-App': bot,
        'X-Telegram-Init-Data': signInitData({
          botToken: bot === 'assist' ? TEST_ASSIST_TOKEN : TEST_QA_TOKEN,
          userId,
        }),
      };
    }

    /** Владелец со своим кабинетом (первый вход создаёт его). */
    async function owner(): Promise<{
      tg: number;
      accountId: string;
      verifyToken: string;
    }> {
      const tg = person();
      const res = await request(srv()).get('/sites/account').set(as(tg));
      expect(res.status).toBe(200);
      expect(res.body.data.me.role).toBe('owner');
      return {
        tg,
        accountId: res.body.data.account.id,
        verifyToken: res.body.data.account.verifyToken,
      };
    }

    async function invite(
      from: number,
      role: 'manager' | 'operator' = 'manager',
    ): Promise<{ token: string; startParam: string }> {
      const res = await request(srv())
        .post('/sites/account/invites')
        .set(as(from))
        .send({ role, productRoles: { assist: role } });
      expect(res.status).toBe(201);
      return res.body.data;
    }

    const preview = (who: number, token: string) =>
      request(srv())
        .get(`/sites/account/invites/${encodeURIComponent(token)}/preview`)
        .set(as(who));

    const accept = (who: number, token: string) =>
      request(srv())
        .post('/sites/account/invites/accept')
        .set(as(who))
        .send({ token });

    async function membershipsOf(tg: number) {
      return prisma.siteAccountMember.findMany({
        where: { telegramId: BigInt(tg) },
      });
    }

    it('превью: кто пригласил, роль, срок — без лишнего; ничего не тратит и не создаёт', async () => {
      const a = await owner();
      await prisma.siteWebSession.create({
        data: {
          tokenHash: `n1-${randomUUID()}`,
          telegramId: BigInt(a.tg),
          app: 'assist',
          username: 'owner_a',
          firstName: 'Ольга',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const inv = await invite(a.tg, 'manager');
      const newbie = person();

      const res = await preview(newbie, inv.startParam);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        account: { tail: accountTail(a.accountId), type: 'owner' },
        inviter: { username: 'owner_a', firstName: 'Ольга' },
        role: 'manager',
        productRoles: { qa: 'none', assist: 'manager', assistAdmin: 'none' },
        expiresAt: expect.any(String),
        alreadyMember: false,
      });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(a.accountId);
      expect(raw).not.toContain(a.verifyToken);
      expect(raw).not.toContain(inv.token);
      expect(raw).not.toContain(String(a.tg));

      // Голый токен — тот же ответ (ссылку могли переслать как угодно).
      expect((await preview(newbie, inv.token)).status).toBe(200);
      // Превью не создаёт новичку кабинет и не тратит приглашение.
      expect(await membershipsOf(newbie)).toHaveLength(0);
      const row = await prisma.siteAccountInvite.findFirst({
        where: { accountId: a.accountId },
      });
      expect(row?.usedAt).toBeNull();

      // Принятие по кнопке — работает как раньше.
      const acc = await accept(newbie, inv.startParam);
      expect(acc.status).toBe(200);
      expect(acc.body.data).toMatchObject({
        account: { id: a.accountId },
        me: { role: 'manager' },
      });
      // Новичок без своего кабинета попадает в кабинет пригласившего.
      const me = await request(srv()).get('/sites/account').set(as(newbie));
      expect(me.body.data).toMatchObject({
        account: { id: a.accountId },
        created: false,
      });
      // Использованное — 403, как у принятия.
      const again = await preview(newbie, inv.token);
      expect(again.status).toBe(403);
      expect(again.body.error.code).toBe('INVITE_INVALID');
    });

    it('пригласивший без веб-входа — inviter: null; свой кабинет — alreadyMember', async () => {
      const a = await owner();
      const inv = await invite(a.tg, 'operator');
      const v = person();
      const res = await preview(v, inv.token);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        inviter: null,
        role: 'operator',
        alreadyMember: false,
      });
      const self = await preview(a.tg, inv.token);
      expect(self.body.data.alreadyMember).toBe(true);
    });

    it('недействительное — один и тот же 403 INVITE_INVALID', async () => {
      const a = await owner();
      const inv = await invite(a.tg);
      await prisma.siteAccountInvite.updateMany({
        where: { accountId: a.accountId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const v = person();
      for (const t of [
        inv.token, // просрочено
        `inv_${'A'.repeat(32)}`, // нет такого
        'short', // битое
        'a.b.c-not-a-token',
      ]) {
        const res = await preview(v, t);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('INVITE_INVALID');
      }
      expect(await membershipsOf(v)).toHaveLength(0);
    });

    it('жертва со своим кабинетом: после принятия по умолчанию — СВОЙ, чужой — только явным выбором', async () => {
      const attacker = await owner();
      const victim = await owner();
      const inv = await invite(attacker.tg, 'manager');
      expect((await accept(victim.tg, inv.token)).status).toBe(200);

      const def = await request(srv()).get('/sites/account').set(as(victim.tg));
      expect(def.status).toBe(200);
      expect(def.body.data.account.id).toBe(victim.accountId);
      expect(def.body.data.me.role).toBe('owner');
      expect(
        def.body.data.accounts.map((x: { id: string }) => x.id).sort(),
      ).toEqual([attacker.accountId, victim.accountId].sort());
      // Тот же выбор у кабинетных маршрутов (SiteAccountGuard): сайт без
      // заголовка ложится в СВОЙ кабинет.
      const site = await request(srv())
        .post('/sites')
        .set(as(victim.tg))
        .send({
          name: 'Мой магазин',
          url: `https://n1-${randomUUID().slice(0, 8)}.example.com`,
        });
      expect(site.status).toBe(201);
      expect(
        (await prisma.site.findFirst({ where: { id: site.body.data.id } }))
          ?.accountId,
      ).toBe(victim.accountId);

      const foreign = await request(srv())
        .get('/sites/account')
        .set({ ...as(victim.tg), [SITE_ACCOUNT_HEADER]: attacker.accountId });
      expect(foreign.body.data).toMatchObject({
        account: { id: attacker.accountId },
        me: { role: 'manager' },
      });
    });

    it('своего кабинета нет — самый ранний по членству, не последний', async () => {
      const a = await owner();
      const b = await owner();
      const invA = await invite(a.tg);
      const invB = await invite(b.tg);
      const v = person();
      expect((await accept(v, invA.token)).status).toBe(200);
      // createdAt членства B строго позже A.
      await new Promise((r) => setTimeout(r, 15));
      expect((await accept(v, invB.token)).status).toBe(200);
      const def = await request(srv()).get('/sites/account').set(as(v, 'qa'));
      expect(def.body.data.account.id).toBe(a.accountId);
      expect(await membershipsOf(v)).toHaveLength(2);
    });

    it(`лимит частоты превью: больше ${INVITE_PREVIEW_LIMIT} в минуту — 429`, async () => {
      const a = await owner();
      const inv = await invite(a.tg);
      const v = person();
      for (let i = 0; i < INVITE_PREVIEW_LIMIT; i++) {
        expect((await preview(v, inv.token)).status).toBe(200);
      }
      const over = await preview(v, inv.token);
      expect(over.status).toBe(429);
      expect(over.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
      // Лимит — на человека: другой не задет.
      expect((await preview(person(), inv.token)).status).toBe(200);
    });
  },
);
