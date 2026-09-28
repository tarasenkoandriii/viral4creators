import {
  isTriggerPaidOperationStep,
  mergeNarration,
  parseScenarioSteps,
} from './scenario-steps';
import { stableStringify } from '../../common/stable-json';
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

describe('parseScenarioSteps — реплики (этап D)', () => {
  const click = (over: Record<string, unknown> = {}) => ({
    kind: 'click',
    selector: '#run',
    ...over,
  });

  it('годная реплика доезжает до шага как есть', () => {
    const r = parseScenarioSteps([
      click({ narration: 'Нажимаем «Запустить».' }),
    ]);

    expect(r.ok).toBe(true);
    expect(r.steps[0]).toEqual({
      kind: 'click',
      selector: '#run',
      narration: 'Нажимаем «Запустить».',
    });
    expect(r.droppedNarrations).toEqual([]);
  });

  it('шага без реплики достаточно — поле необязательное', () => {
    // Сделать его обязательным значило бы, что в момент деплоя этапа
    // D каждый уже сохранённый сценарий становится невалидным, а
    // вместе с ним отваливается регрессионный прогон, к озвучке
    // отношения не имеющий (§3-бис.2 ТЗ).
    const r = parseScenarioSteps([click()]);

    expect(r.ok).toBe(true);
    expect(r.droppedNarrations).toEqual([]);
  });

  it('плохая реплика отбрасывает СЕБЯ, а не весь сценарий', () => {
    // Единственное место, где всё-или-ничего сознательно не
    // применяется: плохая подпись к кадру не должна лишать нас
    // регрессионного прогона, ради которого сценарий и существует.
    const r = parseScenarioSteps([
      click({ narration: 'x'.repeat(221) }),
      { kind: 'waitFor', selector: '#done' },
    ]);

    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0]).toEqual({ kind: 'click', selector: '#run' });
    expect(r.droppedNarrations).toEqual([
      { stepNumber: 1, reason: expect.stringContaining('220') },
    ]);
  });

  it('отброшенная реплика ВЫРЕЗАЕТСЯ, а не остаётся лежать', () => {
    // Иначе она доедет до базы и до карточки в админке, где выглядит
    // сохранённым текстом, и отличить «отбросили» от «озвучим» будет
    // нечем.
    const r = parseScenarioSteps([click({ narration: '   ' })]);

    expect(Object.keys(r.steps[0])).not.toContain('narration');
  });

  it('220 символов — можно, 221 — нельзя', () => {
    expect(
      parseScenarioSteps([click({ narration: 'ы'.repeat(220) })])
        .droppedNarrations,
    ).toEqual([]);
    expect(
      parseScenarioSteps([click({ narration: 'ы'.repeat(221) })])
        .droppedNarrations,
    ).toHaveLength(1);
  });

  it('длина считается ПОСЛЕ trim — пробелы по краям не реплика', () => {
    expect(
      parseScenarioSteps([click({ narration: `  ${'ы'.repeat(220)}  ` })])
        .droppedNarrations,
    ).toEqual([]);
  });

  it('перевод строки — отказ: реплика это одна фраза', () => {
    // Многострочность ломает и `.ass`-подписи этапа E, и звучит как
    // пауза в случайном месте.
    for (const bad of ['Первая\nвторая', 'Первая\r\nвторая']) {
      expect(
        parseScenarioSteps([click({ narration: bad })]).droppedNarrations,
      ).toEqual([{ stepNumber: 1, reason: expect.stringContaining('строк') }]);
    }
  });

  it('пустая реплика и отсутствие поля значат одно и то же', () => {
    const empty = parseScenarioSteps([click({ narration: '' })]);
    const absent = parseScenarioSteps([click()]);

    expect(empty.steps).toEqual(absent.steps);
    // Но пустая — ещё и названа, иначе опечатка в генераторе молчит.
    expect(empty.droppedNarrations).toHaveLength(1);
  });

  it('не строка — отказ, а не приведение к строке', () => {
    expect(
      parseScenarioSteps([click({ narration: 42 })]).droppedNarrations,
    ).toEqual([{ stepNumber: 1, reason: 'реплика не строка' }]);
  });

  it('у triggerPaidOperation реплики не бывает — но шаг остаётся', () => {
    // Произносить нечего: это декларативный маркер. Кадр у него при
    // этом ЕСТЬ и получает тишину — путать «реплики нет» и «кадра
    // нет» нельзя (§3-бис.2, врезка).
    const r = parseScenarioSteps([
      {
        kind: 'triggerPaidOperation',
        operation: 'generation',
        model: 'veo-3.1-generate-preview',
        expectedUnits: { seconds: 8 },
        note: 'Veo рендер',
        narration: 'Ждём, пока модель отрисует ролик.',
      },
    ]);

    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(1);
    expect(Object.keys(r.steps[0])).not.toContain('narration');
    expect(r.droppedNarrations).toEqual([
      { stepNumber: 1, reason: 'у triggerPaidOperation реплики не бывает' },
    ]);
  });

  it('номер шага в отказе — человеческий, с единицы', () => {
    const r = parseScenarioSteps([click(), click(), click({ narration: '' })]);

    expect(r.droppedNarrations[0].stepNumber).toBe(3);
  });

  it('отказ разбора шагов не отчитывается о репликах', () => {
    // Шагов нет — говорить не о чем, и пустой `droppedNarrations`
    // здесь честнее, чем частичный список до места падения.
    const r = parseScenarioSteps([click({ narration: '' }), { kind: 'нет' }]);

    expect(r.ok).toBe(false);
    expect(r.droppedNarrations).toEqual([]);
  });
});

