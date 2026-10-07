/**
 * Приёмка Э3 (L): очередь обучения «Сайта» — ТЗ §4-тер.3, §4-тер.15 п.9,
 * №4; контракт Э3 §7 «4-тер.15 п.9–14». Реальный Postgres + pgvector,
 * сигналы — ПОД РОЛЬЮ assist_public (как пишет конвейер/👎), разбор —
 * крон assist-learn-rollup со `scope` своих сайтов.
 *
 *  1. п.9: три разных посетителя про самовывоз → один кластер с
 *     distinctVisitors = 3; 20 одинаковых вопросов одного suspicious —
 *     кластер не растят (размер растёт, посетители — нет).
 *  2. Сигнал: дедуп (messageId, kind); строка с живым контактом не пишется;
 *     без вектора — вектор досчитает крон из бюджета обучения (нет денег —
 *     ждёт), лог без текста вопроса.
 *  3. Переоткрытие: решённый кластер + новый unknown через ≥ 14 дней →
 *     снова в очереди (reopened); раньше 14 дней — нет.
 *  4. Решение: golden (варианты-цитаты → variantRefs с диалогом, кейс eval
 *     golden), out_of_scope (кейс «вне знаний» из диалога), ignore.
 *  5. №4 черновик: с источниками; без источников — пусто; бюджет — `budget`.
 *  6. Кандидат оператора (Р-33): только свой ответ, оператор видит только
 *     свои кандидаты; бот — дубль/чужой; автоматический operator_fix → по
 *     кнопке «предложен»; отклонить.
 *  7. LearningReadApi (для A): темы периода и факты сводки.
 */
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  DAY,
  LearnStack,
  RAW_URL,
  describeWithoutDb,
  type LSite,
} from '../../modules/assist-site-learning/testing/learning-stack.testing';

const PICKUP = 'Чи є самовивіз у Дніпрі?';

// Реальная база, индексация и конвейер: при параллельных наборах дольше 5 с.
jest.setTimeout(60_000);

