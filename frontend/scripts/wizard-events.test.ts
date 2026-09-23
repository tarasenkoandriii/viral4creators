// Plain assertions runnable with `npx tsx scripts/wizard-events.test.ts`.
//
// Очередь телеметрии шагов — «Тонкая красная линия» §8, этап 8.

import {
  WIZARD_EVENT_QUEUE_MAX,
  queueEvent,
  type WizardEvent,
} from '../src/lib/wizard-events';

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

const ev = (kind: WizardEvent['kind'], stepId = 'url'): WizardEvent => ({
  kind,
  stepId,
});

check('события копятся по порядку', () => {
  const a = queueEvent([], ev('enter'));
  const b = queueEvent(a.queue, ev('leave'));
  eq(
    b.queue.map((e) => e.kind),
    ['enter', 'leave']
  );
  eq(b.full, false);
});

check('повтор подряд склеивается', () => {
  // Перерисовка родителя не должна удваивать «вошёл на шаг»: частоты,
  // по которым потом заводят записи опыта, врали бы ровно на число
  // лишних рендеров.
  const a = queueEvent([], ev('enter'));
  const b = queueEvent(a.queue, ev('enter'));
  eq(b.queue.length, 1);
});

check('тот же вид на другом шаге — другое событие', () => {
  const a = queueEvent([], ev('enter', 'url'));
  const b = queueEvent(a.queue, ev('enter', 'record'));
  eq(b.queue.length, 2);
});

check('повтор не подряд сохраняется', () => {
  // Зашёл, вышел, вернулся — это три события, а не два.
  let q: WizardEvent[] = [];
  for (const e of [ev('enter'), ev('leave'), ev('enter')])
    q = queueEvent(q, e).queue;
  eq(
    q.map((e) => e.kind),
    ['enter', 'leave', 'enter']
  );
});

check('заполненная очередь просит отправку', () => {
  let q: WizardEvent[] = [];
  for (let i = 0; i < WIZARD_EVENT_QUEUE_MAX; i++) {
    q = queueEvent(q, { kind: 'error', stepId: 'url', detail: `E${i}` }).queue;
  }
  eq(q.length, WIZARD_EVENT_QUEUE_MAX);
  const over = queueEvent(q, ev('undo'));
  eq(over.full, true);
  eq(over.queue.length, WIZARD_EVENT_QUEUE_MAX);
});

check('переполнение теряет новое, а не начало прохода', () => {
  // Очередь такой длины означает, что отправка не проходит; начало
  // прохода по мастеру ценнее его хвоста.
  let q: WizardEvent[] = [];
  for (let i = 0; i < WIZARD_EVENT_QUEUE_MAX; i++) {
    q = queueEvent(q, { kind: 'error', stepId: 'url', detail: `E${i}` }).queue;
  }
  const over = queueEvent(q, ev('undo'));
  eq(over.queue[0].detail, 'E0');
  eq(
    over.queue.some((e) => e.kind === 'undo'),
    false
  );
});

check('очередь не меняется на месте', () => {
  // Хук держит её в `useRef` и сравнивает ссылки: мутация на месте
  // сделала бы отправленную пачку и текущую очередь одним массивом.
  const start: WizardEvent[] = [];
  const next = queueEvent(start, ev('enter'));
  eq(start.length, 0);
  eq(next.queue.length, 1);
});

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log('\n7 проверок пройдено');
