/**
 * [AT-F01-01] Карта вопросов (P-B1, проектный документ §6.3, §18.1;
 * F01): десять вопросов с источниками → группы (вручную: AI-кластеризация
 * в P0 выключена, ДТ-2) → шесть тем, у каждой исходные фрагменты и
 * пояснение к каждой из четырёх оценок 0–2.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import type { QuestionView } from '../../modules/publisher/contracts/content-api';
import {
  Kit,
  contentStack,
  errOf,
  type ContentStack,
} from '../../modules/publisher/content/testing/content-kit.testing';
import {
  seedAccount,
  seedProduct,
} from '../../modules/publisher/testing/fixtures.testing';

jest.setTimeout(120_000);

ciDescribe(
  '[AT-F01-01] 10 вопросов с источниками → группы → 6 тем с фрагментами и пояснениями',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('ручная группировка и выбор шести тем; у каждой фрагменты и пояснения всех четырёх оценок', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const allowed = await k.source({ kind: 'customer_question' });
      const restricted = await k.source({
        usage: 'restricted',
        kind: 'discussion',
      });
      const qs: QuestionView[] = [];
      for (let i = 0; i < 10; i++) {
        qs.push(
          await k.question({
            text: `Питання ${i}: як обрати підрядника для контенту ${randomUUID().slice(0, 4)}`,
            sources: [
              {
                sourceId: i % 2 ? allowed.id : restricted.id,
                fragment: `Фрагмент ${i}`,
              },
            ],
          }),
        );
      }
      expect(
        qs.every((q) => q.sources.length === 1 && q.groupId === null),
      ).toBe(true);

      // Группы создаёт человек (AI-предложения нет — aiCallId null).
      const g1 = await k.group({
        key: `g1-${randomUUID().slice(0, 6)}`,
        task: 'Обрати агенцію',
        stage: 'consideration',
        rationale: 'Одна задача — вибір підрядника',
        questionIds: qs.slice(0, 5).map((q) => q.id),
      });
      const g2 = await k.group({
        key: `g2-${randomUUID().slice(0, 6)}`,
        task: 'Оцінити вартість',
        stage: 'decision',
        rationale: 'Питання про ціну та бюджет',
        questionIds: qs.slice(5).map((q) => q.id),
      });
      expect(g1).toMatchObject({ status: 'confirmed', aiCallId: null });
      expect(g1.questionIds).toHaveLength(5);
      expect(g2.questionIds).toHaveLength(5);

      // Выбор: без пояснения у одной из оценок — отказ с полем.
      const fresh = await k.tx((tx) =>
        tx.pubQuestion.findUniqueOrThrow({ where: { id: qs[1].id } }),
      );
      const noWhy = await errOf(
        k.op('question.manage', (tx, st) =>
          k.questions.patch(
            tx,
            k.p,
            qs[1].id,
            {
              expectedRevision: fresh.revision,
              scores: {
                offer_fit: { score: 2, why: 'Прямо про оффер' },
                confirmed_task: { score: 2, why: 'Питали 4 клієнти' },
                own_answer: { score: 1, why: 'Є власний кейс' },
                cost: { score: 1 },
              },
              status: 'selected',
              selectedRank: 1,
            },
            st.actor,
          ),
        ),
      );
      expect(noWhy.code).toBe('PUB_VALIDATION');
      expect(noWhy.details.fields).toEqual([
        { field: 'scores.cost.why', code: 'required' },
      ]);

      // Шесть тем — у каждой разрешённый источник с фрагментом и 4 пояснения.
      const selected: QuestionView[] = [];
      for (let i = 0; i < 6; i++) {
        const cur = await k.tx((tx) =>
          tx.pubQuestion.findUniqueOrThrow({ where: { id: qs[i].id } }),
        );
        selected.push(
          await k.selectQuestion(
            { ...qs[i], revision: cur.revision },
            i + 1,
            allowed.id,
          ),
        );
      }
      for (const q of selected) {
        expect(q.status).toBe('selected');
        expect(q.sources).toEqual([
          { sourceId: allowed.id, fragment: 'Фрагмент запитання' },
        ]);
        for (const key of [
          'offer_fit',
          'confirmed_task',
          'own_answer',
          'cost',
        ] as const) {
          expect(q.scores[key]?.why).toEqual(expect.any(String));
          expect([0, 1, 2]).toContain(q.scores[key]?.score);
        }
      }
      expect(selected.map((q) => q.selectedRank).sort()).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);

      // Седьмая тема и занятый ранг — отказ.
      const cur7 = await k.tx((tx) =>
        tx.pubQuestion.findUniqueOrThrow({ where: { id: qs[6].id } }),
      );
      expect(
        (
          await errOf(
            k.selectQuestion(
              { ...qs[6], revision: cur7.revision },
              7,
              allowed.id,
            ),
          )
        ).code,
      ).toBe('PUB_VALIDATION');
      const r6 = await errOf(
        k.selectQuestion({ ...qs[6], revision: cur7.revision }, 6, allowed.id),
      );
      expect(r6).toMatchObject({
        code: 'PUB_CONFLICT',
        details: { reason: 'rank_taken' },
      });

      // Только ограниченный источник — тема не выбирается (нужен allowed).
      const qr = await k.question({
        text: 'Тільки обмежене джерело',
        sources: [{ sourceId: restricted.id }],
      });
      const why = { score: 1, why: 'пояснення' };
      const onlyRestricted = await errOf(
        k.op('question.manage', (tx, st) =>
          k.questions.patch(
            tx,
            k.p,
            qr.id,
            {
              expectedRevision: qr.revision,
              scores: {
                offer_fit: why,
                confirmed_task: why,
                own_answer: why,
                cost: why,
              },
              status: 'selected',
              selectedRank: 6,
            },
            st.actor,
          ),
        ),
      );
      expect(onlyRestricted.details.fields).toEqual([
        { field: 'sources.allowed', code: 'required' },
      ]);
    });
  },
);
