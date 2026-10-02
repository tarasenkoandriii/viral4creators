/**
 * Приёмка Э3 (L): качество, прогоны eval и симуляция — ТЗ §4-тер.8,
 * §4-тер.11, §4-тер.13, §4-тер.15 п.13, №31 (контракт Э3 решение 22).
 * Реальный Postgres; знания — индексатор Э1; ответчик — подделка
 * AnswerEngine (отвечает по фрагменту с общей основой слова, иначе отказ).
 *
 *  1. п.13: бюджет обучения исчерпан → плановый eval отложен (строка
 *     «отложено», одно уведомление владельцу и менеджеру за период, без
 *     оператора); ворота версии и исключения при этом работают; ручной
 *     прогон и симуляция — `deferred` без вызова модели.
 *  2. Ручной прогон: кейсы сайта (golden, «вне знаний», заведомо
 *     проваленный) + 10 инвариантов → passed/failed/stale, отчёт с
 *     провалами, расход `assist-eval` в бюджете обучения; «Качество».
 *  3. №31: 10 персонажей × 3 вопроса в бюджете обучения, без записи в
 *     диалоги посетителей; провокация, которой «поддался», — в issues.
 */
import { Logger } from '@nestjs/common';
import { INVARIANT_CASES } from '../../modules/assist-knowledge-core/eval/invariant-cases';
import {
  LearnStack,
  RAW_URL,
  describeWithoutDb,
  type LSite,
} from '../../modules/assist-site-learning/testing/learning-stack.testing';
import type { PageSpec } from '../e1/k2-fixtures';

const PAGES: PageSpec[] = [
  {
    path: '/dostavka',
    title: 'Доставка',
    paragraphs: [
      'Доставка Новою Поштою по Україні, вартість доставки 70 грн, термін 1–3 дні.',
    ],
  },
  {
    path: '/oplata',
    title: 'Оплата',
    paragraphs: ['Оплата карткою Visa або Mastercard, накладений платіж.'],
  },
];

// Реальная база, индексация и конвейер: при параллельных наборах дольше 5 с.
jest.setTimeout(60_000);

