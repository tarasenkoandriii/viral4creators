// Plain assertions runnable with `npx tsx scripts/voice-listen.test.ts`.
//
// Этап K3 ТЗ Greeting 2.0 §4А.7.5 (В-15, условие 2): детектор речи на
// устройстве. Синтетические кадры вместо микрофона: правила «конец
// фразы», «шум не уходит на сервер» и «20 с тишины — микрофон гаснет»
// проверяются счётом кадров.

import {
  SPEECH_DETECTOR_DEFAULTS as C,
  initialDetector,
  pauseDetector,
  pickRecorderMime,
  resumeDetector,
  rmsOf,
  speechThreshold,
  stepDetector,
  type SpeechDetectorEvent,
  type SpeechDetectorState,
} from '../src/lib/voice-listen';

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

const LOUD = 0.2;
const QUIET = 0.001;
const frames = (ms: number, rms: number) =>
  Array.from({ length: Math.round(ms / C.frameMs) }, () => rms);

/** Прогнать кадры; события — с номером кадра (мс от начала). */
function run(
  input: number[],
  from: SpeechDetectorState = initialDetector(C)
): {
  state: SpeechDetectorState;
  events: Array<SpeechDetectorEvent & { at: number }>;
} {
  let state = from;
  const events: Array<SpeechDetectorEvent & { at: number }> = [];
  input.forEach((rms, i) => {
    const r = stepDetector(state, rms, C);
    state = r.state;
    for (const e of r.events) events.push({ ...e, at: (i + 1) * C.frameMs });
  });
  return { state, events };
}

check('полсекунды речи и пауза → один отрезок, отправляется', () => {
  const { events } = run([...frames(500, LOUD), ...frames(2000, QUIET)]);
  eq(
    events.map((e) => e.type),
    ['start', 'end']
  );
  const end = events[1] as Extract<SpeechDetectorEvent, { type: 'end' }>;
  eq([end.keep, end.reason, end.speechMs], [true, 'silence', 500]);
});

check('конец фразы — ровно через hangover тишины, не раньше', () => {
  const { events } = run([...frames(500, LOUD), ...frames(2000, QUIET)]);
  eq(events[1].at, 500 + C.hangoverMs);
  // На кадр короче хвоста — фраза ещё идёт.
  const short = run([
    ...frames(500, LOUD),
    ...frames(C.hangoverMs - C.frameMs, QUIET),
  ]);
  eq(
    short.events.map((e) => e.type),
    ['start']
  );
});

check('пауза между словами короче хвоста фразу не режет', () => {
  const { events } = run([
    ...frames(400, LOUD),
    ...frames(500, QUIET),
    ...frames(400, LOUD),
    ...frames(2000, QUIET),
  ]);
  eq(
    events.map((e) => e.type),
    ['start', 'end']
  );
  eq((events[1] as { speechMs: number }).speechMs, 800);
});

check('щелчок короче minSpeech — шум: запись выбрасывается', () => {
  const { events } = run([...frames(100, LOUD), ...frames(2000, QUIET)]);
  const end = events.find((e) => e.type === 'end') as { keep: boolean };
  eq(end.keep, false);
});

check('граница minSpeech: ровно порог — речь, на кадр меньше — шум', () => {
  const at = run([...frames(C.minSpeechMs, LOUD), ...frames(2000, QUIET)]);
  eq((at.events[1] as { keep: boolean }).keep, true);
  const below = run([
    ...frames(C.minSpeechMs - C.frameMs, LOUD),
    ...frames(2000, QUIET),
  ]);
  eq((below.events[1] as { keep: boolean }).keep, false);
});

check('длинный монолог режется потолком и всё же отправляется', () => {
  const { events } = run(frames(C.maxUtteranceMs + 1000, LOUD));
  const end = events.find((e) => e.type === 'end') as {
    keep: boolean;
    reason: string;
    durationMs: number;
  };
  eq(
    [end.keep, end.reason, end.durationMs],
    [true, 'max-length', C.maxUtteranceMs]
  );
});

check('20 с тишины с открытия → idle-timeout, дальше кадры не идут', () => {
  const { events, state } = run(frames(C.idleStopMs + 5000, QUIET));
  eq(
    events.map((e) => [e.type, e.at]),
    [['idle-timeout', C.idleStopMs]]
  );
  eq(state.stopped, true);
  // После остановки даже громкий кадр ничего не открывает.
  eq(stepDetector(state, LOUD, C).events, []);
});

