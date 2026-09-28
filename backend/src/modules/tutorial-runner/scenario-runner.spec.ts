import {
  measurePointer,
  runScenario,
  SCENARIO_VIEWPORT,
  ScenarioPage,
  ScenarioRouteResolver,
} from './scenario-runner';
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

  it('вьюпорт съёмки — телефонный, один на обучалку и снимки мастера', () => {
    expect(SCENARIO_VIEWPORT).toEqual({ width: 390, height: 844 });
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
    expect(page.$).toHaveBeenCalledTimes(1);
  });

  it('замер — сразу ПОСЛЕ снимка и без ожидания элемента', async () => {
    // Ожидание (как у локатора клика) дало бы рамку кнопки, которой на
    // снимке ещё нет.
    const { page, order } = pointerPage();

    await runScenario(page, steps, resolveOk, undefined, true);

    expect(order).toEqual(['screenshot', 'screenshot', '$', 'screenshot']);
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
    expect(page.$).not.toHaveBeenCalled();
  });

  it('без captureFrames не меряется ничего', async () => {
    const { page } = pointerPage();
    await runScenario(page, steps, resolveOk);
    expect(page.$).not.toHaveBeenCalled();
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