if (!RAW_URL) {
  describeWithoutDb('качество и eval обучения (Э3, L)');
} else {
  describe('качество, eval и симуляция (Э3, L), реальный Postgres', () => {
    let st: LearnStack;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      st = await new LearnStack().init();
    });

    afterAll(async () => {
      await st.close();
    });

    beforeEach(() => {
      st.answers.mode = 'honest';
      st.answers.calls = [];
      st.sent.length = 0;
    });

    async function shop(): Promise<LSite> {
      const s = await st.site();
      await st.pages(s, PAGES);
      return s;
    }

    it('п.13: бюджет исчерпан → плановый eval отложен с уведомлением (одним), ворота и исключения работают', async () => {
      const s = await shop();
      await st.golden.create(s.manager, s.siteId, {
        question: 'Скільки коштує доставка?',
        answer: 'Доставка коштує 70 грн.',
      });
      await st.exhaustBudget(s);
      const calls = st.answers.calls.length;

      const r = await st.rollupRun([s]);
      expect(r).toMatchObject({ evalRuns: 0, evalDeferred: 1 });
      expect(st.answers.calls.length).toBe(calls);
      const runs = await st.prisma.assistSiteEvalRun.findMany({
        where: { siteId: s.siteId },
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ kind: 'scheduled', model: '' });
      expect(runs[0].report).toMatchObject({
        deferred: true,
        reason: 'budget',
      });
      // Уведомление — владельцу и менеджеру, не оператору; без секретов.
      expect(st.sent.map((x) => x.body.chat_id).sort()).toEqual(
        [s.owner.telegramId.toString(), s.manager.telegramId.toString()].sort(),
      );
      expect(st.sent[0].body.text).toMatch(/отложена.*бюджет обучения/s);
      expect(st.sent[0].url).not.toContain('l-bot-token/sendMessage?');

      // Тот же день — крон не множит «отложено»; второй отказ за период — без сообщения.
      expect((await st.rollupRun([s])).evalDeferred).toBe(0);
      expect(await st.quality.runEval(null, s.siteId, 'scheduled')).toEqual({
        status: 'deferred',
        reason: 'budget',
      });
      expect(st.sent).toHaveLength(2);
      expect(
        (
          await st.read.digestFacts({
            accountId: s.accountId,
            siteId: s.siteId,
            since: new Date(Date.now() - 60_000),
          })
        ).evalDeferred,
      ).toBe(true);

      // Ручной прогон и симуляция — тоже отложены, без модели.
      expect(await st.quality.runEval(s.manager, s.siteId, 'manual')).toEqual({
        status: 'deferred',
        reason: 'budget',
      });
      expect(await st.quality.simulate(s.manager, s.siteId)).toEqual({
        status: 'deferred',
        reason: 'budget',
        personas: [],
      });
      expect(st.answers.calls.length).toBe(calls);

      // Исключение (§4-тер.12) и публикация человеком — не ждут денег.
      const v = await st.version(s);
      const ex = await st.golden.core.createExclusion(s.manager, s.siteId, {
        kind: 'url',
        value: `${s.origin}/oplata`,
      });
      expect(ex.chunksDeleted).toBeGreaterThan(0);
      expect(await st.version(s)).toBeGreaterThan(v);
      // Ворота версии (код) работают: переобход «горячей» страницы (её
      // эмбеддинги идут и без бюджета, §4-тер.11) публикует версию.
      await st.prisma.assistSite.updateMany({
        where: { siteId: s.siteId },
        data: { hotPages: [`${s.origin}/dostavka`] },
      });
      const v2 = await st.pages(s, [
        {
          path: '/dostavka',
          title: 'Доставка',
          paragraphs: ['Доставка Новою Поштою, вартість доставки 80 грн.'],
        },
      ]);
      expect(v2).toBeGreaterThan(v);
      const gate = await st.prisma.assistSiteKnowledgeVersion.findFirst({
        where: { siteId: s.siteId, number: v2 },
      });
      expect(gate?.status).toBe('published');
    });

    it('ручной прогон: golden + «вне знаний» + провал + 10 инвариантов; отчёт и «Качество»', async () => {
      const s = await shop();
      const g = await st.golden.create(s.manager, s.siteId, {
        question: 'Скільки коштує доставка?',
        answer: 'Доставка коштує 70 грн.',
      });
      await st.ask(s, 'Яка погода буде завтра?');
      await st.rollupRun([s]);
      // Плановый прогон уже прошёл ночью (сайт включён, база есть).
      const scheduled = await st.prisma.assistSiteEvalRun.findMany({
        where: { siteId: s.siteId, kind: 'scheduled' },
      });
      expect(scheduled).toHaveLength(1);
      const [weather] = await st.clusters(s);
      await st.queue.resolve(s.manager, s.siteId, weather.id, {
        action: 'out_of_scope',
      });
      await st.prisma.assistSiteEvalCase.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'manual',
          question: 'Чи є кредит без переплат?',
          expected: 'Так, 0% на 4 місяці.',
          mustCite: [],
          mustNotSay: [],
          lang: 'uk',
        },
      });
      await st.prisma.assistSiteEvalCase.create({
        data: {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'source',
          question: 'Стара ціна',
          expected: '60 грн',
          mustCite: [],
          mustNotSay: [],
          status: 'stale',
        },
      });
      const before = await st.budget.status(s.accountId, s.siteId);

      const r = await st.quality.runEval(s.manager, s.siteId, 'manual');
      if (r.status !== 'done') throw new Error('прогон отложен');
      expect(r).toMatchObject({
        passed: 2 + INVARIANT_CASES.length,
        failed: 1,
        stale: 1,
      });
      const usage = await st.prisma.siteAiUsage.count({
        where: { siteId: s.siteId, operation: 'assist-eval' },
      });
      expect(usage).toBeGreaterThanOrEqual(3 + INVARIANT_CASES.length);
      const after = await st.budget.status(s.accountId, s.siteId);
      expect(after.spentMicroUsd).toBeGreaterThan(before.spentMicroUsd);

      const q = await st.quality.quality(s.manager, s.siteId);
      expect(q.lastEval).toMatchObject({
        id: r.runId,
        kind: 'manual',
        passed: r.passed,
        failed: 1,
        stale: 1,
      });
      expect(q.lastEval!.failures).toEqual([
        expect.objectContaining({
          question: 'Чи є кредит без переплат?',
          reason: 'отказ вместо ответа',
        }),
      ]);
      expect(q.weekly).toHaveLength(8);
      const thisWeek = q.weekly[7];
      expect(thisWeek.dialogs).toBe(1);
      expect(thisWeek.unknownShare).toBe(1);
      expect(thisWeek.thumbsUpShare).toBeNull();
      expect(q.completeness.total).toBeGreaterThan(0);
      expect(q.learningBudget.spentMicroUsd).toBe(after.spentMicroUsd);
      expect(new Date(q.nextScheduledEvalAt!).getTime()).toBeGreaterThan(
        Date.now() + 29 * 24 * 3600_000,
      );
      expect(q.goldenNeedsReview).toBe(0);
      void g;

      // Провальный ответ «поддался» — в отчёте.
      st.answers.mode = 'comply';
      const bad = await st.quality.runEval(s.manager, s.siteId, 'manual');
      if (bad.status !== 'done') throw new Error('прогон отложен');
      // Все 10 инвариантов + «вне знаний» (ответил вместо отказа); golden и
      // «кредит» — «ответил» (подделка без источников, mustCite нет).
      expect(bad.failed).toBe(INVARIANT_CASES.length + 1);
      const q2 = await st.quality.quality(s.manager, s.siteId);
      expect(q2.lastEval!.failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            question: weather.label,
            reason: 'нет честного отказа (вопрос вне знаний)',
          }),
        ]),
      );
      await expect(
        st.quality.runEval(s.operator, s.siteId, 'manual'),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('№31: 10 персонажей × 3 вопроса в бюджете обучения, без записи в диалоги; «поддался» — в issues', async () => {
      const s = await shop();
      const sim = await st.quality.simulate(s.manager, s.siteId);
      expect(sim.status).toBe('done');
      expect(sim.personas).toHaveLength(10);
      expect(sim.personas.every((p) => p.turns.length === 3)).toBe(true);
      const newcomer = sim.personas.find((p) => p.key === 'newcomer')!;
      expect(newcomer.title).toBe('Новий покупець');
      const delivery = newcomer.turns.find((t) =>
        t.question.includes('доставка'),
      )!;
      expect(delivery.refused).toBe(false);
      expect(delivery.sources[0].url).toBe(`${s.origin}/dostavka`);
      expect(delivery.answer).not.toMatch(/\[S\d\]/);
      const offtopic = sim.personas.find((p) => p.key === 'offtopic')!;
      expect(offtopic.issues).toEqual([]);
      expect(
        await st.prisma.siteAiUsage.count({
          where: { siteId: s.siteId, operation: 'assist-eval' },
        }),
      ).toBe(30);
      expect(
        await st.prisma.assistSiteConversation.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);
      expect(
        await st.prisma.assistSiteMessage.count({
          where: { siteId: s.siteId },
        }),
      ).toBe(0);

      st.answers.mode = 'comply';
      const evil = await st.quality.simulate(s.manager, s.siteId);
      const prov = evil.personas.find((p) => p.key === 'provocateur')!;
      expect(prov.issues.some((i) => /поддался/.test(i))).toBe(true);
      expect(prov.issues.some((i) => /без источника/.test(i))).toBe(true);
      await expect(
        st.quality.simulate(s.operator, s.siteId),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
}
