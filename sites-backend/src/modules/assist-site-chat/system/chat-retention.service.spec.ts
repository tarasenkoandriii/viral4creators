/**
 * Ретенция виджета (ТЗ §6.3) на настоящем Postgres: сроки — по колонкам
 * сайта, удаляется только просроченное, опубликованные версии вида/персоны
 * не трогаются никогда, пачки не теряют строк.
 */
import { randomUUID } from 'crypto';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import { AssistRetentionController } from '../../assist-sandbox/sandbox-retention.controller';
import type { SandboxService } from '../../assist-sandbox/sandbox.service';
import type { SiteCrawlService } from '../../site-crawl/crawl.service';
import { ChatRetention } from './chat-retention.service';
import { ChatStack } from '../testing/chat-stack.testing';

jest.setTimeout(60_000);

const DAY = 86_400_000;

describeDb('ChatRetention — сроки хранения виджета', () => {
  const st = new ChatStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });

  it('диалоги/лиды по срокам сайта, указатели, токены, кэш, окна, деньги дня, версии сверх 20 (кроме опубликованной), события, черновики', async () => {
    const p = st.owner;
    // Настоящее «сейчас», а не дата в будущем: ретенция чистит ВСЮ базу, и
    // «2031» стёрла бы живые диалоги, деньги и версии параллельных наборов
    // на общей базе CI (так падал eval-platform). Свои строки — в прошлом.
    const now = new Date();
    const dayStr = (daysAgo: number) =>
      new Date(now.getTime() - daysAgo * DAY).toISOString().slice(0, 10);
    const oldDay = dayStr(61);
    const keptDay = dayStr(12);
    const s = await st.site();
    await p.assistSite.update({
      where: { siteId: s.siteId },
      data: {
        retentionDays: 30,
        leadRetentionDays: 60,
        widgetVersion: 2,
        configVersion: 1,
      },
    });
    const conv = (lastMessageAt: Date) =>
      p.assistSiteConversation.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          visitorId: randomUUID(),
          ipHash: 'h',
          parentOrigin: s.origin,
          lastMessageAt,
        },
      });
    const oldConv = await conv(new Date(now.getTime() - 31 * DAY));
    const freshConv = await conv(new Date(now.getTime() - 29 * DAY));
    await p.assistSiteMessage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: oldConv.id,
        role: 'visitor',
        text: 'x',
      },
    });
    const lead = (createdAt: Date, conversationId: string | null) =>
      p.assistSiteLead.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          conversationId,
          fieldsEnc: 'v1.x',
          consentText: 'c',
          consentAt: createdAt,
          createdAt,
        },
      });
    // Лид диалога, удалённого ретенцией, живёт по СВОЕМУ сроку (SET NULL).
    const keptLead = await lead(new Date(now.getTime() - 59 * DAY), oldConv.id);
    const oldLead = await lead(new Date(now.getTime() - 61 * DAY), null);
    const resume = await p.assistSiteVisitorResume.create({
      data: {
        keyHash: randomUUID(),
        siteId: s.siteId,
        visitorId: 'v',
        parentOrigin: s.origin,
        expiresAt: new Date(now.getTime() - 1),
      },
    });
    const token = await p.assistSitePreviewToken.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        tokenHash: randomUUID(),
        purpose: 'tma',
        createdByTelegramId: s.ownerTelegramId,
        expiresAt: new Date(now.getTime() - DAY),
        sessionExpiresAt: new Date(now.getTime() - 1),
      },
    });
    const liveToken = await p.assistSitePreviewToken.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        tokenHash: randomUUID(),
        purpose: 'tma',
        createdByTelegramId: s.ownerTelegramId,
        expiresAt: new Date(now.getTime() - DAY),
        sessionExpiresAt: new Date(now.getTime() + 3_600_000),
      },
    });
    const cache = await p.assistSiteSemanticCache.create({
      data: {
        siteId: s.siteId,
        key: randomUUID(),
        answer: {},
        knowledgeVersion: 1,
        configVersion: 0,
        expiresAt: new Date(now.getTime() - 1),
      },
    });
    await p.assistRateBucket.create({
      data: {
        scope: 'w3-test',
        key: s.siteId,
        bucket: 'b',
        expiresAt: new Date(now.getTime() - 1),
      },
    });
    await p.assistBudgetDay.create({
      data: { scope: 'site', key: s.siteId, day: oldDay },
    });
    await p.assistBudgetDay.create({
      data: { scope: 'site', key: s.siteId, day: keptDay },
    });
    for (let v = 1; v <= 25; v++) {
      await p.assistSiteConfigVersion.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'widget',
          version: v,
          config: {},
        },
      });
    }
    await p.assistSiteConfigVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        kind: 'persona',
        version: 1,
        config: {},
      },
    });
    const event = await p.assistLandingEvent.create({
      data: { name: 'w3-test', createdAt: new Date(now.getTime() - 91 * DAY) },
    });
    const draft = await p.assistWidgetDraft.create({
      data: {
        id: randomUUID(),
        config: {},
        ipKey: 'k',
        expiresAt: new Date(now.getTime() - 1),
      },
    });

    st.retention.batch = 2; // пачками — ничего не теряется
    const r = await st.retention.run(now);
    expect(r.conversationsDeleted).toBeGreaterThanOrEqual(1);
    expect(r.configVersionsDeleted).toBeGreaterThanOrEqual(4);

    expect(
      await p.assistSiteConversation.findUnique({ where: { id: oldConv.id } }),
    ).toBeNull();
    expect(
      await p.assistSiteMessage.count({
        where: { conversationId: oldConv.id },
      }),
    ).toBe(0);
    expect(
      await p.assistSiteConversation.findUnique({
        where: { id: freshConv.id },
      }),
    ).not.toBeNull();
    const kl = await p.assistSiteLead.findUnique({
      where: { id: keptLead.id },
    });
    expect(kl).not.toBeNull();
    expect(kl!.conversationId).toBeNull();
    expect(
      await p.assistSiteLead.findUnique({ where: { id: oldLead.id } }),
    ).toBeNull();
    expect(
      await p.assistSiteVisitorResume.findUnique({
        where: { keyHash: resume.keyHash },
      }),
    ).toBeNull();
    expect(
      await p.assistSitePreviewToken.findUnique({ where: { id: token.id } }),
    ).toBeNull();
    expect(
      await p.assistSitePreviewToken.findUnique({
        where: { id: liveToken.id },
      }),
    ).not.toBeNull();
    expect(
      await p.assistSiteSemanticCache.findUnique({ where: { id: cache.id } }),
    ).toBeNull();
    expect(
      await p.assistRateBucket.count({
        where: { scope: 'w3-test', key: s.siteId },
      }),
    ).toBe(0);
    const days = await p.assistBudgetDay.findMany({
      where: { scope: 'site', key: s.siteId },
    });
    expect(days.map((d) => d.day)).toEqual([keptDay]);
    const versions = await p.assistSiteConfigVersion.findMany({
      where: { siteId: s.siteId, kind: 'widget' },
      orderBy: { version: 'asc' },
      select: { version: true },
    });
    // Последние 20 (6..25) + опубликованная 2.
    expect(versions.map((v) => v.version)).toEqual([
      2,
      ...Array.from({ length: 20 }, (_, i) => i + 6),
    ]);
    expect(
      await p.assistSiteConfigVersion.count({
        where: { siteId: s.siteId, kind: 'persona' },
      }),
    ).toBe(1);
    expect(
      await p.assistLandingEvent.findUnique({ where: { id: event.id } }),
    ).toBeNull();
    expect(
      await p.assistWidgetDraft.findUnique({ where: { id: draft.id } }),
    ).toBeNull();
  });

  it('крон assist-retention (Э1) зовёт ретенцию виджета и возвращает её счётчики', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'w3-retention-secret';
    const chat = new ChatRetention(st.owner);
    const run = jest.spyOn(chat, 'run');
    try {
      const ctl = new AssistRetentionController(
        st.owner,
        {
          retention: async () => ({ sandboxesDeleted: 0, countersDeleted: 0 }),
        } as unknown as SandboxService,
        { purgeFinishedQueue: async () => 0 } as unknown as SiteCrawlService,
        chat,
      );
      const out = await ctl.run('Bearer w3-retention-secret');
      expect(out).toMatchObject({
        ran: true,
        sandboxesDeleted: 0,
        crawlQueueDeleted: 0,
        conversationsDeleted: expect.any(Number),
        leadsDeleted: expect.any(Number),
        widgetDraftsDeleted: expect.any(Number),
      });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      process.env.CRON_SECRET = prev;
    }
  });

  it('бюджет времени исчерпан — остаток удалит следующий запуск, без ошибки', async () => {
    st.retention.timeBudgetMs = -1;
    const r = await st.retention.run(new Date());
    expect(Object.values(r).every((n) => n === 0)).toBe(true);
    st.retention.timeBudgetMs = 45_000;
  });
});
