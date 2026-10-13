/**
 * [AT-F03-01] Готовый бриф (P-B1, проектный документ §6.3 `pub_briefs`;
 * F03): по выбранному вопросу — бриф с собственным вкладом, разрешённым
 * источником и CTA с пояснением уместности; вручную или через
 * `pub.brief.draft` на фейке — предложение AI принимает человек мутацией со
 * ссылкой `aiCallId` (AI сам ничего не пишет).
 */
import { ciDescribe } from '../../prisma/ci-describe.testing';
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
  '[AT-F03-01] готовый бриф: вклад, источник, CTA с пояснением уместности',
  () => {
    let s: ContentStack;
    beforeAll(async () => {
      s = await contentStack();
    });
    afterAll(async () => {
      await s.close();
    });

    it('вручную: связи question_id, offer_version, source_ids; ready', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      const offer = await k.offer();
      const src = await k.source();
      const q = await k.selectQuestion(await k.question(), 1, src.id);
      const b = await k.brief({
        questionId: q.id,
        goal: 'Допомогти обрати формат співпраці',
        format: 'choice_guide',
        ownContribution: 'Порівняння 3 моделей на даних пілоту',
        shortAnswer: 'Залежить від обсягу',
        cta: 'Обговорити задачу',
        ctaIntentNote:
          'Читач уже порівнює варіанти; пропозиція розмови доречна після відповіді',
        structure: ['Коротка відповідь', 'Порівняння', 'Приклад'],
        channels: ['site', 'telegram'],
        readinessCriteria: ['Є власний приклад'],
        sourceIds: [src.id],
      });
      expect(b).toMatchObject({
        status: 'draft',
        questionId: q.id,
        offerVersionId: offer.id,
        sourceIds: [src.id],
        missing: [],
      });
      const ready = await k.briefReady(b);
      expect(ready.status).toBe('ready');
      const audit = await s.prisma.pubAuditEvent.findMany({
        where: { productId: p.id, objectType: 'brief', objectId: b.id },
      });
      expect(audit.map((x) => `${x.action}:${x.toStatus}`).sort()).toEqual([
        'create:draft',
        'transition:ready',
      ]);
    });

    it('через pub.brief.draft на фейке: человек принимает предложение (aiCallId); чужой генератор и незавершённый вызов — отказ', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      await k.offer();
      const src = await k.source();
      const q = await k.selectQuestion(await k.question(), 1, src.id);
      const proposal = {
        question: q.text,
        audience: null,
        source_ids: [src.id],
        original_contribution: 'Дані пілоту',
        short_answer: 'Коротко',
        structure: ['Відповідь'],
        format: 'instruction',
        cta: { text: 'Обговорити задачу', intent_fit_note: 'Після відповіді' },
        channels: ['site'],
        limitations: [],
        unresolved_questions: [],
      };
      const callId = await k.aiCall(
        'pub.brief.draft',
        proposal,
        'question',
        q.id,
      );
      // До решения человека — ни одного брифа.
      expect(
        await s.prisma.pubBrief.count({ where: { productId: p.id } }),
      ).toBe(0);
      const b = await k.brief({
        questionId: q.id,
        goal: 'Відповісти на питання',
        format: proposal.format,
        ownContribution: proposal.original_contribution,
        cta: proposal.cta.text,
        ctaIntentNote: proposal.cta.intent_fit_note,
        sourceIds: proposal.source_ids,
        aiCallId: callId,
      });
      expect(b.aiCallId).toBe(callId);
      expect((await k.briefReady(b)).status).toBe('ready');
      const wrong = await k.aiCall('pub.helper.answer', { answer: 'x' });
      const r1 = await errOf(
        k.brief({
          questionId: q.id,
          goal: 'x',
          format: 'instruction',
          aiCallId: wrong,
        }),
      );
      expect(r1.details.fields).toEqual([
        { field: 'aiCallId', code: 'ai_call' },
      ]);
      const failed = await k.aiCall(
        'pub.brief.draft',
        null,
        'question',
        `${q.id}-2`,
        'schema_invalid',
      );
      const r2 = await errOf(
        k.brief({
          questionId: q.id,
          goal: 'x',
          format: 'instruction',
          aiCallId: failed,
        }),
      );
      expect(r2.details.fields).toEqual([
        { field: 'aiCallId', code: 'ai_call' },
      ]);
    });

    it('бриф только по выбранной теме', async () => {
      const acc = await seedAccount(s.prisma);
      const p = await seedProduct(s.prisma, {
        accountId: acc.accountId,
        kind: 'test',
      });
      const k = new Kit(s, acc, p);
      await k.offer();
      const q = await k.question();
      const r = await errOf(
        k.brief({ questionId: q.id, goal: 'x', format: 'instruction' }),
      );
      expect(r.details.fields).toEqual([
        { field: 'questionId', code: 'question_not_selected' },
      ]);
    });
  },
);
