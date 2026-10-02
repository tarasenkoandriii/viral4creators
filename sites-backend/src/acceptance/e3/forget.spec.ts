/**
 * Приёмка Э3 (L): право посетителя на удаление по артефактам обучения —
 * ТЗ §4-тер.12, §4-тер.15 п.12, О-15; контракт Э3 решение 10.
 *
 * Шаги `POST /widget/v1/forget` (W, WidgetStateService.forget) повторены
 * ПОД РОЛЬЮ assist_public: ForgetJobs.enqueue ДО удаления диалогов, затем
 * deleteMany диалогов посетителя; хвост — LearnRollup.processForgetJobs
 * (кроны assist-handoff-tick и assist-learn-rollup) со `scope` своего сайта.
 *
 *  1. Элементы очереди и кейс eval «вне знаний» из диалога удалены
 *     каскадом; проверенный ответ остаётся, `fromConversationId` = null.
 *  2. Дословный вариант посетителя снят хвостом и ушёл из индекса (новая
 *     версия знаний); такой же вариант другого посетителя — остаётся.
 *  3. Кластер только из вопросов посетителя удалён, подпись общего —
 *     пересчитана по оставшимся; задание закрыто (processedAt).
 *  4. Хвост ждёт, пока диалоги ещё не удалены (W ставит задание ДО удаления).
 */
import { Logger } from '@nestjs/common';
import {
  LearnStack,
  RAW_URL,
  describeWithoutDb,
  type LSite,
} from '../../modules/assist-site-learning/testing/learning-stack.testing';

const P = 'Де забрати замовлення у Дніпрі?';
const U = 'Чи працюєте ви о двадцять першій?';
const O = 'Яка погода буде завтра?';

// Реальная база, индексация и конвейер: при параллельных наборах дольше 5 с.
jest.setTimeout(60_000);

