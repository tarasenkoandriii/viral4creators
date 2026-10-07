/**
 * ТЗ §4-тер.15 п.7 (§4-тер.10) — языки:
 *  - вопрос на английском к сайту только на украинском → второй поиск по
 *    переводу (`assist-classify`), ответ с источником, в промпте — язык
 *    ответа «in English» и оговорка «информация на сайте — на uk»;
 *  - проверенный ответ на украинском на вопрос на русском — через
 *    генерацию, не прямым путём; тот же вопрос по-украински — прямым путём;
 *  - сбой перевода не ломает ответ (остаётся первый поиск).
 */
import { describeDb } from '../../modules/assist-sandbox/testing/k3-stack.testing';
import { ChatStack } from '../../modules/assist-site-chat/testing/chat-stack.testing';
import { TextModelError } from '../../modules/site-ai/text-model';
import { estimateCost } from '../../shared/ai-pricing';

jest.setTimeout(60_000);

describeDb('§4-тер.15 п.7 — вопрос не на языке базы (chat-multilang)', () => {
  const st = new ChatStack();
  beforeAll(async () => {
    await st.init();
  });
  afterAll(async () => {
    await st.close();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    st.model.calls.length = 0;
    st.translator.calls.length = 0;
    st.translator.fail = false;
  });

  it('английский вопрос к украинской базе: перевод + второй поиск, ответ с источником и оговоркой, язык ответа — английский', async () => {
    const s = await st.stand('shop');
    const r = await st.ask(s, 'How much does delivery cost?');
    expect(st.translator.calls).toHaveLength(1);
    expect(st.translator.calls[0].system).toMatch(/into Ukrainian/);
    expect(r.sources.map((x) => x.url)).toContain(s.url('/delivery'));
    expect(r.text).toContain('80 грн');
    expect(r.text).toMatch(/Information on the site is in language: uk/);
    const req = st.model.calls[0];
    expect(req.system).toContain('in English');
    expect(req.system).toMatch(/Знания сайта написаны на языке «uk»/);
    const ops = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId },
      select: { operation: true },
    });
    expect(ops.map((o) => o.operation).sort()).toEqual([
      'assist-chat',
      'assist-classify',
      'assist-query-embed',
      'assist-query-embed',
    ]);
  });

  it('вопрос на языке базы — без перевода и без оговорки', async () => {
    const s = await st.stand('shop');
    const r = await st.ask(s, 'Скільки коштує доставка Новою поштою?');
    expect(st.translator.calls).toHaveLength(0);
    expect(st.model.calls[0].system).not.toMatch(
      /Знания сайта написаны на языке/,
    );
    expect(r.text).not.toMatch(/Information on the site/);
  });

  it('проверенный ответ (uk) на вопрос по-русски — через генерацию; тот же вопрос по-украински — прямым путём без модели', async () => {
    const s = await st.stand('shop');
    const uk = await st.ask(s, 'Чи є самовивіз з шоуруму на Хрещатику');
    expect(st.model.calls).toHaveLength(0);
    const ukMsg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: uk.meta!.messageId },
    });
    expect(ukMsg.answerPath).toBe('faq');
    expect(uk.text).toMatch(/самовивіз із шоуруму/);
    // Проверенный ответ, чей вопрос без букв, различающих uk/ru: русский
    // вопрос из тех же слов похож на него ≥ 0.92 — но язык другой.
    await st.faq(s, {
      question: 'Доставка до Харкова та Одеси за добу',
      answer: 'Так, до Харкова та Одеси доставляємо за одну добу.',
      lang: 'uk',
    });
    const ru = await st.ask(s, 'Доставка до Харкова та Одеси за добу ещё');
    const ruMsg = await st.owner.assistSiteMessage.findUniqueOrThrow({
      where: { id: ru.meta!.messageId },
    });
    expect(ruMsg.answerPath).toBe('model');
    expect(st.model.calls).toHaveLength(1);
  });

  it('сбой перевода — ответ всё равно идёт по первому поиску', async () => {
    const s = await st.stand('services');
    st.translator.fail = true;
    const r = await st.ask(s, 'How much does laptop diagnostics cost?');
    expect(r.done).toBe(true);
    expect(r.meta).not.toBeNull();
    expect(st.model.calls).toHaveLength(1);
  });

  it('оплаченный сбой перевода (truncated со spent) — расход assist-classify фактом и в суточном бюджете сайта; timeout — как раньше', async () => {
    const siteDay = async (siteId: string) => {
      const rows = await st.owner.$queryRawUnsafe<Array<{ spent: bigint }>>(
        `SELECT "spentMicroUsd" AS spent FROM "sites"."assist_budget_days"
          WHERE "scope" = 'site' AND "key" = $1`,
        siteId,
      );
      return rows.reduce((a, r) => a + Number(r.spent), 0);
    };
    const usage = (siteId: string) =>
      st.owner.siteAiUsage.findMany({ where: { siteId } });

    const s = await st.stand('services');
    const spent = {
      model: 'gemini-3.6-flash',
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 1280,
    };
    jest
      .spyOn(st.translator, 'generate')
      .mockRejectedValueOnce(new TextModelError('truncated', spent));
    const r = await st.ask(s, 'How much does laptop diagnostics cost?');
    // Посетителю — как при любом сбое перевода: ответ по первому поиску.
    expect(r.done).toBe(true);
    expect(r.meta).not.toBeNull();
    expect(st.model.calls).toHaveLength(1);
    const rows = await usage(s.siteId);
    const cls = rows.filter((u) => u.operation === 'assist-classify');
    const fact = estimateCost(spent.model, spent).costMicroUsd;
    expect(fact).toBeGreaterThan(0);
    expect(cls).toHaveLength(1);
    expect(cls[0]).toMatchObject({
      model: spent.model,
      inputTokens: 120,
      outputTokens: 1280,
      costMicroUsd: fact,
    });
    // Резерв дня закрыт фактом всего вопроса — с переводом.
    expect(await siteDay(s.siteId)).toBe(
      rows.reduce((a, u) => a + u.costMicroUsd, 0),
    );

    const t = await st.stand('services');
    jest
      .spyOn(st.translator, 'generate')
      .mockRejectedValueOnce(new TextModelError('timeout'));
    const r2 = await st.ask(t, 'How much does laptop diagnostics cost?');
    expect(r2.done).toBe(true);
    const rows2 = await usage(t.siteId);
    expect(rows2.some((u) => u.operation === 'assist-classify')).toBe(false);
    expect(await siteDay(t.siteId)).toBe(
      rows2.reduce((a, u) => a + u.costMicroUsd, 0),
    );
  });
});
