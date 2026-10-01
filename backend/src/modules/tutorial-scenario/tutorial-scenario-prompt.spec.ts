import { TUTORIAL_DEMO_PRODUCT } from '../../common/tutorial-demo-product';
import { AssistantStepItem } from '../assistant/knowledge/generated';
import {
  buildScenarioPrompt,
  parseScenarioResponse,
  PRICED_VIDEO_MODELS,
  validateScenarioSteps,
} from './tutorial-scenario-prompt';
import {
  MAX_NARRATION_LENGTH,
  WIZARD_PAID_OPERATIONS,
} from './scenario-steps.types';
import { AI_OPERATION_LABEL, MODEL_RATES } from '../../common/ai-pricing';
import { ROUTE_DESCRIPTIONS } from '../tutorial-runner/route-templates';
import { QA_HOOKS } from './qa-hooks';

const step: AssistantStepItem = {
  title: 'Заведите товар',
  text: 'Проект и товар: фото, описание, цена.',
  details: ['Быстрый путь без проекта тоже работает'],
};

describe('buildScenarioPrompt — каталог селекторов (этап I)', () => {
  it('перечисляет каждый хук СВОЕЙ семьи готовым селектором и не зовёт писать плейсхолдеры', () => {
    // «Своей», а не «каждый»: с 29.09.2026 тем две семьи, и экраны
    // чужого мастера в словарь не попадают — иначе список привычных
    // экранов сам приглашает модель выбрать не тот.
    // Убирается ЧУЖОЙ мастер, а не «всё, кроме своего»: постпрод,
    // список проектов и тариф — ничьи, до них доходят оба.
    const cases: Array<[string, (route: string) => boolean]> = [
      ['2', (route) => route.startsWith('greeting-video')],
      [
        'greeting-brief',
        (route) => route.startsWith('generate') || route === 'item',
      ],
    ];
    for (const [subjectKey, foreign] of cases) {
      const prompt = buildScenarioPrompt(subjectKey, 'ru', step);
      // Списками, а не `if` в цикле: упавшая проверка называет
      // конкретные селекторы, а не только «не совпало».
      const missing: string[] = [];
      const leaked: string[] = [];
      for (const [key, hook] of Object.entries(QA_HOOKS)) {
        const selector = `[data-qa="${key}"]`;
        const there = prompt.includes(selector);
        if (foreign(hook.route) && there) leaked.push(key);
        if (!foreign(hook.route) && !there) missing.push(key);
      }
      expect({ subjectKey, missing, leaked }).toEqual({
        subjectKey,
        missing: [],
        leaked: [],
      });
      expect(prompt).not.toContain('оператор поправит');
      expect(prompt).toContain('НЕ плейсхолдер и НЕ произвольный CSS');
    }
  });
});

