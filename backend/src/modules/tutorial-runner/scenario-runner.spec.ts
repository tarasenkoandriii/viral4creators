import {
  FRAME_SETTLE_NETWORK_MS,
  FRAME_SETTLE_SPINNER_MS,
  measurePointer,
  opensOtherStepScreen,
  runScenario,
  ScenarioPage,
  ScenarioRouteResolver,
} from './scenario-runner';
import { CAPTURE_VIEWPORT } from './tutorial-video-assembly';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';

function buildPage(overrides: Partial<ScenarioPage> = {}): ScenarioPage {
  const locator = { click: jest.fn(), fill: jest.fn() };
  return {
    goto: jest.fn().mockResolvedValue(undefined),
    waitForSelector: jest.fn().mockResolvedValue(undefined),
    locator: jest.fn().mockReturnValue(locator),
    $eval: jest.fn().mockResolvedValue('Готово'),
    ...overrides,
  };
}

const resolveOk: ScenarioRouteResolver = (route) => ({
  ok: true,
  url: `https://app.example.com/#/${route}`,
});

describe('runScenario', () => {
  it('проигрывает все виды шагов по порядку и возвращает ok:true', async () => {
    const page = buildPage();
    const steps: ScenarioStep[] = [
      { kind: 'goto', route: 'generate' },
      { kind: 'fill', selector: '[data-testid="name"]', value: 'Товар' },
      { kind: 'click', selector: '[data-testid="next"]' },
      { kind: 'waitFor', selector: '[data-testid="preview"]' },
      { kind: 'assertVisible', selector: '[data-testid="preview"]' },
      {
        kind: 'assertText',
        selector: '[data-testid="status"]',
        value: 'Готово',
      },
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'x',
      },
    ];

    const result = await runScenario(page, steps, resolveOk);

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(7);
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(page.goto).toHaveBeenCalledWith(
      'https://app.example.com/#/generate',
      expect.objectContaining({ waitUntil: 'networkidle2' }),
    );
  });

  it('goto с нерезолвящимся маршрутом останавливает сценарий на этом шаге', async () => {
    const page = buildPage();
    const resolveFail: ScenarioRouteResolver = () => ({
      ok: false,
      reason: 'нет такого маршрута',
    });
    const steps: ScenarioStep[] = [
      { kind: 'goto', route: 'wizard.generation' },
      { kind: 'click', selector: '[data-testid="next"]' },
    ];

    const result = await runScenario(page, steps, resolveFail);

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(0);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].error).toContain('нет такого маршрута');
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('assertText с несовпавшим текстом — провал шага, не бросает наружу', async () => {
    const page = buildPage({ $eval: jest.fn().mockResolvedValue('Ошибка') });
    const steps: ScenarioStep[] = [
      {
        kind: 'assertText',
        selector: '[data-testid="status"]',
        value: 'Готово',
      },
    ];

    const result = await runScenario(page, steps, resolveOk);

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(0);
    expect(result.steps[0].error).toContain('Готово');
  });

  it('all-or-nothing на исполнении: шаг 3 из 3 не выполняется после провала шага 2', async () => {
    const locator = { click: jest.fn(), fill: jest.fn() };
    const page = buildPage({
      locator: jest
        .fn()
        .mockImplementation((selector: string) =>
          selector === '[data-testid="broken"]'
            ? { click: jest.fn().mockRejectedValue(new Error('нет элемента')) }
            : locator,
        ),
    });
    const steps: ScenarioStep[] = [
      { kind: 'click', selector: '[data-testid="ok"]' },
      { kind: 'click', selector: '[data-testid="broken"]' },
      { kind: 'click', selector: '[data-testid="never-reached"]' },
    ];

    const result = await runScenario(page, steps, resolveOk);

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(1);
    expect(result.steps).toHaveLength(2);
  });

  it('triggerPaidOperation на исполнении — no-op, не трогает страницу', async () => {
    const page = buildPage();
    const steps: ScenarioStep[] = [
      {
        kind: 'triggerPaidOperation',
        operation: 'voiceover',
        model: 'eleven_v3',
        expectedUnits: { characters: 500 },
        note: 'x',
      },
    ];

    const result = await runScenario(page, steps, resolveOk);

    expect(result.ok).toBe(true);
    expect(page.goto).not.toHaveBeenCalled();
    expect(page.locator).not.toHaveBeenCalled();
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it('пустой сценарий — ok:true без шагов (валидация непустоты — забота generation-этапа, не runner)', async () => {
    const page = buildPage();
    const result = await runScenario(page, [], resolveOk);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.frames).toEqual([]);
  });

  it('captureFrames:false (по умолчанию) — кадры не снимаются, даже если page.screenshot есть', async () => {
    const screenshot = jest.fn().mockResolvedValue(new Uint8Array([1]));
    const page = buildPage({ screenshot });
    const steps: ScenarioStep[] = [
      { kind: 'waitFor', selector: '[data-testid="x"]' },
    ];

    const result = await runScenario(page, steps, resolveOk);

    expect(result.frames).toEqual([]);
    expect(screenshot).not.toHaveBeenCalled();
  });

  it('captureFrames:true — один кадр после каждого успешного шага, ни одного после провалившегося', async () => {
    let n = 0;
    const screenshot = jest.fn().mockImplementation(async () => {
      n += 1;
      return new Uint8Array([n]);
    });
    const page = buildPage({ screenshot });
    const steps: ScenarioStep[] = [
      { kind: 'waitFor', selector: '[data-testid="a"]' },
      { kind: 'waitFor', selector: '[data-testid="b"]' },
    ];

    const result = await runScenario(page, steps, resolveOk, 15_000, true);

    expect(result.ok).toBe(true);
    expect(screenshot).toHaveBeenCalledTimes(2);
    expect(result.frames).toHaveLength(2);
    expect(Array.from(result.frames[0].bytes)).toEqual([1]);
    expect(result.frames.map((f) => f.stepIndex)).toEqual([0, 1]);
  });

  it('captureFrames:true, но page.screenshot отсутствует — не бросает, кадров просто нет', async () => {
    const page = buildPage();
    const steps: ScenarioStep[] = [
      { kind: 'waitFor', selector: '[data-testid="a"]' },
    ];

    const result = await runScenario(page, steps, resolveOk, 15_000, true);

    expect(result.ok).toBe(true);
    expect(result.frames).toEqual([]);
  });

  it('captureFrames:true, скриншот одного шага падает — сам сценарий не проваливается, кадр просто пропущен', async () => {
    const screenshot = jest
      .fn()
      .mockRejectedValueOnce(new Error('CDP занят'))
      .mockResolvedValueOnce(new Uint8Array([9]));
    const page = buildPage({ screenshot });
    const steps: ScenarioStep[] = [
      { kind: 'waitFor', selector: '[data-testid="a"]' },
      { kind: 'waitFor', selector: '[data-testid="b"]' },
    ];

    const result = await runScenario(page, steps, resolveOk, 15_000, true);

    expect(result.ok).toBe(true);
    expect(result.frames).toHaveLength(1);
    expect(Array.from(result.frames[0].bytes)).toEqual([9]);
    // Главное этого теста с этапа A: уцелевший кадр помнит, что он от
    // ВТОРОГО шага. По позиции в массиве он был бы первым — и всё
    // последующее (реплика, подпись, таймкод) уехало бы на шаг назад,
    // молча.
    expect(result.frames[0].stepIndex).toBe(1);
  });

  it('captureFrames:true, второй шаг проваливается — остаётся кадр первого, со своим номером', async () => {
    const screenshot = jest.fn().mockResolvedValue(new Uint8Array([1]));
    const locator = { click: jest.fn(), fill: jest.fn() };
    const page = buildPage({
      screenshot,
      locator: jest
        .fn()
        .mockImplementation((selector: string) =>
          selector === '[data-testid="broken"]'
            ? { click: jest.fn().mockRejectedValue(new Error('нет элемента')) }
            : locator,
        ),
    });
    const steps: ScenarioStep[] = [
      { kind: 'click', selector: '[data-testid="ok"]' },
      { kind: 'click', selector: '[data-testid="broken"]' },
    ];

    const result = await runScenario(page, steps, resolveOk, 15_000, true);

    expect(result.ok).toBe(false);
    expect(result.frames).toEqual([
      { stepIndex: 0, bytes: new Uint8Array([1]) },
    ]);
  });
});

