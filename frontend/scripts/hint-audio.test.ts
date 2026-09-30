// Plain assertions runnable with `npx tsx scripts/hint-audio.test.ts`.
//
// Этап K1 ТЗ Greeting 2.0 (§4А.4): голос советника — когда говорить,
// как понимать ответ сервера, «без звука» на устройстве, один плеер.

import {
  HINT_AUDIO_MUTED_KEY,
  SILENT_WAV,
  VOICE_BUDGET_DAY_KEY,
  budgetExhaustedOn,
  createBudgetMemory,
  dropLegacyBudgetKey,
  createHintPlayer,
  createOnceClaim,
  rememberBudgetExhausted,
  utcDay,
  voiceBudgetKey,
  voiceBudgetUserOf,
  hintVoicePlan,
  interpretHintAudio,
  readMuted,
  writeMuted,
  type AudioLike,
  type StorageLike,
} from '../src/lib/hint-audio';

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

// ── Когда говорить ───────────────────────────────────────────────────

const ready = {
  voice: true,
  muted: false,
  gestured: true,
  budgetExhausted: false,
  hintKey: 'GREETING_VIDEO|brief|ru|s|d',
  spokenKey: null as string | null,
};

check('всё готово — говорить', () => {
  eq(hintVoicePlan(ready), 'speak');
});

check('голос выключен — ни звука, ни кнопок', () => {
  eq(hintVoicePlan({ ...ready, voice: false }), 'off');
});

check('нет ключа подсказки — озвучивать нечего', () => {
  eq(hintVoicePlan({ ...ready, hintKey: null }), 'off');
  eq(hintVoicePlan({ ...ready, hintKey: undefined }), 'off');
});

check('потолок голоса исчерпан — больше не просим', () => {
  eq(hintVoicePlan({ ...ready, budgetExhausted: true }), 'off');
});

check('«без звука» — молчим, даже если касание было', () => {
  eq(hintVoicePlan({ ...ready, muted: true }), 'muted');
});

check('до первого касания — только текст и приглашение коснуться', () => {
  // iOS/WebView запрещают звук без жеста: запрос файла без права его
  // сыграть был бы платным молчанием.
  eq(hintVoicePlan({ ...ready, gestured: false }), 'await-gesture');
});

check('та же реплика второй раз не звучит', () => {
  eq(hintVoicePlan({ ...ready, spokenKey: ready.hintKey }), 'done');
});

check('новая реплика после прежней — звучит', () => {
  eq(hintVoicePlan({ ...ready, spokenKey: 'другой|ключ' }), 'speak');
});

// ── Ответ сервера ────────────────────────────────────────────────────

check('200 { url } — играть', () => {
  eq(interpretHintAudio({ url: 'https://blob/x.mp3' }), {
    kind: 'play',
    url: 'https://blob/x.mp3',
  });
});

check('204 — пустое тело — тишина', () => {
  eq(interpretHintAudio(undefined), { kind: 'silent' });
  eq(interpretHintAudio(''), { kind: 'silent' });
  eq(interpretHintAudio(null), { kind: 'silent' });
});

check('потолок голоса — отдельный ответ, о нём говорят', () => {
  eq(interpretHintAudio({ url: null, reason: 'budget-exhausted' }), {
    kind: 'budget-exhausted',
  });
});

check('незнакомая причина и не-http ссылка — тишина', () => {
  eq(interpretHintAudio({ url: null, reason: 'что-то новое' }), {
    kind: 'silent',
  });
  eq(interpretHintAudio({ url: 'javascript:alert(1)' }), { kind: 'silent' });
});

// ── «Без звука» на устройстве ────────────────────────────────────────

function memory(): StorageLike & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}
const broken: StorageLike = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

check('по умолчанию звук включён', () => {
  eq(readMuted(memory()), false);
  eq(readMuted(null), false);
});

check('«без звука» запоминается и читается', () => {
  const s = memory();
  writeMuted(s, true);
  eq(s.data[HINT_AUDIO_MUTED_KEY], '1');
  eq(readMuted(s), true);
  writeMuted(s, false);
  eq(readMuted(s), false);
});