if (!RAW_URL) {
  describeWithoutDb('forget посетителя и обучение (Э3, L)');
} else {
  describe('forget посетителя: хвост обучения (Э3 п.12), реальный Postgres', () => {
    let st: LearnStack;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      st = await new LearnStack().init();
    });

    afterAll(async () => {
      await st.close();
    });

    /** Шаги W `forget` под ролью виджета: задание → удаление диалогов. */
    async function widgetForget(
      s: LSite,
      visitorId: string,
      opts: { deleteConversations: boolean } = { deleteConversations: true },
    ): Promise<string[]> {
      const where = { siteId: s.siteId, visitorId };
      const ids = (
        await st.publicDb.assistSiteConversation.findMany({
          where,
          select: { id: true },
        })
      ).map((c) => c.id);
      await st.forget.enqueue(s.siteId, ids);
      if (opts.deleteConversations) {
        await st.publicDb.assistSiteConversation.deleteMany({ where });
      }
      return ids;
    }

    it('п.12: очередь и кейсы из диалога удалены; ответ остаётся без fromConversationId; дословный вариант снят хвостом', async () => {
      const s = await st.site();
      const a = 'v-alice-' + s.siteId;
      const b = 'v-bob-' + s.siteId;
      const ap = await st.ask(s, P, { visitorId: a });
      await st.ask(s, P, { visitorId: b });
      const au = await st.ask(s, U, { visitorId: a });
      await st.ask(s, O, { visitorId: a });
      await st.rollupRun([s]);
      const clusters = await st.clusters(s);
      const cp = clusters.find((c) => c.label === P)!;
      const cu = clusters.find((c) => c.label === U)!;
      const co = clusters.find((c) => c.label === O)!;
      expect(cp.distinctVisitors).toBe(2);

      const gp = await st.queue.resolve(s.manager, s.siteId, cp.id, {
        action: 'golden',
        question: 'Де можна забрати замовлення?',
        answer: 'Самовивіз — вул. Центральна, 1.',
        variants: [P],
      });
      const gu = await st.queue.resolve(s.manager, s.siteId, cu.id, {
        action: 'golden',
        question: 'Графік роботи',
        answer: 'Працюємо щодня з 9 до 21.',
        variants: [U, 'До котрої працюєте?'],
      });
      const oos = await st.queue.resolve(s.manager, s.siteId, co.id, {
        action: 'out_of_scope',
      });
      const before = await st.faqChunkTexts(s);
      expect(before.some((t) => t.includes(U))).toBe(true);
      const faqU0 = await st.prisma.assistSiteFaq.findFirst({
        where: { id: gu.faqId!, siteId: s.siteId },
      });
      expect(faqU0!.fromConversationId).toBe(au.conversationId);
      const v0 = await st.version(s);

      const ids = await widgetForget(s, a);
      expect(ids).toHaveLength(3);
      // Каскады FK: очередь посетителя и кейс «вне знаний» из его диалога.
      const items = await st.items(s);
      expect(items.every((i) => !ids.includes(i.conversationId ?? ''))).toBe(
        true,
      );
      expect(items).toHaveLength(1);
      expect(
        await st.prisma.assistSiteEvalCase.findFirst({
          where: { id: oos.evalCaseId!, siteId: s.siteId },
        }),
      ).toBeNull();
      // Ответ владельца остаётся; ссылка на диалог обнулена базой.
      const faqU1 = await st.prisma.assistSiteFaq.findFirst({
        where: { id: gu.faqId!, siteId: s.siteId },
      });
      expect(faqU1).toMatchObject({
        status: 'active',
        fromConversationId: null,
      });
      expect(
        (
          await st.prisma.assistSiteFaq.findFirst({
            where: { id: gp.faqId!, siteId: s.siteId },
          })
        )?.fromConversationId,
      ).toBeNull();

      // Хвост: дословная цитата посетителя — из вариантов и из индекса.
      const done = await st.rollup.processForgetJobs(50, {
        siteIds: [s.siteId],
      });
      expect(done).toBe(1);
      const faqU2 = await st.prisma.assistSiteFaq.findFirst({
        where: { id: gu.faqId!, siteId: s.siteId },
      });
      expect(faqU2!.variants).toEqual(['До котрої працюєте?']);
      expect(faqU2!.variantRefs).toBeNull();
      // Та же формулировка другого (не забытого) посетителя остаётся.
      const faqP = await st.prisma.assistSiteFaq.findFirst({
        where: { id: gp.faqId!, siteId: s.siteId },
      });
      expect(faqP!.variants).toEqual([P]);
      expect(
        (faqP!.variantRefs as Array<{ conversationId: string }>).map(
          (r) => r.conversationId,
        ),
      ).toEqual([expect.not.stringMatching(ap.conversationId)]);
      expect(await st.version(s)).toBeGreaterThan(v0);
      const after = await st.faqChunkTexts(s);
      expect(after.some((t) => t.includes(U))).toBe(false);
      expect(after.some((t) => t.includes('Графік роботи'))).toBe(true);

      // Кластеры: только его вопросы — удалены; общий — пересчитан.
      const left = await st.clusters(s);
      expect(left.map((c) => c.id)).toEqual([cp.id]);
      expect(left[0]).toMatchObject({ size: 1, distinctVisitors: 1, label: P });
      expect(left.every((c) => c.label !== U && c.label !== O)).toBe(true);

      const job = await st.prisma.assistSiteForgetJob.findFirst({
        where: { siteId: s.siteId },
      });
      expect(job!.processedAt).not.toBeNull();
      // Повтор — ничего.
      expect(
        await st.rollup.processForgetJobs(50, { siteIds: [s.siteId] }),
      ).toBe(0);
    });

    it('хвост ждёт удаления диалогов; пустой forget задания не ставит', async () => {
      const s = await st.site();
      const a = 'v-carol-' + s.siteId;
      await st.ask(s, U, { visitorId: a });
      await st.rollupRun([s]);
      const [c] = await st.clusters(s);
      const g = await st.queue.resolve(s.manager, s.siteId, c.id, {
        action: 'golden',
        question: 'Графік роботи',
        answer: 'Щодня з 9 до 21.',
        variants: [U],
      });
      await widgetForget(s, a, { deleteConversations: false });
      expect(
        await st.rollup.processForgetJobs(50, { siteIds: [s.siteId] }),
      ).toBe(0);
      expect(
        (await st.prisma.assistSiteFaq.findFirst({
          where: { id: g.faqId!, siteId: s.siteId },
        }))!.variants,
      ).toEqual([U]);
      await st.publicDb.assistSiteConversation.deleteMany({
        where: { siteId: s.siteId, visitorId: a },
      });
      expect(
        await st.rollup.processForgetJobs(50, { siteIds: [s.siteId] }),
      ).toBe(1);
      expect(
        (await st.prisma.assistSiteFaq.findFirst({
          where: { id: g.faqId!, siteId: s.siteId },
        }))!.variants,
      ).toEqual([]);
      expect(await st.clusters(s)).toHaveLength(0);

      await st.forget.enqueue(s.siteId, []);
      expect(
        await st.prisma.assistSiteForgetJob.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(1);
    });
  });
}
