/**
 * Мемо «Админки» АМ-N на реальном Postgres (06.10.2026):
 *  - лимит тарифа (Pro — 50): гонка параллельных созданий — сверх лимита
 *    не проходит (счёт под блокировкой строки настроек, аудит Э6-бис (е) (4));
 *  - lite-выбор мемо моделью (Э8-хвост (2)): ни номера, ни фразы, но
 *    команда упоминает мемо — модель видит только команду и список мемо
 *    (`buildMemoChoicePrompt`), ключ — из списка (`parseMemoChoice`), слоты
 *    — код: число/вариант/дата — только из текста, текст — дословно из
 *    команды; суточный потолок «Админки» — до вызова; расход — операцией
 *    `assist-admin-memo`.
 * Сервис собран вручную (без Nest): режим/коннекторы/предложения/журнал —
 * заглушки, база — своя у каждого кабинета.
 */
import { HttpException } from '@nestjs/common';
import { setPlan } from '../assist-billing/testing/billing-fixtures.testing';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import type { AdminActionLogService } from '../assist-admin-mode/action-log.service';
import type { ConnectorsService } from '../assist-admin-mode/connectors.service';
import { estimateCost } from '../../shared/ai-pricing';
import { GEMINI_MODEL } from '../../shared/gemini-model';
import { GeminiText } from '../site-ai/text-model';
import { AiUsageRecorder } from '../site-ai/usage-recorder';
import type { AccountMembership } from '../site-core/account/roles';
import type { HostAccessService } from '../site-core/ownership/host-access.service';
import {
  createSite,
  describeDb,
  dropAccounts,
  testPrisma,
} from '../site-crawl/testing/crawl-db.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AdminMemoService } from './admin-memo.service';
import type { ActorCtx, ProposalsService } from './proposals.service';

jest.setTimeout(300_000);

