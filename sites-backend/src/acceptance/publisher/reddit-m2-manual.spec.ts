/**
 * [AT-RD-10] P-R M2 — LLM недоступна или выключена → ручной редактор
 * (reddit-manual-mvp-adapted.md §M2.3, §M2.7, §9; Р-RD-15, Р-RD-56):
 *  - флаг `PUBLISHER_REDDIT_AI_ENABLED` выключен → 409 `PUB_AI_DISABLED
 *    {manual:true}` без записи вызова;
 *  - флаг включён, генератор выключен в коде до eval 2.3 → `disabled`
 *    в журнале, 409 `{manual:true}`, модель не вызывается;
 *  - гейт `ai_use` закрыт → 409 `PUB_GATE_CLOSED {gate:'ai_use'}`;
 *  - тайм-аут модели (fake) → 503 `PUB_AI_UNAVAILABLE {callId}`, вызов в
 *    журнале, черновик не тронут, версии нет;
 *  во всех случаях версия создаётся вручную и проходит до согласования.
 */
import { PUBLISHER_REDDIT_AI_ENABLED_ENV } from '../../config/publisher-env';
import { TextModelError } from '../../modules/site-ai/text-model';
import { ciDescribe } from '../../prisma/ci-describe.testing';
import {
  api,
  approvedVersion,
  contentPath,
  draftVersion,
  ok,
  redditAi,
  redditStack,
  redditWorld,
  seedStudio,
  submitVersion,
  type Api,
  type RedditStack,
  type RedditWorld,
  type StudioIds,
} from '../../modules/publisher/reddit/testing/reddit-kit.testing';

jest.setTimeout(240_000);

ciDescribe(
  '[AT-RD-10] P-R M2: LLM недоступна или выключена → ручной редактор',
  () => {
    let s: RedditStack;
    const saved = process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
    beforeAll(async () => {
      s = await redditStack();
    });
    afterAll(async () => {
      if (saved === undefined)
        delete process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
      else process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = saved;
      await s?.close();
    });

    async function world(): Promise<{
      w: RedditWorld;
      ed: Api;
      po: Api;
      ids: StudioIds;
    }> {
      const w = await redditWorld(s);
      const ed = api(s, w.acc.accountId, w.team.editor);
      const po = api(s, w.acc.accountId, w.team.product_owner);
      const ids = await seedStudio(s, w, ed, po);
      return { w, ed, po, ids };
    }

    const calls = (productId: string) =>
      s.prisma.pubAiCall.count({ where: { productId } });

    it('флаг выключен → 409 PUB_AI_DISABLED {manual:true}, вызова нет; ручная версия проходит до согласования', async () => {
      delete process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
      const { w, ed, po, ids } = await world();
      const r = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
        template: 'helpful_answer',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'PUB_AI_DISABLED',
        details: { generator: 'pub.reddit.draft', manual: true },
      });
      expect(await calls(w.product.id)).toBe(0);
      const brief = ok<{ ai: { available: boolean; reason: string } }>(
        await ed.get(`${w.P}/briefs/${ids.briefId}`),
        200,
      );
      expect(brief.ai).toEqual({ available: false, reason: 'flag_off' });
      const v = await approvedVersion(ed, po, w, ids);
      const row = await s.prisma.pubContentVersion.findUniqueOrThrow({
        where: { id: v.id },
      });
      expect(row).toMatchObject({ aiCallId: null, status: 'approved' });
    });

    it('флаг включён, генератор выключен в коде (до eval 2.3) → disabled в журнале, 409 {manual:true}, модель не вызывается', async () => {
      process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV] = 'true';
      const { w, ed, ids } = await world();
      const r = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
        template: 'educational_post',
      });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatchObject({
        code: 'PUB_AI_DISABLED',
        details: { status: 'disabled', manual: true },
      });
      const row = await s.prisma.pubAiCall.findUniqueOrThrow({
        where: { id: r.body.error.details.callId },
      });
      expect(row).toMatchObject({
        status: 'disabled',
        errorCode: 'PUB_AI_DISABLED',
        generator: 'pub.reddit.draft',
      });
      // ручной путь
      const d = await draftVersion(ed, w, ids);
      expect((await submitVersion(ed, w, ids.contentId, d)).status).toBe(
        'submitted',
      );
      delete process.env[PUBLISHER_REDDIT_AI_ENABLED_ENV];
    });

    it('гейт ai_use закрыт (параметры AI не утверждены) → 409 PUB_GATE_CLOSED; ручной путь работает', async () => {
      const { w, ed, ids } = await world();
      const ai = await redditAi(s, w, { params: false });
      try {
        const r = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
          template: 'comparison',
        });
        expect(r.status).toBe(409);
        expect(r.body.error).toMatchObject({
          code: 'PUB_GATE_CLOSED',
          details: { gate: 'ai_use' },
        });
        expect(ai.model.requests).toHaveLength(0);
        const d = await draftVersion(ed, w, ids);
        expect(d.status).toBe('draft');
      } finally {
        ai.restore();
      }
    });

    it('тайм-аут модели (fake) → 503 PUB_AI_UNAVAILABLE {callId}; вызов в журнале, черновик не тронут, новой версии нет; ручная правка продолжается', async () => {
      const { w, ed, ids } = await world();
      const C = contentPath(w);
      const ai = await redditAi(s, w);
      try {
        const d = await draftVersion(ed, w, ids);
        const before = await s.prisma.pubContentVersion.findMany({
          where: { contentId: ids.contentId },
        });
        ai.model.fallback = new TextModelError('timeout');
        const r = await ed.post(`${w.P}/briefs/${ids.briefId}/generate`, {
          template: 'troubleshooting',
        });
        expect(r.status).toBe(503);
        expect(r.body.error.code).toBe('PUB_AI_UNAVAILABLE');
        const call = await s.prisma.pubAiCall.findUniqueOrThrow({
          where: { id: r.body.error.details.callId },
        });
        expect(call.status).toBe('timeout');
        const after = await s.prisma.pubContentVersion.findMany({
          where: { contentId: ids.contentId },
        });
        expect(after).toEqual(before);
        const patched = ok<{ body: string; revision: number }>(
          await ed.patch(`${C}/contents/${ids.contentId}/versions/${d.id}`, {
            expectedRevision: d.revision,
            body: `${before[0].body}\n\nWritten by hand while the model was down.`,
          }),
          200,
        );
        expect(patched.body).toMatch(/Written by hand/);
      } finally {
        ai.restore();
      }
    });
  },
);
