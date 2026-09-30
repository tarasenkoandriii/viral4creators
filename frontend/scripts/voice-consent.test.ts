// Plain assertions runnable with `npx tsx scripts/voice-consent.test.ts`.
//
// Этап K7 ТЗ Greeting 2.0 §4А.7.4: согласие голосом тратит деньги —
// первое «генерируй» показывает сводку с ценой, второе в окне и при той
// же сводке нажимает кнопку. Больше ничто кнопку не нажимает.

import {
  CONSENT_CONFIDENCE_MIN,
  CONSENT_INITIAL,
  CONSENT_WINDOW_MS,
  consentFingerprint,
  consentReducer,
  consentRoute,
  runConsent,
  type ConsentInput,
  type ConsentEffect,
  chargeText,
  renderChargeOf,
  type ConsentEvent,
  type ConsentFacts,
  type ConsentState,
  type ConsentSummary,
  type RenderCharge,
} from '../src/lib/voice-consent';

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

const FACTS: ConsentFacts = {
  sessionId: 's1',
  promptId: 'p1',
  scriptText: 'Дорогая Марина, с днём рождения!',
  recipient: 'Марина',
  occasion: 'BIRTHDAY',
  customOccasion: null,
  resolution: '720p',
  presenter: 'grok',
  charge: { kind: 'credit', balance: 3 },
};

function summary(over: Partial<ConsentFacts> = {}): ConsentSummary {
  const f = { ...FACTS, ...over };
  return {
    recipient: f.recipient,
    occasion: 'День рождения',
    quality: `${f.resolution} · ${f.presenter}`,
    charge: f.charge,
    fingerprint: consentFingerprint(f),
  };
}

function consent(
  at: number,
  over: Partial<Extract<ConsentEvent, { type: 'consent' }>> = {}
): ConsentEvent {
  return {
    type: 'consent',
    at,
    confidence: 0.95,
    hasPendingCard: false,
    summary: summary(),
    block: null,
    ...over,
  };
}

function run(events: ConsentEvent[], start: ConsentState = CONSENT_INITIAL) {
  let state = start;
  const effects: string[] = [];
  for (const e of events) {
    const r = consentReducer(state, e);
    state = r.state;
    effects.push(
      r.effect.kind === 'refuse' ? `refuse:${r.effect.reason}` : r.effect.kind
    );
  }
  return { state, effects };
}

console.log('voice-consent');

check('первое «генерируй» — только сводка, второе в окне — старт', () => {
  const r = run([consent(0), consent(30_000)]);
  eq(r.effects, ['summary', 'start']);
  eq(r.state, CONSENT_INITIAL);
});

check('одно «генерируй» никогда не стартует', () => {
  const r = run([consent(0)]);
  eq(r.effects, ['summary']);
  eq(r.state.phase, 'shown');
});

check('окно истекло — снова сводка, не старт', () => {
  const r = run([consent(0), consent(CONSENT_WINDOW_MS + 1)]);
  eq(r.effects, ['summary', 'summary']);
  // Ровно на границе окна — ещё можно.
  eq(run([consent(0), consent(CONSENT_WINDOW_MS)]).effects, [
    'summary',
    'start',
  ]);
});

check('тик после окна закрывает сводку', () => {
  const r = run([consent(0), { type: 'tick', at: CONSENT_WINDOW_MS + 5 }]);
  eq(r.effects, ['summary', 'closed']);
  eq(r.state, CONSENT_INITIAL);
  eq(run([consent(0), { type: 'tick', at: 10 }]).effects, ['summary', 'none']);
});

check(
  'сменился отпечаток (имя, сценарий, цена) — новая сводка, не старт',
  () => {
    for (const over of [
      { recipient: 'Анна' },
      { scriptText: 'Другой текст' },
      { resolution: '1080p' },
      { charge: { kind: 'credit', balance: 2 } as RenderCharge },
      { charge: { kind: 'included' } as RenderCharge },
      { promptId: 'p2' },
    ]) {
      const r = consentReducer(run([consent(0)]).state, {
        ...consent(10_000),
        summary: summary(over),
      } as ConsentEvent);
      eq(r.effect.kind, 'summary');
      eq((r.effect as { changed: boolean }).changed, true);
    }
  }
);