check('на кадр раньше 20 с — ещё слушаем', () => {
  const { events } = run(frames(C.idleStopMs - C.frameMs, QUIET));
  eq(events, []);
});

check('речь обнуляет отсчёт 20 с', () => {
  const { events } = run([
    ...frames(15_000, QUIET),
    ...frames(500, LOUD),
    ...frames(15_000, QUIET),
  ]);
  eq(
    events.map((e) => e.type),
    ['start', 'end']
  );
});

check('шум (выброшенный отрезок) отсчёт 20 с НЕ обнуляет', () => {
  const { events } = run([
    ...frames(15_000, QUIET),
    ...frames(100, LOUD),
    ...frames(10_000, QUIET),
  ]);
  eq(
    events.map((e) => e.type),
    ['start', 'end', 'idle-timeout']
  );
  // Хлопок и хвост после него засчитаны в тишину целиком.
  eq(events[2].at, C.idleStopMs);
});

check('resume: 20 с считаются заново после ответа помощника', () => {
  const first = run(frames(15_000, QUIET));
  const resumed = resumeDetector(first.state);
  eq(resumed.quietMs, 0);
  const { events } = run(frames(15_000, QUIET), resumed);
  eq(events, []);
});

check(
  'ровный гул между порогом начала и речи: учит шум и перестаёт открывать запись',
  () => {
    // Гул 0.012: ниже порога речи (0.015), но выше порога начала (0.009).
    const { events, state } = run(frames(6000, 0.012));
    if (events.some((e) => e.type === 'end' && e.keep)) {
      throw new Error('гул ушёл на сервер');
    }
    const starts = events.filter((e) => e.type === 'start').length;
    if (starts > 2) throw new Error(`гул открыл запись ${starts} раз`);
    // Выученный шум поднял порог выше гула: дальше он — фон.
    if (speechThreshold(state.noiseFloor, C) * C.onsetRatio <= 0.012) {
      throw new Error(
        `порог начала ${speechThreshold(state.noiseFloor, C)} не выше гула`
      );
    }
    eq(run(frames(2000, 0.012), state).events, []);
  }
);

check(
  'ровный фон тишины учит шум: кадр 0.03 на выученном фоне — не речь',
  () => {
    let state = initialDetector(C);
    for (const rms of frames(5000, 0.008))
      state = stepDetector(state, rms, C).state;
    const t = speechThreshold(state.noiseFloor, C);
    if (t <= 0.02) throw new Error(`порог ${t} не поднялся`);
    // Один кадр 0.03 выше порога начала — запись начнётся, но в речь без
    // речевых кадров не превратится.
    const { events } = run([0.03, ...frames(2000, 0.008)], state);
    eq(
      events
        .filter((e) => e.type === 'end')
        .map((e) => (e as { keep: boolean }).keep),
      [false]
    );
  }
);

check(
  'мягкое начало: запись с порога начала, речью — только громкие кадры',
  () => {
    const soft = speechThreshold(initialDetector(C).noiseFloor, C) * 0.8;
    const { events } = run([
      soft,
      soft,
      ...frames(200, LOUD),
      ...frames(2000, QUIET),
    ]);
    eq(events[0].type, 'start');
    eq(events[0].at, C.frameMs);
    const end = events[1] as {
      keep: boolean;
      speechMs: number;
      durationMs: number;
    };
    eq([end.keep, end.speechMs], [true, 200]);
    // Одни мягкие кадры — шум.
    const onlySoft = run([...frames(500, soft), ...frames(2000, QUIET)]);
    eq((onlySoft.events[1] as { keep: boolean }).keep, false);
  }
);

check('короткое «да» (150 мс) — речь', () => {
  const { events } = run([...frames(150, LOUD), ...frames(2000, QUIET)]);
  eq((events[1] as { keep: boolean }).keep, true);
});

// ── Голос советника (K1) и перебивание ──────────────────────────────

/** Прогон с флагом «советник говорит» на кадр. */
function runPlaying(
  input: Array<[number, boolean]>,
  from: SpeechDetectorState = initialDetector(C)
) {
  let state = from;
  const events: Array<SpeechDetectorEvent & { at: number }> = [];
  input.forEach(([rms, playing], i) => {
    const r = stepDetector(state, rms, C, playing);
    state = r.state;
    for (const e of r.events) events.push({ ...e, at: (i + 1) * C.frameMs });
  });
  return { state, events };
}
const playingFrames = (ms: number, rms: number): Array<[number, boolean]> =>
  frames(ms, rms).map((x) => [x, true]);