describe('buildScenarioPrompt', () => {
  it('включает заголовок/описание/детали шага и словарь примитивов', () => {
    const prompt = buildScenarioPrompt('1', 'ru', step);
    expect(prompt).toContain('тема "1"');
    expect(prompt).toContain('ru');
    expect(prompt).toContain('Заведите товар');
    expect(prompt).toContain('Проект и товар: фото, описание, цена.');
    expect(prompt).toContain('Быстрый путь без проекта тоже работает');
    expect(prompt).toContain('"kind":"goto"');
    expect(prompt).toContain('"kind":"triggerPaidOperation"');
    expect(prompt).toContain('{"steps":[...]}');
  });

  /**
   * Тем две семьи (29.09.2026), и промпт обязан называть РАЗНЫЕ
   * мастера. Одна формулировка на обе стоила бы дорого и молча: модель,
   * которой сказали «шаг мастера генерации рекламных роликов», писала
   * бы сценарий поздравления по экранам товарки — с её маршрутами и её
   * хуками, — и валидатор отверг бы результат уже ПОСЛЕ платного
   * вызова.
   */
  it('тема поздравления описана СВОИМ мастером, а не товарным', () => {
    const prompt = buildScenarioPrompt('greeting-brief', 'ru', step);
    expect(prompt).toContain('мастера ПОЗДРАВИТЕЛЬНОГО ролика');
    expect(prompt).not.toContain('мастера генерации рекламных роликов');
    // И прямым запретом: перечисление маршрутов ниже по промпту
    // содержит экраны обоих мастеров, и без запрета модель выбрала бы
    // привычные.
    expect(prompt).toContain('greeting-video*');
    expect(prompt).toContain('использовать НЕЛЬЗЯ');
    // И экранов чужого мастера в словаре нет вовсе — запрет запретом,
    // но лежащий рядом список привычных экранов сам себе приглашение.
    expect(prompt).toContain('"greeting-video-ready"');
    expect(prompt).not.toContain('"generate-ready"');
    expect(prompt).not.toContain('wizard-step-product');
  });

  /**
   * Блок «Характер ролика» и вопрос о настроении (29.09.2026). Ролики
   * темы настроек сняты ДО блока, и пересъёмка должна его показать;
   * бриф фикстуры — день рождения, и вопроса о настроении (он только
   * у «Особого повода») в кадре не будет — диктор не должен его обещать.
   */
  it('тема настроек видит блок «Характер ролика», бриф — оговорку про настроение', () => {
    const settings = buildScenarioPrompt('greeting-settings', 'ru', step);
    expect(settings).toContain(
      '[data-qa="greeting-character-block"] — блок «Характер ролика»',
    );
    expect(settings).toContain('С него начинается тема настроек ролика');
    const brief = buildScenarioPrompt('greeting-brief', 'ru', step);
    expect(brief).toMatch(
      /greeting-brief-card"\] — [^\n]*настроении появляется ТОЛЬКО при «Особом поводе»[^\n]*не обещать/,
    );
    // В товарный мастер ни то ни другое не протекает.
    const product = buildScenarioPrompt('1', 'ru', step);
    expect(product).not.toContain('greeting-character-block');
    expect(product).not.toContain('Особом поводе');
  });

  it('шаг мастера товара описан товарным мастером', () => {
    const prompt = buildScenarioPrompt('1', 'ru', step);
    expect(prompt).toContain('мастера генерации рекламных роликов');
    expect(prompt).toContain('"generate-ready"');
    expect(prompt).not.toContain('"greeting-video-ready"');
    expect(prompt).not.toContain('greeting-brief-card');
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

    // И ровно у помеченных — СВОЕЙ семьи: с 29.09.2026 промпт не
    // показывает экраны чужого мастера, поэтому и предупреждать ему
    // не о чем. Предупреждение на всех подряд обесценивает его так же,
    // как предупреждение не там, где оно нужно.
    const warned = prompt
      .split('\n')
      .filter((l) => l.includes('НЕ НАЖИМАТЬ для перехода')).length;
    const marked = Object.values(QA_HOOKS).filter(
      (h) => h.clickOnlyWhenVisited && !h.route.startsWith('greeting-video'),
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
      '```json\n{"steps":[{"kind":"goto","route":"generate-ready"},' +
      '{"kind":"click","selector":"[data-qa=\\"analysis-continue\\"]"}]}\n```';
    const result = parseScenarioResponse(text);
    expect(result.ok).toBe(true);
    expect(result.steps).toHaveLength(2);
  });

  it('разбирает голый JSON без ограждения', () => {
    const text = '{"steps":[{"kind":"goto","route":"generate-ready"}]}';
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
    // `relevance-recheck`, а не `relevance-check`: вторая с 29.09.2026
    // помечена «её может не быть» и отвергается раньше — по другой
    // причине. Пример должен проверять ПРАВИЛО ПЛАТНОСТИ, а не
    // случайно срабатывать на соседнем запрете.
    for (const key of [
      'reference-link-submit',
      'relevance-recheck',
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
          { kind: 'goto', route: 'generate-ready' },
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

  it('генератор знает демо-товар и не выдумывает свой (01.10.2026)', () => {
    const prompt = buildScenarioPrompt('1', 'ru', step);
    expect(prompt).toContain(`«${TUTORIAL_DEMO_PRODUCT.title}»`);
    expect(prompt).toContain(TUTORIAL_DEMO_PRODUCT.description);
    expect(prompt).toMatch(/не придумывай другой товар/);
    expect(prompt).toMatch(/К мастеру поздравлений это не относится/);
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
          { kind: 'goto', route: 'generate-ready' },
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
          { kind: 'goto', route: 'generate-ready-to-render' },
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
          { kind: 'goto', route: 'generate-ready-to-render' },
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
          { kind: 'goto', route: 'generate-ready-to-render' },
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

/**
 * Закрытый список имён моделей — третий в этом промпте после маршрутов
 * и селекторов (сквозной аудит 29.09.2026).
 */
describe('модель платного шага — закрытый список', () => {
  const steps = (model: string, expectedUnits: Record<string, number>) => [
    // Кнопка рендера живёт на экране «промпт одобрен, ролика нет» —
    // на готовой сессии её прячет сам готовый ролик (разбор
    // достижимости 29.09.2026).
    { kind: 'goto', route: 'generate-ready-to-render' },
    {
      kind: 'triggerPaidOperation',
      operation: 'generation',
      model,
      expectedUnits,
      note: 'рендер',
    },
    { kind: 'click', selector: '[data-qa="video-generate"]' },
  ];

  it('список берётся из прайса и не пуст', () => {
    expect(PRICED_VIDEO_MODELS.length).toBeGreaterThan(0);
    expect(PRICED_VIDEO_MODELS).toContain('veo-3.1-generate-preview');
  });

  const STEP_8 = {
    title: 'Сгенерируйте видео',
    text: 'Нажмите кнопку генерации.',
    details: [],
  } as never;

  it('промпт печатает модели ТОГО движка, что предзаполнен в мастере', () => {
    // Замечание владельца 29.09.2026: умолчание — Grok, не Veo. Дать
    // модели оба списка значило бы завести новую ошибку вместо
    // исправленной: объявленный Veo даёт прикидку $3.20 за
    // восьмисекундный ролик, а Grok 480p отрендерит его за $0.64 —
    // оператор одобряет не ту сумму.
    const prompt = buildScenarioPrompt('8', 'ru', STEP_8, 'grok');
    expect(prompt).toContain('grok-imagine-video-1.5:480p');
    expect(prompt).not.toContain('veo-3.1-generate-preview');
  });

  it('умолчание аргумента повторяет умолчание продукта', () => {
    // Вызывающий, не прочитавший настройку, обязан получить верное
    // поведение, а не тихо неверное.
    expect(buildScenarioPrompt('8', 'ru', STEP_8)).toBe(
      buildScenarioPrompt('8', 'ru', STEP_8, 'grok'),
    );
  });

  it('оператор переключил мастер на Veo — промпт едет следом', () => {
    const prompt = buildScenarioPrompt('8', 'ru', STEP_8, 'veo');
    expect(prompt).toContain('veo-3.1-generate-preview');
    expect(prompt).not.toContain('grok-imagine-video-1.5:480p');
  });

  it('валидатор принимает движки ОБОИХ провайдеров', () => {
    // Асимметрия намеренная: промпт ведёт новые сценарии к верной
    // прикидке, валидатор не ломает сохранённые до смены умолчания.
    for (const model of [
      'grok-imagine-video-1.5:480p',
      'veo-3.1-generate-preview',
    ]) {
      expect(validateScenarioSteps(steps(model, { seconds: 8 })).ok).toBe(true);
    }
  });

  it('придуманное имя модели отвергает сценарий целиком', () => {
    const parsed = validateScenarioSteps(steps('veo-3', { seconds: 8 }));
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('нет среди оцениваемых');
  });

  it('верное имя с неверными единицами тоже отвергается', () => {
    const parsed = validateScenarioSteps(
      steps('veo-3.1-generate-preview', { calls: 1 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toContain('expectedUnits.seconds');
  });

  it('верное имя и секунды проходят', () => {
    const parsed = validateScenarioSteps(
      steps('veo-3.1-generate-preview', { seconds: 8 }),
    );
    expect(parsed.ok).toBe(true);
  });
});

it('список моделей — только движки мастера, без аватара и клона голоса', () => {
  // По секундам считаются ещё и hedra-character-3, и клон голоса.
  // Пустить их в список значило бы заменить нулевую прикидку на
  // уверенно неверную — у нуля хотя бы есть подпись «занижена».
  for (const name of PRICED_VIDEO_MODELS) {
    expect(['VEO', 'GROK']).toContain(MODEL_RATES[name].provider);
  }
  expect(PRICED_VIDEO_MODELS).not.toContain('hedra-character-3');
  expect(PRICED_VIDEO_MODELS).not.toContain('resemble-voice-clone');
  // Одного провайдера мало: у GROK есть и модель-КАРТИНКА, у которой
  // ставки за секунду нет вовсе. Попади она в список — валидатор
  // потребовал бы `expectedUnits.seconds` у того, что секундами не
  // считается, и отверг бы верный сценарий.
  for (const name of PRICED_VIDEO_MODELS) {
    expect(MODEL_RATES[name].perSecond).toBeDefined();
  }
  expect(PRICED_VIDEO_MODELS).not.toContain('grok-imagine-image');
});

/**
 * Третий боевой прогон 29.09.2026: механизм `generate-ready` заработал,
 * но модель пользовалась им через раз — шаг 3 сам догадался кликнуть
 * степпер и прошёл, шаги 4 и 5 ждали карточку сразу после goto и упали
 * по 15 секунд. Правило в промпте было, но мягкое: «отсюда МОЖНО
 * вернуться».
 */
describe('переход по степперу перед ожиданием карточки', () => {
  const prompt = () =>
    buildScenarioPrompt('5', 'ru', {
      title: 'Разбор ролика',
      text: 'Посмотрите, как ИИ разобрал ролик по сценам.',
      details: [],
    } as never);

  it('промпт требует сначала кликнуть степпер, а не просто разрешает', () => {
    const p = prompt();
    expect(p).toContain('ОБЯЗАН сначала кликнуть нужную позицию степпера');
    expect(p).toContain('первым действием ПОСЛЕ goto ставь click');
  });

  it('названо, на КАКОМ экране открывается generate-ready', () => {
    // Без этого правило «кликни степпер» выглядит произволом: модель
    // не знает, почему карточки нет.
    //
    // Четвёртый боевой прогон 29.09.2026 уточнил САМО это утверждение:
    // мастер открывается не на последнем шаге «Видео», а ЗА ним — на
    // состоянии «ролик готов» (`stepFromSession`: готовый ролик →
    // `complete`). Из-за прежней формулировки модель решила, что форма
    // выбора формата видна сразу, и сценарий шага 7 упал на
    // `aspect-ratio-picker`.
    expect(prompt()).toContain('ролик готов');
    // Разбор достижимости 29.09.2026: форма запуска рендера переехала
    // из «скрыто, дойди кликом» в «здесь её нет вовсе», и промпт
    // обязан называть, ГДЕ она есть. Прежний текст обещал её на
    // generate-ready — обещание было ложным во всех пяти боевых
    // прогонах.
    expect(prompt()).toContain('формы запуска рендера');
    expect(prompt()).toContain('generate-ready-to-render');
    expect(prompt()).toContain('generate-prompt-pending');
  });

  it('позиции степпера названы В ОПИСАНИИ МАРШРУТА, а не только в общем списке хуков', () => {
    // Проверяем само описание, а не весь промпт: имена этих хуков есть
    // и в каталоге селекторов, поэтому «промпт их содержит» ничего не
    // доказывает. Модель должна встретить их там, где объясняется,
    // ЗАЧЕМ по ним кликать.
    const desc = ROUTE_DESCRIPTIONS['generate-ready'];
    // И само состояние названо верно: мастер открывается ЗА последним
    // шагом, на готовом ролике, — иначе правило «кликни степпер»
    // противоречит само себе для позиции «Видео» (четвёртый боевой
    // прогон 29.09.2026).
    expect(desc).toContain('ГОТОВЫМ роликом');
    // Разбор достижимости 29.09.2026: описание обязано отделять
    // «скрыто до клика» от «не существует здесь». Прежде оно этого не
    // делало, и модель ставила клик ради элемента, которого на экране
    // не бывает ни при каком клике.
    expect(desc).toContain('НЕТ И НЕ БУДЕТ');
    for (const hook of [
      'wizard-step-upload',
      'wizard-step-analysis',
      'wizard-step-product',
      'wizard-step-prompt',
      'wizard-step-video',
    ]) {
      expect(desc).toContain(hook);
    }
  });
});

/**
 * Хук на чужом экране — разбор достижимости 29.09.2026.
 *
 * До этой проверки промах маршрута был неотличим от поломки продукта:
 * сценарий проходил валидацию, уезжал в базу и падал ночью на
 * `waitFor` через пятнадцать секунд. Пять боевых прогонов подряд
 * причина была именно в маршруте, и каждый раз объяснялась не тем.
 */
describe('хук должен жить на том экране, который открыл сценарий', () => {
  const run = (route: string, selector: string) =>
    validateScenarioSteps([
      { kind: 'goto', route },
      { kind: 'waitFor', selector: `[data-qa="${selector}"]` },
    ]);

  it('карточка запуска рендера на готовой сессии — отказ с названным экраном', () => {
    // Ровно сценарий 7, падавший все пять прогонов.
    const r = run('generate-ready', 'aspect-ratio-picker');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('generate-ready-to-render');
    // Причина обязана называть последствие: иначе оператор увидит
    // «не тот экран» и не поймёт, что дело в таймауте прогона.
    expect(r.reason).toContain('до таймаута');
  });

  it('карточка релевантности на готовой сессии — отказ', () => {
    // Сценарий 4, та же история.
    const r = run('generate-ready', 'relevance-panel');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('generate-prompt-pending');
  });

  it('свой хук на своём экране проходит — все четыре маршрута мастера', () => {
    for (const [route, hook] of [
      ['generate', 'reference-tab-link'],
      ['generate-ready', 'video-result'],
      ['generate-prompt-pending', 'relevance-panel'],
      ['generate-ready-to-render', 'aspect-ratio-picker'],
    ] as const) {
      expect(run(route, hook).ok).toBe(true);
    }
  });

  it('маршрут запоминается последним goto, а не первым', () => {
    // Сценарий может перейти на другой экран посреди себя; правило
    // обязано следовать за ним, иначе оно запрещало бы законное.
    const r = validateScenarioSteps([
      { kind: 'goto', route: 'generate' },
      { kind: 'waitFor', selector: '[data-qa="reference-tab-link"]' },
      { kind: 'goto', route: 'postprod-video' },
      { kind: 'waitFor', selector: '[data-qa="revoice-panel"]' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('шаги ДО первого goto не проверяются — маршрут ещё неизвестен', () => {
    // Сознательный пробел, названный в доккомментарии: заводить здесь
    // ещё один класс отказа значило бы решать в одной правке две
    // задачи. Тест держит именно это решение, а не недосмотр.
    const r = validateScenarioSteps([
      { kind: 'waitFor', selector: '[data-qa="video-result"]' },
      { kind: 'goto', route: 'generate' },
    ]);
    expect(r.ok).toBe(true);
  });
});

/**
 * Имя экрана — закрытый список (разбор достижимости 29.09.2026,
 * доводка).
 *
 * Список существовал с этапа 106, но только в промпте: придуманное
 * моделью имя доезжало до раннера и отвергалось уже ночью.
 */
describe('несуществующий экран отвергается на генерации', () => {
  it('придуманное имя — отказ, и сказано, что такого экрана нет', () => {
    const r = validateScenarioSteps([
      { kind: 'goto', route: 'wizard.product' },
      { kind: 'click', selector: '[data-qa="analysis-continue"]' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('не существует');
    // Именно «нет такого экрана», а не «хук на другом экране»:
    // проверка обязана стоять ПЕРЕД сверкой хука с маршрутом, иначе
    // причина уводит в сторону.
    expect(r.reason).not.toContain('живёт на экране');
  });

  it('маршрут, который исполнитель умеет открыть, но НЕ предлагает модели, проходит', () => {
    // `testing` исполнитель знает, но модели не предлагает: экран брифа
    // тестировщика фикстурному пользователю ответит отказом в доступе.
    // Валидатор по описаниям отверг бы законный сценарий, написанный
    // руками.
    //
    // Раньше примером было `greeting-video` — до 29.09.2026, пока
    // фикстура не заводила проект четвёртого типа. Теперь заводит три,
    // и поздравление предлагается наравне с остальными.
    const r = validateScenarioSteps([{ kind: 'goto', route: 'testing' }]);
    expect(r.ok).toBe(true);
    expect(ROUTE_DESCRIPTIONS['testing']).toBeUndefined();
  });

  it('все предлагаемые модели экраны — резолвятся', () => {
    // Иначе промпт звал бы туда, куда исполнитель не умеет.
    for (const name of Object.keys(ROUTE_DESCRIPTIONS)) {
      expect(validateScenarioSteps([{ kind: 'goto', route: name }]).ok).toBe(
        true,
      );
    }
  });
});

/**
 * Элемент, которого на стенде может не быть вовсе (четвёртый боевой
 * прогон 29.09.2026).
 *
 * `greeting-settings/ru` упал на `assertVisible` карточки наклейки:
 * `StickerStep` возвращает `null`, пока стенду не задан ключ Pixabay,
 * — то есть карточки нет в DOM, и puppeteer ждал её пятнадцать
 * секунд. Сценарий был верен во всём остальном: маршрут, голос,
 * музыка, титры прошли. Соврал КАТАЛОГ, объявивший карточку
 * безусловной, — и потому чинится каталогом, а не сценарием.
 *
 * Третий раз подряд один и тот же именованный класс отказа: хук
 * обещает экран, где его не бывает.
 */
describe('хук, которого на стенде может не быть', () => {
  const marked = Object.entries(QA_HOOKS).filter(([, h]) => h.absentWhen);

  it('пометка несёт ПРИЧИНУ, а не голый флаг', () => {
    // Строка, а не `true`, именно ради этого: «карточки может не
    // быть» без «потому что стенду не задан ключ» модель прочтёт как
    // каприз и обойдёт формулировкой.
    expect(marked.length).toBeGreaterThan(0);
    for (const [key, hook] of marked) {
      expect(`${key}: ${hook.absentWhen?.why}`).toMatch(/: .{30}/);
    }
  });

  it('промпт печатает запрет вместе с причиной — на строке самого хука', () => {
    const prompt = buildScenarioPrompt('greeting-settings', 'ru', step);
    const line = prompt
      .split('\n')
      .find((l) => l.includes('greeting-sticker-card'));

    expect(line).toBeDefined();
    expect(line).toContain('НЕ УПОМИНАТЬ В ШАГАХ ВООБЩЕ');
    expect(line).toContain(QA_HOOKS['greeting-sticker-card'].absentWhen?.why);
    // Запрет шире клика: перечислены все четыре вида шага, иначе
    // модель прочтёт его как «нельзя нажимать» — ровно ту пометку,
    // которая у соседних хуков уже есть.
    for (const kind of ['waitFor', 'assertVisible', 'click', 'fill']) {
      expect(line).toContain(kind);
    }
  });

  it('и ровно у помеченных — соседние карточки того же экрана чисты', () => {
    const prompt = buildScenarioPrompt('greeting-settings', 'ru', step);
    // Только строки САМИХ хуков: общее правило ниже повторяет эту
    // же формулировку в кавычках, и счёт по всему промпту считал бы
    // пометку там, где стоит объяснение пометки. Ровно тот же
    // промах, что уже стоил одного теста-пустышки.
    const warned = prompt
      .split('\n')
      .filter(
        (l) =>
          l.trimStart().startsWith('- [data-qa=') &&
          l.includes('НЕ УПОМИНАТЬ В ШАГАХ ВООБЩЕ'),
      ).length;
    expect(warned).toBe(
      marked.filter(([, h]) => h.route.startsWith('greeting-video')).length,
    );
    expect(warned).toBeGreaterThan(0);
    const music = prompt
      .split('\n')
      .find((l) => l.includes('greeting-music-card'));
    expect(music).not.toContain('НЕ УПОМИНАТЬ');
  });

  it('промпт объясняет последствие, а не только запрещает', () => {
    // Без «ролик не соберётся» запрет выглядит стилистическим, и
    // модель торгуется с ним: «покажу, но мягко».
    const prompt = buildScenarioPrompt('greeting-settings', 'ru', step);
    const rule = prompt.split('\n').find(
      (l) =>
        l.includes('НЕ УПОМИНАТЬ В ШАГАХ ВООБЩЕ') &&
        // Правило, а не строка хука: с этапа K3 помеченных хуков на
        // экранах поздравления несколько (поля «Особого повода»).
        !l.trimStart().startsWith('- [data-qa='),
    );
    expect(rule).toBeDefined();
    expect(rule).toContain('не собирается');
    // И даёт выход, а не только тупик: иначе шаг обучалки про
    // наклейки описывать нечем.
    expect(rule).toContain('say');
  });

  it('валидатор отвергает ЛЮБОЙ вид шага, а не только click', () => {
    const selector = '[data-qa="greeting-sticker-card"]';
    const cases = [
      { kind: 'waitFor', selector },
      { kind: 'assertVisible', selector },
      { kind: 'click', selector },
      { kind: 'fill', selector, value: 'снеговик' },
    ];
    for (const bad of cases) {
      const r = validateScenarioSteps([
        { kind: 'goto', route: 'greeting-video-ready' },
        bad,
      ]);
      expect(`${bad.kind}: ${r.ok}`).toBe(`${bad.kind}: false`);
      // Причина называет условие и последствие: по ней оператор
      // понимает, что чинить — стенд, а не сценарий.
      expect(r.reason).toContain(
        QA_HOOKS['greeting-sticker-card'].absentWhen?.why,
      );
      expect(r.reason).toContain('не соберёт ролик');
    }
  });

  it('соседний хук того же экрана проходит — запрет пообъектный, не поэкранный', () => {
    const r = validateScenarioSteps([
      { kind: 'goto', route: 'greeting-video-ready' },
      { kind: 'waitFor', selector: '[data-qa="greeting-music-card"]' },
    ]);
    expect(r.ok).toBe(true);
  });

  it('причина — про отсутствие, а не про чужой экран', () => {
    // Проверка обязана стоять ПЕРЕД сверкой хука с маршрутом: иначе
    // про несуществующую карточку сообщалось бы «она на другом
    // экране», и оператор пошёл бы править goto.
    const r = validateScenarioSteps([
      { kind: 'goto', route: 'generate' },
      { kind: 'waitFor', selector: '[data-qa="greeting-sticker-card"]' },
    ]);
    expect(r.ok).toBe(false);
    expect(r.reason).not.toContain('живёт на экране');
  });
});

/**
 * Элемент, исчезающий сам (пятый боевой прогон 29.09.2026).
 *
 * `4/ru` упал на `assertVisible [data-qa="relevance-check"]`, а двумя
 * шагами раньше успешно поставил галочку `relevance-use-in-prompt` —
 * то есть сценарий утверждал разом две ВЗАИМОИСКЛЮЧАЮЩИЕ вещи:
 * чекбокс живёт под `{report && …}`, кнопка — под `{!report && …}`.
 *
 * Причина глубже каталога. `RelevancePanel` запускает проверку САМА
 * при открытии (`if (!s.report) void run()`), поэтому «Проверить
 * релевантность» — не обычная кнопка экрана, а повтор после неудачи:
 * на исправной сессии её не видно никогда. Модель же, читая описание
 * «кнопка проверки релевантности», честно на неё сослалась, а хотела
 * описать соседнюю — «Проверить ещё раз», у которой `data-qa` не было
 * вовсе. Каталог предлагал недостижимое и умалчивал о достижимом.
 */
describe('кнопка релевантности: недостижимая помечена, достижимая заведена', () => {
  const run = (selector: string) =>
    validateScenarioSteps([
      { kind: 'goto', route: 'generate-prompt-pending' },
      { kind: 'assertVisible', selector: `[data-qa="${selector}"]` },
    ]);

  it('первичная кнопка отвергается — её не бывает на исправной сессии', () => {
    const r = run('relevance-check');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('отчёт');
  });

  it('повторная — проходит: она видна ровно тогда, когда отчёт есть', () => {
    expect(run('relevance-recheck').ok).toBe(true);
  });

  it('обе остаются платными, нажимать нельзя ни ту, ни другую', () => {
    // Пометка «не бывает» не отменяет пометку «платная»: кнопка,
    // которая всё-таки появилась после неудачи, тратит деньги так же.
    for (const key of ['relevance-check', 'relevance-recheck']) {
      expect(`${key}: ${QA_HOOKS[key].clickCost}`).toBe(`${key}: forbidden`);
    }
  });

  it('причина отсутствия НЕ называет переменную окружения — она не в настройке стенда', () => {
    // Две причины отсутствия живут в одном поле, и различает их
    // только `env`. Спутать их дорого: шов требует живую переменную
    // у тех, кто её объявил, и промолчал бы, объяви эта кнопка
    // чужую.
    expect(QA_HOOKS['relevance-check'].absentWhen?.env).toBeUndefined();
    expect(QA_HOOKS['greeting-sticker-card'].absentWhen?.env).toBe(
      'PIXABAY_API_KEY',
    );
  });
});
