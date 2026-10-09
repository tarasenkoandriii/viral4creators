/**
 * Голосовая карта «Админки» (заход 11, №117) на НАСТОЯЩЕМ Postgres — сервис
 * основной ролью: черновик с ревизией (409) и проверками ядра (422),
 * хосты — только хосты САМОЙ админки, тариф Pro (402, В-55), ворота «фраза
 * мемо» по индексу фраз «Админки», публикация → индекс фраз (владелец
 * `voice-map`) и опубликованная карта для плана (только `published`, кэш
 * сбрасывается публикацией), откат и отклонение, 20 версий, экспорт/импорт
 * `kind: admin` (файл «Сайта» — отказ), журнал `voice-map` в append-only
 * журнале действий с целой цепочкой.
 */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AdminMemoMonitorService } from '../assist-admin-actions/admin-memo-monitor.service';
import { AssistAdminRetentionController } from '../assist-admin-chat/cron/assist-admin-retention.controller';
import { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import { setPlan } from '../assist-billing/testing/billing-fixtures.testing';
import {
  describeDb,
  testPrisma as ownerPrisma,
} from '../site-crawl/testing/crawl-db.testing';
import { exportPayload, versionContent } from '../assist-ui-core/voice-map';
import type { AccountMembership } from '../site-core/account/roles';
import type { HostAccessService } from '../site-core/ownership/host-access.service';
import {
  clearAdminVoiceMapCache,
  readPublishedAdminVoiceMap,
} from './admin-voice-map-store';
import {
  actorOfMember,
  ADMIN_MAP_PHRASE_OWNER,
  AdminVoiceMapService,
} from './admin-voice-map.service';

jest.setTimeout(120_000);

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException) {
      const r = e.getResponse() as {
        code: string;
        errors?: Array<{ code: string; path: string }>;
      };
      return { status: e.getStatus(), code: r.code, errors: r.errors ?? [] };
    }
    throw e;
  }
  throw new Error('ожидался отказ');
}

