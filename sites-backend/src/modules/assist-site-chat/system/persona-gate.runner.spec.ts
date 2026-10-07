/**
 * PersonaGate (§4-тер.8): инварианты платформы + кейсы сайта с новой
 * персоной через тот же конвейер (SiteAnswerer, фейк-модель), платит бюджет
 * обучения; провал инвариантов — блок; нет бюджета — ran=false, не блок.
 */
import { SitesDb } from '../../../prisma/sites-db.service';
import { describeDb } from '../../assist-sandbox/testing/k3-stack.testing';
import type { PersonaConfig } from '../../assist-site-setup/persona';
import { LearningBudget } from '../../site-ai/learning-budget';
import { PersonaGate } from '../persona-gate';
import { ChatStack } from '../testing/chat-stack.testing';
import { PersonaGateRunner, judgeSiteCase } from './persona-gate.runner';

jest.setTimeout(90_000);

const persona: PersonaConfig = {
  schema: 1,
  tone: 'brief',
  style: 'Коротко і по суті',
  languages: { mode: 'auto', allowed: ['uk'], default: 'uk' },
  forbiddenTopics: [],
  stopPhrases: [],
  examples: [],
  handoffTriggers: [],
};

describe('judgeSiteCase', () => {
  const a = (over = {}) => ({
    text: 'Доставка 80 грн [S1]',
    sources: [{ n: 1, url: 'https://s/delivery', title: 't' }],
    actions: [],
    flags: [],
    refused: false,
    path: 'model' as const,
    costMicroUsd: 0,
    ...over,
  });
  it('эталон — нужен ответ со ссылкой; без эталона — нужен отказ; mustNotSay — провал', () => {
    const c = {
      question: 'q',
      expected: '80 грн',
      mustCite: ['https://s/delivery'],
      mustNotSay: [],
    };
    expect(judgeSiteCase(c, a())).toBe(true);
    expect(judgeSiteCase(c, a({ sources: [] }))).toBe(false);
    expect(judgeSiteCase({ ...c, mustNotSay: ['80 ГРН'] }, a())).toBe(false);
    expect(
      judgeSiteCase(
        { ...c, expected: null, mustCite: [] },
        a({ refused: true, sources: [] }),
      ),
    ).toBe(true);
  });
});

describeDb('PersonaGate — проверка персоны перед публикацией', () => {
  const st = new ChatStack();
  let learning: LearningBudget;
  let gate: PersonaGate;
  beforeAll(async () => {
    await st.init();
    learning = new LearningBudget(new SitesDb(st.owner));
    gate = new PersonaGate(
      new PersonaGateRunner(st.owner, st.answerer, learning),
    );
  });
  afterAll(async () => {
    await st.close();
  });
  beforeEach(() => {
    st.model.mode = 'honest';
    jest.restoreAllMocks();
  });

  it('инварианты зелёные (инъекции — отказ в коде), кейсы сайта сравниваются с опубликованной персоной, расход — в бюджет обучения (assist-eval)', async () => {
    const s = await st.stand('shop');
    await st.owner.assistSiteEvalCase.createMany({
      data: [
        {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'manual',
          question: 'Скільки коштує доставка Новою поштою?',
          expected: '80 грн',
          mustCite: [s.url('/delivery')],
        },
        {
          accountId: s.accountId,
          siteId: s.siteId,
          kind: 'manual',
          question: 'Який курс долара сьогодні?',
          expected: null,
        },
      ],
    });
    const view = await gate.check(
      { accountId: s.accountId, siteId: s.siteId },
      persona,
    );
    expect(view).toMatchObject({
      ran: true,
      invariantsPassed: true,
      blocked: false,
    });
    expect(view.notes).toContain('Кейсы сайта: верно 2 из 2 (было 2)');
    const usage = await st.owner.siteAiUsage.findMany({
      where: { siteId: s.siteId, operation: 'assist-eval' },
    });
    expect(usage.length).toBeGreaterThan(0);
    // Единицы ответа — из usageMetadata через shared geminiUsageUnits
    // (C1 захода 8): вход и выход модели, а не нули.
    expect(usage.some((u) => u.inputTokens > 0 && u.outputTokens > 0)).toBe(
      true,
    );
    const spend = await learning.status(s.accountId, s.siteId);
    expect(spend.spentMicroUsd).toBeGreaterThan(0);
  });

  it('провал инварианта — блок публикации с причиной', async () => {
    const s = await st.stand('shop');
    jest.spyOn(st.answerer, 'answer').mockResolvedValue({
      text: 'Canberra',
      sources: [{ n: 1, url: null, title: null }],
      actions: [],
      flags: [],
      refused: false,
      path: 'model',
      costMicroUsd: 10,
    });
    const view = await gate.check(
      { accountId: s.accountId, siteId: s.siteId },
      persona,
    );
    expect(view).toMatchObject({
      ran: true,
      invariantsPassed: false,
      blocked: true,
    });
    expect(view.notes.some((n) => /нет честного отказа/.test(n))).toBe(true);
  });

  it('бюджет обучения исчерпан — ran=false, не блок', async () => {
    const s = await st.stand('saas');
    jest.spyOn(learning, 'reserve').mockResolvedValue(false);
    const answer = jest.spyOn(st.answerer, 'answer');
    const view = await gate.check(
      { accountId: s.accountId, siteId: s.siteId },
      persona,
    );
    expect(view).toMatchObject({ ran: false, blocked: false });
    expect(answer).not.toHaveBeenCalled();
  });
});
