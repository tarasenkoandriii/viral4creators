import { AssistantStepItem } from '../assistant/knowledge/generated';
import {
  buildScenarioPrompt,
  parseScenarioResponse,
} from './tutorial-scenario-prompt';
import {
  MAX_NARRATION_LENGTH,
  WIZARD_PAID_OPERATIONS,
} from './scenario-steps.types';
import { AI_OPERATION_LABEL } from '../../common/ai-pricing';
import { QA_HOOKS } from './qa-hooks';

const step: AssistantStepItem = {
  title: 'Заведите товар',
  text: 'Проект и товар: фото, описание, цена.',
  details: ['Быстрый путь без проекта тоже работает'],
};

describe('buildScenarioPrompt — каталог селекторов (этап I)', () => {
  it('перечисляет каждый хук каталога готовым селектором и не зовёт писать плейсхолдеры', () => {
    const prompt = buildScenarioPrompt('2', 'ru', step);
    for (const key of Object.keys(QA_HOOKS)) {
      expect(prompt).toContain(`[data-qa="${key}"]`);
    }
    expect(prompt).not.toContain('оператор поправит');
    expect(prompt).toContain('НЕ плейсхолдер и НЕ произвольный CSS');
  });
});

describe('buildScenarioPrompt', () => {
  it('включает заголовок/описание/детали шага и словарь примитивов', () => {
    const prompt = buildScenarioPrompt('1', 'ru', step);
    expect(prompt).toContain('шаг "1"');
    expect(prompt).toContain('ru');
    expect(prompt).toContain('Заведите товар');
    expect(prompt).toContain('Проект и товар: фото, описание, цена.');
    expect(prompt).toContain('Быстрый путь без проекта тоже работает');
    expect(prompt).toContain('"kind":"goto"');
    expect(prompt).toContain('"kind":"triggerPaidOperation"');
    expect(prompt).toContain('{"steps":[...]}');
  });

  it('промпт называет ровно ДОСТИЖИМЫЕ операции — подмножество белого списка (этап F, уточнено повторным аудитом)', () => {
    // Две стороны одного контракта, но они не равны, и это нарочно.
    // Валидатор ПРИНИМАЕТ весь `WIZARD_PAID_OPERATIONS` — иначе
    // сценарий, сохранённый до этапа I, перестал бы разбираться.
    // Промпт ПРЕДЛАГАЕТ только то, для чего в каталоге хуков есть
    // кнопка: назвать модели операцию, которую нечем нажать, значит
    // позвать её написать шаг, который будет вырезан
    // (`dropDanglingPaidOperations`).
    const prompt = buildScenarioPrompt('1', 'ru', step);
    const listed = /"operation":((?:"[a-z-]+"\|?)+)/.exec(prompt);
    expect(listed).not.toBeNull();
    const values = listed![1].split('|').map((v) => v.replace(/"/g, ''));
    const reachable = WIZARD_PAID_OPERATIONS.filter((op) =>
      Object.values(QA_HOOKS).some((hook) => hook.clickCost === op),
    );
    expect(values).toEqual([...reachable]);
    expect(values.length).toBeGreaterThan(0);
    // И ни одной фоновой строки отчёта — ни в перечне, ни в
    // пояснении к нему.
    const background = Object.keys(AI_OPERATION_LABEL).filter(
      (op) => !(WIZARD_PAID_OPERATIONS as readonly string[]).includes(op),
    );
    for (const op of background) {
      expect(prompt).not.toContain(`"${op}"`);
    }
  });

  it('у каждой операции мастера есть пояснение в промпте', () => {
    // Пояснение — `Record` по типу списка, но проверяем и текст:
    // значение без пояснения модель выбирает наугад.
    const prompt = buildScenarioPrompt('1', 'ru', step);
    const reachable = WIZARD_PAID_OPERATIONS.filter((op) =>
      Object.values(QA_HOOKS).some((hook) => hook.clickCost === op),
    );
    for (const op of reachable) {
      expect(prompt).toMatch(new RegExp(`[а-яё-]+ — "${op}"`));
    }
  });

  it('про выключенную кнопку степпера промпт говорит прямо', () => {
    // Находка боевого прогона 29.09.2026. Без этой строки модель
    // писала «открыть экран → нажать нужный шаг», и такой клик ждал
    // включения кнопки тридцать секунд и падал.
    const prompt = buildScenarioPrompt('1', 'ru', step);
    const stepperLine = prompt
      .split('\n')
      .find((l) => l.includes('wizard-step-product'));

    expect(stepperLine).toBeDefined();
    expect(stepperLine).toContain('НЕ НАЖИМАТЬ для перехода');
    expect(stepperLine).toContain('пока шаг не пройден');

    // И ровно у помеченных: предупреждение на всех подряд
    // обесценивает его.
    const warned = prompt
      .split('\n')
      .filter((l) => l.includes('НЕ НАЖИМАТЬ для перехода')).length;
    const marked = Object.values(QA_HOOKS).filter(
      (h) => h.clickOnlyWhenVisited,
    ).length;
    expect(warned).toBe(marked);
    expect(warned).toBeGreaterThan(0);
  });

  it('без деталей — раздела "Детали:" нет вовсе', () => {
    const prompt = buildScenarioPrompt('2', 'ru', { ...step, details: [] });
    expect(prompt).not.toContain('Детали:');
  });

  it('перечисляет настоящие маршруты вместо приглашения придумать плейсхолдер (этап 106: 9/9 сценариев падали на "wizard.step-N")', () => {
    const prompt = buildScenarioPrompt('1', 'ru', step);
    // Реальные ключи из route-templates.ts — каждый должен быть виден
    // модели буква в букву.
    for (const key of [
      'projects',
      'item',
      'generate',
      'postprod',
      'manifest',
      'plan',
    ]) {
      expect(prompt).toContain(`"${key}"`);
    }
    // Старая формулировка приводила несуществующий маршрут КАК ПРИМЕР —
    // именно она и породила "wizard.generation"/"wizard.step-N" в
    // реальных сгенерированных сценариях; проверяем, что она ушла.
    expect(prompt).not.toContain('wizard.generation');
    expect(prompt).not.toContain('route" в шаге goto — это тоже плейсхолдер');
    expect(prompt).toContain('НЕ плейсхолдер');
  });
});

describe('parseScenarioResponse', () => {
  it('разбирает {"steps":[...]} внутри ```json ограждения', () => {
    const text =
      '```json\n{"steps":[{"kind":"goto","route":"wizard.product"},' +
      '{"kind":"click","selector":"[data-qa=\\"analysis-continue\\"]"}]}\n```';
    const result = parseScenarioResponse(text);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
  });

  it('разбирает голый JSON без ограждения', () => {
    const text = '{"steps":[{"kind":"goto","route":"wizard.product"}]}';
    const result = parseScenarioResponse(text);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  it('селектор не из каталога data-qa — отказ с номером шага и самим селектором (этап I)', () => {
    const cases = [
      '[data-qa="next"]', // похоже, но такого хука нет
      '#promptText', // настоящий id, но не хук
      '[data-qa="prompt-approve"] button', // потомок через пробел
      '[data-testid="prompt-approve"]', // чужое соглашение
    ];
    for (const selector of cases) {
      const result = parseScenarioResponse(
        JSON.stringify({
          steps: [
            { kind: 'goto', route: 'generate' },
            { kind: 'click', selector },
          ],
        }),
      );
      expect(result.ok).toBe(false);
      expect(result.steps).toEqual([]);
      expect(result.reason).toContain('шаг 2 (click)');
      expect(result.reason).toContain(selector);
    }
  });

  it('все виды шагов с селектором проверяются, а не только click', () => {
    for (const kind of ['fill', 'waitFor', 'assertVisible', 'assertText']) {
      const result = parseScenarioResponse(
        JSON.stringify({ steps: [{ kind, selector: '.btn', value: 'x' }] }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toContain(`шаг 1 (${kind})`);
    }
  });

  it('платную кнопку вне списка операций нажимать нельзя, ждать можно (аудит этапа I)', () => {
    for (const key of [
      'reference-link-submit',
      'relevance-check',
      'prompt-generate',
    ]) {
      const click = parseScenarioResponse(
        JSON.stringify({
          steps: [{ kind: 'click', selector: `[data-qa="${key}"]` }],
        }),
      );
      expect(click.ok).toBe(false);
      expect(click.reason).toContain('нажимать его сценарию нельзя');
      const wait = parseScenarioResponse(
        JSON.stringify({
          steps: [{ kind: 'waitFor', selector: `[data-qa="${key}"]` }],
        }),
      );
      expect(wait.ok).toBe(true);
    }
  });

  it('рендер нажимается только сразу после triggerPaidOperation "generation"', () => {
    const paid = {
      kind: 'triggerPaidOperation',
      operation: 'generation',
      model: 'veo-3.1-generate-preview',
      expectedUnits: { seconds: 8 },
      note: 'рендер',
    };
    const click = { kind: 'click', selector: '[data-qa="video-generate"]' };
    const wait = { kind: 'waitFor', selector: '[data-qa="video-provider"]' };
    expect(parseScenarioResponse(JSON.stringify({ steps: [click] })).ok).toBe(
      false,
    );
    // Декларация есть, но не прямо перед кликом.
    expect(
      parseScenarioResponse(JSON.stringify({ steps: [paid, wait, click] })).ok,
    ).toBe(false);
    // Не та операция.
    expect(
      parseScenarioResponse(
        JSON.stringify({
          steps: [
            {
              ...paid,
              operation: 'voiceover',
              expectedUnits: { characters: 100 },
            },
            click,
          ],
        }),
      ).reason,
    ).toContain('"generation"');
    expect(
      parseScenarioResponse(JSON.stringify({ steps: [wait, paid, click] })).ok,
    ).toBe(true);
  });

  it('хук из каталога и шаги без селектора проходят', () => {
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          { kind: 'waitFor', selector: '[data-qa="prompt-editor"]' },
          { kind: 'click', selector: ' [data-qa="prompt-approve"] ' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
  });

  it('не-JSON текст — ok:false с понятной причиной', () => {
    const result = parseScenarioResponse('извините, не могу помочь');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('ответ не JSON-объект');
  });

  it('JSON-объект без steps — парсинг шагов сам отбраковывает (steps undefined — не массив)', () => {
    const result = parseScenarioResponse('{"note":"пусто"}');
    expect(result.ok).toBe(false);
  });

  it('JSON-массив на верхнем уровне (не {"steps":[...]}) — отбраковывается', () => {
    // extractJson() ищет ПЕРВУЮ {...}-подстроку в тексте — здесь это сам
    // элемент массива, а не массив целиком (extractJson не видит
    // окружающих [] ) — итоговый разобранный объект не содержит steps,
    // и дальше отбраковывается уже parseScenarioSteps как "steps не
    // массив", а не на уровне extractJson.
    const result = parseScenarioResponse('[{"kind":"goto","route":"x"}]');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('steps не массив');
  });
});

describe('buildScenarioPrompt — язык интерфейса (этап C)', () => {
  const step = {
    title: 'Заведите товар',
    text: 'Проект и товар',
    details: [],
  };

  it('язык назван ЯВНО, а не ISO-кодом', () => {
    // Модель читает `uk` как United Kingdom, а не украинский — та же
    // находка, что у `languageNameForLocale`.
    const prompt = buildScenarioPrompt('1', 'uk', step);
    expect(prompt).toContain('Ukrainian');
  });

  it('сказано, что assertText и fill пишутся на языке локали', () => {
    // Без этой инструкции сценарий любой локали получал русский
    // `assertText` и падал на чужом интерфейсе — тихо и непонятно.
    //
    // Проверяется ФРАЗА целиком, а не наличие слова `assertText`:
    // оно есть в словаре примитивов независимо от этого абзаца, и
    // тест проходил, даже если абзац вырезать (находка аудита
    // этапа C).
    const prompt = buildScenarioPrompt('1', 'es', step);
    expect(prompt).toMatch(
      /поле "value" у assertText — ожидаемая надпись интерфейса именно на нём/,
    );
    expect(prompt).toMatch(
      /поле "value" у fill — то, что осмысленно ввести пользователю этого языка/,
    );
    expect(prompt).toMatch(/Spanish/);
  });

  it('селекторы и имена маршрутов переводить запрещено', () => {
    // Иначе модель «переведёт» route и сценарий не найдёт экран.
    const prompt = buildScenarioPrompt('1', 'de', step);
    expect(prompt).toMatch(/Не переводи.*селекторы/);
  });

  it('у каждой локали своё имя языка', () => {
    expect(buildScenarioPrompt('1', 'ru', step)).toContain('Russian');
    expect(buildScenarioPrompt('1', 'en', step)).toContain('English');
    expect(buildScenarioPrompt('1', 'de', step)).toContain('German');
  });

  describe('реплики (этап D)', () => {
    it('потолок длины берётся из контракта, а не пишется числом', () => {
      // Инструкция модели и отказ валидатора обязаны говорить одно и
      // то же. Разойдясь, они дают худший из исходов: модель
      // послушно пишет 240 символов, разбор молча выкидывает
      // реплику, и кадр немой без единой жалобы.
      const prompt = buildScenarioPrompt('1', 'ru', step);

      expect(prompt).toContain(`до ${MAX_NARRATION_LENGTH} символов`);
    });

    it('сказано, что у triggerPaidOperation реплики нет', () => {
      // Валидатор её отбрасывает; не сказать об этом модели значит
      // каждый раз платить за текст, который тут же выкинут.
      const prompt = buildScenarioPrompt('1', 'ru', step);

      expect(prompt).toMatch(/КРОМЕ triggerPaidOperation/);
      expect(prompt).toMatch(/У triggerPaidOperation реплики быть не должно/);
    });

    it('словарь примитивов показывает narration настоящим полем', () => {
      // Тот же принцип, что у маршрутов и операций: промпт дважды
      // поплатился за плейсхолдеры. Поле, названное только в прозе,
      // модель ставит куда попало.
      const prompt = buildScenarioPrompt('1', 'ru', step);

      expect(prompt).toContain('"narration":"<реплика диктора>"');
    });

    it('запрет на перевод строки и требование одной фразы — в промпте', () => {
      const prompt = buildScenarioPrompt('1', 'ru', step);

      expect(prompt).toMatch(/одной строкой, без переводов строк/);
      expect(prompt).toMatch(/одну фразу от первого лица/);
    });

    it('язык реплики назван именем, а не кодом', () => {
      // Модель читает `uk` как United Kingdom — та же находка, что у
      // `languageNameForLocale` в инструкции про assertText.
      expect(buildScenarioPrompt('1', 'uk', step)).toMatch(
        /Язык реплики — тот же.*Ukrainian/,
      );
    });

    it('три «чего не делать» на месте', () => {
      const prompt = buildScenarioPrompt('1', 'ru', step);

      expect(prompt).toMatch(/Не повторяй дословно описание шага/);
      expect(prompt).toMatch(/Не нумеруй/);
      expect(prompt).toMatch(/Не обещай того, чего на кадре не будет/);
    });
  });
});

describe('повисшее объявление платного вызова (повторный аудит этапа F)', () => {
  const paid = {
    kind: 'triggerPaidOperation',
    operation: 'generation',
    model: 'veo-3.1-generate-preview',
    expectedUnits: { seconds: 8 },
    note: 'Veo, ожидаемо 8 секунд рендера',
  };

  it('объявление без нажатия ВЫРЕЗАЕТСЯ, а сценарий остаётся', () => {
    // Отказ выбросил бы десяток исправных шагов ради шага, который
    // при исполнении и так no-op. Вырезаем плохую часть — то же
    // решение, что у негодной реплики (§3 ТЗ: ролик получается ВСЕГДА).
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          paid,
          { kind: 'assertVisible', selector: '[data-qa="video-result"]' },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.kind)).toEqual(['goto', 'assertVisible']);
  });

  it('вырезанное названо оператору: номер шага, операция и почему', () => {
    // Без этой строки единственным следом правки было бы то, что
    // сценарий ПЕРЕСТАЛ быть платным, — а «перестал» в журнале не
    // видно вовсе.
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [{ kind: 'goto', route: 'generate' }, paid],
      }),
    );

    expect(result.droppedPaidOperations).toHaveLength(1);
    expect(result.droppedPaidOperations[0].stepNumber).toBe(2);
    expect(result.droppedPaidOperations[0].operation).toBe('generation');
    expect(result.droppedPaidOperations[0].reason).toMatch(/одобрения/);
  });

  it('объявление ПЕРЕД своей кнопкой остаётся нетронутым', () => {
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          paid,
          { kind: 'click', selector: '[data-qa="video-generate"]' },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(3);
    expect(result.droppedPaidOperations).toEqual([]);
  });

  it('объявление НЕ ТОЙ операции перед платной кнопкой — отказ, а не вырезание', () => {
    // Здесь первым срабатывает правило платного клика (этап I), и оно
    // строже нарочно: вырезав объявление, мы оставили бы нажатие
    // кнопки рендера мимо гейта одобрения — то есть настоящую трату
    // каждую ночь. Порядок правил важен, поэтому он под тестом.
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          { ...paid, operation: 'voiceover' },
          { kind: 'click', selector: '[data-qa="video-generate"]' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toContain('video-generate');
    expect(result.reason).toContain('generation');
    expect(result.droppedPaidOperations).toEqual([]);
  });

  it('объявление перед НЕ нажатием вырезается — ждать кнопку не значит нажать', () => {
    const result = parseScenarioResponse(
      JSON.stringify({
        steps: [
          { kind: 'goto', route: 'generate' },
          paid,
          { kind: 'waitFor', selector: '[data-qa="video-generate"]' },
        ],
      }),
    );

    expect(result.droppedPaidOperations).toHaveLength(1);
  });

  it('промпт предлагает только ДОСТИЖИМЫЕ операции', () => {
    // В белом списке пять значений, а платная кнопка после этапа I
    // одна. Предлагать остальные — звать модель написать то, что
    // будет вырезано.
    const reachable = WIZARD_PAID_OPERATIONS.filter((op) =>
      Object.values(QA_HOOKS).some((hook) => hook.clickCost === op),
    );
    const prompt = buildScenarioPrompt('1', 'ru', step);

    expect(reachable).toEqual(['generation']);
    // Обе стороны одним утверждением, а не ветвлением внутри цикла:
    // названо ровно достижимое, и ни одного слова сверх него.
    const named = WIZARD_PAID_OPERATIONS.filter((op) =>
      prompt.includes(`"${op}"`),
    );
    expect(named).toEqual([...reachable]);
  });

  it('валидатор при этом принимает ВЕСЬ белый список — сценарии до этапа I должны разбираться', () => {
    // Сузить приём значило бы, что одобренный сценарий, сохранённый
    // раньше, перестаёт разбираться и пара теряет ролик.
    for (const operation of WIZARD_PAID_OPERATIONS) {
      const result = parseScenarioResponse(
        JSON.stringify({
          steps: [
            { kind: 'goto', route: 'generate' },
            { ...paid, operation },
          ],
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
    }
  });
});
