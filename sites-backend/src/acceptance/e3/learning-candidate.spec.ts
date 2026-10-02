/**
 * Приёмка Э3 п.4 (план Этапа 3) и ТЗ §4-тер.15 п.10 — L (+H): «ручная
 * правка из диалога меняет следующий ответ на тот же вопрос: правка
 * менеджера — сразу; ответ оператора — только после принятия кандидата».
 *
 * Сквозной путь на реальном Postgres: знания «Сайта» строит настоящий
 * индексатор Э1 (обход → версия), проверенный ответ публикует
 * ModeKnowledgeCore (новая версия знаний), а спрашивает НАСТОЯЩИЙ конвейер
 * виджета SiteChatService под ролью assist_public (ChatStack W3: модель и
 * эмбеддинги — подделки, прямой путь FAQ — настоящий §4.5 п.1).
 *
 *  1. Оператор ответил в передаче и предложил ответ кандидатом → версия
 *     знаний та же, следующий ответ посетителю — НЕ ответ оператора.
 *  2. Менеджер принял кандидата → новая версия; тот же вопрос → ответ
 *     прямым путём из проверенного ответа (answerPath = faq), текст —
 *     принятый ответ; trace-источник — FAQ (faqId).
 *  3. Правка менеджера (POST golden) — следующий ответ сразу.
 */
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  ChatStack,
  type ChatSite,
} from '../../modules/assist-site-chat/testing/chat-stack.testing';
import {
  LearnStack,
  RAW_URL,
  describeWithoutDb,
  type LSite,
} from '../../modules/assist-site-learning/testing/learning-stack.testing';

const Q = 'Чи доставляєте ви у Чернігів?';
const OPERATOR_ANSWER = 'Так, у Чернігів доставляємо курʼєром за 2 дні.';

// Реальная база, индексация и конвейер: при параллельных наборах дольше 5 с.
jest.setTimeout(60_000);

if (!RAW_URL) {
  describeWithoutDb('кандидат оператора → ответ помощника (Э3 п.4, L)');
} else {
  describe('правка из диалога меняет следующий ответ (Э3 п.4, §4-тер.15 п.10), реальный Postgres', () => {
    let st: LearnStack;
    let chat: ChatStack;

    beforeAll(async () => {
      Logger.overrideLogger(false);
      st = await new LearnStack().init();
      chat = await new ChatStack().init();
    });

    afterAll(async () => {
      await chat.close();
      await st.close();
    });

    /** Сайт стенда L глазами конвейера виджета (опубликованная версия — текущая). */
    async function asChatSite(s: LSite): Promise<ChatSite> {
      const v = await st.version(s);
      return {
        accountId: s.accountId,
        siteId: s.siteId,
        host: new URL(s.origin).host,
        origin: s.origin,
        ownerTelegramId: s.owner.telegramId,
        url: (path) => `${s.origin}${path}`,
        ctx: (over = {}) => ({
          accountId: s.accountId,
          siteId: s.siteId,
          knowledgeVersion: v,
          configVersion: 0,
          widgetVersion: 1,
          parentOrigin: s.origin,
          keyKind: 'live',
          preview: false,
          ...over,
        }),
      };
    }

    async function askWidget(s: LSite, question: string) {
      const cs = await asChatSite(s);
      const c = await chat.ask(cs, question, {
        clientRequestId: randomUUID(),
      });
      expect(c.done).toBe(true);
      const msg = await st.prisma.assistSiteMessage.findFirst({
        where: { id: c.meta!.messageId, siteId: s.siteId },
        select: { answerPath: true, text: true },
      });
      return { text: c.text, path: msg?.answerPath ?? null };
    }

    async function shop(): Promise<LSite> {
      const s = await st.site();
      await st.pages(s, [
        {
          path: '/dostavka',
          title: 'Доставка',
          paragraphs: [
            'Доставляємо Новою Поштою по всій Україні, термін доставки 1–3 дні.',
          ],
        },
      ]);
      return s;
    }

    it('ответ оператора — только после принятия кандидата; после — следующий ответ из проверенного', async () => {
      const s = await shop();
      const v0 = await st.version(s);

      // Передача: посетитель спросил, модель не знала, оператор ответил.
      const conv = await st.conversation(s);
      await st.message(s, conv.id, 'visitor', Q);
      await st.message(
        s,
        conv.id,
        'assistant',
        'Не знаю — уточніть у магазина.',
      );
      const op = await st.message(s, conv.id, 'operator', OPERATOR_ANSWER, {
        authorMemberId: s.operator.memberId,
      });
      // Кнопка «Предложить как проверенный ответ» (бот H → L).
      expect(
        await st.candidates.proposeFromOperator({
          telegramId: s.operator.telegramId,
          messageId: op.id,
        }),
      ).toBe('proposed');

      // Кандидат — не знание: версия та же, ответ помощника — не оператора.
      expect(await st.version(s)).toBe(v0);
      expect(
        await st.prisma.assistSiteFaq.count({ where: { siteId: s.siteId } }),
      ).toBe(0);
      const before = await askWidget(s, Q);
      expect(before.path).not.toBe('faq');
      expect(before.text).not.toContain('курʼєром за 2 дні');

      // Менеджер принимает кандидата → новая версия знаний.
      const q = await st.queue.list(s.manager, s.siteId, {
        kind: 'operator_fix',
        status: 'open',
      });
      expect(q.entries).toHaveLength(1);
      const res = await st.queue.resolve(s.manager, s.siteId, q.entries[0].id, {
        action: 'accept',
      });
      expect(res.status).toBe('resolved');
      expect(await st.version(s)).toBeGreaterThan(v0);
      const faq = await st.prisma.assistSiteFaq.findFirst({
        where: { id: res.faqId!, siteId: s.siteId },
      });
      expect(faq).toMatchObject({
        origin: 'operator_candidate',
        question: Q,
        answer: OPERATOR_ANSWER,
        status: 'active',
        fromConversationId: conv.id,
      });

      const after = await askWidget(s, Q);
      expect(after.path).toBe('faq');
      expect(after.text).toBe(OPERATOR_ANSWER);
    });

    it('правка менеджера (проверенный ответ из кабинета) — следующий ответ сразу', async () => {
      const s = await shop();
      const Q2 = 'Чи приймаєте ви картки Visa?';
      const before = await askWidget(s, Q2);
      expect(before.path).not.toBe('faq');

      await st.golden.create(s.manager, s.siteId, {
        question: Q2,
        answer: 'Так, приймаємо Visa і Mastercard без комісії.',
        lang: 'uk',
      });
      const after = await askWidget(s, Q2);
      expect(after.path).toBe('faq');
      expect(after.text).toBe('Так, приймаємо Visa і Mastercard без комісії.');

      // Оператор опубликовать сам не может (§4-тер.15 п.14).
      await expect(
        st.golden.create(s.operator, s.siteId, {
          question: 'Чи є самовивіз?',
          answer: 'Так',
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
}
