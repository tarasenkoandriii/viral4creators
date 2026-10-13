/**
 * [AT-F01-02] Частотность неизвестна и разные задачи не склеиваются
 * (P-B1, проектный документ §6.3, §18.1; F01): без измерения частотность
 * `NULL` и подпись «невідомо» (не ноль; без источника измерения значение не
 * принимается); два вопроса с общими словами и разными задачами система не
 * объединяет сама — только решением человека, перенос из другой группы —
 * явным флагом.
 */
import { randomUUID } from 'crypto';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import { FREQUENCY_UNKNOWN_LABEL } from '../../modules/publisher/contracts/content-api';
import { sameWordsPairs } from '../../modules/publisher/content/rules';
import { loadGroup } from '../../modules/publisher/content/views';
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

describe('[AT-F01-02] unit: общие слова — подсказка исследователю, а не склейка', () => {
  it('пары с общими словами находятся; вопросы без общих слов — нет', () => {
    const qs = [
      { id: 'a', text: 'Скільки коштує контент для сайту агенції' },
      { id: 'b', text: 'Скільки коштує контент для сайту самостійно' },
      { id: 'c', text: 'Як виміряти заявки з публікацій' },
    ];
    expect(sameWordsPairs(qs)).toEqual([['a', 'b']]);
    expect(FREQUENCY_UNKNOWN_LABEL).toBe('невідомо');
  });
});

ciDescribe(
  '[AT-F01-02] частотность неизвестна, разные задачи не склеены автоматически',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('без частотности — NULL и «невідомо»; частотность без источника — отказ; с источником — сохраняется', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const q = await k.question({
        text: 'Скільки коштує контент для сайту агенції',
      });
      expect(q.frequency).toBeNull();
      expect(q.frequencySourceId).toBeNull();
      expect(q.frequencyLabel).toBe('невідомо');
      expect(q.observedRepeats).toBeNull();
      const bad = await errOf(k.question({ text: 'x', frequency: 120 }));
      expect(bad).toMatchObject({
        code: 'PUB_VALIDATION',
        details: { fields: [{ field: 'frequency', code: 'requires_source' }] },
      });
      const measure = await k.source({
        kind: 'search_data',
        title: 'Звіт пошукових даних',
      });
      const withSrc = await k.question({
        text: 'y',
        frequency: 120,
        frequencySourceId: measure.id,
      });
      expect(withSrc).toMatchObject({ frequency: 120, frequencyLabel: '120' });
    });

    it('два вопроса с одинаковыми словами и разными задачами: система не склеивает; перенос из другой группы — только явным решением', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const a = await k.question({
        text: 'Скільки коштує контент для сайту агенції',
      });
      const b = await k.question({
        text: 'Скільки коштує контент для сайту самостійно',
      });
      expect(a.groupId).toBeNull();
      expect(b.groupId).toBeNull();
      const ga = await k.group({
        key: `agency-${randomUUID().slice(0, 6)}`,
        task: 'Купити послугу агенції',
        stage: 'decision',
        rationale: 'Вибір підрядника',
        questionIds: [a.id],
      });
      const gb = await k.group({
        key: `diy-${randomUUID().slice(0, 6)}`,
        task: 'Зробити самостійно',
        stage: 'consideration',
        rationale: 'Самостійна підготовка',
        questionIds: [b.id],
      });
      // Склеить b в группу задачи a без явного решения — нельзя.
      const merge = await errOf(
        k.group({
          key: `merged-${randomUUID().slice(0, 6)}`,
          task: 'Вартість контенту',
          stage: 'decision',
          rationale: 'Спільні слова',
          questionIds: [a.id, b.id],
        }),
      );
      expect(merge).toMatchObject({
        code: 'PUB_CONFLICT',
        details: {
          reason: 'question_in_other_group',
          questionIds: [a.id, b.id].sort(),
        },
      });
      const rows = await k.tx((tx) =>
        tx.pubQuestion.findMany({
          where: { id: { in: [a.id, b.id] } },
          select: { id: true, groupId: true },
        }),
      );
      expect(Object.fromEntries(rows.map((r) => [r.id, r.groupId]))).toEqual({
        [a.id]: ga.id,
        [b.id]: gb.id,
      });

      // Разделение группы человеком — вопросы выходят из неё.
      const split = await k.op(
        'question.manage',
        (tx) =>
          k.questions.patchGroup(tx, k.p, ga.id, {
            expectedRevision: ga.revision,
            status: 'split',
          }),
        { noStore: (tx) => loadGroup(tx, k.p.id, ga.id) },
      );
      expect(split).toMatchObject({ status: 'split', questionIds: [] });
    });
  },
);
