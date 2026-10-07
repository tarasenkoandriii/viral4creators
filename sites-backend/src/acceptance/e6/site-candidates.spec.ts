/**
 * W7: кандидаты привязки черновика обучалки к сайту помощника на НАСТОЯЩЕМ
 * Postgres — только кабинеты, где человек владелец или менеджер помощника,
 * только сайты с помощником и с хостом черновика среди подтверждённых (не
 * отозванных); чужие не раскрываются. Без `SITES_DIRECT_URL` — пропуск с
 * причиной, при `CI=true` — провал. Здесь, а не в internal-sites: стенд
 * чата (ChatStack) — вне графа `internal-sites-scope`.
 */
import { randomUUID } from 'crypto';
import { SitesDb } from '../../prisma/sites-db.service';
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { AccountService } from '../../modules/site-core/account/account.service';
import { InternalSiteMediaService } from '../../modules/internal-sites/site-media.service';

jest.setTimeout(120_000);

describeDb('internal-sites: кандидаты привязки (W7)', () => {
  const st = new ChatStack();
  let svc: InternalSiteMediaService;

  beforeAll(async () => {
    await st.init();
    const db = new SitesDb(st.owner);
    svc = new InternalSiteMediaService(db, new AccountService(db));
    svc.env = {};
  });
  afterAll(async () => {
    await st.close();
  });

  it('свой сайт с подтверждённым хостом черновика — кандидат; www и регистр не мешают', async () => {
    const s = await st.site({ name: 'Магазин' });
    await expect(
      svc.candidates(s.ownerTelegramId, `www.${s.host.toUpperCase()}`),
    ).resolves.toEqual({
      sites: [{ siteId: s.siteId, name: 'Магазин', hosts: [s.host] }],
    });
  });

  it('чужой кабинет, оператор помощника, другой хост — пусто', async () => {
    const s = await st.site({
      members: [{ role: 'operator', productRoles: { assist: 'operator' } }],
    });
    const other = await st.site();
    const op = await st.owner.siteAccountMember.findFirst({
      where: { accountId: s.accountId, role: 'operator' },
    });
    for (const [tg, host] of [
      [other.ownerTelegramId, s.host],
      [op!.telegramId, s.host],
      [s.ownerTelegramId, `${randomUUID().slice(0, 8)}.example.com`],
      [BigInt(1), s.host],
    ] as const) {
      await expect(svc.candidates(tg, host)).resolves.toEqual({ sites: [] });
    }
  });

  it('менеджер помощника (не владелец) — видит; отозванный и неподтверждённый хост — нет', async () => {
    const s = await st.site({
      members: [{ role: 'manager', productRoles: { assist: 'manager' } }],
    });
    const mgr = await st.owner.siteAccountMember.findFirst({
      where: { accountId: s.accountId, role: 'manager' },
    });
    const got = await svc.candidates(mgr!.telegramId, s.host);
    expect(got.sites.map((x) => x.siteId)).toEqual([s.siteId]);

    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { revokedAt: new Date() },
    });
    await expect(svc.candidates(s.ownerTelegramId, s.host)).resolves.toEqual({
      sites: [],
    });
    await st.owner.siteHost.updateMany({
      where: { siteId: s.siteId },
      data: { revokedAt: null, status: 'pending' },
    });
    await expect(svc.candidates(s.ownerTelegramId, s.host)).resolves.toEqual({
      sites: [],
    });
  });

  it('сайт без помощника — не кандидат', async () => {
    const s = await st.site();
    await st.owner.assistSite.delete({ where: { siteId: s.siteId } });
    await expect(svc.candidates(s.ownerTelegramId, s.host)).resolves.toEqual({
      sites: [],
    });
  });
});
