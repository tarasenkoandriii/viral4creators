import {
  GUIDE_CONFIRM_RULES,
  GUIDE_NEVER_RULES,
  buildGuideKnowledge,
  factGlossary,
  guideKnowledgeStamp,
} from './guide-assist-knowledge';
import { SCENARIO_HINTS, stepIdsOf } from '../wizard-guide/hint-scenarios';
import { STEP_TARGET_PREFIX, projectFactsView } from './guide-assist-facts';
import type { FreeScenario } from '../../common/test-user-scenarios';

const SCENARIOS = Object.keys(SCENARIO_HINTS) as FreeScenario[];

describe('Ш6 — знания гида для «Админки»', () => {
  const md = buildGuideKnowledge();

  it('каждый шаг каждого сценария — с целью из карточки и кнопкой степпера', () => {
    for (const s of SCENARIOS) {
      for (const id of stepIdsOf(s)) {
        expect(md).toContain(SCENARIO_HINTS[s]!.cards[id].goal);
        expect(md).toContain(`\`${STEP_TARGET_PREFIX[s]}${id}\``);
      }
    }
  });

  it('правила «никогда» — оплата, удаление, рендер — в тексте', () => {
    for (const r of GUIDE_NEVER_RULES) expect(md).toContain(r);
    expect(md).toMatch(/Оплата/);
    expect(md).toMatch(/Удаление/);
    expect(md).toMatch(/рендер/);
  });

  it('Р-Ш6-11: разовые платные действия — «только с подтверждением», с ценой', () => {
    expect(md).toContain('## Только с подтверждением');
    for (const r of GUIDE_CONFIRM_RULES) expect(md).toContain(r);
    const confirm = GUIDE_CONFIRM_RULES.join(' ');
    for (const w of [
      'сценария',
      'кадр-референс',
      'эскиз',
      'база',
      'звуковая дорожка',
      'модерацию',
      'обучалки на сборку',
      'цену',
    ])
      expect(confirm).toContain(w);
    // Рендер, оплата, удаление и согласия в «подтверждение» не переехали.
    expect(confirm).not.toMatch(/рендер|оплат|удален|соглас/i);
    expect(md.indexOf('## Никогда')).toBeLessThan(
      md.indexOf('## Только с подтверждением'),
    );
  });

  it('словарь фактов — из кода советника, без конкретных чисел', () => {
    const g = factGlossary();
    expect(g.GREETING_VIDEO).toContain('повод задан');
    expect(g.GREETING_VIDEO).toContain('повод не задан');
    expect(g.CLIENT_SITE).toContain('записано шагов: N');
    for (const s of SCENARIOS) {
      for (const f of g[s]) expect(md).toContain(f);
    }
  });

  it('штамп устойчив и зависит от текста', () => {
    expect(guideKnowledgeStamp()).toMatch(/^[0-9a-f]{12}$/);
    expect(guideKnowledgeStamp()).toBe(guideKnowledgeStamp());
  });
});

describe('Ш6 — вид фактов проекта', () => {
  it('неизвестный тип проекта — ни шагов, ни фактов', () => {
    expect(projectFactsView('p1', null, ['лишнее'])).toEqual({
      projectId: 'p1',
      scenario: null,
      scenarioTitle: null,
      scenarioGoal: null,
      steps: [],
      facts: [],
    });
  });

  it('шаги поздравления — с data-assist-id степпера TMA', () => {
    const v = projectFactsView('p1', 'GREETING_VIDEO', ['повод задан']);
    expect(v.steps.map((s) => s.uiTarget)).toEqual([
      'greeting-step-brief',
      'greeting-step-references',
      'greeting-step-script',
      'greeting-step-video',
    ]);
    expect(v.facts).toEqual(['повод задан']);
  });
});