check('бросающее хранилище не роняет мастер', () => {
  eq(readMuted(broken), false);
  writeMuted(broken, true); // не бросает
});

// ── Плеер ────────────────────────────────────────────────────────────

function fakeAudio() {
  const log: string[] = [];
  let made = 0;
  const el: AudioLike = {
    src: '',
    muted: false,
    currentTime: 5,
    play: () => {
      log.push(`play:${el.muted ? 'muted' : 'loud'}:${el.src}`);
      return Promise.reject(new Error('NotAllowedError'));
    },
    pause: () => {
      log.push('pause');
    },
  };
  return {
    log,
    el,
    made: () => made,
    make: () => {
      made++;
      return el;
    },
  };
}

check('отпирание — беззвучный файл, один раз', () => {
  const a = fakeAudio();
  const p = createHintPlayer(a.make);
  eq(p.unlocked, false);
  p.unlock();
  p.unlock();
  eq(p.unlocked, true);
  eq(a.log, [`play:muted:${SILENT_WAV}`]);
});

check('реплики играют на ТОМ ЖЕ элементе, что отперли', () => {
  // Разрешение iOS выдаётся элементу: новый элемент на реплику молчал бы.
  const a = fakeAudio();
  const p = createHintPlayer(a.make);
  p.unlock();
  p.play('https://blob/1.mp3');
  p.play('https://blob/2.mp3');
  eq(a.made(), 1);
});

check('новая реплика обрывает прежнюю и звучит громко с начала', () => {
  const a = fakeAudio();
  const p = createHintPlayer(a.make);
  p.unlock();
  a.log.length = 0;
  p.play('https://blob/2.mp3');
  eq(a.log, ['pause', 'play:loud:https://blob/2.mp3']);
  eq(a.el.currentTime, 0);
});

check('stop глушит и перематывает', () => {
  const a = fakeAudio();
  const p = createHintPlayer(a.make);
  p.play('https://blob/1.mp3');
  a.el.currentTime = 3;
  a.log.length = 0;
  p.stop();
  eq(a.log, ['pause']);
  eq(a.el.currentTime, 0);
});

check('stop до первой реплики не создаёт элемент', () => {
  const a = fakeAudio();
  createHintPlayer(a.make).stop();
  eq(a.made(), 0);
});

// ── Потолок голоса: общий источник на сутки UTC (аудит волны 1) ─────

const ann = { userId: 'tg-1', plan: 'LITE' };

check('ключ — с человеком (изменение контракта 6), сутки — UTC', () => {
  eq(voiceBudgetKey('tg-1'), 'greeting-voice-budget-day:tg-1');
  eq(VOICE_BUDGET_DAY_KEY, 'greeting-voice-budget-day');
  eq(utcDay(new Date('2026-09-29T23:59:59Z')), '2026-09-29');
});

check('сутки считаются по UTC, а не по часам устройства', () => {
  // 01:30 по Киеву 30-го — ещё 29-е по UTC.
  eq(utcDay(new Date('2026-09-30T01:30:00+03:00')), '2026-09-29');
});

check('исчерпан сегодня — помнится, завтра — нет', () => {
  const s = memory();
  const today = new Date('2026-09-29T10:00:00Z');
  eq(budgetExhaustedOn(s, today, ann), false);
  rememberBudgetExhausted(s, today, ann);
  eq(JSON.parse(s.data[voiceBudgetKey('tg-1')]), {
    day: '2026-09-29',
    plan: 'LITE',
  });
  eq(budgetExhaustedOn(s, new Date('2026-09-29T23:00:00Z'), ann), true);
  eq(budgetExhaustedOn(s, new Date('2026-09-30T00:00:01Z'), ann), false);
});