const silentFrames = (ms: number, rms: number): Array<[number, boolean]> =>
  frames(ms, rms).map((x) => [x, false]);

check(
  'пока говорит советник, отрезок не начинается (его голос не уходит)',
  () => {
    // Утечка советника в микрофон — выше порога речи, но ниже порога перебивания.
    const leak = C.minRms * 1.5;
    const { events } = runPlaying(playingFrames(3000, leak));
    eq(events, []);
  }
);

check('советник говорит — 20 с тишины не идут', () => {
  const { events, state } = runPlaying(
    playingFrames(C.idleStopMs + 5000, QUIET)
  );
  eq(events, []);
  eq(state.quietMs, 0);
});

check('реплика советника обнуляет отсчёт 20 с — считается после неё', () => {
  const { events } = runPlaying([
    ...silentFrames(15_000, QUIET),
    ...playingFrames(3000, QUIET),
    ...silentFrames(10_000, QUIET),
  ]);
  eq(events, []);
});

check(
  'громкая речь поверх советника → barge-in, после — чистый отрезок',
  () => {
    const { events, state } = runPlaying([
      ...playingFrames(500, QUIET),
      ...playingFrames(C.bargeInMs, LOUD),
    ]);
    eq(
      events.map((e) => [e.type, e.at]),
      [['barge-in', 500 + C.bargeInMs]]
    );
    eq(state.phase, 'idle');
    // Советник замолчал; человек продолжает — новый отрезок с нуля.
    const after = runPlaying(
      [...silentFrames(500, LOUD), ...silentFrames(2000, QUIET)],
      state
    );
    eq(
      after.events.map((e) => e.type),
      ['start', 'end']
    );
    eq((after.events[1] as { speechMs: number }).speechMs, 500);
  }
);

check(
  'перебивание — только подряд: всплески короче bargeInMs не глушат',
  () => {
    const blips: Array<[number, boolean]> = [];
    for (let i = 0; i < 20; i++) blips.push([LOUD, true], [QUIET, true]);
    eq(runPlaying(blips).events, []);
  }
);

check('советник заговорил посреди отрезка — отрезок выбрасывается', () => {
  const { events, state } = runPlaying([
    ...silentFrames(400, LOUD),
    [LOUD, true],
  ]);
  eq(
    events.map((e) => e.type),
    ['start', 'end']
  );
  const end = events[1] as { keep: boolean; reason: string };
  eq([end.keep, end.reason], [false, 'playback']);
  eq(state.phase, 'idle');
});

check('rmsOf — среднеквадратичное', () => {
  eq(rmsOf([]), 0);
  eq(rmsOf([0.5, -0.5, 0.5, -0.5]), 0.5);
  eq(Math.round(rmsOf([1, 0]) * 1000), 707);
});

check(
  'формат записи — первый поддерживаемый, иначе выбор браузера (null)',
  () => {
    eq(
      pickRecorderMime((m) => m === 'audio/mp4'),
      'audio/mp4'
    );
    eq(
      pickRecorderMime(() => true),
      'audio/webm;codecs=opus'
    );
    eq(
      pickRecorderMime(() => false),
      null
    );
  }
);

check(
  'потолок фразы — 45 с (изменение контракта 4), меньше серверных 60 с',
  () => {
    eq(C.maxUtteranceMs, 45_000);
  }
);

check('микрофон занят: начатый отрезок выброшен, тишина не копится', () => {
  // Отрезок начался, потом микрофон взяла запись образца.
  const started = run(frames(500, LOUD));
  eq(started.state.phase, 'speech');
  const p = pauseDetector(started.state);
  eq(
    p.events.map((e) => [e.type, (e as { keep?: boolean }).keep]),
    [['end', false]]
  );
  eq([p.state.phase, p.state.quietMs], ['idle', 0]);
  // Долгая пауза «занято» не гасит микрофон: счёт тишины стоит.
  let st = run(frames(C.idleStopMs - 1000, QUIET)).state;
  for (let i = 0; i < 1000; i++) st = pauseDetector(st).state;
  eq([st.quietMs, st.stopped], [0, false]);
  // Погашенный тишиной детектор пауза не оживляет.
  const stopped = run(frames(C.idleStopMs + 100, QUIET)).state;
  eq(pauseDetector(stopped).state, stopped);
});

console.log(failed ? `\n${failed} провалено` : `\n${passed} проверок пройдено`);
if (failed) process.exit(1);
