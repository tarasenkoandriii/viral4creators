import {
  parseSiteTutorialDemoSeed,
  siteTutorialDemoSeed,
  siteTutorialDemoTitle,
} from './site-tutorial-demo-seed';
import { validateScenarioSteps } from '../tutorial-scenario/tutorial-scenario-prompt';
import { SITE_TUTORIAL_DEMO_KEYS } from '../tutorial-help/site-tutorial-demo';
import { SUPPORTED_LOCALES } from '../../common/locale';
import {
  narrationOf,
  ScenarioStep,
} from '../tutorial-scenario/scenario-steps.types';

describe('сид демо обучающего лендинга (seeds/site-tutorial-demo.json)', () => {
  const entries = siteTutorialDemoSeed();

  it('три слота × пять локалей, каждая пара один раз', () => {
    expect(entries).toHaveLength(SITE_TUTORIAL_DEMO_KEYS.length * 5);
    for (const key of SITE_TUTORIAL_DEMO_KEYS) {
      expect(
        entries
          .filter((e) => e.subjectKey === key)
          .map((e) => e.locale)
          .sort(),
      ).toEqual([...SUPPORTED_LOCALES].sort());
    }
  });

  it('слоты по решению владельца: 1 — С3, 2 — С2, 3 — С4', () => {
    const scenarioOf = (key: string) =>
      new Set(
        entries.filter((e) => e.subjectKey === key).map((e) => e.scenario),
      );
    expect([...scenarioOf('site-tutorial-demo-1')]).toEqual(['C3-delivery']);
    expect([...scenarioOf('site-tutorial-demo-2')]).toEqual(['C2-order']);
    expect([...scenarioOf('site-tutorial-demo-3')]).toEqual(['C4-booking']);
  });

  it('каждая пара проходит ту же валидацию, что ручная правка, без отброшенных реплик', () => {
    for (const e of entries) {
      const res = validateScenarioSteps(e.steps, e.subjectKey);
      expect({
        pair: `${e.subjectKey}/${e.locale}`,
        ok: res.ok,
        reason: res.reason,
      }).toEqual({
        pair: `${e.subjectKey}/${e.locale}`,
        ok: true,
        reason: undefined,
      });
      expect(res.droppedNarrations).toEqual([]);
    }
  });

  it('у одного сценария шаги одинаковы во всех локалях — различаются только реплики и данные', () => {
    for (const key of SITE_TUTORIAL_DEMO_KEYS) {
      const shapes = entries
        .filter((e) => e.subjectKey === key)
        .map((e) =>
          JSON.stringify(
            (e.steps as ScenarioStep[]).map((s) =>
              s.kind === 'goto'
                ? `goto:${s.route}`
                : `${s.kind}:${'selector' in s ? s.selector : ''}`,
            ),
          ),
        );
      expect(new Set(shapes).size).toBe(1);
    }
  });

  it('реплик хватает на большинство кадров — ролик озвучивается покадрово', () => {
    for (const e of entries) {
      const steps = e.steps as ScenarioStep[];
      const narrated = steps.filter((s) => narrationOf(s)).length;
      expect(narrated / steps.length).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('данные вымышленные: почты только на example.com', () => {
    const text = JSON.stringify(entries);
    const emails = text.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails)
      expect(email.endsWith('@example.com')).toBe(true);
  });

  it('заголовок ролика — из сида по локали, запасной — русский, иначе ключ', () => {
    expect(siteTutorialDemoTitle('site-tutorial-demo-1', 'en')).toBe(
      'How to find the delivery terms',
    );
    expect(siteTutorialDemoTitle('site-tutorial-demo-2', 'fr')).toBe(
      'Как оформить заказ в магазине',
    );
    expect(siteTutorialDemoTitle('site-tutorial-demo-9', 'ru')).toBe(
      'site-tutorial-demo-9',
    );
  });
});

describe('parseSiteTutorialDemoSeed — разбор закрыт', () => {
  const ok = {
    version: 1,
    family: 'site-tutorial-demo',
    scenarios: [
      {
        subjectKey: 'site-tutorial-demo-1',
        scenario: 'C3-delivery',
        locale: 'ru',
        title: 'Т',
        steps: [],
      },
    ],
  };

  it('годный документ разбирается', () => {
    expect(parseSiteTutorialDemoSeed(ok)).toHaveLength(1);
  });

  it.each([
    ['не объект', null],
    ['другая версия', { ...ok, version: 2 }],
    ['чужое семейство', { ...ok, family: 'x' }],
    ['нет сценариев', { ...ok, scenarios: [] }],
    [
      'ключ не слот',
      { ...ok, scenarios: [{ ...ok.scenarios[0], subjectKey: '3' }] },
    ],
    [
      'ключ по префиксу, но не слот',
      {
        ...ok,
        scenarios: [{ ...ok.scenarios[0], subjectKey: 'site-tutorial-demo-4' }],
      },
    ],
    [
      'плохая локаль',
      { ...ok, scenarios: [{ ...ok.scenarios[0], locale: 'RU' }] },
    ],
    [
      'без заголовка',
      { ...ok, scenarios: [{ ...ok.scenarios[0], title: ' ' }] },
    ],
    ['пара дважды', { ...ok, scenarios: [ok.scenarios[0], ok.scenarios[0]] }],
  ])('%s — исключение', (_l, doc) => {
    expect(() => parseSiteTutorialDemoSeed(doc)).toThrow();
  });
});