check('флаг одного человека не глушит другого на том же устройстве', () => {
  const s = memory();
  const at = new Date('2026-09-29T12:00:00Z');
  rememberBudgetExhausted(s, at, ann);
  eq(budgetExhaustedOn(s, at, { userId: 'tg-2', plan: 'LITE' }), false);
  // Старый общий ключ (без человека) больше не читается.
  const old = memory();
  old.setItem('greeting-voice-budget-day', '2026-09-29');
  eq(budgetExhaustedOn(old, at, ann), false);
});

check('сменился тариф — флаг сброшен; тариф неизвестен — флаг в силе', () => {
  const s = memory();
  const at = new Date('2026-09-29T12:00:00Z');
  rememberBudgetExhausted(s, at, ann);
  eq(budgetExhaustedOn(s, at, { userId: 'tg-1', plan: 'PREMIUM' }), false);
  eq(budgetExhaustedOn(s, at, { userId: 'tg-1', plan: null }), true);
  // Запись без тарифа (старый формат) не действует ни для какого тарифа.
  s.setItem(
    voiceBudgetKey('tg-1'),
    JSON.stringify({ day: '2026-09-29', plan: null })
  );
  eq(budgetExhaustedOn(s, at, { userId: 'tg-1', plan: 'PREMIUM' }), false);
  eq(budgetExhaustedOn(s, at, { userId: 'tg-1', plan: null }), false);
});

check(
  'потолок узнан до тарифа: в памяти сразу, на устройство — с тарифом',
  () => {
    const s = memory();
    const at = new Date('2026-09-29T12:00:00Z');
    const mem = createBudgetMemory(() => s);
    mem.mark({ userId: 'tg-1', plan: null }, at);
    eq(Object.keys(s.data), []);
    eq(mem.isExhausted({ userId: 'tg-1', plan: null }, at), true);
    // Другой человек — не он.
    eq(mem.isExhausted({ userId: 'tg-2', plan: null }, at), false);
    // Тариф пришёл — записано с ним.
    eq(mem.isExhausted({ userId: 'tg-1', plan: 'LITE' }, at), true);
    eq(JSON.parse(s.data[voiceBudgetKey('tg-1')]), {
      day: '2026-09-29',
      plan: 'LITE',
    });
    // Сменили тариф — флаг снят.
    eq(mem.isExhausted({ userId: 'tg-1', plan: 'PREMIUM' }, at), false);
    // С известным тарифом — пишется сразу.
    const s2 = memory();
    createBudgetMemory(() => s2).mark(ann, at);
    eq(budgetExhaustedOn(s2, at, ann), true);
    // Отложенное «исчерпан» вчерашнего дня сегодня не действует.
    const mem3 = createBudgetMemory(() => memory());
    mem3.mark({ userId: 'tg-1', plan: null }, at);
    eq(
      mem3.isExhausted(
        { userId: 'tg-1', plan: null },
        new Date('2026-09-30T00:00:01Z')
      ),
      false
    );
  }
);

check('старый общий ключ убирается; бросающее хранилище — без падения', () => {
  const data: Record<string, string> = {
    'greeting-voice-budget-day': '2026-09-29',
    [voiceBudgetKey('tg-1')]: 'x',
  };
  dropLegacyBudgetKey({
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  });
  eq(Object.keys(data), [voiceBudgetKey('tg-1')]);
  dropLegacyBudgetKey({
    ...broken,
    removeItem: () => {
      throw new Error('SecurityError');
    },
  });
  dropLegacyBudgetKey(null);
});

check('испорченная запись — не исчерпан, без падения', () => {
  const s = memory();
  s.setItem(voiceBudgetKey('tg-1'), '2026-09-29');
  eq(budgetExhaustedOn(s, new Date('2026-09-29T12:00:00Z'), ann), false);
});

check('чей телефон: Telegram, иначе дев-вход, иначе браузер', () => {
  eq(voiceBudgetUserOf({ telegramUserId: 42, devUserId: '7' }), 'tg-42');
  eq(voiceBudgetUserOf({ telegramUserId: null, devUserId: '7' }), 'dev-7');
  eq(voiceBudgetUserOf({ telegramUserId: ' ', devUserId: null }), 'browser');
  eq(voiceBudgetUserOf({}), 'browser');
});

