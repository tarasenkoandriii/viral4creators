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

const step: AssistantStepItem = {
  title: 'Заведите товар',
  text: 'Проект и товар: фото, описание, цена.',
  details: ['Быстрый путь без проекта тоже работает'],
};

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

  it('промпт называет ровно те операции, что пропустит валидатор (этап F)', () => {
    // Две стороны одного контракта: модель пишет то, что ей назвали,
    // валидатор роняет ВЕСЬ сценарий на незнакомом значении. До этапа
    // F промпт называл пять значений руками, а валидатор принимал все
    // ключи отчёта расходов.
    const prompt = buildScenarioPrompt('1', 'ru', step);
    const listed = /"operation":((?:"[a-z-]+"\|?)+)/.exec(prompt);
    expect(listed).not.toBeNull();
    const values = listed![1].split('|').map((v) => v.replace(/"/g, ''));
    expect(values).toEqual([...WIZARD_PAID_OPERATIONS]);
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
    for (const op of WIZARD_PAID_OPERATIONS) {
      expect(prompt).toMatch(new RegExp(`[а-яё-]+ — "${op}"`));
    }
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
      '{"kind":"click","selector":"[data-testid=\\"next\\"]"}]}\n```';
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
