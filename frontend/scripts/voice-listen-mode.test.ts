// Plain assertions runnable with `npx tsx scripts/voice-listen-mode.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.7.5 (В-15): режим прослушивания — три
// условия владельца (только у включивших, первое включение нажатием;
// 20 с тишины → кнопка; открытый микрофон виден и гаснет одним касанием).

import {
  LISTEN_INITIAL,
  autoListenDecision,
  isCurrentUtterance,
  listenReducer,
  micOpen,
  watchPageHidden,
  type ListenEvent,
  type ListenState,
} from '../src/lib/voice-listen-mode';

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

const run = (events: ListenEvent[], from: ListenState = LISTEN_INITIAL) =>
  events.reduce(listenReducer, from);

check('нажатие → разрешение → слушаю → фраза → разбор → снова слушаю', () => {
  const s = run([
    { type: 'enable' },
    { type: 'granted' },
    { type: 'speech-start' },
    { type: 'utterance', keep: true },
  ]);
  eq(s.phase, 'processing');
  eq(listenReducer(s, { type: 'processed', seq: s.seq }).phase, 'listening');
});

check('шум (keep: false) — сразу обратно слушать, без разбора', () => {
  const s = run([
    { type: 'enable' },
    { type: 'granted' },
    { type: 'speech-start' },
    { type: 'utterance', keep: false },
  ]);
  eq(s.phase, 'listening');
});

check('20 с тишины → микрофон закрыт, кнопка ждёт, причина названа', () => {
  const s = run([
    { type: 'enable' },
    { type: 'granted' },
    { type: 'idle-timeout' },
  ]);
  eq([s.phase, s.notice], ['off', 'idle']);
  eq(micOpen(s.phase), false);
});

check('отказ в разрешении → закрыт с причиной «denied»', () => {
  const s = run([{ type: 'enable' }, { type: 'denied' }]);
  eq([s.phase, s.notice], ['off', 'denied']);
});

check('одно касание гасит микрофон из любого открытого состояния', () => {
  const opened: ListenEvent[][] = [
    [{ type: 'enable' }],
    [{ type: 'enable' }, { type: 'granted' }],
    [{ type: 'enable' }, { type: 'granted' }, { type: 'speech-start' }],
    [
      { type: 'enable' },
      { type: 'granted' },
      { type: 'speech-start' },
      { type: 'utterance', keep: true },
    ],
    [{ type: 'hold-start' }],
  ];
  for (const events of opened) {
    const s = run(events);
    if (!micOpen(s.phase)) throw new Error(`${s.phase} не считается открытым`);
    const off = listenReducer(s, { type: 'disable' });
    eq({ ...off, seq: 0 }, LISTEN_INITIAL);
    // Выключение делает ответ на отрезок в полёте устаревшим.
    if (off.seq <= s.seq) throw new Error('seq не вырос при выключении');
  }
});

check(
  'выключили во время разбора — после ответа микрофон НЕ открывается',
  () => {
    const s = run([
      { type: 'enable' },
      { type: 'granted' },
      { type: 'speech-start' },
      { type: 'utterance', keep: true },
      { type: 'disable' },
      { type: 'processed', seq: 1 },
    ]);
    eq(s.phase, 'off');
  }
);

check(
  'ручная фраза: только при выключенном прослушивании, потом — к кнопке',
  () => {
    const listening = run([{ type: 'enable' }, { type: 'granted' }]);
    eq(listenReducer(listening, { type: 'hold-start' }).phase, 'listening');
    const s = run([{ type: 'hold-start' }, { type: 'hold-end', keep: true }]);
    eq(s.phase, 'processing');
    eq(listenReducer(s, { type: 'processed', seq: s.seq }).phase, 'off');
    eq(
      run([{ type: 'hold-start' }, { type: 'hold-end', keep: false }]).phase,
      'off'
    );
  }
);

check(
  'потолок — конечное состояние: ни кнопка, ни ручная фраза не открывают',
  () => {
    const s = run([
      { type: 'enable' },
      { type: 'granted' },
      { type: 'budget-exhausted' },
    ]);
    eq(s.phase, 'blocked');
    eq(
      run([{ type: 'enable' }, { type: 'hold-start' }, { type: 'granted' }], s)
        .phase,
      'blocked'
    );
    eq(micOpen('blocked'), false);
  }
);

check('«выключить» на потолке и без поддержки не возвращает кнопку', () => {
  const blocked = run([{ type: 'budget-exhausted' }]);
  eq(listenReducer(blocked, { type: 'disable' }).phase, 'blocked');
  const unsupported: ListenState = { ...LISTEN_INITIAL, phase: 'unsupported' };
  eq(listenReducer(unsupported, { type: 'disable' }).phase, 'unsupported');
  eq(
    listenReducer(unsupported, { type: 'budget-exhausted' }).phase,
    'unsupported'
  );
});

check('«granted» без запроса ничего не открывает', () => {
  eq(listenReducer(LISTEN_INITIAL, { type: 'granted' }), LISTEN_INITIAL);
});

