import {
  demoShopHookOf,
  polygonOrigin,
  resolvePolygonRoute,
  validatePolygonScenarioSteps,
  withPolygonReadyWait,
} from './polygon-scenario';
import { DEMO_SHOP_HOOKS, POLYGON_ROUTES } from './polygon-catalog';
import {
  parseScenarioResponse,
  validateScenarioSteps,
} from '../tutorial-scenario/tutorial-scenario-prompt';

const ORIGIN = 'https://landing.example';

describe('polygonOrigin — origin полигона из LANDING_PUBLIC_URL', () => {
  it.each([
    ['https с путём', 'https://landing.example/ru', 'https://landing.example'],
    [
      'https с портом',
      'https://landing.example:8443',
      'https://landing.example:8443',
    ],
    [
      'пробелы вокруг',
      '  https://landing.example  ',
      'https://landing.example',
    ],
  ])('%s → origin', (_l, raw, expected) => {
    expect(polygonOrigin({ LANDING_PUBLIC_URL: raw })).toBe(expected);
  });

  it.each([
    ['не задан', undefined],
    ['пусто', ''],
    ['http', 'http://landing.example'],
    ['учётные данные', 'https://u:p@landing.example'],
    ['только имя', 'https://u@landing.example'],
    ['не адрес', 'landing.example'],
    ['javascript:', 'javascript:alert(1)'],
  ])('%s → null', (_l, raw) => {
    expect(polygonOrigin({ LANDING_PUBLIC_URL: raw })).toBeNull();
  });
});

describe('resolvePolygonRoute — только origin полигона и только /qa/', () => {
  it('имя из таблицы → адрес на полигоне с языком', () => {
    expect(resolvePolygonRoute('qa-demo-shop', ORIGIN, 'uk')).toEqual({
      ok: true,
      url: `${ORIGIN}/qa/demo-shop?lang=uk`,
    });
  });

  it.each([
    ['маршрут TMA', 'generate'],
    ['произвольный URL', 'https://evil.example/qa/demo-shop'],
    ['путь', '/qa/demo-shop'],
    ['прототип', '__proto__'],
    ['constructor', 'constructor'],
    ['соседний полигон, которого нет в таблице', 'qa-site-sandbox'],
  ])('%s — отказ', (_l, name) => {
    const res = resolvePolygonRoute(name, ORIGIN, 'ru');
    expect(res.ok).toBe(false);
  });

  it.each([
    ['не код локали', 'ru&x=1'],
    ['пусто', ''],
    ['длинный', 'rus'],
  ])('локаль «%s» в адрес не попадает', (_l, locale) => {
    expect(resolvePolygonRoute('qa-demo-shop', ORIGIN, locale).ok).toBe(false);
  });

  it.each([
    ['http-origin', 'http://landing.example'],
    ['origin с путём', 'https://landing.example/ru'],
    ['не адрес', 'nope'],
  ])('origin «%s» — отказ', (_l, origin) => {
    expect(resolvePolygonRoute('qa-demo-shop', origin, 'ru').ok).toBe(false);
  });

  it('все маршруты таблицы — под /qa/ (контракт со страницей)', () => {
    for (const path of Object.values(POLYGON_ROUTES)) {
      expect(path.startsWith('/qa/')).toBe(true);
    }
  });
});

describe('demoShopHookOf — селектор только из каталога витрины', () => {
  it('каждый элемент каталога узнаётся', () => {
    for (const id of DEMO_SHOP_HOOKS) {
      expect(demoShopHookOf(`[data-qa="${id}"]`)).toBe(id);
    }
  });

  it.each([
    ['вне каталога', '[data-qa="demo-shop-pay"]'],
    ['хук TMA', '[data-qa="reference-card"]'],
    ['префикс', '[data-qa="demo-shop"]'],
    ['одинарные кавычки', "[data-qa='demo-shop-root']"],
    ['произвольный CSS', '#demo-shop-root'],
    ['цепочка', '[data-qa="demo-shop-root"] a'],
  ])('%s — нет', (_l, selector) => {
    expect(demoShopHookOf(selector)).toBeNull();
  });
});

