import {
  isTriggerPaidOperationStep,
  parseScenarioSteps,
} from './scenario-steps';
import { MAX_SCENARIO_STEPS } from './scenario-steps.types';

describe('parseScenarioSteps', () => {
  it('принимает валидную последовательность разных видов шагов', () => {
    const result = parseScenarioSteps([
      { kind: 'goto', route: 'wizard.product' },
      { kind: 'fill', selector: '[data-testid="name"]', value: 'Товар' },
      { kind: 'click', selector: '[data-testid="next"]' },
      { kind: 'waitFor', selector: '[data-testid="preview"]' },
      { kind: 'assertVisible', selector: '[data-testid="preview"]' },
      {
        kind: 'assertText',
        selector: '[data-testid="status"]',
        value: 'Готово',
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(6);
    expect(result.reason).toBeUndefined();
  });

  it('принимает triggerPaidOperation с валидным operation/model/expectedUnits', () => {
    const result = parseScenarioSteps([
      { kind: 'goto', route: 'wizard.generation' },
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'Veo, ожидаемо 8 секунд рендера',
      },
      { kind: 'click', selector: '[data-testid="generate"]' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(isTriggerPaidOperationStep(result.steps[1])).toBe(true);
  });

  it('пустой массив — весь сценарий отбрасывается', () => {
    const result = parseScenarioSteps([]);
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.reason).toBe('пустой сценарий');
  });

  it('не массив — отбрасывается', () => {
    expect(parseScenarioSteps({ steps: [] }).ok).toBe(false);
    expect(parseScenarioSteps(null).ok).toBe(false);
    expect(parseScenarioSteps('nope').ok).toBe(false);
  });

  it('слишком много шагов — отбрасывается целиком', () => {
    const steps = Array.from({ length: MAX_SCENARIO_STEPS + 1 }, () => ({
      kind: 'click',
      selector: '[data-testid="x"]',
    }));
    const result = parseScenarioSteps(steps);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('слишком много шагов');
  });

  it('all-or-nothing: один невалидный шаг в середине роняет весь сценарий, а не только его', () => {
    const result = parseScenarioSteps([
      { kind: 'goto', route: 'wizard.product' },
      { kind: 'click' }, // нет selector
      { kind: 'waitFor', selector: '[data-testid="preview"]' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([]);
    expect(result.reason).toBe('шаг 2 невалиден');
  });

  it('неизвестный kind — невалиден', () => {
    const result = parseScenarioSteps([{ kind: 'eval', code: 'alert(1)' }]);
    expect(result.ok).toBe(false);
  });

  it('triggerPaidOperation с неизвестной operation — невалиден', () => {
    const result = parseScenarioSteps([
      {
        kind: 'triggerPaidOperation',
        operation: 'не-существует',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'x',
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it('triggerPaidOperation с отрицательным expectedUnits.seconds — невалиден', () => {
    const result = parseScenarioSteps([
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: -5 },
        note: 'x',
      },
    ]);
    expect(result.ok).toBe(false);
  });

  // Найдено доп. аудитом (MEDIUM): раньше `expectedUnits: {}` (ни одна
  // единица объёма не задана) проходила валидацию — для известной модели
  // это давало уверенный `costMicroUsd: 0` вместо помеченной недостоверной
  // оценки, хотя доверять такому числу нечего.
  it('triggerPaidOperation с пустым expectedUnits (ни одной единицы объёма) — невалиден', () => {
    const result = parseScenarioSteps([
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: {},
        note: 'x',
      },
    ]);
    expect(result.ok).toBe(false);
  });

  it('fill без value или с value не-строкой — невалиден', () => {
    expect(
      parseScenarioSteps([{ kind: 'fill', selector: '[data-testid="x"]' }]).ok,
    ).toBe(false);
    expect(
      parseScenarioSteps([
        { kind: 'fill', selector: '[data-testid="x"]', value: 42 },
      ]).ok,
    ).toBe(false);
  });
});

describe('isTriggerPaidOperationStep', () => {
  it('различает виды шагов', () => {
    expect(
      isTriggerPaidOperationStep({ kind: 'click', selector: 'x' } as never),
    ).toBe(false);
    expect(
      isTriggerPaidOperationStep({
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'x',
        expectedUnits: {},
        note: 'x',
      } as never),
    ).toBe(true);
  });
});
