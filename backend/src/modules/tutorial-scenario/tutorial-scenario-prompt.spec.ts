import { AssistantStepItem } from '../assistant/knowledge/generated';
import {
  buildScenarioPrompt,
  parseScenarioResponse,
} from './tutorial-scenario-prompt';

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

  it('без деталей — раздела "Детали:" нет вовсе', () => {
    const prompt = buildScenarioPrompt('2', 'ru', { ...step, details: [] });
    expect(prompt).not.toContain('Детали:');
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