describe('указатель клика: замер в момент снимка (этап H)', () => {
  // Кнопка «Далее»: CSS 30…360 × 740…790 при вьюпорте 390×844.
  const box = { x: 30, y: 740, width: 330, height: 50 };
  const pointerPage = (
    over: Partial<ScenarioPage> = {},
    found: typeof box | null = box,
  ) => {
    const order: string[] = [];
    const page = buildPage({
      screenshot: jest.fn(async () => {
        order.push('screenshot');
        return new Uint8Array([1]);
      }),
      $: jest.fn(async () => {
        order.push('$');
        return { boundingBox: jest.fn().mockResolvedValue(found) };
      }),
      viewport: jest.fn().mockReturnValue({ width: 390, height: 844 }),
      ...over,
    });
    return { page, order };
  };
  const steps: ScenarioStep[] = [
    { kind: 'goto', route: 'generate' },
    { kind: 'fill', selector: '#name', value: 'Товар' },
    { kind: 'click', selector: '#next' },
  ];

  it('выключенная кнопка — named отказ сразу, а не таймаут через 30 секунд', async () => {
    // Находка боевого прогона 29.09.2026. Позиции степпера
    // отрисованы как `<button disabled>`, пока шаг не пройден;
    // `locator().click()` ждал включения тридцать секунд и падал с
    // «Timed out after waiting 30000ms» — причина в этой строке не
    // названа. Восемь сценариев из девяти падали так и съели весь
    // бюджет тика.
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn(() => ({
        click: jest.fn().mockResolvedValue(undefined),
        fill: jest.fn().mockResolvedValue(undefined),
      })),
      $eval: jest.fn().mockResolvedValue(''),
      $: jest.fn().mockResolvedValue({
        boundingBox: jest.fn().mockResolvedValue(null),
        evaluate: jest.fn().mockResolvedValue(true),
      }),
      viewport: () => CAPTURE_VIEWPORT,
    } as unknown as ScenarioPage;

    const result = await runScenario(
      page,
      [{ kind: 'click', selector: '[data-qa="wizard-step-product"]' }],
      resolveOk,
    );

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(0);
    expect(result.steps[0].error).toContain('выключен');
    expect(result.steps[0].error).toContain('wizard-step-product');
    // Кликать выключённую кнопку не пробовали вовсе.
    expect(page.locator).not.toHaveBeenCalled();
  });

  it('включённая кнопка нажимается как раньше', async () => {
    const click = jest.fn().mockResolvedValue(undefined);
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn(() => ({ click, fill: jest.fn() })),
      $eval: jest.fn().mockResolvedValue(''),
      $: jest.fn().mockResolvedValue({
        boundingBox: jest.fn().mockResolvedValue(null),
        evaluate: jest.fn().mockResolvedValue(false),
      }),
      viewport: () => CAPTURE_VIEWPORT,
    } as unknown as ScenarioPage;

    const result = await runScenario(
      page,
      [{ kind: 'click', selector: '#go' }],
      resolveOk,
    );

    expect(result.ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);

    // Мок отдаёт своё значение, не исполняя колбэк, — значит сам
    // предикат надо проверить отдельно, иначе «выключено всегда» и
    // «выключено никогда» тест не различает.
    const evaluate = (await (page.$ as jest.Mock).mock.results[0].value)
      .evaluate as jest.Mock;
    const predicate = evaluate.mock.calls[0][0] as (el: unknown) => boolean;
    expect(predicate({ disabled: true })).toBe(true);
    expect(predicate({ disabled: false })).toBe(false);
    expect(predicate({})).toBe(false);
  });

  it('страница без $ или без evaluate — клик ведёт себя как раньше', async () => {
    // Мок, не знающий про проверку, не должен от неё падать: она
    // необязательная по построению.
    const click = jest.fn().mockResolvedValue(undefined);
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn(() => ({ click, fill: jest.fn() })),
      $eval: jest.fn().mockResolvedValue(''),
    } as unknown as ScenarioPage;

    const result = await runScenario(
      page,
      [{ kind: 'click', selector: '#go' }],
      resolveOk,
    );

    expect(result.ok).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('вьюпорт съёмки — телефонный, один на обучалку и снимки мастера', () => {
    expect(CAPTURE_VIEWPORT).toEqual({ width: 390, height: 844 });
  });

  it('указатель ложится на кадр ПЕРЕД кликом — там кнопка видна', async () => {
    const { page } = pointerPage();

    const result = await runScenario(page, steps, resolveOk, undefined, true);

    // Кадр шага 1 (fill) — последний перед кликом шага 2.
    expect(result.frames.map((f) => f.stepIndex)).toEqual([0, 1, 2]);
    expect(result.frames[1].pointer).toEqual({ x: 0.5, y: 0.9064 });
    expect(result.frames[0].pointer).toBeUndefined();
    expect(result.frames[2].pointer).toBeUndefined();
    expect(page.$).toHaveBeenCalledWith('#next');
    // Дважды: замер указателя перед снимком и проверка «кнопка не
    // выключена» перед самим нажатием (находка боевого прогона
    // 29.09.2026). Оба — БЕЗ ожидания, см. следующий тест.
    expect(page.$).toHaveBeenCalledTimes(2);
  });

  it('замер — сразу ПОСЛЕ снимка и без ожидания элемента', async () => {
    // Ожидание (как у локатора клика) дало бы рамку кнопки, которой на
    // снимке ещё нет.
    const { page, order } = pointerPage();

    await runScenario(page, steps, resolveOk, undefined, true);

    // Второй `$` — перед кликом: спросить, не выключена ли кнопка,
    // дешевле, чем узнать это таймаутом через тридцать секунд.
    expect(order).toEqual(['screenshot', 'screenshot', '$', '$', 'screenshot']);
    expect(page.waitForSelector).not.toHaveBeenCalled();
  });

  it('снимок не удался — нет кадра, нет и указателя, и прогон не падает', async () => {
    const { page } = pointerPage({
      screenshot: jest
        .fn()
        .mockResolvedValueOnce(new Uint8Array([1]))
        .mockRejectedValueOnce(new Error('гонка CDP'))
        .mockResolvedValue(new Uint8Array([1])),
    });

    const result = await runScenario(page, steps, resolveOk, undefined, true);

    expect(result.ok).toBe(true);
    expect(result.frames.map((f) => f.stepIndex)).toEqual([0, 2]);
    expect(result.frames.some((f) => f.pointer)).toBe(false);
    // Замера указателя не было (снимка нет — мерить не для чего), но
    // проверка «кнопка не выключена» перед кликом идёт всегда: она не
    // про кадр, а про то, чтобы не ждать таймаут зря.
    expect(page.$).toHaveBeenCalledTimes(1);
    expect(page.$).toHaveBeenCalledWith('#next');
  });

  it('без captureFrames указатель не меряется — но кнопку всё равно проверяем', async () => {
    const { page } = pointerPage();
    await runScenario(page, steps, resolveOk);
    // Ровно один вызов, и тот перед кликом: указателю без кадров
    // мерить нечего.
    expect(page.$).toHaveBeenCalledTimes(1);
    expect(page.$).toHaveBeenCalledWith('#next');
  });

  type Box = typeof box;
  const noPointer: Array<[string, Box | null | undefined]> = [
    ['элемента нет на странице', null],
    ['рамки нет — элемент скрыт', undefined],
    ['рамка пустая', { ...box, width: 0 }],
    ['центр ниже экрана — клик прокрутил бы страницу', { ...box, y: 900 }],
    ['центр левее экрана', { ...box, x: -400 }],
  ];

  it.each(noPointer)(
    '%s — указателя нет',
    async (_name: string, found: Box | null | undefined) => {
      const page = buildPage({
        viewport: () => ({ width: 390, height: 844 }),
        $: jest.fn(async () =>
          found === null
            ? null
            : { boundingBox: jest.fn().mockResolvedValue(found ?? null) },
        ),
      });
      expect(await measurePointer(page, '#next')).toBeNull();
    },
  );

  it('страница без $ или без вьюпорта — без указателя, без ошибки', async () => {
    expect(await measurePointer(buildPage(), '#x')).toBeNull();
    expect(
      await measurePointer(
        buildPage({
          $: jest.fn(),
          viewport: () => null,
        }),
        '#x',
      ),
    ).toBeNull();
  });

  it('сбой замера глотается — это улучшение, а не условие прогона', async () => {
    const page = buildPage({
      viewport: () => ({ width: 390, height: 844 }),
      $: jest.fn().mockRejectedValue(new Error('страница закрылась')),
    });
    expect(await measurePointer(page, '#x')).toBeNull();
  });

  it('доли округлены до десятитысячных — дробный хвост рамки не меняет отпечаток', async () => {
    const page = buildPage({
      viewport: () => ({ width: 390, height: 844 }),
      $: jest.fn(async () => ({
        boundingBox: jest.fn().mockResolvedValue({
          x: 10.123456,
          y: 20.987654,
          width: 33.333333,
          height: 11.111111,
        }),
      })),
    });
    const p = (await measurePointer(page, '#x'))!;
    expect(String(p.x).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(String(p.y).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
    expect(p.x).toBeCloseTo((10.123456 + 33.333333 / 2) / 390, 4);
  });
});

/**
 * Платный клик не исполняется — находка сквозного аудита 29.09.2026.
 * До неё `click` за маркером нажимался буквально, то есть регрессионный
 * прогон запускал настоящий рендер Veo каждую ночь.
 */
describe('runScenario — платный клик', () => {
  function pageSpy() {
    const clicked: string[] = [];
    const shots: number[] = [];
    let shot = 0;
    return {
      clicked,
      shots,
      page: {
        goto: jest.fn().mockResolvedValue(undefined),
        waitForSelector: jest.fn().mockResolvedValue(undefined),
        locator: (selector: string) => ({
          click: jest.fn().mockImplementation(async () => {
            clicked.push(selector);
          }),
          fill: jest.fn().mockResolvedValue(undefined),
        }),
        $eval: jest.fn().mockResolvedValue(''),
        screenshot: jest.fn().mockImplementation(async () => {
          shots.push(shot);
          return new Uint8Array([shot++]);
        }),
      } as never,
    };
  }
  const route = () => ({ ok: true as const, url: 'https://tma.example/#/x' });

  it('клик сразу за triggerPaidOperation не нажимается и не даёт кадра', async () => {
    const { page, clicked } = pageSpy();
    const result = await runScenario(
      page,
      [
        { kind: 'goto', route: 'generate-ready' },
        {
          kind: 'triggerPaidOperation',
          operation: 'generation',
          model: 'veo-3.1-generate-preview',
          expectedUnits: { seconds: 8 },
          note: 'рендер ролика',
        },
        { kind: 'click', selector: '[data-qa="video-generate"]' },
      ] as never,
      route,
      1000,
      true,
    );

    expect(result.ok).toBe(true);
    // Главное: кнопка рендера НЕ нажата.
    expect(clicked).toEqual([]);
    expect(result.skippedPaidClicks).toEqual([2]);
    expect(result.steps[2]).toMatchObject({ ok: true, skippedAsPaid: true });
    // Кадр экрана ДО нажатия остаётся (его даёт сам маркер), кадра
    // пропущенного клика нет — иначе в ролик уехал бы дубль.
    expect(result.frames.map((f) => f.stepIndex)).toEqual([0, 1]);
  });

  it('обычный клик, не идущий за маркером, нажимается как раньше', async () => {
    const { page, clicked } = pageSpy();
    const result = await runScenario(
      page,
      [
        { kind: 'goto', route: 'generate' },
        { kind: 'click', selector: '[data-qa="reference-tab-link"]' },
      ] as never,
      route,
      1000,
      true,
    );

    expect(clicked).toEqual(['[data-qa="reference-tab-link"]']);
    expect(result.skippedPaidClicks).toEqual([]);
  });

  it('пропускается ТОЛЬКО соседний клик, следующий за ним — обычный', async () => {
    // Иначе один маркер глушил бы весь хвост сценария, и оператор
    // считал бы пройденным то, что не исполнялось.
    const { page, clicked } = pageSpy();
    const result = await runScenario(
      page,
      [
        {
          kind: 'triggerPaidOperation',
          operation: 'generation',
          model: 'veo-3.1-generate-preview',
          expectedUnits: { seconds: 8 },
          note: 'рендер',
        },
        { kind: 'click', selector: '[data-qa="video-generate"]' },
        { kind: 'click', selector: '[data-qa="open-postprod"]' },
      ] as never,
      route,
      1000,
      false,
    );

    expect(clicked).toEqual(['[data-qa="open-postprod"]']);
    expect(result.skippedPaidClicks).toEqual([1]);
  });
});

/**
 * Пропавший кадр обязан быть виден снаружи — сквозной аудит
 * 29.09.2026. Пустой `catch` прятал единственный след частичного
 * успеха: ролик из пяти кадров вместо десяти и ни строчки об этом.
 */
describe('runScenario — несостоявшийся снимок', () => {
  it('сбой скриншота не роняет прогон, но попадает в skippedFrames', async () => {
    let n = 0;
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: () => ({
        click: jest.fn().mockResolvedValue(undefined),
        fill: jest.fn().mockResolvedValue(undefined),
      }),
      $eval: jest.fn().mockResolvedValue(''),
      screenshot: jest.fn().mockImplementation(async () => {
        n++;
        if (n === 2) throw new Error('страница в переходном состоянии');
        return new Uint8Array([n]);
      }),
    } as never;

    const result = await runScenario(
      page,
      [
        { kind: 'goto', route: 'generate' },
        { kind: 'waitFor', selector: '[data-qa="reference-card"]' },
        { kind: 'assertVisible', selector: '[data-qa="reference-card"]' },
      ] as never,
      () => ({ ok: true as const, url: 'https://tma.example/#/generate' }),
      1000,
      true,
    );

    expect(result.ok).toBe(true);
    // Дыра в нумерации, а не сдвиг: шаг 1 пропал, шаги 0 и 2 на месте.
    expect(result.frames.map((f) => f.stepIndex)).toEqual([0, 2]);
    expect(result.skippedFrames).toEqual([
      { stepIndex: 1, error: 'страница в переходном состоянии' },
    ]);
  });

  it('всё снялось — список пуст, а не отсутствует', async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: () => ({ click: jest.fn(), fill: jest.fn() }),
      $eval: jest.fn().mockResolvedValue(''),
      screenshot: jest.fn().mockResolvedValue(new Uint8Array([1])),
    } as never;

    const result = await runScenario(
      page,
      [{ kind: 'goto', route: 'generate' }] as never,
      () => ({ ok: true as const, url: 'https://tma.example/#/generate' }),
      1000,
      true,
    );
    expect(result.skippedFrames).toEqual([]);
  });
});