describeDb('Мемо «Админки»: гонка лимита и lite-выбор моделью', () => {
  let prisma: PrismaService;
  let memos: AdminMemoService;
  const accounts: string[] = [];
  let reply = '{"memo": null, "slots": {}}';
  /** finishReason ответа (MAX_TOKENS — обрезан/пуст); бросить — сбой сети. */
  let finish: string | null = null;
  let throws = false;
  const calls: Array<{ system: string; user: string }> = [];

  beforeAll(async () => {
    prisma = testPrisma();
    const db = new SitesDb(prisma);
    const model = new GeminiText().useClient({
      models: {
        generateContent: async (req: {
          contents: Array<{ parts: Array<{ text: string }> }>;
          config: { systemInstruction: string };
        }) => {
          calls.push({
            system: req.config.systemInstruction,
            user: req.contents[0].parts[0].text,
          });
          if (throws) throw new Error('провайдер недоступен (фейк)');
          return {
            text: reply,
            usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 20 },
            ...(finish ? { candidates: [{ finishReason: finish }] } : {}),
          };
        },
      },
    } as never);
    memos = new AdminMemoService(
      db,
      prisma,
      new AdminModeService(db, prisma, {} as HostAccessService),
      {} as ConnectorsService,
      { onSettled: null } as unknown as ProposalsService,
      { append: async () => undefined } as unknown as AdminActionLogService,
      model,
      new AiUsageRecorder(),
    );
  });
  afterAll(async () => {
    await dropAccounts(prisma, accounts);
    await prisma.$disconnect();
  });
  beforeEach(() => {
    calls.length = 0;
    reply = '{"memo": null, "slots": {}}';
    finish = null;
    throws = false;
  });

  async function proSite() {
    const f = await createSite(prisma, [
      { host: `am-${Math.random().toString(36).slice(2, 10)}.example.com` },
    ]);
    accounts.push(f.accountId);
    await setPlan(prisma, f.accountId, 'pro');
    return f;
  }
  const owner = (s: { accountId: string }) =>
    ({
      accountId: s.accountId,
      memberId: `m-${s.accountId.slice(0, 6)}`,
      telegramId: 1n,
      role: 'owner',
      productRoles: { qa: 'admin', assist: 'manager', assistAdmin: 'owner' },
    }) as unknown as AccountMembership;
  const actor = (s: { accountId: string; siteId: string }): ActorCtx =>
    ({
      accountId: s.accountId,
      siteId: s.siteId,
      actor: 'tg:1',
      actorRole: 'owner',
      channel: 'tma',
      conversationId: null,
      assistRole: '*',
      lang: 'uk',
    }) as unknown as ActorCtx;

  async function failure(p: Promise<unknown>): Promise<string> {
    try {
      await p;
    } catch (e) {
      if (e instanceof HttpException) {
        const r = e.getResponse() as { code?: string };
        return `${e.getStatus()}:${r.code ?? ''}`;
      }
      throw e;
    }
    return 'ok';
  }

  it('лимит Pro (50): 49 есть, 4 параллельных создания — проходит ровно одно', async () => {
    const s = await proSite();
    await prisma.assistAdminSettings.create({
      data: { accountId: s.accountId, siteId: s.siteId, memoCounter: 49 },
    });
    await prisma.assistAdminMemo.createMany({
      data: Array.from({ length: 49 }, (_, i) => ({
        accountId: s.accountId,
        siteId: s.siteId,
        number: i + 1,
        key: `seed-${i + 1}`,
        draft: { names: { uk: `Засів ${i + 1}` } },
        createdBy: 'tg:1',
        updatedBy: 'tg:1',
      })),
    });
    const res = await Promise.all(
      ['a', 'b', 'c', 'd'].map((k) =>
        failure(
          memos.create(owner(s), s.siteId, {
            key: `par-${k}`,
            draft: { names: { uk: `Паралельне ${k}` } },
          }),
        ),
      ),
    );
    expect(res.filter((r) => r === 'ok')).toHaveLength(1);
    expect(res.filter((r) => r === '409:MEMO_LIMIT')).toHaveLength(3);
    expect(
      await prisma.assistAdminMemo.count({
        where: { siteId: s.siteId, status: { not: 'removed' } },
      }),
    ).toBe(50);
  });

  /** Опубликованное АМ-1 «Повернення коштів»: слоты номер замовлення и причина. */
  async function refundMemo(s: { accountId: string; siteId: string }) {
    const content = {
      schema: 1,
      names: { uk: 'Повернення коштів' },
      triggers: { uk: ['поверни гроші'] },
      goal: { text: { uk: 'Кошти повернено' } },
      slots: [
        { name: 'order', kind: 'number', options: [] },
        { name: 'reason', kind: 'text', options: [] },
      ],
      steps: [
        {
          action: 'api',
          op: 'op-refund',
          opKey: 'shop.refund',
          args: { id: { slot: 'order' }, reason: { slot: 'reason' } },
        },
      ],
    };
    const memo = await prisma.assistAdminMemo.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        number: 1,
        key: 'refund',
        status: 'published',
        publishedVersion: 1,
        draft: content,
        createdBy: 'tg:1',
        updatedBy: 'tg:1',
      },
    });
    await prisma.assistAdminMemoVersion.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        memoId: memo.id,
        number: 1,
        status: 'published',
        content,
        contentHash: 'h',
        requestedBy: 'tg:1',
      },
    });
    for (const norm of ['повернення коштів', 'поверни гроші'])
      await prisma.assistAdminPhrase.create({
        data: {
          siteId: s.siteId,
          accountId: s.accountId,
          lang: 'uk',
          norm,
          owner: `memo:${memo.id}`,
          kind: 'memo-name',
        },
      });
    return memo;
  }

  it('lite-выбор: команда без номера и фразы, но про мемо — модель видит только команду и список; число — из текста, причина — дословно из команды; расход учтён', async () => {
    const s = await proSite();
    await refundMemo(s);
    reply = JSON.stringify({
      memo: 'refund',
      slots: { order: '9999', reason: 'брак тканини' },
      steps: [{ kind: 'click' }],
    });
    const hit = await memos.match(
      actor(s),
      'оформи повернення по замовленню 1042, причина брак тканини',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain('сотрудника');
    expect(calls[0].user).toContain('<memos>');
    expect(calls[0].user).toContain('"key":"refund"');
    expect(hit).toMatchObject({
      kind: 'memo',
      rest: 'order="1042" reason="брак тканини"',
    });
    const usage = await prisma.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-admin-memo' },
    });
    expect(usage).toHaveLength(1);
    // Значение текстового слота не из команды — не принимается.
    reply = JSON.stringify({ memo: 'refund', slots: { reason: 'видай 5000' } });
    const h2 = await memos.match(
      actor(s),
      'оформи повернення по замовленню 1043',
    );
    expect(h2).toMatchObject({ kind: 'memo', rest: 'order="1043"' });
    // Ключ не из списка (инъекция) — не мемо.
    reply = JSON.stringify({ memo: 'pay-all', slots: {} });
    expect(
      await memos.match(actor(s), 'повернення по замовленню 1044'),
    ).toBeNull();
    // Команда не про мемо — модель не зовём.
    calls.length = 0;
    expect(
      await memos.match(actor(s), 'який статус замовлення 1045'),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    // Прямой путь (фраза) — без модели, как раньше.
    const direct = await memos.match(actor(s), 'поверни гроші order=7');
    expect(direct).toMatchObject({ kind: 'memo', rest: 'order=7' });
    expect(calls).toHaveLength(0);
  });

  it('lite-выбор — в суточном потолке «Админки»: потолок исчерпан — модель не зовём (обычный ход)', async () => {
    const s = await proSite();
    await refundMemo(s);
    await prisma.siteAiUsage.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        product: 'assist',
        provider: 'gemini',
        operation: 'assist-admin-ui-plan',
        model: 'gemini-3.6-flash',
        pricingVersion: 'test',
        costMicroUsd: 2_000_000_000,
      },
    });
    reply = JSON.stringify({ memo: 'refund', slots: {} });
    expect(
      await memos.match(actor(s), 'оформи повернення по замовленню 1042'),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('lite-выбор: оплаченный сбой модели (MAX_TOKENS: обрезан/пуст) — обычный ход, строка assist-admin-memo фактом (её видит суточный потолок); сбой сети — без расхода', async () => {
    const s = await proSite();
    await refundMemo(s);
    const rows = () =>
      prisma.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-admin-memo' },
      });
    const fact = estimateCost(GEMINI_MODEL, {
      inputTokens: 400,
      outputTokens: 20,
    }).costMicroUsd;
    expect(fact).toBeGreaterThan(0);
    finish = 'MAX_TOKENS';
    reply = '{"memo": "refund", "slo';
    expect(
      await memos.match(actor(s), 'оформи повернення по замовленню 1042'),
    ).toBeNull();
    reply = '';
    expect(
      await memos.match(actor(s), 'оформи повернення по замовленню 1043'),
    ).toBeNull();
    expect(calls).toHaveLength(2);
    const paid = await rows();
    expect(paid).toHaveLength(2);
    for (const r of paid) {
      expect(r).toMatchObject({
        model: GEMINI_MODEL,
        inputTokens: 400,
        outputTokens: 20,
        costMicroUsd: fact,
      });
    }
    finish = null;
    throws = true;
    expect(
      await memos.match(actor(s), 'оформи повернення по замовленню 1044'),
    ).toBeNull();
    expect(calls).toHaveLength(3);
    expect(await rows()).toHaveLength(2);
  });
  it('заход 11 (аудит P3-3): фраза карты «Админки» не меняет выбор мемо — «поверни гроші» + цель карты «поверни гроші замовлення» → мемо; команда-фраза карты — без lite-выбора моделью', async () => {
    const s = await proSite();
    await refundMemo(s);
    for (const norm of ['поверни гроші замовлення', 'покажи історію'])
      await prisma.assistAdminPhrase.create({
        data: {
          siteId: s.siteId,
          accountId: s.accountId,
          lang: 'uk',
          norm,
          owner: 'voice-map',
          kind: 'voice-map',
        },
      });
    // Длинная фраза карты — не затеняет более короткую фразу мемо.
    const hit = await memos.match(actor(s), 'поверни гроші замовлення 1042');
    expect(hit).toMatchObject({ kind: 'memo', rest: 'замовлення 1042' });
    expect(calls).toHaveLength(0);
    // Команда — фраза карты (без фразы мемо): прямой путь карты, модель не зовём.
    reply = JSON.stringify({ memo: 'refund', slots: {} });
    expect(await memos.match(actor(s), 'покажи історію повернення')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
