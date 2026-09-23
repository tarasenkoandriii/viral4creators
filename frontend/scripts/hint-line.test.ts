// Plain assertions runnable with `npx tsx scripts/hint-line.test.ts`.
//
// Машина состояний строки совета — «Тонкая красная линия» §5.11, этап 6.
// Проверяются не пиксели, а то, что стоит денег и доверия: один запрос
// на шаг, ответ не на тот шаг, поведение после снятия галочки.

import {
  hintReducer,
  initialHintState,
  isVisible,
  shouldRequest,
  type HintEvent,
  type HintState,
} from '../src/lib/hint-line';

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

const run = (state: HintState, ...events: HintEvent[]): HintState =>
  events.reduce(hintReducer, state);

const on = () => initialHintState(true, 'url');
const off = () => initialHintState(false, 'url');

check('без галочки строки нет', () => {
  eq(off().phase, 'hidden');
  eq(isVisible(off()), false);
  eq(shouldRequest(off()), false);
});

check('галочка показывает свёрнутую строку, но не зовёт модель', () => {
  // Ленивая загрузка (§5.4): шаг рисуется сразу, запрос уходит позже.
  const s = hintReducer(off(), { type: 'enabled' });
  eq(s.phase, 'collapsed');
  eq(shouldRequest(s), false);
});

check('клик и простой ведут в одно и то же состояние', () => {
  eq(run(on(), { type: 'open' }).phase, 'loading');
  eq(run(on(), { type: 'idle' }).phase, 'loading');
});

check('второй клик и простой поверх запроса не платят второй раз', () => {
  // «Один вызов на (шаг × состояние)» — иначе дребезг интерфейса
  // оплачивается по числу кликов.
  const s = run(on(), { type: 'open' }, { type: 'open' }, { type: 'idle' });
  eq(s.phase, 'loading');
  eq(shouldRequest(s), true);
});

check('простой поверх показанного совета не зовёт модель снова', () => {
  const shown = run(
    on(),
    { type: 'open' },
    { type: 'result', hint: 'совет', actions: [] }
  );
  eq(run(shown, { type: 'idle' }).phase, 'shown');
});

check('ответ приходит на свой шаг и не приходит на чужой', () => {
  // Ответ, приехавший после ухода с шага, — совет не про то, что на
  // экране. Роняется здесь, а не только отменой: отмена не мгновенна.
  const late = run(
    on(),
    { type: 'open' },
    { type: 'step', stepId: 'record' },
    { type: 'result', hint: 'про прошлый шаг', actions: [] }
  );
  eq(late.phase, 'collapsed');
  eq(late.hint, null);
});

check('пустой ответ убирает строку до конца шага', () => {
  // «Нечего сказать» — строки нет (§5.9). И повторять этот запрос на
  // каждом простое незачем: ответ не изменится.
  const s = run(
    on(),
    { type: 'open' },
    {
      type: 'result',
      hint: null,
      actions: [],
    }
  );
  eq(s.phase, 'hidden');
  eq(run(s, { type: 'idle' }).phase, 'hidden');
});

check('пустой ответ не мешает попробовать на следующем шаге', () => {
  const s = run(
    on(),
    { type: 'open' },
    { type: 'result', hint: null, actions: [] },
    { type: 'step', stepId: 'record' }
  );
  eq(s.phase, 'collapsed');
});

check('ошибка сворачивает строку, а не краснеет', () => {
  const s = run(on(), { type: 'open' }, { type: 'failed' });
  eq(s.phase, 'collapsed');
  // И повтор после ошибки осмыслен, в отличие от пустого ответа.
  eq(run(s, { type: 'open' }).phase, 'loading');
});

check('личный лимит показывается текстом, хотя совета нет', () => {
  const s = run(
    on(),
    { type: 'open' },
    {
      type: 'result',
      hint: null,
      actions: [],
      notice: 'На сегодня советы закончились',
    }
  );
  eq(s.phase, 'shown');
  eq(isVisible(s), true);
});

check('смена шага сворачивает строку и забывает прошлый текст', () => {
  const shown = run(
    on(),
    { type: 'open' },
    {
      type: 'result',
      hint: 'про ссылку',
      actions: [{ kind: 'goto-step', stepId: 'review' }],
    }
  );
  const next = hintReducer(shown, { type: 'step', stepId: 'record' });
  eq(next.phase, 'collapsed');
  eq(next.hint, null);
  eq(next.actions, []);
});

check('повтор того же шага ничего не сбрасывает', () => {
  // Перерисовка родителя не должна стирать прочитанный совет.
  const shown = run(
    on(),
    { type: 'open' },
    { type: 'result', hint: 'совет', actions: [] }
  );
  eq(hintReducer(shown, { type: 'step', stepId: 'url' }), shown);
});

check('снятая галочка замораживает прочитанное, но не зовёт модель', () => {
  const shown = run(
    on(),
    { type: 'open' },
    { type: 'result', hint: 'совет', actions: [] }
  );
  const frozen = hintReducer(shown, { type: 'disabled' });
  eq(frozen.phase, 'frozen');
  eq(frozen.hint, 'совет');
  eq(shouldRequest(run(frozen, { type: 'open' }, { type: 'idle' })), false);
});

check('снятая галочка без текста просто убирает строку', () => {
  eq(hintReducer(on(), { type: 'disabled' }).phase, 'hidden');
});

check('после заморозки следующий шаг уже без советов', () => {
  const frozen = run(
    on(),
    { type: 'open' },
    { type: 'result', hint: 'совет', actions: [] },
    { type: 'disabled' }
  );
  const next = hintReducer(frozen, { type: 'step', stepId: 'record' });
  eq(next.phase, 'hidden');
  eq(isVisible(next), false);
});

check('запрос уходит ровно в одном состоянии', () => {
  const phases: HintState['phase'][] = [
    'hidden',
    'collapsed',
    'loading',
    'shown',
    'frozen',
  ];
  eq(
    phases.filter((phase) => shouldRequest({ ...on(), phase })),
    ['loading']
  );
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n16 проверок пройдено');