describe('подготовка кадра (просмотр роликов прода 01.10.2026)', () => {
  function recordingPage() {
    const log: string[] = [];
    const page = buildPage({
      screenshot: jest.fn(async () => {
        log.push('shot');
        return new Uint8Array([1]);
      }),
      waitForNetworkIdle: jest.fn(async () => {
        log.push('network');
      }),
      waitForFunction: jest.fn(async () => {
        log.push('spinner');
      }),
      evaluate: jest.fn(async (_fn: unknown, arg: unknown) => {
        log.push(`scroll:${String(arg)}`);
      }) as ScenarioPage['evaluate'],
    });
    return { page, log };
  }

  it('после перехода — затишье сети и нет спиннера, потом снимок', async () => {
    const { page, log } = recordingPage();
    await runScenario(
      page,
      [{ kind: 'goto', route: 'generate' }],
      resolveOk,
      undefined,
      true,
    );
    expect(log).toEqual(['network', 'spinner', 'shot']);
    expect(page.waitForNetworkIdle).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: FRAME_SETTLE_NETWORK_MS }),
    );
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: FRAME_SETTLE_SPINNER_MS,
    });
  });

  it('шаг с селектором — элемент в центр экрана до снимка, сеть не ждём', async () => {
    const { page, log } = recordingPage();
    await runScenario(
      page,
      [{ kind: 'waitFor', selector: '[data-qa="greeting-video-card"]' }],
      resolveOk,
      undefined,
      true,
    );
    expect(log).toEqual([
      'scroll:[data-qa="greeting-video-card"]',
      'spinner',
      'shot',
    ]);
  });

  it('прокрутка в странице: scrollIntoView по центру', async () => {
    const { page } = recordingPage();
    await runScenario(
      page,
      [{ kind: 'assertVisible', selector: '#card' }],
      resolveOk,
      undefined,
      true,
    );
    const fn = (page.evaluate as jest.Mock).mock.calls[0][0] as (
      sel: string,
    ) => void;
    const scrollIntoView = jest.fn();
    const querySelector = jest.fn().mockReturnValue({ scrollIntoView });
    (global as unknown as { document: unknown }).document = { querySelector };
    try {
      fn('#card');
    } finally {
      delete (global as unknown as { document?: unknown }).document;
    }
    expect(querySelector).toHaveBeenCalledWith('#card');
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'center',
      behavior: 'instant',
    });
  });

  it('ожидания мягкие: их отказ не роняет шаг и не отменяет кадр', async () => {
    const { page } = recordingPage();
    (page.waitForNetworkIdle as jest.Mock).mockRejectedValue(new Error('t'));
    (page.waitForFunction as jest.Mock).mockRejectedValue(new Error('t'));
    (page.evaluate as jest.Mock).mockRejectedValue(new Error('t'));
    const result = await runScenario(
      page,
      [
        { kind: 'goto', route: 'generate' },
        { kind: 'waitFor', selector: '#x' },
      ],
      resolveOk,
      undefined,
      true,
    );
    expect(result.ok).toBe(true);
    expect(result.frames).toHaveLength(2);
  });

  it('без кадров — никакой подготовки', async () => {
    const { page, log } = recordingPage();
    await runScenario(page, [{ kind: 'goto', route: 'generate' }], resolveOk);
    expect(log).toEqual([]);
  });
});

