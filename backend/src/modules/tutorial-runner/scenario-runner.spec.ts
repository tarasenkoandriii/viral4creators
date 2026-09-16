import {
  runScenario,
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
    expect(Array.from(result.frames[0])).toEqual([1]);
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
    expect(Array.from(result.frames[0])).toEqual([9]);
  });

  it('captureFrames:true, шаг 2 из 3 проваливается — кадр есть только после шага 1', async () => {
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
    expect(result.frames).toHaveLength(1);
  });
});
