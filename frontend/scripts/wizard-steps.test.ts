// Plain assertions runnable with `npx tsx scripts/wizard-steps.test.ts`.
//
// Проверяется общий контракт шагов («Тонкая красная линия», §4.3) и —
// главное — что переезд товарки на него ничего не изменил: состояние
// «всё пройдено» осталось состоянием, а не выходом за границу массива.

import { toStepsView, type WizardStep } from '../src/lib/wizard-steps';
import {
  STEPPER_IDS,
  stepperIdOf,
  type WorkflowStep,
} from '../src/lib/session-step';
import ru from '../src/dictionaries/ru.json';
import uk from '../src/dictionaries/uk.json';
import en from '../src/dictionaries/en.json';
import de from '../src/dictionaries/de.json';
import es from '../src/dictionaries/es.json';

type Id = 'a' | 'b' | 'c';

const linear = (targets: Array<Id | null>): WizardStep<Id>[] =>
  (['a', 'b', 'c'] as const).map((id, i) => ({
    id,
    label: id.toUpperCase(),
    target: targets[i],
  }));

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(actual: unknown, expected: unknown, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} ожидалось ${b}, получено ${a}`);
}

check('подписи и текущий шаг берутся как есть', () => {
  const v = toStepsView(linear(['a', 'b', null]), 'b');
  eq(v.steps, ['A', 'B', 'C']);
  eq(v.current, 1);
});

check('кликабельность — это наличие цели, а не позиция', () => {
  // `null` в `target` и есть «сюда нельзя»: та же форма, что у
  // `stepTargets` товарки, только вынесенная наружу.
  eq(toStepsView(linear(['a', null, 'c']), 'a').selectable, [
    true,
    false,
    true,
  ]);
});

check('«всё пройдено» — это состояние, а не индекс за границей', () => {
  // Раньше товарка выражала его индексом 5 при пяти подписях, и
  // Stepper рисовал все шаги пройденными «случайно правильно». Простой
  // кламп в length-1 снял бы галочку с последнего шага.
  const v = toStepsView(linear(['a', 'b', 'c']), null);
  eq(v.current, 3, 'current должен равняться числу шагов:');
});

check('неизвестный идентификатор не выводит за границы', () => {
  // Это ошибка вызывающего; ведём себя как прежний `default: return 0`.
  const v = toStepsView(linear(['a', 'b', 'c']), 'zzz' as Id);
  eq(v.current, 0);
});

check('никто не объявил завершённость — наружу она не уходит', () => {
  // Тогда её считает Stepper позиционно, как делал всегда. Это и есть
  // условие, при котором товарка переезжает, не меняя ни пикселя.
  eq(toStepsView(linear(['a', 'b', 'c']), 'b').done, undefined);
});

check('объявил хотя бы один — заполняются все', () => {
  const steps: WizardStep<Id>[] = [
    { id: 'a', label: 'A', target: 'a' },
    { id: 'b', label: 'B', target: 'b', done: true },
    { id: 'c', label: 'C', target: null },
  ];
  // Шаг без явного флага падает на позиционное правило, а не на false:
  // иначе объявление завершённости у ОДНОГО шага стирало бы галочки у
  // всех пройденных до него.
  eq(toStepsView(steps, 'c').done, [true, true, false]);
});

check('явная завершённость сильнее позиции', () => {
  // Ровно случай greeting: секция после текущей уже заполнена.
  const steps: WizardStep<Id>[] = [
    { id: 'a', label: 'A', target: 'a', done: false },
    { id: 'b', label: 'B', target: 'b', done: false },
    { id: 'c', label: 'C', target: 'c', done: true },
  ];
  eq(toStepsView(steps, 'a').done, [false, false, true]);
});

check('пустой список шагов не роняет хелпер', () => {
  const v = toStepsView([] as WizardStep<Id>[], null);
  eq(v.current, 0);
  eq(v.steps, []);
});

// ── Регрессия переезда товарки (этап 2) ───────────────────────────────
//
// Приёмка этапа — «поведение до и после совпадает». Таблица ниже — это
// прежний `GenerationWizard.getStepIndex()` дословно, включая индекс 5
// при пяти подписях. Если общий контракт когда-нибудь начнёт считать
// позицию иначе, это увидит именно этот тест, а не пользователь.
const HISTORICAL_INDEX: Record<WorkflowStep, number> = {
  upload: 0,
  analyzing: 1,
  'analysis-complete': 1,
  'product-input': 2,
  'prompt-generation': 3,
  'video-generation': 4,
  complete: 5,
};

check(
  'позиция степпера товарки совпадает с прежней при всех состояниях',
  () => {
    const labels = ['Видео', 'Анализ', 'Товар', 'Промпт', 'Генерация'];
    for (const [step, expected] of Object.entries(HISTORICAL_INDEX) as Array<
      [WorkflowStep, number]
    >) {
      const view = toStepsView(
        STEPPER_IDS.map((id, i) => ({ id, label: labels[i], target: id })),
        stepperIdOf(step)
      );
      eq(view.current, expected, `состояние ${step}:`);
    }
  }
);

check('товарка не объявляет завершённость явно — Stepper считает сам', () => {
  const view = toStepsView(
    STEPPER_IDS.map((id, i) => ({ id, label: String(i), target: id })),
    stepperIdOf('product-input')
  );
  eq(view.done, undefined);
});

check('цели шагов доезжают наружу, а не схлопываются в булев флаг', () => {
  // Товарка ходит по индексу, обучалка и greeting будут ходить по
  // адресу — им нужен идентификатор шага, а не «можно/нельзя».
  eq(toStepsView(linear(['a', null, 'c']), 'a').targets, ['a', null, 'c']);
});

check('идентификаторы шагов товарки уникальны', () => {
  // Дубль сделал бы второй шаг недостижимым, и молча: `findIndex`
  // вернул бы первый. Хелпер этого не проверяет намеренно — проверка
  // живёт здесь, на конкретном списке.
  eq(new Set(STEPPER_IDS).size, STEPPER_IDS.length);
});

check('во всех локалях столько подписей, сколько позиций степпера', () => {
  // Паритет словарей сравнивает КЛЮЧИ и внутрь массивов не заходит
  // (`keyPaths` возвращает [] для массива). Локаль с четырьмя
  // подписями вместо пяти прошла бы его молча, а пятый шаг остался бы
  // без названия.
  const dicts: Array<[string, { generationWizard: { steps: string[] } }]> = [
    ['ru', ru],
    ['uk', uk],
    ['en', en],
    ['de', de],
    ['es', es],
  ];
  for (const [locale, d] of dicts) {
    eq(
      d.generationWizard.steps.length,
      STEPPER_IDS.length,
      `подписей шагов в ${locale}:`
    );
  }
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n13 проверок пройдено');
