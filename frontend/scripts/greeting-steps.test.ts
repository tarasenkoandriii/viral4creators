// Plain assertions runnable with `npx tsx scripts/greeting-steps.test.ts`.
//
// Шаги поздравления — «Тонкая красная линия» §4.5, волна D, этап 12.

import {
  GREETING_STEP_IDS,
  greetingFactsOf,
  greetingStepOf,
  greetingSteps,
  type GreetingFacts,
  type GreetingStepId,
} from '../src/lib/greeting-steps';
import { toStepsView } from '../src/lib/wizard-steps';

const LABELS: Record<GreetingStepId, string> = {
  brief: 'Повод',
  references: 'Фото',
  script: 'Сценарий',
  video: 'Видео',
};

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
  if (a !== b) throw new Error(`${msg}\n    ожидалось ${b}\n    получено ${a}`);
}

const facts = (over: Partial<GreetingFacts> = {}): GreetingFacts => ({
  hasSession: true,
  hasPrompt: false,
  hasVideo: false,
  ...over,
});

check('идентификаторы шагов не разъезжаются со списком', () => {
  eq(
    greetingSteps(facts(), LABELS).map((s) => s.id),
    [...GREETING_STEP_IDS]
  );
});

check('до сессии доступен только бриф', () => {
  const view = toStepsView(
    greetingSteps(facts({ hasSession: false }), LABELS),
    'brief'
  );
  eq(view.selectable, [true, false, false, false]);
  eq(view.current, 0);
});

check('после сессии открыты фото и сценарий, видео — нет', () => {
  const view = toStepsView(greetingSteps(facts(), LABELS), 'references');
  eq(view.selectable, [true, true, true, false]);
});

check('видео открывается вместе со сценарием', () => {
  const view = toStepsView(
    greetingSteps(facts({ hasPrompt: true }), LABELS),
    'script'
  );
  eq(view.selectable, [true, true, true, true]);
});

check('бриф остаётся доступен после сборки сценария', () => {
  // Помеченный модерацией сценарий чинится правкой текста на брифе —
  // закрыть туда дорогу значило бы закрыть единственный выход.
  const view = toStepsView(
    greetingSteps(facts({ hasPrompt: true, hasVideo: true }), LABELS),
    'video'
  );
  eq(view.targets[0], 'brief');
});

check('завершённость задаётся фактами, а не позицией', () => {
  // Позиционное правило объявило бы фото пройденными просто потому,
  // что человек дошёл до сценария.
  const view = toStepsView(greetingSteps(facts(), LABELS), 'references');
  eq(view.done, [true, false, false, false]);
});

check('текущий шаг читается из состояния', () => {
  eq(greetingStepOf(facts({ hasSession: false })), 'brief');
  eq(greetingStepOf(facts()), 'references');
  eq(greetingStepOf(facts({ hasPrompt: true })), 'script');
  eq(greetingStepOf(facts({ hasPrompt: true, hasVideo: true })), 'video');
});

check('готовый ролик не считается началом', () => {
  // Ровно тот блокер, из-за которого степпер врал после перезагрузки:
  // сессия есть, промпт и видео дочитаны — шаг обязан быть последним.
  const restored = greetingFactsOf('s1', { id: 'p' }, { id: 'v' });
  eq(greetingStepOf(restored), 'video');
});

check('потерянный при загрузке промпт даёт первый шаг — это и был баг', () => {
  const broken = greetingFactsOf('s1', undefined, undefined);
  eq(greetingStepOf(broken), 'references');
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n9 проверок пройдено');
