/**
 * Предпросмотр темпа обучалки без CORS у хранилища mp3 (TODO L1966):
 * выбор пути звука (WebAudio → `<audio>`-элементы → «без звука») и
 * расписание запасного пути по часам картинки. Плюс шов с
 * `TutorialPreview.tsx`: компонент действительно идёт этими функциями,
 * элементы — без `crossOrigin` (иначе им тоже понадобился бы CORS), и
 * пометка «без звука» не ставится, когда запасной путь сработал.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ELEMENT_MAX_LATE_S,
  dueClips,
  previewAudioPath,
  primeClip,
  type AudioLike,
} from '../src/lib/tutorial-preview-audio';

let passed = 0;
function it(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log('  ✓', name);
}

const env = (over: Partial<Parameters<typeof previewAudioPath>[0]>) => ({
  webAudio: true,
  elementAudio: true,
  clips: 3,
  webAudioFailed: false,
  ...over,
});

it('всё скачалось и декодировалось — WebAudio', () => {
  assert.equal(previewAudioPath(env({})), 'webaudio');
});

it('CORS/декодирование упали — элементы, а не «без звука»', () => {
  assert.equal(previewAudioPath(env({ webAudioFailed: true })), 'element');
});

it('нет WebAudio вовсе — элементы', () => {
  assert.equal(previewAudioPath(env({ webAudio: false })), 'element');
});

it('нет ни WebAudio-звука, ни Audio — честно «без звука»', () => {
  assert.equal(
    previewAudioPath(env({ webAudioFailed: true, elementAudio: false })),
    'silent'
  );
  assert.equal(
    previewAudioPath(env({ webAudio: false, elementAudio: false })),
    'silent'
  );
});

it('реплик нет — путь не важен, «без звука» не про это', () => {
  assert.equal(previewAudioPath(env({ clips: 0 })), 'webaudio');
  assert.equal(previewAudioPath(env({ clips: 0, webAudio: false })), 'silent');
});

it('одна неудача из многих — все реплики элементами (без смешанных часов)', () => {
  assert.equal(
    previewAudioPath(env({ clips: 10, webAudioFailed: true })),
    'element'
  );
});

const schedule = [{ at: 0 }, { at: 1.5 }, { at: 4 }];

it('реплика стартует в начале своего кадра, не раньше', () => {
  assert.deepEqual(dueClips(schedule, new Set(), 0), {
    start: [0],
    skipped: [],
  });
  assert.deepEqual(dueClips(schedule, new Set([0]), 1.49), {
    start: [],
    skipped: [],
  });
  assert.deepEqual(dueClips(schedule, new Set([0]), 1.5), {
    start: [1],
    skipped: [],
  });
  assert.deepEqual(dueClips(schedule, new Set([0]), 1.6), {
    start: [1],
    skipped: [],
  });
});

it('запущенная реплика не запускается второй раз', () => {
  assert.deepEqual(dueClips(schedule, new Set([0, 1]), 2), {
    start: [],
    skipped: [],
  });
});

it('после фона (rAF стоял) опоздавшие сверх допуска пропускаются, а не звучат разом', () => {
  const r = dueClips(schedule, new Set(), 4.1);
  assert.deepEqual(r.start, [2]);
  assert.deepEqual(r.skipped, [0, 1]);
  assert.ok(ELEMENT_MAX_LATE_S > 0.1 && ELEMENT_MAX_LATE_S <= 1);
  // На самой границе допуска — ещё звучит.
  assert.deepEqual(
    dueClips([{ at: 1 }], new Set(), 1 + ELEMENT_MAX_LATE_S).start,
    [0]
  );
});

it('проход по часам кадров запускает каждую реплику ровно один раз и вовремя', () => {
  const fired = new Set<number>();
  const startedAt: number[] = [];
  for (let now = 0; now <= 5; now += 1 / 60) {
    const { start, skipped } = dueClips(schedule, fired, now);
    for (const i of skipped) fired.add(i);
    for (const i of start) {
      fired.add(i);
      startedAt[i] = now;
    }
  }
  assert.equal(startedAt.length, schedule.length);
  schedule.forEach((clip, i) => {
    assert.ok(startedAt[i] >= clip.at, `реплика ${i} раньше кадра`);
    assert.ok(startedAt[i] - clip.at < 1 / 30, `реплика ${i} опоздала на кадр`);
  });
});

it('TutorialPreview: путь выбирается функцией, элементы без CORS, «без звука» — только при отказе', () => {
  const src = readFileSync(
    new URL('../src/features/postprod/TutorialPreview.tsx', import.meta.url),
    'utf8'
  );
  const has = (re: RegExp, what: string) => assert.ok(re.test(src), what);
  has(/previewAudioPath\(\{/, 'путь — через previewAudioPath');
  has(/dueClips\(schedule, fired, now\)/, 'расписание — через dueClips');
  has(/new Audio\(\)/, 'запасной путь — элементы');
  // `crossOrigin` вернул бы элементу требование CORS — ради которого он и нужен.
  assert.ok(!/crossOrigin/i.test(src), 'у элемента не должно быть crossOrigin');
  // Пометка: в WebAudio-ветке и в ветке элементов — не ставится сразу.
  has(/if \(path === 'element'\) \{/, 'ветка элементов');
  has(
    /\} else \{\s*fallback = schedule\.length > 0;\s*\}/,
    '«без звука» — только вне ветки элементов'
  );
  // Отказ элемента (ошибка загрузки или play()) — честная пометка.
  has(/addEventListener\('error', failed\)/, 'ошибка загрузки элемента');
  has(/primed\[i\]\.start\(\)\.catch\(failed\)/, 'отказ play()');
  // Однажды упавший WebAudio не повторяет fetch — жест нажатия цел.
  has(/webAudioBlockedRef\.current = true/, 'запоминание отказа WebAudio');
  // stop() гасит и элементы.
  has(
    /for \(const el of elementsRef\.current\) \{\s*el\.pause\(\);/,
    'stop() гасит элементы'
  );
});

/** Поддельный `<audio>`: журнал вызовов и управляемый промис play(). */
class FakeAudio implements AudioLike {
  log: string[] = [];
  private _muted = false;
  private _time = 0;
  resolvers: Array<() => void> = [];
  rejectNext = false;
  get muted() {
    return this._muted;
  }
  set muted(v: boolean) {
    this._muted = v;
    this.log.push(`muted=${v}`);
  }
  get currentTime() {
    return this._time;
  }
  set currentTime(v: number) {
    this._time = v;
    this.log.push(`time=${v}`);
  }
  play(): Promise<void> {
    this.log.push(`play(muted=${this._muted})`);
    if (this.rejectNext) return Promise.reject(new Error('NotAllowedError'));
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
  pause() {
    this.log.push('pause');
  }
}
const flush = () => new Promise((r) => setTimeout(r, 0));

async function asyncChecks() {
  {
    // Разблокировка: play() без звука СИНХРОННО, после старта — пауза и
    // перемотка; потом расписание запускает со звуком с начала.
    const el = new FakeAudio();
    const clip = primeClip(el);
    assert.deepEqual(el.log, ['muted=true', 'play(muted=true)']);
    el.resolvers.shift()!();
    await flush();
    assert.deepEqual(el.log.slice(2), ['pause', 'time=0']);
    void clip.start();
    assert.deepEqual(el.log.slice(4), [
      'time=0',
      'muted=false',
      'play(muted=false)',
    ]);
    passed += 1;
    console.log(
      '  ✓ разблокировка в жесте: play без звука → pause → старт со звуком'
    );
  }
  {
    // Расписание успело раньше разблокировки — пауза реплику не обрывает.
    const el = new FakeAudio();
    const clip = primeClip(el);
    void clip.start();
    el.resolvers.shift()!();
    await flush();
    assert.ok(!el.log.includes('pause'), 'пауза оборвала бы реплику');
    assert.equal(el.muted, false);
    passed += 1;
    console.log('  ✓ старт раньше разблокировки — без паузы, со звуком');
  }
  {
    // Отказ при разблокировке не роняет обработчик (промис ловится).
    const el = new FakeAudio();
    el.rejectNext = true;
    primeClip(el); // бросок здесь уронил бы весь скрипт
    await flush();
    passed += 1;
    console.log('  ✓ отказ разблокировки не бросает');
  }
  {
    // Шов: в play() компонента элементы создаются и разблокируются ДО
    // первого await, а расписание запускает их через start().
    const src = readFileSync(
      new URL('../src/features/postprod/TutorialPreview.tsx', import.meta.url),
      'utf8'
    );
    const body = src.slice(src.indexOf('const play = async () => {'));
    const firstAwait = body.indexOf('await ');
    const prime = body.indexOf('primeClip(el)');
    assert.ok(prime > 0, 'шов ослеп: primeClip в play() не найден');
    assert.ok(
      prime < firstAwait,
      'разблокировка после await — жест уже потерян'
    );
    const register = body.indexOf('elementsRef.current = primed.map');
    assert.ok(register > 0, 'шов ослеп: элементы не отдаются stop()');
    assert.ok(
      register < firstAwait,
      'stop() во время загрузки должен гасить разблокированные элементы'
    );
    passed += 1;
    console.log('  ✓ TutorialPreview разблокирует элементы до первого await');
  }
  console.log(`  ${passed} проверок`);
}

void asyncChecks().catch((error) => {
  console.error(error);
  process.exit(1);
});
