import { knownQaHook, qaSelector, QA_HOOKS } from './qa-hooks';
import { ROUTE_DESCRIPTIONS } from '../tutorial-runner/route-templates';

describe('QA_HOOKS', () => {
  it('каждый хук живёт на маршруте, который предлагается модели', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect({ key, known: hook.route in ROUTE_DESCRIPTIONS }).toEqual({
        key,
        known: true,
      });
    }
  });

  it('ключи в форме, которую понимает knownQaHook, и описаны', () => {
    for (const [key, hook] of Object.entries(QA_HOOKS)) {
      expect(knownQaHook(qaSelector(key))).toBe(key);
      expect(hook.description.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('knownQaHook', () => {
  it('принимает только [data-qa="ключ"] из каталога', () => {
    expect(knownQaHook('[data-qa="prompt-approve"]')).toBe('prompt-approve');
    expect(knownQaHook('  [data-qa="prompt-approve"]  ')).toBe(
      'prompt-approve',
    );
    expect(knownQaHook('[data-qa="no-such"]')).toBeNull();
    expect(knownQaHook("[data-qa='prompt-approve']")).toBeNull();
    expect(knownQaHook('[data-qa="prompt-approve"] span')).toBeNull();
    expect(knownQaHook('#promptText')).toBeNull();
    // Ключ-свойство объекта не должно считаться хуком.
    expect(knownQaHook('[data-qa="constructor"]')).toBeNull();
  });
});

describe('позиции степпера кликабельны только у пройденных шагов', () => {
  // Находка боевого прогона 29.09.2026: `Stepper.tsx` рисует каждую
  // позицию как `<button disabled={!clickable}>`, а `clickable`
  // истинно только у пройденного шага. Модель читала описание
  // «позиция «Товар» в степпере мастера» как приглашение перейти и
  // писала `goto generate` → `click wizard-step-product` вторым
  // шагом; на свежем мастере эта кнопка выключена, и восемь сценариев
  // из девяти падали таймаутом в тридцать секунд.
  const stepperKeys = Object.keys(QA_HOOKS).filter((k) => k.includes('-step-'));

  it('их тринадцать, и все помечены', () => {
    // Список выписан руками, а не выведен из самого каталога: тест,
    // перебирающий то же, что и код, согласится с любой его
    // редакцией — включая ту, где пометку сняли со всех.
    expect(stepperKeys.sort()).toEqual([
      // Поздравление (29.09.2026): степпер из четырёх позиций, и у него
      // та же ловушка — текущий шаг нарисован, но выключен. Какая
      // позиция жива на каком экране, проверяет шов check-docs по
      // таблице `LIVE_BY_ROUTE` во `frontend/scripts/greeting-steps.test.ts`.
      'greeting-step-brief',
      'greeting-step-references',
      'greeting-step-script',
      'greeting-step-video',
      'item-step-analogs',
      'item-step-photo',
      'item-step-price',
      'item-step-voice',
      'wizard-step-analysis',
      'wizard-step-product',
      'wizard-step-prompt',
      'wizard-step-upload',
      'wizard-step-video',
    ]);
    for (const key of stepperKeys) {
      expect(QA_HOOKS[key].clickOnlyWhenVisited).toBe(true);
    }
  });

  it('обычные хуки пометки не носят — иначе она ничего не значит', () => {
    expect(QA_HOOKS['video-generate'].clickOnlyWhenVisited).toBeUndefined();
    expect(
      QA_HOOKS['reference-link-submit'].clickOnlyWhenVisited,
    ).toBeUndefined();
    const marked = Object.values(QA_HOOKS).filter(
      (h) => h.clickOnlyWhenVisited,
    );
    expect(marked).toHaveLength(stepperKeys.length);
  });
});