describeDb('голосовая карта «Админки» — сервис на настоящей базе', () => {
  let prisma: PrismaService;
  let maps: AdminVoiceMapService;
  let log: AdminActionLogService;
  const accounts: string[] = [];

  beforeAll(() => {
    prisma = ownerPrisma();
    const db = new SitesDb(prisma);
    log = new AdminActionLogService(db);
    const mode = new AdminModeService(db, prisma, {} as HostAccessService);
    maps = new AdminVoiceMapService(db, mode, log);
    maps.env = {};
  });
  afterAll(async () => {
    if (accounts.length)
      await prisma.siteAccount.deleteMany({ where: { id: { in: accounts } } });
    await prisma.$disconnect();
  });
  beforeEach(() => clearAdminVoiceMapCache());

  async function site(plan: 'pro' | 'business' = 'pro') {
    const tag = randomUUID().slice(0, 8);
    const account = await prisma.siteAccount.create({
      data: { verifyToken: `z11a-${randomUUID()}` },
    });
    accounts.push(account.id);
    const tg = BigInt(Math.floor(Math.random() * 1e12) + 1e12);
    const member = await prisma.siteAccountMember.create({
      data: {
        accountId: account.id,
        telegramId: tg,
        role: 'owner',
        productRoles: {},
      },
    });
    const s = await prisma.site.create({
      data: { accountId: account.id, name: `Магазин ${tag}` },
    });
    const verified = (host: string) =>
      prisma.siteHost.create({
        data: {
          accountId: account.id,
          siteId: s.id,
          host,
          status: 'verified',
          method: 'dns',
          verifiedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    const pub = await verified(`shop-${tag}.z11a.example`);
    const adm = await verified(`admin-${tag}.z11a.example`);
    await prisma.assistAdminSettings.create({
      data: {
        accountId: account.id,
        siteId: s.id,
        adminModeEnabled: true,
        adminAccess: 'both',
        adminHostIds: [adm.id],
        // Раунд исправлений: редактор — роль заказчика, сопоставленная с `owner`.
        roleMap: { admin: 'owner' },
      },
    });
    await setPlan(prisma, account.id, plan);
    const m: AccountMembership = {
      accountId: account.id,
      memberId: member.id,
      telegramId: tg,
      role: 'owner',
      productRoles: {},
    } as AccountMembership;
    return {
      m,
      siteId: s.id,
      accountId: account.id,
      adminHost: adm.host,
      publicHost: pub.host,
    };
  }

  const ordersTarget = (adminHost: string, extra = {}) => ({
    key: 'orders',
    scope: 'site',
    descriptor: {
      tag: 'a',
      role: 'link',
      text: 'Замовлення',
      hrefPath: '/admin/orders',
      hrefHost: adminHost,
      unique: true,
    },
    names: { uk: 'Замовлення', ru: 'Заказы', en: 'Orders' },
    synonyms: { uk: [{ text: 'список замовлень' }] },
    ...extra,
  });

  async function patch(S: Awaited<ReturnType<typeof site>>, ops: unknown[]) {
    const d = await maps.draft(S.m, S.siteId);
    return maps.patch(
      actorOfMember(S.m),
      S.siteId,
      { expectedRevision: d.revision, ops },
      'tma',
    );
  }

  it('черновик: цель на хосте админки — «сразу»; ссылка на публичный сайт — чужой хост («никогда», имена — 422); 409 на старой ревизии', async () => {
    const S = await site();
    const r = await patch(S, [
      { op: 'upsert-target', target: ordersTarget(S.adminHost) },
    ]);
    expect(r).toEqual({ revision: 1, applied: 1 });
    const d = await maps.draft(S.m, S.siteId);
    expect(d.content.targets[0]).toMatchObject({
      key: 'orders',
      riskComputed: 'now',
    });
    // Хост публичного сайта для карты «Админки» — чужой: ссылка «никогда»,
    // имя у такой цели — 422 (только denylist).
    const bad = await code(
      patch(S, [
        {
          op: 'upsert-target',
          target: {
            ...ordersTarget(S.publicHost),
            key: 'shop-home',
            descriptor: {
              tag: 'a',
              role: 'link',
              text: 'Магазин',
              hrefPath: '/',
              hrefHost: S.publicHost,
              offHost: true,
              unique: true,
            },
          },
        },
      ]),
    );
    expect(bad.status).toBe(422);
    expect(bad.errors.map((e) => e.code)).toContain('never_target_named');
    const stale = await code(
      maps.patch(
        actorOfMember(S.m),
        S.siteId,
        { expectedRevision: 0, ops: [{ op: 'remove-target', key: 'orders' }] },
        'tma',
      ),
    );
    expect(stale).toMatchObject({ status: 409, code: 'VOICE_MAP_CONFLICT' });
  });

  it('тариф Business — изменения 402, чтение — да (сводка: planAllows=false)', async () => {
    const S = await site('business');
    expect(
      await code(
        patch(S, [{ op: 'upsert-target', target: ordersTarget(S.adminHost) }]),
      ),
    ).toMatchObject({ status: 402, code: 'ADMIN_VOICE_MAP_PLAN_REQUIRED' });
    expect((await code(maps.editorLink(S.m, S.siteId, {}))).code).toBe(
      'ADMIN_VOICE_MAP_PLAN_REQUIRED',
    );
    expect(
      (await code(maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma'))).code,
    ).toBe('ADMIN_VOICE_MAP_PLAN_REQUIRED');
    const sum = await maps.summary(S.m, S.siteId);
    expect(sum).toMatchObject({ planAllows: false, publishedVersion: 0 });
    expect(sum.hosts).toEqual([S.adminHost]);
  });

  it('публикация: индекс фраз «Админки» (владелец voice-map), план читает только опубликованную версию; кэш сбрасывается публикацией', async () => {
    const S = await site();
    const db = maps.db(S.accountId);
    expect(await readPublishedAdminVoiceMap(db, S.siteId)).toBeNull();
    await patch(S, [
      { op: 'upsert-target', target: ordersTarget(S.adminHost) },
    ]);
    const v = await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    expect(v.status).toBe('checking');
    // Версия на проверке плану не видна (и кэш «нет карты» живёт).
    expect(await readPublishedAdminVoiceMap(db, S.siteId)).toBeNull();
    const pub = await maps.publish(S.m, S.siteId, String(v.number));
    expect(pub.status).toBe('published');
    const live = await readPublishedAdminVoiceMap(db, S.siteId);
    expect(live?.version).toBe(v.number);
    expect(live?.content.targets.map((t) => t.key)).toEqual(['orders']);
    const phrases = await prisma.assistAdminPhrase.findMany({
      where: { siteId: S.siteId },
      orderBy: { norm: 'asc' },
    });
    expect(phrases.map((p) => [p.owner, p.lang, p.norm])).toEqual(
      expect.arrayContaining([
        [ADMIN_MAP_PHRASE_OWNER, 'uk', 'замовлення'],
        [ADMIN_MAP_PHRASE_OWNER, 'uk', 'список замовлень'],
        [ADMIN_MAP_PHRASE_OWNER, 'ru', 'заказы'],
        [ADMIN_MAP_PHRASE_OWNER, 'en', 'orders'],
      ]),
    );
    // «Сайт» не задет (нет ни карты, ни фраз) — приёмка z11a
    // `voice-map-isolation.spec.ts`: имён таблиц «Сайта» модуль «Админки»
    // не называет даже в тестах (правило графа admin-names↛site).
    // Повторная публикация той же версии — 409 (статус уже не checking).
    expect(
      (await code(maps.publish(S.m, S.siteId, String(v.number)))).code,
    ).toBe('VOICE_MAP_VERSION_STATE');
  });

  it('ворота: фраза опубликованного мемо АМ-N — `memo_phrase` (версия held, публикация 409)', async () => {
    const S = await site();
    await prisma.assistAdminPhrase.create({
      data: {
        siteId: S.siteId,
        accountId: S.accountId,
        lang: 'uk',
        norm: 'список замовлень',
        owner: 'memo:x',
        kind: 'memo-trigger',
      },
    });
    await patch(S, [
      { op: 'upsert-target', target: ordersTarget(S.adminHost) },
    ]);
    const v = await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    expect(v.status).toBe('held');
    expect(v.gateReport?.problems.map((p) => p.code)).toContain('memo_phrase');
    expect(
      (await code(maps.publish(S.m, S.siteId, String(v.number)))).code,
    ).toBe('VOICE_MAP_VERSION_STATE');
    const dis = await maps.discard(S.m, S.siteId, String(v.number));
    expect(dis.status).toBe('discarded');
  });

  it('откат — новая версия с содержимым N (через ворота); хранятся 20 версий, опубликованная — всегда', async () => {
    const S = await site();
    await patch(S, [
      { op: 'upsert-target', target: ordersTarget(S.adminHost) },
    ]);
    const v1 = await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    await maps.publish(S.m, S.siteId, String(v1.number));
    await patch(S, [
      {
        op: 'upsert-target',
        target: ordersTarget(S.adminHost, {
          synonyms: { uk: [{ text: 'усі замовлення' }] },
        }),
      },
    ]);
    const v2 = await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    await maps.publish(S.m, S.siteId, String(v2.number));
    const back = await maps.rollback(S.m, S.siteId, String(v1.number));
    expect(back).toMatchObject({ rollbackOf: v1.number, status: 'checking' });
    expect(back.content.targets[0].synonyms.uk?.[0].text).toBe(
      'список замовлень',
    );
    await maps.publish(S.m, S.siteId, String(back.number));
    const live = await readPublishedAdminVoiceMap(
      maps.db(S.accountId),
      S.siteId,
    );
    expect(live?.version).toBe(back.number);
    // Откатить можно только бывшую опубликованную.
    const held = await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    await maps.discard(S.m, S.siteId, String(held.number));
    expect(
      (await code(maps.rollback(S.m, S.siteId, String(held.number)))).code,
    ).toBe('VOICE_MAP_VERSION_STATE');
    for (let i = 0; i < 20; i++)
      await maps.buildVersion(actorOfMember(S.m), S.siteId, 'tma');
    const kept = await prisma.assistAdminVoiceMapVersion.findMany({
      where: { siteId: S.siteId },
      select: { number: true },
    });
    expect(kept.length).toBe(21);
    expect(kept.map((k) => k.number)).toContain(back.number);
  });

  it('экспорт `kind: admin` с подписью → импорт в пустую карту того же сайта; файл «Сайта» — отказ целиком', async () => {
    const S = await site();
    maps.env = { ASSIST_SECRETS_KEY: 'k'.repeat(44) };
    try {
      await patch(S, [
        { op: 'upsert-target', target: ordersTarget(S.adminHost) },
      ]);
      const f = await maps.exportFile(S.m, S.siteId);
      expect(f.name).toMatch(/\.admin\.v0\.json$/);
      expect(f.file.kind).toBe('admin');
      const T = await site();
      const imp = await maps.importFile(T.m, T.siteId, {
        expectedRevision: 0,
        file: JSON.parse(
          JSON.stringify(f.file).split(S.adminHost).join(T.adminHost),
        ),
      });
      // Хост заменён — подпись уже «не наша», но импорт идёт (пометка).
      expect(imp).toMatchObject({ accepted: 1, rejected: [], signed: false });
      const U = await site();
      const same = await maps.importFile(U.m, U.siteId, {
        expectedRevision: 0,
        file: f.file,
      });
      expect(same.signed).toBe(true);
      const siteFile = exportPayload(
        versionContent((await maps.draft(S.m, S.siteId)).content),
      );
      expect(
        await code(
          maps.importFile(T.m, T.siteId, {
            expectedRevision: imp.revision,
            file: siteFile,
          }),
        ),
      ).toMatchObject({ status: 422, code: 'VOICE_MAP_IMPORT_KIND' });
    } finally {
      maps.env = {};
    }
  });

  it('ссылка редактора — только хост самой админки (путь `//чужой` → `/`); журнал `voice-map` — append-only цепочка цела', async () => {
    const S = await site();
    const l = await maps.editorLink(S.m, S.siteId, {
      path: '//evil.example/x',
      focus: 'orders',
    });
    expect(l.url).toMatch(
      new RegExp(`^https://${S.adminHost.replace(/\./g, '\\.')}/\\?v4c_edit=`),
    );
    expect(
      (await code(maps.editorLink(S.m, S.siteId, { host: S.publicHost }))).code,
    ).toBe('ADMIN_VOICE_MAP_HOST_REQUIRED');
    const row = await prisma.assistAdminVoiceMapEditorSession.findFirstOrThrow({
      where: { siteId: S.siteId },
    });
    expect(row).toMatchObject({ pagePath: '/', focusKey: 'orders' });
    expect(JSON.stringify(row)).not.toContain(
      new URL(l.url).searchParams.get('v4c_edit'),
    );
    await patch(S, [
      { op: 'upsert-target', target: ordersTarget(S.adminHost) },
    ]);
    expect(await maps.revokeSessions(S.m, S.siteId, null)).toEqual({
      revoked: 1,
    });
    const rows = await prisma.assistAdminActionLog.findMany({
      where: { siteId: S.siteId },
      orderBy: [{ at: 'asc' }, { id: 'asc' }],
    });
    expect(rows.map((r) => [r.kind, r.operation, r.actor])).toEqual([
      ['voice-map', 'voice-map.editor-link', `tg:${S.m.telegramId}`],
      ['voice-map', 'voice-map.draft', `tg:${S.m.telegramId}`],
      ['voice-map', 'voice-map.editor-revoke', `tg:${S.m.telegramId}`],
    ]);
    expect(rows[1].requestMasked).toMatchObject({
      revision: 1,
      source: 'tma',
      more: 0,
    });
    expect(await log.verifyChain(S.accountId, S.siteId)).toBe(-1);
    // Журнал только дописывается (триггер миграции _assist_admin_read).
    await expect(
      prisma.assistAdminActionLog.deleteMany({ where: { siteId: S.siteId } }),
    ).rejects.toThrow();
  });

  it('assist-admin-retention: ссылки и сессии редактора карты — через сутки после срока/отзыва; живые — остаются', async () => {
    const S = await site();
    const now = new Date();
    const mk = (over: Record<string, unknown>) =>
      prisma.assistAdminVoiceMapEditorSession.create({
        data: {
          accountId: S.accountId,
          siteId: S.siteId,
          memberId: S.m.memberId,
          hostId: 'h',
          host: S.adminHost,
          parentOrigin: `https://${S.adminHost}`,
          linkTokenHash: randomUUID(),
          linkExpiresAt: new Date(now.getTime() + 600_000),
          ...over,
        },
      });
    const DAY = 86_400_000;
    const oldLink = await mk({
      linkExpiresAt: new Date(now.getTime() - 2 * DAY),
    });
    const freshLink = await mk({
      linkExpiresAt: new Date(now.getTime() - 60_000),
    });
    const oldRevoked = await mk({
      exchangedAt: new Date(now.getTime() - 3 * DAY),
      revokedAt: new Date(now.getTime() - 2 * DAY),
    });
    const oldAbs = await mk({
      exchangedAt: new Date(now.getTime() - 3 * DAY),
      absoluteExpiresAt: new Date(now.getTime() - 2 * DAY),
    });
    const live = await mk({
      exchangedAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      absoluteExpiresAt: new Date(now.getTime() + 3_600_000),
    });
    const cron = new AssistAdminRetentionController(prisma, {
      run: async () => ({ reviews: 0 }),
    } as unknown as AdminMemoMonitorService);
    const r = await cron.runOnce(now);
    expect(r.editorSessions).toBeGreaterThanOrEqual(3);
    const left = (
      await prisma.assistAdminVoiceMapEditorSession.findMany({
        where: { siteId: S.siteId },
        select: { id: true },
      })
    ).map((x) => x.id);
    expect(left).toEqual(expect.arrayContaining([freshLink.id, live.id]));
    for (const gone of [oldLink, oldRevoked, oldAbs])
      expect(left).not.toContain(gone.id);
  });
});