describe('mergeNarration — реплика переживает ночную перегенерацию', () => {
  const step = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'click',
      selector: '#run',
      ...over,
    }) as never;

  it('шаг тот же, формулировка другая — остаётся ПРЕЖНЯЯ реплика', () => {
    // Иначе ночной крон менял бы текст каждую ночь, а на текст
    // завязаны кеш озвучки, отпечаток сборки и отметка о вычитке.
    const merged = mergeNarration(
      [step({ narration: 'Нажимаем «Запустить».' })],
      [step({ narration: 'Жмём кнопку запуска.' })],
    );

    expect(merged).toEqual([
      { kind: 'click', selector: '#run', narration: 'Нажимаем «Запустить».' },
    ]);
  });

  it('изменился САМ шаг — берётся новая реплика целиком', () => {
    // «Реплика изменилась» значит «изменился шаг, к которому она
    // написана», а не «модель подобрала другие слова».
    const merged = mergeNarration(
      [step({ selector: '#old', narration: 'Старая.' })],
      [step({ selector: '#new', narration: 'Новая.' })],
    );

    expect(merged).toEqual([
      { kind: 'click', selector: '#new', narration: 'Новая.' },
    ]);
  });

  it('у прежнего шага реплики не было — берётся новая', () => {
    // Сценарии, сгенерированные до этапа D, обязаны получить реплики
    // с первой же ночи; иначе они не получат их никогда.
    const merged = mergeNarration([step()], [step({ narration: 'Жмём.' })]);

    expect(merged[0]).toHaveProperty('narration', 'Жмём.');
  });

  it('прежняя реплика негодна — берётся новая, а не переносится мимо валидации', () => {
    // В базе может лежать строка, сохранённая до ужесточения правил.
    const merged = mergeNarration(
      [step({ narration: 'x'.repeat(300) })],
      [step({ narration: 'Короткая.' })],
    );

    expect(merged[0]).toHaveProperty('narration', 'Короткая.');
  });

  it('в базе пусто или мусор — берётся свежий ответ целиком', () => {
    const fresh = [step({ narration: 'Жмём.' })];
    expect(mergeNarration(null, fresh)).toEqual(fresh);
    expect(mergeNarration('не массив', fresh)).toEqual(fresh);
    expect(mergeNarration([], fresh)).toEqual(fresh);
  });

  it('сравнение позиционное: вставленный шаг разъезжает остальные', () => {
    // И это верно: сценарий стал другим, а не «тот же со сдвигом».
    const merged = mergeNarration(
      [
        step({ selector: '#a', narration: 'Первая.' }),
        step({ selector: '#b', narration: 'Вторая.' }),
      ],
      [
        step({ selector: '#new', narration: 'Новая нулевая.' }),
        step({ selector: '#a', narration: 'Свежая первая.' }),
        step({ selector: '#b', narration: 'Свежая вторая.' }),
      ],
    );

    expect(merged.map((s) => (s as { narration?: string }).narration)).toEqual([
      'Новая нулевая.',
      'Свежая первая.',
      'Свежая вторая.',
    ]);
  });

  it('порядок ключей из jsonb не считается изменением шага', () => {
    // `steps` — колонка `jsonb`, Postgres хранит короткие ключи
    // раньше длинных. Прямое сравнение объектов объявляло бы
    // изменением любой шаг с `value` (та же находка, что у
    // `stableStringify`).
    const merged = mergeNarration(
      [{ kind: 'fill', value: 'x', selector: '#a', narration: 'Прежняя.' }],
      [
        {
          kind: 'fill',
          selector: '#a',
          value: 'x',
          narration: 'Свежая.',
        } as never,
      ],
    );

    expect(merged[0]).toHaveProperty('narration', 'Прежняя.');
  });

  it('слияние идемпотентно: второй прогон ничего не меняет', () => {
    // Ради этого всё и делается — устоявшееся состояние обязано быть
    // неподвижным, иначе кеш, отпечаток и отметка о вычитке
    // сбрасываются каждую ночь.
    const stored = [step({ narration: 'Прежняя.' })];
    const first = mergeNarration(stored, [step({ narration: 'Иначе.' })]);
    const second = mergeNarration(first, [step({ narration: 'Ещё иначе.' })]);

    expect(stableStringify(second)).toBe(stableStringify(stored));
  });
});
