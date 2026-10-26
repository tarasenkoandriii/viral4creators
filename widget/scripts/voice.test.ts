/**
 * Э5: голос iframe-чата без браузера — детектор речи (§5-бис.7: конец фразы
 * тишиной ~1 с, короче 0.4 с — выбросить, потолок 30 с), выбор формата
 * записи (Opus/AAC), разбор `voice` конфига, логика VoiceController:
 * микрофон только по нажатию и после согласия, одно уведомление при
 * исчерпании потолка, другая вкладка гасит запись, озвучка «стоп» повторным
 * нажатием. Запись звука и WebAudio — e2e (Chromium с фейковым микрофоном).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Vad, pickMime, rms } from '../src/voice/vad';
import { parseVoice } from '../src/shared/config';
import { DICTS } from '../src/chat/i18n';
import {
  UI_LANG_HEADER,
  uiLangOfDict,
  VoiceController,
  voiceOff,
  type VoiceHost,
  type VoiceUi,
} from '../src/chat/voice';
import type { RecordEnd, VoiceEngine } from '../src/shared/voice-api';
import { createVoice } from '../src/voice';
import { VoiceStream } from '../src/chat/voice-stream';

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
    speech?: () => void;
    minSpeechMs: number;
    audio?: (chunk: Blob) => void;
  }> = [];
  unlocked = 0;
  played: ArrayBuffer[] = [];
  stops = 0;
  playEnd: ((failed?: boolean) => void) | null = null;
  canRecord() {
    return true;
  }
  record(
    _l: {
      onSpeech?: () => void;
      minSpeechMs: number;
      onAudio?: (chunk: Blob) => void;
    },
    _lv: (n: number) => void,
    onEnd: (e: RecordEnd) => void
  ) {
    const r = {
      onEnd,
      stopped: false,
      cancelled: false,
      speech: _l.onSpeech,
      audio: _l.onAudio,
      minSpeechMs: _l.minSpeechMs,
    };
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
  play(b: ArrayBuffer, onEnd: (failed?: boolean) => void) {
    this.played.push(b);
    this.playEnd = onEnd;
  }
  stopPlayback() {
    this.stops++;
  }
}

function harness(limits?: { durationMs: number; turns: number }) {
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
  const vc = new VoiceController(
    host,
    async () => ({
      createVoice: () => engine,
    }),
    limits
  );
  return {
    vc,
    engine,
    notices,
    asked,
    store,
    sent,
    host,
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
  const settle = () => new Promise((r) => setTimeout(r, 240));
  const answer = (text = 'hello') => ({
    status: 200,
    body: { success: true, data: { text, voiceTicket: 'v1.test' } },
  });
  // Late recorder callbacks after Stop cannot feed the next paid stream.
  {
    const savedFetch = g.fetch;
    const savedSocket = g.WebSocket;
    const savedAudio = VoiceStream.prototype.audio;
    const chunks: Blob[] = [];
    g.fetch = () => new Promise(() => {}); // Pending authorization, no network.
    g.WebSocket = class {};
    VoiceStream.prototype.audio = (chunk) => {
      chunks.push(chunk);
    };
    const h = harness();
    try {
      h.vc.configure({ ...cfg, streaming: true });
      await tick();
      h.store['local:vconsent'] = '1';
      h.vc.press();
      const old = h.engine.recs[0];
      h.vc.stop();
      h.vc.press();
      const current = h.engine.recs[1];
      old.audio?.(new Blob(['stale']));
      assert.equal(
        chunks.length,
        0,
        'old capture must not enter new utterance'
      );
      const fresh = new Blob(['fresh']);
      current.audio?.(fresh);
      assert.deepEqual(chunks, [fresh]);
    } finally {
      h.vc.stop();
      VoiceStream.prototype.audio = savedAudio;
      g.WebSocket = savedSocket;
      g.fetch = savedFetch;
    }
  }
  // Explicit opt-in, consent, sequential phrases, quiet rearm without STT.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    h.vc.toggleHandsFree();
    assert.equal(h.ui.phase, 'consent');
    assert.equal(h.engine.recs.length, 0);
    h.vc.consent(false);
    assert.equal(h.ui.handsFree, false);
    h.store['local:vconsent'] = '1';
    h.vc.toggleHandsFree();
    assert.equal(h.ui.handsFree, true);
    const count = fetches.length;
    h.engine.recs[0].onEnd({ reason: 'short' });
    await settle();
    assert.equal(fetches.length, count, 'silence never calls STT');
    replies = [answer()];
    h.engine.recs[1].onEnd({
      reason: 'ok',
      blob: new Blob(['audio']),
      speechMs: 900,
    });
    await tick();
    await settle();
    assert.equal(h.asked.length, 1);
    assert.equal(
      h.engine.recs.length,
      3,
      'hands-free rearmed without another gesture'
    );
    replies = [answer('stop')];
    h.engine.recs[2].onEnd({
      reason: 'ok',
      blob: new Blob(['audio']),
      speechMs: 900,
    });
    await tick();
    await settle();
    assert.equal(h.ui.handsFree, false);
    assert.equal(h.asked.length, 1, 'Stop never becomes a new question');
    assert.equal(h.engine.recs.length, 3);
  }
  // Re-arming waits for the answer; turning on during a plan keeps early pause.
  {
    const h = harness();
    let busy = true;
    h.host.busy = () => busy;
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.toggleHandsFree();
    assert.equal(
      h.engine.recs[0].minSpeechMs,
      150,
      'short Stop uses plan threshold'
    );
    replies = [answer()];
    h.vc.press();
    await tick();
    await settle();
    assert.equal(
      h.engine.recs.length,
      1,
      'no next capture while answer is busy'
    );
    busy = false;
    await settle();
    assert.equal(h.engine.recs.length, 2);
    h.vc.stop();
    const p = harness();
    const pauses: boolean[] = [];
    p.host.speech = (on) => pauses.push(on);
    p.store['local:vconsent'] = '1';
    p.vc.configure(cfg);
    await tick();
    p.vc.press();
    p.vc.planListen(true);
    p.vc.toggleHandsFree();
    p.engine.recs[1].speech?.();
    assert.deepEqual(pauses, [true]);
    p.vc.stop();
  }
  // Bound both time and utterance count. No persistent opt-in.
  {
    const h = harness({ durationMs: 10000, turns: 1 });
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.toggleHandsFree();
    replies = [answer()];
    h.vc.press();
    await tick();
    await settle();
    assert.equal(h.ui.handsFree, false, 'turn budget stops rearm');
    assert.equal(h.engine.recs.length, 1);
    const k = harness({ durationMs: 40, turns: 20 });
    k.store['local:vconsent'] = '1';
    k.vc.configure(cfg);
    await tick();
    k.vc.toggleHandsFree();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(
      k.ui.handsFree,
      false,
      'deadline stops even while waiting for speech'
    );
    assert.equal(k.engine.recs[0].cancelled, true);
  }
  // Speech interrupts playing AND in-flight TTS locally before STT.
  for (const pending of [true, false]) {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    let resolve!: (r: Response) => void;
    const original = g.fetch;
    g.fetch = () => new Promise<Response>((r) => (resolve = r));
    h.vc.speak('answer');
    if (!pending) {
      resolve(new Response(new Uint8Array(8)));
      await tick();
    }
    h.vc.toggleHandsFree();
    h.engine.recs[0].speech?.();
    assert.equal(h.ui.playing, null);
    assert.equal(h.ui.loading, null);
    if (pending) {
      resolve(new Response(new Uint8Array(8)));
      await tick();
      assert.equal(h.engine.played.length, 0);
    }
    h.vc.stop();
    g.fetch = original;
  }
  // STT failure during an interruption must halt actions, not resume them.
  {
    const h = harness();
    let stops = 0;
    const pauses: boolean[] = [];
    h.host.stopPlan = () => {
      stops++;
    };
    h.host.speech = (on) => pauses.push(on);
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    h.vc.toggleHandsFree();
    h.vc.planListen(true);
    h.engine.recs[0].speech?.();
    replies = [
      { status: 502, body: { success: false, error: { code: 'UPSTREAM' } } },
    ];
    h.vc.press();
    await tick();
    await settle();
    assert.equal(stops, 1);
    assert.deepEqual(pauses, [true]);
    assert.equal(h.ui.handsFree, false);
    assert.equal(h.engine.recs.length, 1);
  }

  // Заход 9 (P2-2): заголовок и язык по словарю — как ждёт сервер.
  {
    assert.equal(UI_LANG_HEADER, 'X-Assist-Lang');
    const srv = readFileSync(
      new URL(
        '../../sites-backend/src/modules/assist-site-voice/public/site-voice.service.ts',
        import.meta.url
      ),
      'utf8'
    );
    assert.ok(srv.includes(`STT_UI_LANG_HEADER = '${UI_LANG_HEADER}'`));
    assert.equal(uiLangOfDict(DICTS.ru), 'ru');
    assert.equal(uiLangOfDict(DICTS.en), 'en');
    assert.equal(
      uiLangOfDict({ ...DICTS.uk }),
      null,
      'чужой словарь — без заголовка'
    );
  }
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
    // Заход 9 (P2-2): язык интерфейса — для счётчиков «не расслышал» Т-4.
    assert.equal(fetches[0].headers['X-Assist-Lang'], 'uk');
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
    assert.equal(fetches[0].path, '/widget/v1/tts?segment=0');
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
  for (const how of ['stop', 'hidden', 'other-tab', 'off'] as const) {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    let signal: AbortSignal | null = null;
    let resolve!: (r: Response) => void;
    const original = g.fetch;
    g.fetch = (_p: string, o: { signal: AbortSignal }) => {
      signal = o.signal;
      return new Promise<Response>((r) => (resolve = r));
    };
    h.vc.toggleHandsFree();
    h.vc.press();
    if (how === 'stop') h.vc.stop();
    if (how === 'hidden') h.vc.hidden();
    if (how === 'other-tab') h.vc.onChannel('voice-on:other');
    if (how === 'off') h.vc.configure(null);
    assert.equal((signal as AbortSignal | null)?.aborted, true, how);
    resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: { text: 'late', voiceTicket: 'v1.late' },
        })
      )
    );
    await tick();
    await settle();
    g.fetch = original;
    assert.equal(h.ui.handsFree, false);
    assert.equal(h.engine.recs.length, 1);
    assert.deepEqual(
      h.asked,
      [],
      'no late command after hands-free cancellation'
    );
  }
  // Late STT must not send a question or reopen the microphone after cancellation.
  for (const cancel of ['close', 'hidden', 'off', 'other-tab'] as const) {
    const h = harness();
    h.store['local:vconsent'] = '1';
    h.vc.configure(cfg);
    await tick();
    let resolve!: (r: Response) => void;
    const originalFetch = g.fetch;
    g.fetch = () => new Promise<Response>((r) => (resolve = r));
    h.vc.press();
    h.vc.press();
    assert.equal(h.ui.phase, 'sending');
    if (cancel === 'close') h.vc.cancel();
    if (cancel === 'hidden') h.vc.hidden();
    if (cancel === 'off') h.vc.configure(null);
    if (cancel === 'other-tab') h.vc.onChannel('voice-on:other');
    resolve(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            text: 'закрий банер',
            voiceTicket: 'v1.late',
          },
        })
      )
    );
    await tick();
    await tick();
    g.fetch = originalFetch;
    assert.deepEqual(h.asked, [], `late STT after ${cancel}`);
    assert.equal(h.ui.phase, 'idle', cancel);
    h.vc.planListen(true);
    assert.equal(
      h.engine.recs.length,
      1,
      `mic must need a fresh gesture after ${cancel}`
    );
  }
  // A superseded TTS failure must not clear the newer answer or show a stale error.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    let reject!: (e: Error) => void;
    const originalFetch = g.fetch;
    let calls = 0;
    g.fetch = () =>
      ++calls === 1
        ? new Promise<Response>((_r, j) => (reject = j))
        : Promise.resolve(new Response(new Uint8Array(8)));
    h.vc.speak('old');
    h.vc.speak('new');
    await tick();
    await tick();
    assert.equal(h.ui.playing, 'new');
    reject(new Error('late failure'));
    await tick();
    g.fetch = originalFetch;
    assert.equal(h.ui.playing, 'new');
    assert.deepEqual(h.notices, []);
  }
  // Repeated play taps during delayed TTS preserve one request and one playback.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    const originalFetch = g.fetch;
    const pending: Array<(r: Response) => void> = [];
    g.fetch = () => new Promise<Response>((r) => pending.push(r));
    h.vc.speak('waiting');
    h.vc.speak('waiting');
    h.vc.speak('waiting');
    assert.equal(pending.length, 1);
    assert.equal(h.ui.loading, 'waiting');
    pending[0](new Response(new Uint8Array(8)));
    await tick();
    await tick();
    g.fetch = originalFetch;
    assert.equal(h.engine.played.length, 1);
    assert.equal(h.ui.playing, 'waiting');
    h.vc.speak('waiting');
    assert.equal(h.ui.playing, null);
  }
  // Phrase protocol: play the first bytes before later audio is ready, one look-ahead.
  for (const cancel of [false, true]) {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    const original = g.fetch;
    const pending: Array<{
      path: string;
      signal: AbortSignal;
      resolve: (r: Response) => void;
    }> = [];
    g.fetch = (path: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((resolve) =>
        pending.push({ path, signal: init.signal, resolve })
      );
    const audio = (index: number) =>
      new Response(new Uint8Array([index + 1]), {
        headers: {
          'X-Assist-Tts-Parts': '3',
          'X-Assist-Tts-Part': String(index),
        },
      });
    h.vc.speak('phrases');
    pending[0].resolve(audio(0));
    await tick();
    await tick();
    assert.equal(
      h.engine.played.length,
      1,
      'first phrase plays without waiting for the rest'
    );
    assert.equal(pending.length, 2, 'only one future phrase is requested');
    assert.equal(pending[1].path, '/widget/v1/tts?segment=1');
    if (cancel) {
      h.vc.cancel();
      assert.equal(pending[1].signal.aborted, true);
      pending[1].resolve(audio(1));
      h.engine.playEnd?.();
      await tick();
      await tick();
      assert.equal(h.engine.played.length, 1);
      assert.equal(pending.length, 2);
    } else {
      pending[1].resolve(audio(1));
      await tick();
      assert.equal(
        h.engine.played.length,
        1,
        'prefetched audio cannot overlap'
      );
      h.engine.playEnd?.();
      await tick();
      await tick();
      assert.equal(h.engine.played.length, 2);
      assert.equal(pending.length, 3);
      pending[2].resolve(audio(2));
      await tick();
      h.engine.playEnd?.();
      await tick();
      await tick();
      assert.equal(h.engine.played.length, 3);
      assert.deepEqual(
        h.engine.played.map((b) => new Uint8Array(b)[0]),
        [1, 2, 3]
      );
      h.engine.playEnd?.();
      assert.equal(h.ui.playing, null);
    }
    g.fetch = original;
  }
  // A failed look-ahead ends the queue after the current phrase, without retries.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    const original = g.fetch;
    let calls = 0;
    g.fetch = async () => {
      calls++;
      return calls === 1
        ? new Response(new Uint8Array([1]), {
            headers: { 'X-Assist-Tts-Parts': '3', 'X-Assist-Tts-Part': '0' },
          })
        : new Response(
            JSON.stringify({ success: false, error: { code: 'UPSTREAM' } }),
            { status: 503 }
          );
    };
    h.vc.speak('provider-error');
    await tick();
    await tick();
    assert.equal(h.engine.played.length, 1);
    h.engine.playEnd?.();
    await tick();
    await tick();
    assert.equal(calls, 2);
    assert.equal(h.engine.played.length, 1);
    assert.equal(h.ui.playing, null);
    assert.equal(h.ui.loading, null);
    assert.ok(h.notices.length > 0);
    g.fetch = original;
  }
  // Playback rejection is not a natural end: never synthesize the remaining queue.
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    const original = g.fetch;
    let calls = 0;
    g.fetch = async () => {
      const index = calls++;
      return new Response(new Uint8Array([index + 1]), {
        headers: {
          'X-Assist-Tts-Parts': '4',
          'X-Assist-Tts-Part': String(index),
        },
      });
    };
    h.vc.speak('blocked-audio');
    await tick();
    await tick();
    h.engine.playEnd?.(true);
    await tick();
    await tick();
    assert.equal(
      calls,
      2,
      'only the bounded look-ahead may have been dispatched'
    );
    assert.equal(h.engine.played.length, 1);
    assert.equal(h.ui.playing, null);
    assert.ok(h.notices.length > 0);
    g.fetch = original;
  }
  // Stop/start of the SAME message: an older response must not play twice (ABA).
  {
    const h = harness();
    h.vc.configure(cfg);
    await tick();
    const originalFetch = g.fetch;
    const pending: Array<(r: Response) => void> = [];
    g.fetch = () => new Promise<Response>((r) => pending.push(r));
    h.vc.speak('same');
    h.vc.cancelSpeech();
    h.vc.speak('same');
    pending[0](new Response(new Uint8Array(4)));
    await tick();
    await tick();
    assert.equal(h.engine.played.length, 0, 'stopped TTS must stay stopped');
    pending[1](new Response(new Uint8Array(8)));
    await tick();
    await tick();
    g.fetch = originalFetch;
    assert.equal(h.engine.played.length, 1);
    assert.equal(h.engine.played[0].byteLength, 8);
  }
  // HTML audio autoplay rejection is reported as an error, not a normal end.
  {
    const original = g.Audio;
    let ended = 0;
    let failed: boolean | undefined;
    g.Audio = class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = '';
      pause() {}
      play() {
        return Promise.reject(new Error('NotAllowedError'));
      }
    };
    const engine = createVoice();
    engine.play(new ArrayBuffer(8), (error) => {
      ended++;
      failed = error;
    });
    await tick();
    assert.equal(ended, 1);
    assert.equal(failed, true);
    g.Audio = original;
  }
  // WebAudio decoding is asynchronous too: Stop invalidates its pending callback.
  {
    let decoded!: (b: AudioBuffer) => void;
    let started = 0;
    class DecodeContext {
      state = 'running';
      destination = {};
      decodeAudioData(_b: ArrayBuffer, done: (b: AudioBuffer) => void) {
        decoded = done;
      }
      createBufferSource() {
        return {
          connect() {},
          start() {
            started++;
          },
          stop() {},
          onended: null,
        };
      }
    }
    g.window = { AudioContext: DecodeContext };
    const engine = createVoice();
    engine.unlock();
    engine.play(new ArrayBuffer(4), () => assert.fail('stopped audio ended'));
    engine.stopPlayback();
    decoded({} as AudioBuffer);
    assert.equal(started, 0, 'late decoding must not start stopped audio');
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
    const cancelledEnds: RecordEnd[] = [];
    const cancelled = engine.record(
      { minSpeechMs: 1, endSilenceMs: 60_000, maxRecordMs: 30_000 },
      () => undefined,
      (e) => cancelledEnds.push(e)
    );
    await tick();
    cancelled.cancel();
    assert.equal(
      tracks.stopped,
      2,
      'Stop releases microphone before deferred onstop'
    );
    assert.equal(ctxs.open, 0);
    assert.deepEqual(cancelledEnds, [{ reason: 'cancel' }]);
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(
      cancelledEnds,
      [{ reason: 'cancel' }],
      'no late audio submission'
    );
  }
  console.log('voice: детектор речи, формат, конфиг, контроллер голоса — ok');
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
