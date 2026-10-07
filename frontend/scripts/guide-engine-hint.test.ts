/**
 * Аудит Ш6 (TODO I-М «Сквозной аудит 06.10.2026»): при
 * `WIZARD_GUIDE_ENGINE=legacy` мини-апп не спрашивает
 * `GET /guide-assist/config` на каждом старте. Гид человека приходит в
 * ответе гида проекта (`WizardGuideState.engine`) и запоминается на
 * устройстве; `config` нужен только для `assist` (pk и origin) или когда
 * гид ещё не известен. Проверяется логика `createGuideAssistController`
 * (то, что `GuideAssistMount` только подключает к DOM) и шов: ответы
 * `wizard-guide-api` доходят до подсказки.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUIDE_ENGINE_EVENT,
  GUIDE_ENGINE_STORAGE_KEY,
  GUIDE_JWT_RETRY_MS,
  announceGuideEngine,
  createGuideAssistController,
  engineNewsAction,
  guideEngineOf,
  needsConfigOnStart,
  readGuideEngineHint,
  writeGuideEngineHint,
  type GuideAssistConfig,
  type GuideAssistIdentity,
  type GuideEngine,
  type GuideEngineStore,
} from '../src/lib/guide-assist';

let passed = 0;
async function it(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log('  ✓', name);
}

const ON: GuideAssistConfig = {
  engine: 'assist',
  pk: 'pk_live_v4c',
  origin: 'https://assist-wa.viral4creators.app',
};

class MemStore implements GuideEngineStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Двойник окружения: считает запросы и вызовы окна. */
function harness(opts: {
  hint: GuideEngine | null;
  config: GuideAssistConfig;
  identity?: GuideAssistIdentity;
}) {
  const store = new MemStore();
  writeGuideEngineHint(store, opts.hint);
  const log = {
    config: 0,
    identity: 0,
    inserted: 0,
    calls: [] as unknown[][],
    timers: [] as number[],
  };
  let loader = false;
  let config = opts.config;
  const pending: Array<() => void> = [];
  let holdConfig = false;
  const ctl = createGuideAssistController({
    getConfig: async () => {
      log.config += 1;
      if (holdConfig) await new Promise<void>((r) => pending.push(r));
      writeGuideEngineHint(store, config.engine);
      return config;
    },
    getIdentity: async () => {
      log.identity += 1;
      return opts.identity ?? { jwt: 'a.b.c', exp: 2_000_000_000 };
    },
    hint: () => readGuideEngineHint(store),
    forgetHint: () => writeGuideEngineHint(store, null),
    hasLoader: () => loader,
    insertLoader: () => {
      loader = true;
      log.inserted += 1;
    },
    call: (...a) => log.calls.push(a),
    setTimer: (_fn, ms) => {
      log.timers.push(ms);
      return log.timers.length;
    },
    clearTimer: () => {},
    now: () => 1_000_000_000_000,
  });
  return {
    ctl,
    log,
    store,
    setConfig: (c: GuideAssistConfig) => (config = c),
    hold: () => (holdConfig = true),
    release: () => {
      holdConfig = false;
      for (const r of pending.splice(0)) r();
    },
  };
}

