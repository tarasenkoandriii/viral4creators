// Plain assertions runnable with `npx tsx scripts/greeting-render.test.ts`.
//
// CONTRACT6 G-FE п. 1, 4, 5: опрос рендера не умирает на сетевой
// ошибке; кнопка рендера гаснет с причиной; «ролик в работе».

import {
  RENDER_POLL_BASE_MS,
  RENDER_POLL_MAX_MS,
  isVideoBusy,
  renderBlockOf,
  renderPollDelay,
  renderPollErrorKind,
} from '../src/lib/greeting-render';

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}
function eq(a: unknown, b: unknown) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x !== y) throw new Error(`${x} !== ${y}`);
}

check(
  'пауза опроса: без сбоев — обычный шаг; сбои — удвоение до потолка',
  () => {
    eq(renderPollDelay(0), RENDER_POLL_BASE_MS);
    eq(renderPollDelay(1), RENDER_POLL_BASE_MS * 2);
    eq(renderPollDelay(2), RENDER_POLL_BASE_MS * 4);
    eq(renderPollDelay(3), RENDER_POLL_BASE_MS * 8);
    eq(renderPollDelay(10), RENDER_POLL_MAX_MS);
    eq(renderPollDelay(1000), RENDER_POLL_MAX_MS);
    eq(renderPollDelay(-1), RENDER_POLL_BASE_MS);
  }
);

check(
  'ошибка опроса: сеть/408/429/5xx — пробуем снова; прочие 4xx — стоп',
  () => {
    eq(renderPollErrorKind(undefined), 'retry');
    eq(renderPollErrorKind(null), 'retry');
    eq(renderPollErrorKind(408), 'retry');
    eq(renderPollErrorKind(429), 'retry');
    eq(renderPollErrorKind(500), 'retry');
    eq(renderPollErrorKind(503), 'retry');
    eq(renderPollErrorKind(401), 'stop');
    eq(renderPollErrorKind(403), 'stop');
    eq(renderPollErrorKind(404), 'stop');
  }
);

const ready = {
  items: [
    { key: 'recipient', stepId: 'brief', required: true, done: true },
    { key: 'sender', stepId: 'brief', required: false, done: false },
  ],
};
const notReady = {
  items: [
    ...ready.items,
    { key: 'face', stepId: 'references', required: true, done: false },
  ],
};

check(
  'кнопка рендера: FLAGGED и BYPASSED — «сценарий не прошёл проверку»',
  () => {
    eq(
      renderBlockOf({ moderationStatus: 'flagged', readiness: ready }),
      'flagged'
    );
    eq(
      renderBlockOf({ moderationStatus: 'bypassed', readiness: ready }),
      'flagged'
    );
    // Проверка важнее готовности: причина — одна, самая точная.
    eq(
      renderBlockOf({ moderationStatus: 'flagged', readiness: notReady }),
      'flagged'
    );
  }
);

check('кнопка рендера: невыполненный ОБЯЗАТЕЛЬНЫЙ пункт — «не готово»', () => {
  eq(
    renderBlockOf({ moderationStatus: 'approved', readiness: notReady }),
    'not-ready'
  );
  // Необязательный пункт кнопку не гасит.
  eq(renderBlockOf({ moderationStatus: 'approved', readiness: ready }), null);
  eq(renderBlockOf({ moderationStatus: 'pending', readiness: ready }), null);
});

check('готовность не загрузилась — кнопку не гасим (решает сервер)', () => {
  eq(renderBlockOf({ moderationStatus: 'approved', readiness: null }), null);
  eq(
    renderBlockOf({ moderationStatus: undefined, readiness: undefined }),
    null
  );
});

check('ролик в работе — только pending и processing', () => {
  eq(isVideoBusy('pending'), true);
  eq(isVideoBusy('processing'), true);
  eq(isVideoBusy('complete'), false);
  eq(isVideoBusy('failed'), false);
  eq(isVideoBusy(undefined), false);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