check(
  'цена неизвестна — отказ, сводки нет, и второе «генерируй» не стартует',
  () => {
    const unknown = summary({ charge: { kind: 'unknown', reason: 'no-data' } });
    const r = run([
      consent(0, { summary: unknown }),
      consent(1000, { summary: unknown }),
    ]);
    eq(r.effects, ['refuse:no-price', 'refuse:no-price']);
    eq(r.state, CONSENT_INITIAL);
    const locked = summary({ charge: { kind: 'unknown', reason: 'locked' } });
    eq(run([consent(0, { summary: locked })]).effects, ['refuse:locked']);
  }
);

check('цена пропала между сводкой и согласием — отказ, сводка закрыта', () => {
  const r = run([
    consent(0),
    consent(1000, {
      summary: summary({ charge: { kind: 'unknown', reason: 'no-data' } }),
    }),
  ]);
  eq(r.effects, ['summary', 'refuse:no-price']);
  eq(r.state, CONSENT_INITIAL);
});

check('карточка «я понял так» на экране — не согласие', () => {
  eq(run([consent(0, { hasPendingCard: true })]).effects, [
    'refuse:pending-card',
  ]);
  const r = run([consent(0), consent(1000, { hasPendingCard: true })]);
  eq(r.effects, ['summary', 'refuse:pending-card']);
  // Сводка при этом жива: следующее «генерируй» без карточки — старт.
  eq(consentReducer(r.state, consent(2000)).effect.kind, 'start');
});

check('низкая уверенность — переспрос, не старт; сводка остаётся', () => {
  const low = CONSENT_CONFIDENCE_MIN - 0.01;
  eq(run([consent(0, { confidence: low })]).effects, ['refuse:low-confidence']);
  const r = run([consent(0), consent(1000, { confidence: low })]);
  eq(r.effects, ['summary', 'refuse:low-confidence']);
  eq(r.state.phase, 'shown');
  eq(
    run([consent(0), consent(1000, { confidence: CONSENT_CONFIDENCE_MIN })])
      .effects,
    ['summary', 'start']
  );
  eq(run([consent(0, { confidence: Number.NaN })]).effects, [
    'refuse:low-confidence',
  ]);
});

check('кнопка занята / ролик идёт / готов — отказ причиной', () => {
  for (const block of ['busy', 'in-progress', 'done'] as const) {
    const r = run([consent(0), consent(1000, { block })]);
    eq(r.effects, ['summary', `refuse:${block}`]);
    eq(r.state, CONSENT_INITIAL);
  }
});

check('«нет»/отмена и другое действие закрывают сводку', () => {
  eq(run([consent(0), { type: 'cancel' }, consent(1000)]).effects, [
    'summary',
    'closed',
    'summary',
  ]);
  eq(run([consent(0), { type: 'interrupt' }, consent(1000)]).effects, [
    'summary',
    'closed',
    'summary',
  ]);
  eq(run([{ type: 'cancel' }]).effects, ['none']);
});

check('renderChargeOf — зеркало assertCanRender', () => {
  eq(renderChargeOf(null), { kind: 'unknown', reason: 'no-data' });
  const f = (
    wallEnabled: boolean,
    generationsAvailable: number,
    unlocked: boolean
  ) => renderChargeOf({ wallEnabled, generationsAvailable, unlocked });
  // Стена выключена: кредит, если есть, иначе лимит тарифа.
  eq(f(false, 2, false), { kind: 'credit', balance: 2 });
  eq(f(false, 0, false), { kind: 'included' });
  // Стена включена: право — без кредита, даже если кредиты есть.
  eq(f(true, 5, true), { kind: 'included' });
  eq(f(true, 1, false), { kind: 'credit', balance: 1 });
  // Ни права, ни кредитов — цену назвать нельзя.
  eq(f(true, 0, false), { kind: 'unknown', reason: 'locked' });
  eq(f(true, -3, false), { kind: 'unknown', reason: 'locked' });
});

