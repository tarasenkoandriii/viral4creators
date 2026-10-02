/**
 * Э5: голос iframe-чата без браузера — детектор речи (§5-бис.7: конец фразы
 * тишиной ~1 с, короче 0.4 с — выбросить, потолок 30 с), выбор формата
 * записи (Opus/AAC), разбор `voice` конфига, логика VoiceController:
 * микрофон только по нажатию и после согласия, одно уведомление при
 * исчерпании потолка, другая вкладка гасит запись, озвучка «стоп» повторным
 * нажатием. Запись звука и WebAudio — e2e (Chromium с фейковым микрофоном).
 */
import assert from 'node:assert/strict';
import { Vad, pickMime, rms } from '../src/voice/vad';
import { parseVoice } from '../src/shared/config';
import { DICTS } from '../src/chat/i18n';
import {
  VoiceController,
  voiceOff,
  type VoiceHost,
  type VoiceUi,
} from '../src/chat/voice';
import type { RecordEnd, VoiceEngine } from '../src/shared/voice-api';
import { createVoice } from '../src/voice';

// ── детектор речи ──────────────────────────────────────────────────────────
{
  const limits = { minSpeechMs: 400, endSilenceMs: 1000, maxMs: 30_000 };
  const run = (levels: Array<[number, number]>) => {
    const v = new Vad(limits);
    let t = 0;
    for (const [level, ms] of levels) {
      for (let x = 0; x < ms; x += 50) {
        const step = v.push(level, t);
        if (step !== 'listen') return { step, t, speech: v.speechMs };
        t += 50;
      }
    }
    return { step: 'listen', t, speech: v.speechMs };
  };
  // Тишина — ждём (кнопка «стоп» или потолок решат).
  assert.equal(run([[0.001, 5_000]]).step, 'listen');
  // 1.5 с речи, затем тишина — конец фразы через ~1 с тишины.
  const r = run([
    [0.001, 300],
    [0.3, 1500],
    [0.001, 3_000],
  ]);
  assert.equal(r.step, 'end');
  assert.ok(r.t >= 1800 + 1000 - 50 && r.t <= 1800 + 1100, `конец на ${r.t}`);
  // Щелчок 0.2 с — не речь: фраза не закрывается, детектор слушает дальше.
  assert.equal(
    run([
      [0.001, 300],
      [0.3, 200],
      [0.001, 3_000],
    ]).step,
    'listen'
  );
  // Потолок 30 с.
  assert.equal(run([[0.3, 31_000]]).step, 'max');
  // Шумная комната: пол поднимается, речь всё равно отличима.
  assert.equal(
    run([
      [0.03, 1000],
      [0.2, 1000],
      [0.03, 2000],
    ]).step,
    'end'
  );
  assert.equal(rms(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5);
}

// ── формат записи ──────────────────────────────────────────────────────────
assert.equal(
  pickMime((m) => m.startsWith('audio/webm')),
  'audio/webm;codecs=opus'
);
assert.equal(
  pickMime((m) => m === 'audio/mp4'),
  'audio/mp4'
); // Safari/iOS
assert.equal(
  pickMime(() => false),
  ''
);
assert.equal(
  pickMime(() => {
    throw new Error('old safari');
  }),
  ''
);

// ── конфиг ─────────────────────────────────────────────────────────────────
assert.equal(parseVoice(undefined), null);
assert.equal(parseVoice({ input: false, output: false }), null);
assert.deepEqual(
  parseVoice({ input: true, maxRecordMs: 10 ** 9, minSpeechMs: 400 }),
  {
    input: true,
    output: false,
    maxRecordMs: 30_000,
    minSpeechMs: 400,
    endSilenceMs: 1_000,
  }
);

// ── VoiceController ────────────────────────────────────────────────────────
const g = globalThis as unknown as Record<string, unknown>;
Object.defineProperty(globalThis, 'navigator', {
  value: {
    mediaDevices: { getUserMedia: () => Promise.reject(new Error('x')) },
  },
  configurable: true,
});
g.MediaRecorder = function MediaRecorder() {};

class FakeEngine implements VoiceEngine {
  recs: Array<{
    onEnd: (e: RecordEnd) => void;
    stopped: boolean;
    cancelled: boolean;
  }> = [];
  unlocked = 0;
  played: ArrayBuffer[] = [];
  stops = 0;
  playEnd: (() => void) | null = null;
  canRecord() {
    return true;
  }
  record(_l: unknown, _lv: (n: number) => void, onEnd: (e: RecordEnd) => void) {
    const r = { onEnd, stopped: false, cancelled: false };
    this.recs.push(r);
    return {
      stop: () => {
        r.stopped = true;
        onEnd({
          reason: 'ok',
          blob: new Blob(['opus'], { type: 'audio/webm' }),
          speechMs: 900,
        });
      },
      cancel: () => {
        r.cancelled = true;
        onEnd({ reason: 'cancel' });
      },
    };
  }
  unlock() {
    this.unlocked++;
  }
  play(b: ArrayBuffer, onEnd: () => void) {
    this.played.push(b);
    this.playEnd = onEnd;
  }
  stopPlayback() {
    this.stops++;
  }
}

function harness() {
  let ui: VoiceUi = voiceOff();
  const notices: string[] = [];
  const asked: Array<[string, string | null]> = [];
  const store: Record<string, string> = {};
  const sent: string[] = [];
  const engine = new FakeEngine();
  const host: VoiceHost = {
    ui: () => ui,
    setUi: (p) => (ui = { ...ui, ...p }),
    t: () => DICTS.uk,
    notify: (t) => notices.push(t),
    auth: () => ({ token: 'tok', preview: null }),
    refreshSession: async () => undefined,
    ask: (t, k) => asked.push([t, k]),
    storage: (kind, name, value) => {
      const k = `${kind}:${name}`;
      if (value === undefined) return store[k] ?? null;
      if (value === null) delete store[k];
      else store[k] = value;
      return null;
    },
    broadcast: (m) => sent.push(m),
  };
  const vc = new VoiceController(host, async () => ({
    createVoice: () => engine,
  }));
  return {
    vc,
    engine,
    notices,
    asked,
    store,
    sent,
    get ui() {
      return ui;
    },
  };
}

const cfg = {
  input: true,
  output: true,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1000,
};
const fetches: Array<{
  path: string;
  body: unknown;
  headers: Record<string, string>;
}> = [];
let replies: Array<{ status: number; body: unknown; bytes?: ArrayBuffer }> = [];
g.fetch = async (
  path: string,
  init: { body: unknown; headers: Record<string, string> }
) => {
  fetches.push({ path, body: init.body, headers: init.headers });
  const r = replies.shift() ?? { status: 500, body: null };
  return {
    ok: r.status < 300,
    status: r.status,
    json: async () => r.body,
    arrayBuffer: async () => r.bytes ?? new ArrayBuffer(4),
  };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  // Нет голоса в конфиге — кнопок нет, чанк не грузится.
  {
    const h = harness();
    h.vc.configure(null);
    assert.equal(h.ui.mic, false);
    assert.equal(h.ui.speak, false);
  }
  // Первое нажатие — согласие, БЕЗ записи; согласие → запись; стоп → отправка → вопрос с билетом.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    assert.equal(h.ui.mic, true);
    h.vc.press();
    assert.equal(h.ui.phase, 'consent');
    assert.equal(
      h.engine.recs.length,
      0,
      'до согласия микрофон не открывается'
    );
    h.vc.consent(true);
    assert.equal(h.store['local:vconsent'], '1');
    assert.equal(h.store['session:voice'], 'armed');
    assert.equal(h.ui.phase, 'recording');
    assert.ok(
      h.sent[0].startsWith('voice-on:'),
      'другим вкладкам — погасить микрофон'
    );
    replies = [
      {
        status: 200,
        body: {
          success: true,
          data: { text: 'Скільки коштує доставка?', voiceTicket: 'v1.1.x' },
        },
      },
    ];
    fetches.length = 0;
    h.vc.press(); // второе нажатие — стоп
    await tick();
    await tick();
    assert.equal(fetches[0].path, '/widget/v1/voice');
    assert.equal(fetches[0].headers['Content-Type'], 'audio/webm');
    assert.ok(fetches[0].body instanceof Blob);
    assert.deepEqual(h.asked, [['Скільки коштує доставка?', 'v1.1.x']]);
    assert.equal(h.ui.phase, 'idle');
    // Второй раз согласие не спрашивается.
    h.vc.press();
    assert.equal(h.ui.phase, 'recording');
    // Другая вкладка включила микрофон — эта запись брошена без отправки.
    fetches.length = 0;
    h.vc.onChannel('voice-on:othertab1');
    await tick();
    assert.equal(h.engine.recs[1].cancelled, true);
    assert.equal(fetches.length, 0);
    assert.equal(h.ui.phase, 'idle');
    // Своё же сообщение канала — не гасит.
    h.vc.press();
    h.vc.onChannel(`voice-on:${h.vc.tab}`);
    assert.equal(h.engine.recs[2].cancelled, false);
    h.vc.cancel();
  }
  // После перезагрузки «был включён» — пауза, а не запись (Р-28).
  {
    const h = harness();
    h.store['session:voice'] = 'armed';
    h.vc.configure(cfg);
    await tick();
    assert.equal(h.ui.phase, 'paused');
    assert.equal(h.engine.recs.length, 0);
  }
  // Потолок голоса: одно уведомление, кнопки пропадают, второй отказ — без уведомления.
  {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.press();
    replies = [
      { status: 429, body: { success: false, error: { code: 'VOICE_LIMIT' } } },
    ];
    h.vc.press();
    await tick();
    await tick();
    assert.deepEqual(h.notices, [DICTS.uk.voiceLimit]);
    assert.equal(h.ui.mic, false);
    assert.equal(h.ui.speak, false);
    h.vc.press();
    h.vc.speak('m1');
    assert.equal(h.notices.length, 1);
    // Перенастройка (новый конфиг в этой же вкладке) голос не возвращает.
    h.vc.configure(cfg);
    assert.equal(h.ui.mic, false);
  }
  // Два отказа сразу (запись и озвучка в полёте) — всё равно ОДНО уведомление.
  {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.press();
    const limit = {
      status: 429,
      body: { success: false, error: { code: 'VOICE_LIMIT' } },
    };
    replies = [limit, limit];
    h.vc.speak('m9');
    h.vc.press();
    for (let i = 0; i < 5; i++) await tick();
    assert.deepEqual(h.notices, [DICTS.uk.voiceLimit]);
  }
  // Не расслышал — уведомление, голос остаётся.
  {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.press();
    replies = [
      {
        status: 422,
        body: { success: false, error: { code: 'VOICE_NOT_HEARD' } },
      },
    ];
    h.vc.press();
    await tick();
    await tick();
    assert.deepEqual(h.notices, [DICTS.uk.voiceNotHeard]);
    assert.equal(h.ui.mic, true);
  }
  // Озвучка: разблокировка в жесте, байты → плеер; повторное нажатие — стоп.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    replies = [{ status: 200, body: null, bytes: new ArrayBuffer(8) }];
    fetches.length = 0;
    h.vc.speak('m1');
    assert.equal(h.engine.unlocked, 1);
    assert.equal(h.ui.loading, 'm1');
    await tick();
    await tick();
    assert.equal(fetches[0].path, '/widget/v1/tts');
    assert.equal(fetches[0].body, JSON.stringify({ messageId: 'm1' }));
    assert.equal(h.ui.playing, 'm1');
    assert.equal(h.engine.played.length, 1);
    h.vc.speak('m1');
    assert.equal(h.ui.playing, null);
    assert.ok(h.engine.stops >= 2);
  }
  // Закрыли чат, пока озвучка грузилась, — звук не начинается после закрытия.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    replies = [{ status: 200, body: null, bytes: new ArrayBuffer(8) }];
    h.vc.speak('m2');
    assert.equal(h.ui.loading, 'm2');
    h.vc.cancel();
    await tick();
    await tick();
    assert.equal(h.engine.played.length, 0, 'озвучка после закрытия чата');
    assert.equal(h.ui.loading, null);
    assert.equal(h.ui.playing, null);
  }
  // Движок записи (src/voice) на подделках браузера: «Стоп» дважды подряд
  // (двойное нажатие; или тик детектора между rec.stop() и onstop — state
  // уже 'inactive', а stop ещё не пришёл) — запись НЕ выбрасывается как
  // «не розчув», onEnd — ровно один раз; микрофон и AudioContext закрыты.
  {
    const tracks = { stopped: 0 };
    const ctxs = { open: 0 };
    const recorders: unknown[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            getTracks: () => [{ stop: () => tracks.stopped++ }],
          }),
        },
      },
      configurable: true,
    });
    class FakeRecorder {
      static isTypeSupported(m: string) {
        return m === 'audio/webm;codecs=opus';
      }
      state = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((e: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      start() {
        this.state = 'recording';
        recorders.push(this);
      }
      stop() {
        if (this.state === 'inactive') throw new Error('InvalidStateError');
        // Как в спецификации: state — сразу, события — позже задачами.
        this.state = 'inactive';
        setTimeout(() => {
          this.ondataavailable?.({ data: new Blob(['opus-bytes']) });
          this.onstop?.();
        }, 30);
      }
    }
    const born = Date.now();
    class FakeCtx {
      constructor() {
        ctxs.open++;
      }
      createAnalyser() {
        return {
          fftSize: 0,
          // Тишина калибровки, потом речь.
          getFloatTimeDomainData: (b: Float32Array) =>
            b.fill(Date.now() - born < 250 ? 0.005 : 0.5),
        };
      }
      createMediaStreamSource() {
        return { connect: () => undefined };
      }
      close() {
        ctxs.open--;
        return Promise.resolve();
      }
    }
    g.MediaRecorder = FakeRecorder;
    g.window = Object.assign(globalThis, { AudioContext: FakeCtx });
    const ends: RecordEnd[] = [];
    const engine = createVoice();
    const rec = engine.record(
      { minSpeechMs: 1, endSilenceMs: 60_000, maxRecordMs: 30_000 },
      () => undefined,
      (e) => ends.push(e)
    );
    await new Promise((r) => setTimeout(r, 600)); // калибровка + речь
    assert.equal(recorders.length, 1, 'запись началась');
    rec.stop();
    rec.stop(); // второе нажатие «Стоп» до onstop
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(ends.length, 1, 'onEnd — ровно один раз');
    assert.equal(ends[0].reason, 'ok', `запись потеряна: ${ends[0].reason}`);
    assert.equal(tracks.stopped, 1, 'трек микрофона остановлен');
    assert.equal(ctxs.open, 0, 'AudioContext индикатора закрыт');
  }
  console.log('voice: детектор речи, формат, конфиг, контроллер голоса — ok');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