if (!RAW_URL) {
  describeWithoutDb('очередь обучения (Э3, L)');
} else {
  describe('очередь обучения «Сайта» (Э3, L), реальный Postgres', () => {
    let st: LearnStack;
    const logs: string[] = [];

    beforeAll(async () => {
      st = await new LearnStack().init();
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest
          .spyOn(Logger.prototype, level)
          .mockImplementation((...args: unknown[]) => {
            logs.push(args.map(String).join(' '));
          });
      }
    });

    afterAll(async () => {
      jest.restoreAllMocks();
      await st.close();
    });

    beforeEach(() => {
      st.answers.mode = 'honest';
      st.answers.calls = [];
    });

    it('п.9: 3 разных посетителя → кластер distinctVisitors = 3; 20 от одного suspicious не растят', async () => {
      const s = await st.site();
      await st.ask(s, PICKUP, { pageUrl: `${s.origin}/dostavka?utm=x` });
      await st.ask(s, PICKUP, { pageUrl: `${s.origin}/kontakty` });
      await st.ask(s, 'Чи є самовивіз у Дніпрі сьогодні?');
      const bot = `v-bot-${randomUUID()}`;
      for (let i = 0; i < 20; i++) {
        await st.ask(s, PICKUP, { visitorId: bot, suspicious: true });
      }
      await st.ask(s, 'Скільки коштує доставка курʼєром у Львів?');

      const r = await st.rollupRun([s]);
      expect(r).toMatchObject({ sites: 1, clustered: 24 });
      const clusters = await st.clusters(s);
      expect(clusters).toHaveLength(2);
      const pickup = clusters.find((c) => c.size === 23)!;
      expect(pickup).toBeDefined();
      expect(pickup.distinctVisitors).toBe(3);
      expect(pickup.kind).toBe('unknown');
      expect(pickup.label).toBe(PICKUP);

      const q = await st.queue.list(s.manager, s.siteId, {
        kind: null,
        status: 'open',
      });
      const e = q.entries.find((x) => x.id === pickup.id);
      expect(e).toMatchObject({
        entry: 'cluster',
        distinctVisitors: 3,
        size: 23,
        status: 'open',
        reopened: false,
      });
      if (e?.entry !== 'cluster') throw new Error('не кластер');
      expect(e.examples.length).toBeLessThanOrEqual(5);
      expect(new Set(e.examples).size).toBe(e.examples.length);
      // Страницы — без query (§6.6).
      expect(e.pages.every((p) => !p.includes('?'))).toBe(true);
      expect(q.counts.unknown).toBe(2);

      // Повторный прогон — те же кластеры (детерминированно), ничего нового.
      const again = await st.rollupRun([s]);
      expect(again.clustered).toBe(0);
      expect(await st.clusters(s)).toHaveLength(2);
      expect(
        (await st.clusters(s)).find((c) => c.id === pickup.id),
      ).toMatchObject({ size: 23, distinctVisitors: 3 });
    });

    it('сигнал под ролью assist_public: дедуп (messageId, kind), контакт не пишется, лог без текста', async () => {
      const s = await st.site();
      const c = await st.conversation(s);
      const msg = await st.message(s, c.id, 'assistant', 'Не знаю');
      const base = {
        questionMasked: 'Де ваш склад?',
        conversationId: c.id,
        messageId: msg.id,
        visitorId: c.visitorId,
      };
      await st.signal(s, base);
      await st.signal(s, base);
      await st.signal(s, { ...base, kind: 'wrong', signal: 'thumbs_down' });
      const before = logs.length;
      await st.signal(s, {
        questionMasked: 'Передзвоніть на +380 67 123 45 67, Петро',
        messageId: randomUUID(),
      });
      await st.signal(s, {
        questionMasked: 'Мій e-mail petro@example.com',
        messageId: randomUUID(),
      });
      await st.signal(s, {
        questionMasked: 'Питання з відповіддю',
        answerMasked: 'Пишіть на shop@example.com',
        messageId: randomUUID(),
      });
      const items = await st.items(s);
      expect(items.map((i) => i.kind).sort()).toEqual(['unknown', 'wrong']);
      const tail = logs.slice(before).join('\n');
      expect(tail).toMatch(/question_contact/);
      expect(tail).toMatch(/answer_contact/);
      expect(tail).not.toMatch(/\+?380 67|380671|petro|example\.com|Петро/);
      // Неизвестный тип сигнала — не пишется.
      await st.signal(s, {
        questionMasked: 'x',
        signal: 'hack' as never,
        messageId: randomUUID(),
      });
      expect(await st.items(s)).toHaveLength(2);
    });

    it('без вектора: крон досчитывает из бюджета обучения (assist-embed); нет денег — элемент ждёт', async () => {
      const s = await st.site();
      await st.signal(s, {
        questionMasked: 'Чи можна оплатити частинами?',
        embedding: null,
      });
      await st.signal(s, {
        questionMasked: 'Чи можна оплатити частинами?',
        embedding: null,
      });
      const poor = await st.site();
      await st.exhaustBudget(poor);
      await st.signal(poor, {
        questionMasked: 'Чи є подарункові картки?',
        embedding: null,
      });

      await st.rollupRun([s, poor]);
      expect(await st.clusters(s)).toHaveLength(1);
      expect((await st.clusters(s))[0]).toMatchObject({
        size: 2,
        distinctVisitors: 2,
      });
      const usage = await st.prisma.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-embed' },
      });
      expect(usage).toHaveLength(1);
      expect(await st.clusters(poor)).toHaveLength(0);
      const [waiting] = await st.items(poor);
      expect(waiting.clusterId).toBeNull();
    });

    it('переоткрытие: решённый кластер + новый unknown через ≥ 14 дней → снова open; раньше — нет', async () => {
      const s = await st.site();
      await st.ask(s, 'Чи є доставка в Ужгород?', {
        createdAt: new Date(Date.now() - 30 * DAY),
      });
      await st.rollupRun([s]);
      const [c] = await st.clusters(s);
      await st.queue.resolve(s.manager, s.siteId, c.id, { action: 'source' });
      // Решили 20 дней назад (прошлое, своя строка — §9 п.6 (в)).
      await st.prisma.assistSiteLearningCluster.updateMany({
        where: { id: c.id, siteId: s.siteId },
        data: { resolvedAt: new Date(Date.now() - 20 * DAY) },
      });
      // Новый вопрос через 10 дней после решения — не повод.
      await st.ask(s, 'Чи є доставка в Ужгород?', {
        createdAt: new Date(Date.now() - 10 * DAY),
      });
      let r = await st.rollupRun([s]);
      expect(r.reopened).toBe(0);
      expect((await st.clusters(s))[0].status).toBe('resolved');
      // Сейчас (20 дней после решения) — переоткрыть.
      await st.ask(s, 'Чи є доставка в Ужгород?');
      r = await st.rollupRun([s]);
      expect(r.reopened).toBe(1);
      const [after] = await st.clusters(s);
      expect(after.status).toBe('open');
      expect(after.reopenedAt).not.toBeNull();
      const q = await st.queue.list(s.manager, s.siteId, {
        kind: null,
        status: 'open',
      });
      expect(q.entries.find((x) => x.id === c.id)).toMatchObject({
        reopened: true,
        size: 3,
      });
    });

    it('решение кластера: golden (цитаты → variantRefs, кейс golden), out_of_scope (кейс из диалога), ignore', async () => {
      const s = await st.site();
      const a = await st.ask(s, 'Чи працюєте ви у неділю?');
      await st.ask(s, 'Чи працюєте ви у неділю?');
      await st.ask(s, 'Яка погода у Києві завтра?');
      await st.ask(s, 'Котра година у Токіо?');
      await st.rollupRun([s]);
      const clusters = await st.clusters(s);
      const sunday = clusters.find((c) => c.label.includes('неділю'))!;
      const weather = clusters.find((c) => c.label.includes('погода'))!;
      const tokyo = clusters.find((c) => c.label.includes('Токіо'))!;

      const g = await st.queue.resolve(s.manager, s.siteId, sunday.id, {
        action: 'golden',
        question: 'Чи працюєте у неділю?',
        answer: 'Так, у неділю з 10:00 до 16:00.',
        variants: ['Чи працюєте ви у неділю?', 'Графік у вихідні'],
      });
      expect(g.status).toBe('resolved');
      const faq = await st.prisma.assistSiteFaq.findFirst({
        where: { id: g.faqId!, siteId: s.siteId },
      });
      expect(faq).toMatchObject({
        origin: 'gap',
        status: 'active',
        fromConversationId: a.conversationId,
        variants: ['Чи працюєте ви у неділю?', 'Графік у вихідні'],
      });
      const refs = faq!.variantRefs as Array<{
        variant: string;
        conversationId: string;
      }>;
      expect(refs).toHaveLength(2);
      expect(refs.every((r) => r.variant === 'Чи працюєте ви у неділю?')).toBe(
        true,
      );
      // В ответе есть числа — пересмотр через 30 дней, а не 180.
      const days = (faq!.reviewAt!.getTime() - Date.now()) / DAY;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
      const goldenCase = await st.prisma.assistSiteEvalCase.findFirst({
        where: { id: g.evalCaseId!, siteId: s.siteId },
      });
      expect(goldenCase).toMatchObject({
        kind: 'golden',
        faqId: g.faqId,
        expected: 'Так, у неділю з 10:00 до 16:00.',
        status: 'active',
      });
      expect(
        (await st.items(s))
          .filter((i) => i.clusterId === sunday.id)
          .every((i) => i.status === 'resolved' && i.faqId === g.faqId),
      ).toBe(true);

      const o = await st.queue.resolve(s.manager, s.siteId, weather.id, {
        action: 'out_of_scope',
      });
      const oos = await st.prisma.assistSiteEvalCase.findFirst({
        where: { id: o.evalCaseId!, siteId: s.siteId },
      });
      expect(oos).toMatchObject({
        kind: 'manual',
        expected: null,
        status: 'active',
      });
      expect(oos!.fromConversationId).not.toBeNull();

      const i = await st.queue.resolve(s.manager, s.siteId, tokyo.id, {
        action: 'ignore',
      });
      expect(i).toEqual({ status: 'ignored', faqId: null, evalCaseId: null });
      const open = await st.queue.list(s.manager, s.siteId, {
        kind: null,
        status: 'open',
      });
      expect(open.entries.filter((e) => e.entry === 'cluster')).toHaveLength(0);
      const done = await st.queue.list(s.manager, s.siteId, {
        kind: null,
        status: 'resolved',
      });
      expect(done.entries.map((e) => e.id).sort()).toEqual(
        [sunday.id, weather.id, tokyo.id].sort(),
      );

      // Неверное действие и чужой элемент.
      await expect(
        st.queue.resolve(s.manager, s.siteId, sunday.id, { action: 'accept' }),
      ).rejects.toMatchObject({ status: 400 });
      const other = await st.site();
      await expect(
        st.queue.resolve(other.manager, other.siteId, sunday.id, {
          action: 'ignore',
        }),
      ).rejects.toMatchObject({
        response: { code: 'LEARNING_ITEM_NOT_FOUND' },
      });
      // Вопрос с контактом посетителя — не проверенный ответ.
      await expect(
        st.queue.resolve(s.manager, s.siteId, weather.id, {
          action: 'golden',
          question: 'Наберіть [телефон скрыт]',
          answer: 'Так',
        }),
      ).rejects.toMatchObject({ response: { code: 'GOLDEN_INVALID' } });
    });

    it('№4 черновик: по знаниям с источником; без источников — пусто; нет бюджета — budget без модели', async () => {
      const s = await st.site();
      await st.pages(s, [
        {
          path: '/oplata',
          title: 'Оплата частинами',
          paragraphs: [
            'Оплата частинами доступна від 1000 грн через банк-партнер.',
          ],
        },
      ]);
      await st.ask(s, 'Чи можна оплата частинами?');
      await st.ask(s, 'Чи приймаєте біткоїн?');
      await st.rollupRun([s]);
      const clusters = await st.clusters(s);
      const pay = clusters.find((c) => c.label.includes('частинами'))!;
      const btc = clusters.find((c) => c.label.includes('біткоїн'))!;

      const d = await st.queue.draft(s.manager, s.siteId, pay.id);
      expect(d.status).toBe('ok');
      expect(d.text).toContain('1000 грн');
      expect(d.text).not.toMatch(/\[S\d\]/);
      expect(d.sources[0].url).toBe(`${s.origin}/oplata`);
      const learn = await st.prisma.siteAiUsage.findMany({
        where: { siteId: s.siteId, operation: 'assist-learn' },
      });
      expect(learn.length).toBe(1);

      const none = await st.queue.draft(s.manager, s.siteId, btc.id);
      expect(none).toMatchObject({
        status: 'no_sources',
        text: '',
        sources: [],
      });
      // Модель ответила, но без источника — черновика нет (не выдумывает).
      st.answers.mode = 'comply';
      const ungrounded = await st.queue.draft(s.manager, s.siteId, pay.id);
      expect(ungrounded).toMatchObject({ status: 'no_sources', text: '' });
      st.answers.mode = 'honest';

      await st.exhaustBudget(s);
      const calls = st.answers.calls.length;
      const b = await st.queue.draft(s.manager, s.siteId, pay.id);
      expect(b).toMatchObject({ status: 'budget', text: '' });
      expect(st.answers.calls.length).toBe(calls);
      await expect(
        st.queue.draft(s.operator, s.siteId, pay.id),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('кандидат оператора: свой ответ; оператор видит только свои; бот — дубль/чужой; авто → по кнопке; отклонить', async () => {
      const s = await st.site();
      const c = await st.conversation(s);
      await st.message(s, c.id, 'visitor', 'Чи доставляєте ви у Чернігів?');
      await st.message(s, c.id, 'assistant', 'Не знаю — уточніть у магазина.');
      const op1 = await st.message(
        s,
        c.id,
        'operator',
        'Так, доставляємо у Чернігів за 2 дні.',
        { authorMemberId: s.operator.memberId },
      );
      const op2 = await st.message(
        s,
        c.id,
        'operator',
        'Вам зробимо знижку 10%.',
        {
          authorMemberId: s.operator2.memberId,
        },
      );

      // Чужой ответ оператор не предлагает (§4-тер.13 «из своей передачи»).
      await expect(
        st.queue.propose(s.operator, s.siteId, { messageId: op2.id }),
      ).rejects.toMatchObject({ status: 403 });
      // Не сообщение оператора — CANDIDATE_INVALID.
      const visitorMsg = await st.message(s, c.id, 'visitor', 'дякую');
      await expect(
        st.queue.propose(s.operator, s.siteId, { messageId: visitorMsg.id }),
      ).rejects.toMatchObject({ response: { code: 'CANDIDATE_INVALID' } });

      const mine = await st.queue.propose(s.operator, s.siteId, {
        messageId: op1.id,
      });
      expect(mine).toMatchObject({
        entry: 'candidate',
        questionMasked: 'Чи доставляєте ви у Чернігів?',
        proposedAnswer: 'Так, доставляємо у Чернігів за 2 дні.',
        proposedByMe: true,
        status: 'proposed',
      });
      // Повтор — тот же элемент.
      const again = await st.queue.propose(s.operator, s.siteId, {
        messageId: op1.id,
      });
      expect(again.id).toBe(mine.id);

      // Бот: чужой оператор — forbidden, не участник — forbidden, второй раз — duplicate.
      expect(
        await st.candidates.proposeFromOperator({
          telegramId: s.operator2.telegramId,
          messageId: op1.id,
        }),
      ).toBe('forbidden');
      expect(
        await st.candidates.proposeFromOperator({
          telegramId: BigInt(42),
          messageId: op1.id,
        }),
      ).toBe('forbidden');
      expect(
        await st.candidates.proposeFromOperator({
          telegramId: s.operator.telegramId,
          messageId: op1.id,
        }),
      ).toBe('duplicate');
      expect(
        await st.candidates.proposeFromOperator({
          telegramId: s.operator.telegramId,
          messageId: 'нет-такого',
        }),
      ).toBe('not_found');

      // Автоматический operator_fix (закрытие передачи) → «предложен» кнопкой.
      await st.candidates.recordOperatorFix({
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: c.id,
        operatorMessageId: op2.id,
      });
      await st.candidates.recordOperatorFix({
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: c.id,
        operatorMessageId: op2.id,
      });
      const auto = (await st.items(s)).filter((i) => i.messageId === op2.id);
      expect(auto).toHaveLength(1);
      expect(auto[0]).toMatchObject({
        status: 'new',
        proposedByTelegramId: null,
        answerMasked: 'Не знаю — уточніть у магазина.',
      });

      // Оператор видит только свои кандидаты и не видит кластеров.
      await st.ask(s, 'Скільки коштує доставка?');
      await st.rollupRun([s]);
      const opView = await st.queue.list(s.operator, s.siteId, {
        kind: null,
        status: 'all',
      });
      expect(opView.entries.map((e) => e.id)).toEqual([mine.id]);
      const op2View = await st.queue.list(s.operator2, s.siteId, {
        kind: null,
        status: 'open',
      });
      expect(op2View.entries).toHaveLength(0);
      const mgr = await st.queue.list(s.manager, s.siteId, {
        kind: 'operator_fix',
        status: 'open',
      });
      expect(mgr.entries.map((e) => e.id).sort()).toEqual(
        [mine.id, auto[0].id].sort(),
      );
      expect(mgr.counts.candidates).toBe(2);

      expect(
        await st.candidates.proposeFromOperator({
          telegramId: s.manager.telegramId,
          messageId: op2.id,
        }),
      ).toBe('proposed');
      const upgraded = (await st.items(s)).find((i) => i.id === auto[0].id)!;
      expect(upgraded).toMatchObject({
        status: 'proposed',
        proposedByTelegramId: s.manager.telegramId,
      });

      // Оператор кандидата не решает (§4-тер.15 п.14); менеджер — отклоняет.
      await expect(
        st.queue.resolve(s.operator, s.siteId, mine.id, { action: 'accept' }),
      ).rejects.toMatchObject({ status: 403 });
      const rej = await st.queue.resolve(s.manager, s.siteId, auto[0].id, {
        action: 'reject',
      });
      expect(rej.status).toBe('ignored');
      await expect(
        st.queue.resolve(s.manager, s.siteId, auto[0].id, { action: 'accept' }),
      ).rejects.toMatchObject({ status: 409 });
      // Знаний не прибавилось: кандидат — не знание.
      expect(
        await st.prisma.assistSiteFaq.count({ where: { siteId: s.siteId } }),
      ).toBe(0);
    });

    it('ретенция удалила диалог: кластер пересчитан, подпись — из оставшихся вопросов, пустой — удалён', async () => {
      const s = await st.site();
      const first = await st.ask(s, 'Чи є доставка у Херсон?');
      await st.ask(s, 'Чи є доставка у Херсон сьогодні?');
      const lone = await st.ask(s, 'Скільки коштує подарункова упаковка?');
      await st.rollupRun([s]);
      const before = await st.clusters(s);
      expect(before).toHaveLength(2);
      const kherson = before.find((c) => c.size === 2)!;
      expect(kherson.label).toBe('Чи є доставка у Херсон?');
      // Ретенция (W3, основная роль) — удаление диалогов, каскад на очередь.
      await st.prisma.assistSiteConversation.deleteMany({
        where: {
          siteId: s.siteId,
          id: { in: [first.conversationId, lone.conversationId] },
        },
      });
      await st.rollupRun([s]);
      const after = await st.clusters(s);
      expect(after.map((c) => c.id)).toEqual([kherson.id]);
      expect(after[0]).toMatchObject({
        size: 1,
        distinctVisitors: 1,
        label: 'Чи є доставка у Херсон сьогодні?',
      });
    });

    it('LearningReadApi: темы периода и факты сводки (для A)', async () => {
      const s = await st.site();
      const old = new Date(Date.now() - 40 * DAY);
      await st.ask(s, 'Чи є доставка в Ужгород?', { createdAt: old });
      await st.ask(s, 'Чи є знижки для студентів?');
      await st.ask(s, 'Чи є знижки для студентів?');
      await st.rollupRun([s]);
      const since = new Date(Date.now() - 7 * DAY);
      const topics = await st.read.topics({
        accountId: s.accountId,
        siteId: s.siteId,
        from: since,
        to: new Date(Date.now() + 60_000),
        limit: 10,
      });
      expect(topics).toHaveLength(1);
      expect(topics[0]).toMatchObject({
        label: 'Чи є знижки для студентів?',
        size: 2,
        distinctVisitors: 2,
        status: 'open',
      });
      expect(topics[0].conversationIds).toHaveLength(2);
      const facts = await st.read.digestFacts({
        accountId: s.accountId,
        siteId: s.siteId,
        since,
      });
      expect(facts).toMatchObject({
        newClusters: 2,
        openClusters: 2,
        goldenNeedsReview: 0,
        candidates: 0,
        evalDeferred: false,
      });
      // Другой кабинет фактов этого сайта не видит.
      const other = await st.site();
      expect(
        await st.read.topics({
          accountId: other.accountId,
          siteId: s.siteId,
          from: since,
          to: new Date(Date.now() + 60_000),
          limit: 10,
        }),
      ).toEqual([]);
    });
  });
}

export type { LSite };