check('бросающее хранилище — потолок не исчерпан, и без падения', () => {
  eq(budgetExhaustedOn(broken, new Date(), ann), false);
  rememberBudgetExhausted(broken, new Date(), ann);
});

check('о потолке говорит ровно один', () => {
  const claim = createOnceClaim();
  eq([claim(), claim(), claim()], [true, false, false]);
  // У другой страницы — своё право.
  eq(createOnceClaim()(), true);
});

// ── Играет ли реплика: микрофон не должен записать советника ─────────

function eventedAudio() {
  const listeners: Record<string, Array<() => void>> = {};
  let reject = false;
  const el: AudioLike & { fire(t: string): void } = {
    src: '',
    muted: false,
    currentTime: 0,
    paused: true,
    play: () => {
      el.paused = false;
      // Отказ — «синхронным обещанием»: `catch` зовёт обработчик сразу,
      // и проверка не зависит от очереди микрозадач.
      return reject
        ? ({ catch: (fn: () => void) => fn() } as unknown as Promise<void>)
        : Promise.resolve();
    },
    pause: () => {
      el.paused = true;
    },
    addEventListener: (t, fn) => {
      (listeners[t] ??= []).push(fn);
    },
    fire: (t) => (listeners[t] ?? []).forEach((fn) => fn()),
  };
  return {
    el,
    make: () => el,
    rejectNext: () => {
      reject = true;
    },
  };
}

check('реплика пошла — играет; stop — нет', () => {
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  const seen: boolean[] = [];
  p.onPlayingChange((v) => seen.push(v));
  p.play('https://blob/1.mp3');
  eq(p.playing, true);
  p.stop();
  eq(p.playing, false);
  eq(seen, [true, false]);
});

check('беззвучное отпирание репликой не считается', () => {
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  p.unlock();
  a.el.fire('playing');
  eq(p.playing, false);
});

check('реплика доиграла сама или сломалась — не играет', () => {
  for (const ev of ['ended', 'error']) {
    const a = eventedAudio();
    const p = createHintPlayer(a.make);
    p.play('https://blob/1.mp3');
    a.el.fire(ev);
    eq(p.playing, false);
  }
});

check('пауза от смены реплики, пришедшая позже, речь не обрывает', () => {
  // play() ставит прежнюю на паузу и сразу запускает новую; событие
  // `pause` приходит задачей уже после этого.
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  p.play('https://blob/1.mp3');
  p.play('https://blob/2.mp3');
  a.el.fire('pause');
  eq(p.playing, true);
});

check('настоящая пауза (браузер остановил) — не играет', () => {
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  p.play('https://blob/1.mp3');
  a.el.paused = true;
  a.el.fire('pause');
  eq(p.playing, false);
});

check('браузер отказал в воспроизведении — не играет', () => {
  const a = eventedAudio();
  a.rejectNext();
  const p = createHintPlayer(a.make);
  p.play('https://blob/1.mp3');
  eq(p.playing, false);
});

check('браузер возобновил реплику — снова играет', () => {
  // Например, iOS вернул звук после звонка: микрофон обязан снова
  // замолчать.
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  p.play('https://blob/1.mp3');
  a.el.paused = true;
  a.el.fire('pause');
  a.el.paused = false;
  a.el.fire('playing');
  eq(p.playing, true);
});

check('подписчик слышит только смены, без повторов', () => {
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  const seen: boolean[] = [];
  p.onPlayingChange((v) => seen.push(v));
  p.stop();
  p.play('https://blob/1.mp3');
  p.play('https://blob/2.mp3');
  p.stop();
  p.stop();
  eq(seen, [true, false]);
});

check('отписка работает', () => {
  const a = eventedAudio();
  const p = createHintPlayer(a.make);
  const seen: boolean[] = [];
  const off = p.onPlayingChange((v) => seen.push(v));
  off();
  p.play('https://blob/1.mp3');
  eq(seen, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