async function main() {
  await it('разбор гида и правило старта', () => {
    assert.equal(guideEngineOf('legacy'), 'legacy');
    assert.equal(guideEngineOf('assist'), 'assist');
    for (const bad of [undefined, null, '', 'pilot', 'ASSIST', 1, {}])
      assert.equal(guideEngineOf(bad), null);
    assert.equal(needsConfigOnStart('legacy'), false);
    assert.equal(needsConfigOnStart('assist'), true);
    assert.equal(needsConfigOnStart(null), true);
    assert.equal(engineNewsAction('assist', false), 'start');
    assert.equal(engineNewsAction('assist', true), 'none');
    assert.equal(engineNewsAction('legacy', true), 'stop');
    assert.equal(engineNewsAction('legacy', false), 'none');
  });

  await it('подсказка на устройстве: запись, чтение, забывание, мусор и сбой хранилища', () => {
    const s = new MemStore();
    assert.equal(readGuideEngineHint(s), null);
    writeGuideEngineHint(s, 'legacy');
    assert.equal(s.getItem(GUIDE_ENGINE_STORAGE_KEY), 'legacy');
    assert.equal(readGuideEngineHint(s), 'legacy');
    writeGuideEngineHint(s, null);
    assert.equal(readGuideEngineHint(s), null);
    s.setItem(GUIDE_ENGINE_STORAGE_KEY, 'pilot');
    assert.equal(readGuideEngineHint(s), null);
    const broken: GuideEngineStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    assert.equal(readGuideEngineHint(broken), null);
    writeGuideEngineHint(broken, 'assist');
    writeGuideEngineHint(null, 'assist');
    assert.equal(readGuideEngineHint(null), null);
  });

  await it('ответ гида проекта → подсказка и событие окна; без engine — ничего', () => {
    const s = new MemStore();
    const t = new EventTarget();
    const got: unknown[] = [];
    t.addEventListener(GUIDE_ENGINE_EVENT, (e) =>
      got.push((e as CustomEvent).detail)
    );
    assert.equal(
      announceGuideEngine({ enabled: true, engine: 'assist' }, t, s),
      'assist'
    );
    assert.deepEqual(got, ['assist']);
    assert.equal(readGuideEngineHint(s), 'assist');
    // Старый сервер без поля, мусор — подсказка прежняя, события нет.
    for (const st of [{ enabled: true }, { engine: 'x' }, null, 'legacy']) {
      assert.equal(announceGuideEngine(st, t, s), null);
    }
    assert.deepEqual(got, ['assist']);
    assert.equal(readGuideEngineHint(s), 'assist');
  });

  await it('legacy известен — старт БЕЗ запроса config (главное исправление)', async () => {
    const h = harness({ hint: 'legacy', config: { engine: 'legacy' } });
    await h.ctl.start();
    assert.equal(h.log.config, 0);
    assert.equal(h.log.identity, 0);
    assert.equal(h.log.inserted, 0);
    // Повторный старт (новая сессия мини-аппа) — тоже без запроса.
    await h.ctl.start();
    assert.equal(h.log.config, 0);
  });

  await it('гид не известен — один config; legacy запоминается, следующий старт без запроса', async () => {
    const h = harness({ hint: null, config: { engine: 'legacy' } });
    await h.ctl.start();
    assert.equal(h.log.config, 1);
    assert.equal(h.log.inserted, 0);
    assert.equal(readGuideEngineHint(h.store), 'legacy');
    const next = harness({ hint: readGuideEngineHint(h.store), config: ON });
    await next.ctl.start();
    assert.equal(next.log.config, 0);
  });

  await it('известен assist — config, загрузчик, JWT и таймер обновления', async () => {
    const h = harness({ hint: 'assist', config: ON });
    await h.ctl.start();
    assert.equal(h.log.config, 1);
    assert.equal(h.log.inserted, 1);
    assert.deepEqual(h.log.calls, [['identify-admin', 'a.b.c']]);
    assert.equal(h.log.timers.length, 1);
  });

  await it('legacy на устройстве, но гид проекта сказал assist — config и окно', async () => {
    const h = harness({ hint: 'legacy', config: ON });
    await h.ctl.start();
    assert.equal(h.log.config, 0);
    await h.ctl.engineNews('assist');
    assert.equal(h.log.config, 1);
    assert.equal(h.log.inserted, 1);
    assert.deepEqual(h.log.calls, [['identify-admin', 'a.b.c']]);
    // Повторная весть «assist» при работающем окне — ничего нового.
    await h.ctl.engineNews('assist');
    assert.equal(h.log.config, 1);
    assert.equal(h.log.identity, 1);
  });

  await it('весть legacy: окно работает — logout; не работает — ни запроса, ни logout', async () => {
    const h = harness({ hint: 'assist', config: ON });
    await h.ctl.start();
    await h.ctl.engineNews('legacy');
    assert.deepEqual(h.log.calls[h.log.calls.length - 1], ['logout']);
    const quiet = harness({ hint: 'legacy', config: ON });
    await quiet.ctl.start();
    await quiet.ctl.engineNews('legacy');
    await quiet.ctl.engineNews('мусор');
    assert.equal(quiet.log.config, 0);
    assert.deepEqual(quiet.log.calls, []);
  });

  await it('весть assist во время старта — второй config не нужен', async () => {
    const h = harness({ hint: null, config: ON });
    h.hold();
    const first = h.ctl.start();
    await tick();
    const news = h.ctl.engineNews('assist');
    h.release();
    await Promise.all([first, news]);
    assert.equal(h.log.config, 1);
    assert.equal(h.log.identity, 1);
    assert.equal(h.log.inserted, 1);
    // Два старта подряд (повторный монтаж) — тоже один config.
    const twice = harness({ hint: null, config: ON });
    twice.hold();
    const a = twice.ctl.start();
    const b = twice.ctl.start();
    await tick();
    twice.release();
    await Promise.all([a, b]);
    assert.equal(twice.log.config, 1);
    assert.equal(twice.log.identity, 1);
  });

  await it('смена личности: logout, подсказка забыта, config спрошен заново', async () => {
    const h = harness({ hint: 'legacy', config: { engine: 'legacy' } });
    await h.ctl.start();
    assert.equal(h.log.config, 0);
    h.setConfig(ON);
    await h.ctl.identityChanged();
    assert.equal(h.log.config, 1);
    assert.equal(h.log.inserted, 1);
    assert.equal(readGuideEngineHint(h.store), 'assist');
    // Ещё раз: окно было — сначала logout, потом новый JWT.
    await h.ctl.identityChanged();
    const tail = h.log.calls.slice(-2);
    assert.deepEqual(tail, [['logout'], ['identify-admin', 'a.b.c']]);
  });

  await it('JWT: off — logout без таймера; retry — повтор через GUIDE_JWT_RETRY_MS', async () => {
    const off = harness({
      hint: 'assist',
      config: ON,
      identity: { failure: 'off' },
    });
    await off.ctl.start();
    assert.deepEqual(off.log.calls, [['logout']]);
    assert.equal(off.log.timers.length, 0);
    const retry = harness({
      hint: 'assist',
      config: ON,
      identity: { failure: 'retry' },
    });
    await retry.ctl.start();
    assert.deepEqual(retry.log.calls, []);
    assert.deepEqual(retry.log.timers, [GUIDE_JWT_RETRY_MS]);
  });

  await it('шов: все ответы гида проекта проходят через noteWizardGuideState; Mount слушает событие', () => {
    const api = readFileSync('src/services/wizard-guide-api.ts', 'utf8');
    for (const fn of [
      'getWizardGuide',
      'setWizardGuide',
      'setWizardGuideVoice',
    ]) {
      const at = api.indexOf(`export async function ${fn}(`);
      assert.ok(at >= 0, fn);
      const body = api.slice(at, api.indexOf('\n}\n', at));
      assert.ok(body.includes('guideState('), `${fn} без guideState()`);
    }
    assert.ok(/noteWizardGuideState\(state\)/.test(api));
    const mount = readFileSync('src/components/GuideAssistMount.tsx', 'utf8');
    assert.ok(mount.includes('addEventListener(GUIDE_ENGINE_EVENT, onEngine)'));
    assert.ok(
      mount.includes('removeEventListener(GUIDE_ENGINE_EVENT, onEngine)')
    );
    assert.ok(mount.includes('createGuideAssistController('));
    // Удачный ответ config запоминается подсказкой, сбой — нет.
    const svc = readFileSync('src/services/guide-assist-api.ts', 'utf8');
    const cfgAt = svc.indexOf('export async function getGuideAssistConfig(');
    const cfgBody = svc.slice(cfgAt, svc.indexOf('\n}\n', cfgAt));
    const tryPart = cfgBody.slice(0, cfgBody.indexOf('} catch'));
    const catchPart = cfgBody.slice(cfgBody.indexOf('} catch'));
    assert.ok(
      /writeGuideEngineHint\(hintStore\(\), cfg\.engine\)/.test(tryPart)
    );
    assert.ok(!/writeGuideEngineHint/.test(catchPart));
    // Mount сам config не зовёт мимо контроллера.
    assert.ok(!/getGuideAssistConfig\(\)/.test(mount));
  });

  assert.equal(passed, TOTAL);
  clearTimeout(hang);
  console.log(`guide-engine-hint: ${passed} ok`);
}

// Висящий промис молча завершил бы процесс с кодом 0: таймер держит цикл
// событий и валит прогон, если main() не дошёл до конца.
const TOTAL = 12;
const hang = setTimeout(() => {
  console.error(`guide-engine-hint: завис, прошло ${passed} из ${TOTAL}`);
  process.exit(1);
}, 20_000);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