describe('кадр с экрана другого шага не снимается (01.10.2026)', () => {
  it('goto → клик по позиции степпера: кадр после goto пропущен', async () => {
    const shot = jest.fn().mockResolvedValue(new Uint8Array([1]));
    const page = buildPage({ screenshot: shot });
    const result = await runScenario(
      page,
      [
        { kind: 'goto', route: 'generate-ready' },
        { kind: 'click', selector: '[data-qa="wizard-step-analysis"]' },
        { kind: 'waitFor', selector: '[data-qa="analysis-card"]' },
      ],
      resolveOk,
      undefined,
      true,
    );
    expect(result.frames.map((f) => f.stepIndex)).toEqual([1, 2]);
    // Пропуск — не сбой кадра: в «не снялось» он не попадает.
    expect(result.skippedFrames).toEqual([]);
  });

  it('после goto другой шаг или другой клик — кадр снимается', () => {
    const goto = { kind: 'goto' as const, route: 'generate-ready' };
    expect(
      opensOtherStepScreen(goto, {
        kind: 'click',
        selector: '[data-qa="analysis-continue"]',
      }),
    ).toBe(false);
    expect(
      opensOtherStepScreen(goto, { kind: 'waitFor', selector: '#x' }),
    ).toBe(false);
    expect(opensOtherStepScreen(goto, undefined)).toBe(false);
    expect(
      opensOtherStepScreen(
        { kind: 'click', selector: '[data-qa="x"]' },
        { kind: 'click', selector: '[data-qa="wizard-step-prompt"]' },
      ),
    ).toBe(false);
    expect(
      opensOtherStepScreen(goto, {
        kind: 'click',
        selector: '[data-qa="wizard-step-prompt"]',
      }),
    ).toBe(true);
  });
});