check('consentRoute — куда идёт реплика', () => {
  eq(consentRoute('consent', false, false), 'consent');
  eq(consentRoute('consent', true, true), 'consent');
  eq(consentRoute('cancel', false, true), 'cancel');
  eq(consentRoute('cancel', true, true), 'pass');
  eq(consentRoute('cancel', false, false), 'pass');
  // «Да», «ага», непонятое при сводке — подсказка, что сказать, а не
  // «подтверждать нечего».
  eq(consentRoute('unknown', false, true), 'hint');
  eq(consentRoute('confirm', false, true), 'hint');
  eq(consentRoute(null, false, true), 'hint');
  eq(consentRoute('unknown', false, false), 'pass');
  eq(consentRoute('confirm', false, false), 'pass');
  // При карточке «я понял так» «да»/«нет» — ей.
  eq(consentRoute('confirm', true, true), 'pass');
  eq(consentRoute('unknown', true, true), 'pass');
  eq(consentRoute('fill', true, true), 'interrupt');
  eq(consentRoute('help', false, true), 'pass');
  eq(consentRoute('fill', false, true), 'interrupt');
  // Переход ничего не меняет в данных — сводка остаётся (финальный аудит).
  eq(consentRoute('navigate', false, true), 'pass');
  eq(consentRoute('navigate', true, true), 'pass');
  eq(consentRoute('command', false, true), 'interrupt');
  eq(consentRoute('fill', false, false), 'pass');
  // K4: вопрос о шаге ничего не меняет — сводку не закрывает.
  eq(consentRoute('question', false, true), 'pass');
  eq(consentRoute('question', true, true), 'pass');
});

check('chargeText — цена словами; неизвестная — null', () => {
  const t = { costCredit: '1 из {balance}', costIncluded: 'входит' };
  eq(chargeText({ kind: 'credit', balance: 4 }, t), '1 из 4');
  eq(chargeText({ kind: 'included' }, t), 'входит');
  eq(chargeText({ kind: 'unknown', reason: 'no-data' }, t), null);
});

// ── runConsent: сеть между фразой и решением ─────────────────────────

async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

function harness(opts: { start?: ConsentState } = {}) {
  let state: ConsentState = opts.start ?? CONSENT_INITIAL;
  let input: ConsentInput = {
    facts: { ...FACTS },
    occasionLabel: 'День рождения',
    qualityLabel: '720p · grok',
    block: null,
  };
  let valid = true;
  let starts = 0;
  let release: (c: RenderCharge) => void = () => undefined;
  const run = (confidence = 0.95) =>
    runConsent({
      confidence,
      hasPendingCard: false,
      fetchCharge: () =>
        new Promise<RenderCharge>((r) => {
          release = r;
        }),
      stillValid: () => valid,
      read: () => input,
      step: (e): ConsentEffect => {
        const r = consentReducer(state, e);
        state = r.state;
        return r.effect;
      },
      start: () => {
        starts++;
      },
      now: () => 1000,
    });
  return {
    run,
    release: (c: RenderCharge) => release(c),
    invalidate: () => {
      valid = false;
    },
    setInput: (next: Partial<ConsentInput>) => {
      input = { ...input, ...next };
    },
    starts: () => starts,
    state: () => state,
  };
}

const shownFor = (at = 0): ConsentState => ({
  phase: 'shown',
  summary: summary(),
  shownAt: at,
});

async function main() {
  await checkAsync(
    'runConsent: сводка → второе «генерируй» нажимает кнопку',
    async () => {
      const h = harness();
      const first = h.run();
      h.release(FACTS.charge);
      eq((await first)?.kind, 'summary');
      eq(h.starts(), 0);
      const second = h.run();
      h.release(FACTS.charge);
      eq((await second)?.kind, 'start');
      eq(h.starts(), 1);
    }
  );

  await checkAsync(
    'runConsent: шаг снят/вытеснен, пока ждали цену, — ничего',
    async () => {
      const h = harness({ start: shownFor() });
      const p = h.run();
      h.invalidate();
      h.release(FACTS.charge);
      eq(await p, null);
      eq(h.starts(), 0);
      eq(h.state().phase, 'shown');
    }
  );

  await checkAsync(
    'runConsent: сессия сменилась, пока ждали цену, — ничего',
    async () => {
      const h = harness({ start: shownFor() });
      const p = h.run();
      h.setInput({ facts: { ...FACTS, sessionId: 's2' } });
      h.release(FACTS.charge);
      eq(await p, null);
      eq(h.starts(), 0);
    }
  );

  await checkAsync(
    'runConsent: цена неизвестна — отказ, кнопка не нажата',
    async () => {
      const h = harness({ start: shownFor() });
      const p = h.run();
      h.release({ kind: 'unknown', reason: 'locked' });
      eq(await p, { kind: 'refuse', reason: 'locked' });
      eq(h.starts(), 0);
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

void main();
