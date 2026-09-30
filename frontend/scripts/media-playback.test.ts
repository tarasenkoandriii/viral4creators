// Plain assertions runnable with `npx tsx scripts/media-playback.test.ts`.
//
// Аудит волны 2 ветки K: микрофон помощника не пишет звук роликов
// страницы — общий реестр медиа-элементов.

import {
  createMediaPlaybackRegistry,
  createMicBusyRegistry,
  mediaPlaybackRef,
  withMediaPlayback,
  type MediaLike,
} from '../src/lib/media-playback';

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

/** Фейковый `<video>`: состояние и события — как у браузера. */
class FakeMedia implements MediaLike {
  paused = true;
  ended = false;
  private readonly ls = new Map<string, Set<() => void>>();
  addEventListener(t: string, l: () => void) {
    if (!this.ls.has(t)) this.ls.set(t, new Set());
    this.ls.get(t)!.add(l);
  }
  removeEventListener(t: string, l: () => void) {
    this.ls.get(t)?.delete(l);
  }
  listenerCount() {
    let n = 0;
    for (const s of this.ls.values()) n += s.size;
    return n;
  }
  private fire(t: string) {
    for (const l of [...(this.ls.get(t) ?? [])]) l();
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.fire('play');
    this.fire('playing');
  }
  pause() {
    this.paused = true;
    this.fire('pause');
  }
  end() {
    // Браузер: по окончании `ended = true`, `paused` тоже true.
    this.ended = true;
    this.paused = true;
    this.fire('ended');
  }
  fail() {
    this.paused = true;
    this.fire('error');
  }
}

check('ничего не зарегистрировано — тишина', () => {
  eq(createMediaPlaybackRegistry().isPlaying(), false);
});

check('play → звучит; pause/ended/error → нет', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  r.register(v);
  eq(r.isPlaying(), false);
  v.play();
  eq(r.isPlaying(), true);
  v.pause();
  eq(r.isPlaying(), false);
  v.play();
  v.end();
  eq(r.isPlaying(), false);
  v.play();
  v.fail();
  eq(r.isPlaying(), false);
});

check('ended без paused (редкий браузер) — всё равно не звучит', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  r.register(v);
  v.play();
  v.ended = true;
  eq(r.isPlaying(), false);
});

check('снятый с экрана играющий ролик — не звучит, слушатели сняты', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  const off = r.register(v);
  v.play();
  eq(r.isPlaying(), true);
  off();
  eq(r.isPlaying(), false);
  eq(v.listenerCount(), 0);
  off(); // повторное снятие безвредно
});

check('два ролика: звучит, пока играет хоть один', () => {
  const r = createMediaPlaybackRegistry();
  const a = new FakeMedia();
  const b = new FakeMedia();
  r.register(a);
  r.register(b);
  a.play();
  b.play();
  a.pause();
  eq(r.isPlaying(), true);
  b.pause();
  eq(r.isPlaying(), false);
});

check('подписчик слышит только смену состояния', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  const seen: boolean[] = [];
  const unsub = r.onChange((p) => seen.push(p));
  r.register(v);
  v.play(); // play + playing — одно «заиграло»
  v.pause();
  v.pause();
  eq(seen, [true, false]);
  unsub();
  v.play();
  eq(seen, [true, false]);
});

check('регистрация уже играющего элемента — сразу «звучит»', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  v.paused = false;
  const seen: boolean[] = [];
  r.onChange((p) => seen.push(p));
  r.register(v);
  eq(r.isPlaying(), true);
  eq(seen, [true]);
});

check('двойная регистрация не удваивает слушателей', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  r.register(v);
  const n = v.listenerCount();
  const offSecond = r.register(v);
  eq(v.listenerCount(), n);
  // Снятие «второй» регистрации не снимает первую: элемент один, и
  // владелец у него тот, кто зарегистрировал первым.
  v.play();
  offSecond();
  eq(r.isPlaying(), true);
});

check('колбэк-реф: монтирование регистрирует, null — снимает', () => {
  const r = createMediaPlaybackRegistry();
  const ref = mediaPlaybackRef(r);
  const v = new FakeMedia();
  ref(v);
  v.play();
  eq(r.isPlaying(), true);
  const seen: boolean[] = [];
  r.onChange((p) => seen.push(p));
  ref(v); // повторный вызов с тем же элементом — без переустановки
  eq(r.isPlaying(), true);
  eq(seen, []); // ни мигания «перестал/заиграл» для детектора
  ref(null);
  eq(r.isPlaying(), false);
  eq(v.listenerCount(), 0);
  // Смена элемента — старый снят, новый учтён.
  const w = new FakeMedia();
  ref(v);
  ref(w);
  eq(v.listenerCount(), 0);
  w.play();
  eq(r.isPlaying(), true);
});

check('детектор речи: советник ИЛИ ролик; глушится только советник', () => {
  const r = createMediaPlaybackRegistry();
  const v = new FakeMedia();
  r.register(v);
  let hint = false;
  let stops = 0;
  const p = withMediaPlayback(
    { isPlaying: () => hint, stop: () => stops++ },
    r
  );
  eq(p.isPlaying(), false);
  v.play();
  eq(p.isPlaying(), true);
  v.pause();
  hint = true;
  eq(p.isPlaying(), true);
  v.play();
  p.stop();
  eq(stops, 1);
  // Ролик перебиванием не останавливается — его ставит на паузу человек.
  eq(v.paused, false);
});

check(
  'микрофон занят: счётчик захватов, повторное отпускание безвредно',
  () => {
    const m = createMicBusyRegistry();
    const seen: boolean[] = [];
    const off = m.onChange((b) => seen.push(b));
    eq(m.isBusy(), false);
    const a = m.acquire();
    const b = m.acquire();
    eq(m.isBusy(), true);
    a();
    a(); // эффект и finally оба отпускают — чужой захват цел
    eq(m.isBusy(), true);
    b();
    eq(m.isBusy(), false);
    // Подписчик слышит только смену: занят → свободен, без повторов.
    eq(seen, [true, false]);
    off();
    m.acquire();
    eq(seen, [true, false]);
  }
);

if (failed) {
  console.error(`\n${failed} проверок упало`);
  process.exit(1);
}
console.log(`\n${passed} проверок пройдено`);