describe('validatePolygonScenarioSteps — правила семейства демо', () => {
  const GOOD = [
    { kind: 'goto', route: 'qa-demo-shop', narration: 'Покажем.' },
    { kind: 'click', selector: '[data-qa="demo-shop-nav-delivery"]' },
    { kind: 'assertVisible', selector: '[data-qa="demo-shop-delivery-terms"]' },
  ];

  it('годный сценарий принимается', () => {
    const res = validatePolygonScenarioSteps(GOOD, 'site-tutorial-demo-1');
    expect(res.ok).toBe(true);
    expect(res.steps).toHaveLength(3);
  });

  it.each([
    [
      'селектор вне каталога',
      [GOOD[0], { kind: 'click', selector: '[data-qa="demo-shop-x"]' }],
      /каталога витрины/,
    ],
    [
      'хук TMA',
      [GOOD[0], { kind: 'click', selector: '[data-qa="reference-card"]' }],
      /каталога витрины/,
    ],
    [
      'маршрут TMA',
      [{ kind: 'goto', route: 'generate' }, GOOD[1]],
      /нет на полигоне/,
    ],
    [
      'второй goto на чужой маршрут',
      [GOOD[0], { kind: 'goto', route: 'qa-site-sandbox' }],
      /нет на полигоне/,
    ],
    ['первый шаг не goto', [GOOD[1], GOOD[0]], /начинается с goto/],
    [
      'triggerPaidOperation',
      [
        GOOD[0],
        {
          kind: 'triggerPaidOperation',
          operation: 'generation',
          model: 'veo-3.0-fast-generate-001',
          expectedUnits: { seconds: 8 },
          note: 'рендер',
        },
        GOOD[1],
      ],
      /triggerPaidOperation/,
    ],
    ['пусто', [], /пустой/],
  ])('%s — отказ', (_l, steps, reason) => {
    const res = validatePolygonScenarioSteps(steps, 'site-tutorial-demo-2');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(reason);
  });

  it.each([
    ['ключ продукта', '3'],
    ['похожий, но не слот', 'site-tutorial-demo-99'],
    ['client-site', 'client-site'],
  ])('тема «%s» правилами витрины не принимается', (_l, key) => {
    expect(validatePolygonScenarioSteps(GOOD, key).ok).toBe(false);
  });
});

describe('validateScenarioSteps — одна точка, два свода правил', () => {
  const POLYGON = [
    { kind: 'goto', route: 'qa-demo-shop' },
    { kind: 'click', selector: '[data-qa="demo-shop-nav-cart"]' },
  ];

  it('для семейства — правила витрины', () => {
    expect(validateScenarioSteps(POLYGON, 'site-tutorial-demo-2').ok).toBe(
      true,
    );
    expect(
      validateScenarioSteps(
        [{ kind: 'goto', route: 'generate' }],
        'site-tutorial-demo-2',
      ).ok,
    ).toBe(false);
  });

  it('ключ по префиксу, но вне слотов — не уходит в правила TMA', () => {
    const res = validateScenarioSteps(
      [{ kind: 'goto', route: 'generate' }],
      'site-tutorial-demo-7',
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/слота/);
  });

  it('для темы продукта шаги витрины не годятся', () => {
    expect(validateScenarioSteps(POLYGON, '3').ok).toBe(false);
  });

  it('ответ модели для семейства отвергается целиком, даже годный', () => {
    const res = parseScenarioResponse(
      JSON.stringify({ steps: POLYGON }),
      'site-tutorial-demo-1',
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/генератор её не пишет/);
  });
});

describe('withPolygonReadyWait — goto ждёт ожившую витрину', () => {
  class FakePage {
    #secret = 'ok';
    calls: string[] = [];
    get secret() {
      return this.#secret;
    }
    async goto(url: string) {
      this.calls.push(`goto ${url}`);
    }
    async waitForSelector(selector: string) {
      this.calls.push(`wait ${selector}`);
    }
    locator() {
      return {} as never;
    }
    async $eval() {
      return this.#secret;
    }
  }

  it('после перехода ждёт data-demo-ready; методы и геттеры — на самой странице', async () => {
    const page = new FakePage();
    const wrapped = withPolygonReadyWait(page as never) as unknown as FakePage;
    await wrapped.goto('https://landing.example/qa/demo-shop?lang=ru');
    expect(page.calls).toEqual([
      'goto https://landing.example/qa/demo-shop?lang=ru',
      'wait [data-qa="demo-shop-root"][data-demo-ready="true"]',
    ]);
    expect(wrapped.secret).toBe('ok');
    await expect(wrapped.$eval()).resolves.toBe('ok');
  });
});