const auto = {
  voiceOn: true,
  armed: true,
  permission: 'granted' as const,
  blocked: false,
  supported: true,
};

check(
  'сам слушает только включавший раньше И с подтверждённым разрешением',
  () => {
    eq(autoListenDecision(auto), 'listen');
    eq(autoListenDecision({ ...auto, armed: false }), 'wait-tap');
    for (const permission of ['prompt', 'unknown', 'denied'] as const) {
      eq(autoListenDecision({ ...auto, permission }), 'wait-tap');
    }
  }
);

check('без «голосом», при потолке или без поддержки — вовсе нет', () => {
  eq(autoListenDecision({ ...auto, voiceOn: false }), 'off');
  eq(autoListenDecision({ ...auto, blocked: true }), 'off');
  eq(autoListenDecision({ ...auto, supported: false }), 'off');
});

check(
  'ответ на старый отрезок не возвращает режим и не считается текущим',
  () => {
    const first = run([
      { type: 'enable' },
      { type: 'granted' },
      { type: 'speech-start' },
      { type: 'utterance', keep: true },
    ]);
    eq(isCurrentUtterance(first, first.seq), true);
    // Выключили и включили снова, сказали новое — пока старый ответ шёл.
    const second = run(
      [
        { type: 'disable' },
        { type: 'enable' },
        { type: 'granted' },
        { type: 'speech-start' },
        { type: 'utterance', keep: true },
      ],
      first
    );
    eq(isCurrentUtterance(second, first.seq), false);
    eq(listenReducer(second, { type: 'processed', seq: first.seq }), second);
    eq(
      listenReducer(second, { type: 'processed', seq: second.seq }).phase,
      'listening'
    );
  }
);

check('шум (keep: false) номер отрезка не тратит', () => {
  const s = run([
    { type: 'enable' },
    { type: 'granted' },
    { type: 'speech-start' },
    { type: 'utterance', keep: false },
  ]);
  eq(s.seq, 0);
  eq(run([{ type: 'hold-start' }, { type: 'hold-end', keep: false }]).seq, 0);
});

check('потолок делает ответ в полёте устаревшим', () => {
  const s = run([{ type: 'hold-start' }, { type: 'hold-end', keep: true }]);
  const b = listenReducer(s, { type: 'budget-exhausted' });
  eq(isCurrentUtterance(b, s.seq), false);
});

/** Цель событий: слушатели по типу, `fire` — как браузер. */
class FakeTarget {
  private readonly ls = new Map<string, Set<() => void>>();
  visibilityState = 'visible';
  addEventListener(t: string, l: () => void) {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)!.add(l);
  }
  removeEventListener(t: string, l: () => void) {
    this.ls.get(t)?.delete(l);
  }
  onEvent(t: string, l: () => void) {
    this.addEventListener(t, l);
  }
  offEvent(t: string, l: () => void) {
    this.removeEventListener(t, l);
  }
  fire(t: string) {
    for (const l of [...(this.ls.get(t) ?? [])]) l();
  }
  count() {
    let n = 0;
    for (const s of this.ls.values()) n += s.size;
    return n;
  }
}

check('микрофон гаснет: pagehide, скрытая вкладка, свёрнутый Telegram', () => {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const tg = new FakeTarget();
  let released = 0;
  const off = watchPageHidden(
    { window: win, document: doc, telegram: tg },
    () => released++
  );
  // Видимая вкладка сменила видимость на видимую — не уход.
  doc.fire('visibilitychange');
  eq(released, 0);
  doc.visibilityState = 'hidden';
  doc.fire('visibilitychange');
  win.fire('pagehide');
  tg.fire('deactivated');
  eq(released, 3);
  off();
  eq([win.count(), doc.count(), tg.count()], [0, 0, 0]);
  win.fire('pagehide');
  eq(released, 3);
  // Вне Telegram — только окно и документ.
  const off2 = watchPageHidden(
    { window: win, document: doc, telegram: null },
    () => released++
  );
  win.fire('pagehide');
  eq(released, 4);
  off2();
});

check('потолок снят сменой тарифа — к кнопке, не сразу слушать', () => {
  const b = listenReducer(LISTEN_INITIAL, { type: 'budget-exhausted' });
  const u = listenReducer(b, { type: 'unblock' });
  eq([u.phase, u.resumeTo, u.notice], ['off', 'off', null]);
  // Устаревший ответ до снятия не оживёт.
  eq(u.seq > b.seq, true);
  // Не заблокирован — ничего не меняется.
  const on = listenReducer(LISTEN_INITIAL, { type: 'enable' });
  eq(listenReducer(on, { type: 'unblock' }), on);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);

for (const phase of [
  'requesting',
  'listening',
  'recording',
  'processing',
  'holding',
] as const) {
  const before = { ...LISTEN_INITIAL, phase, seq: 4 };
  const after = listenReducer(before, { type: 'recording-error' });
  if (
    after.phase !== 'off' ||
    after.notice !== 'recording-error' ||
    isCurrentUtterance(after, 4)
  )
    throw new Error('Ошибка записи не остановила ' + phase);
}
