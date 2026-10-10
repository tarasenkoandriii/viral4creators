// Actual hook + fake device APIs: checks cleanup and asynchronous races without a microphone.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
let effects = [],
  state,
  intervals = new Map(),
  timeouts = new Map(),
  serial = 0;
let failContext = false,
  failRecorder = false,
  recorder,
  context,
  permissionPromise,
  stream;
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function environment() {
  effects = [];
  state = null;
  intervals = new Map();
  timeouts = new Map();
  failContext = false;
  failRecorder = false;
  const ended = [];
  const track = {
    stop: () => {
      track.stopped = true;
    },
    stopped: false,
    addEventListener: (_, cb) => ended.push(cb),
  };
  stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
    track,
    ended,
  };
  permissionPromise = Promise.resolve(stream);
  class Context {
    constructor() {
      if (failContext) throw Error('device');
      context = this;
    }
    resume() {
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createAnalyser() {
      return {
        fftSize: 4,
        connect() {},
        getFloatTimeDomainData(b) {
          b.fill(0.1);
        },
      };
    }
    createGain() {
      return { gain: { value: 0 }, connect() {} };
    }
    createMediaStreamSource() {
      return { connect() {} };
    }
  }
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor() {
      if (failRecorder) throw Error('codec');
      recorder = this;
      this.mimeType = 'audio/webm';
      this.state = 'inactive';
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      if (this.ondataavailable)
        this.ondataavailable({ data: new Blob(['audio']) });
      if (this.onstop) this.onstop();
    }
  }
  global.window = {
    AudioContext: Context,
    setInterval: (cb) => {
      const id = ++serial;
      intervals.set(id, cb);
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (cb) => {
      const id = ++serial;
      timeouts.set(id, cb);
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    addEventListener() {},
    removeEventListener() {},
  };
  global.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: () => permissionPromise } },
  });
  global.MediaRecorder = Recorder;
  global.localStorage = { getItem: () => null, setItem() {} };
  global.__voiceHooks = {
    useCallback: (f) => f,
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      const value = typeof initial === 'function' ? initial() : initial;
      state = value;
      return [
        value,
        (next) => {
          state = next;
        },
      ];
    },
    useEffect: (fn) => effects.push(fn),
  };
}
async function main() {
  environment();
  const result = await build({
    entryPoints: [root + '/src/features/voice/useVoiceListening.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'device-harness',
        setup(b) {
          b.onResolve({ filter: /^react$/ }, () => ({
            path: 'react',
            namespace: 'mock',
          }));
          b.onResolve({ filter: /\/lib\/telegram$/ }, () => ({
            path: 'telegram',
            namespace: 'mock',
          }));
          b.onLoad({ filter: /.*/, namespace: 'mock' }, (a) => ({
            contents:
              a.path === 'react'
                ? 'module.exports=global.__voiceHooks'
                : 'export function getTelegramWebApp(){return null;}',
          }));
        },
      },
    ],
  });
  const make = (onUtterance = async () => {}) => {
    const m = new Module(root + '/voice-harness.cjs');
    m._compile(result.outputFiles[0].text, root + '/voice-harness.cjs');
    const h = m.exports.useVoiceListening({
      active: false,
      blocked: false,
      onUtterance,
    });
    const clean = effects.map((f) => f()).filter(Boolean);
    return { h, clean };
  };
  let n = 0;
  const test = async (name, fn) => {
    environment();
    await fn(make);
    n++;
    console.log('PASS ' + name);
  };
  await test('AudioContext failure releases request', async (make) => {
    failContext = true;
    const { h } = make();
    h.enable();
    await flush();
    assert.equal(state.notice, 'recording-error');
    assert.equal(state.phase, 'off');
  });
  await test('permission denial closes audio context', async (make) => {
    permissionPromise = Promise.reject(Error('denied'));
    const { h } = make();
    h.enable();
    await flush();
    assert.equal(state.notice, 'denied');
    assert.equal(context.closed, true);
  });
  await test('late permission after disable stops the stale stream', async (make) => {
    let resolve;
    permissionPromise = new Promise((r) => (resolve = r));
    const { h } = make();
    h.enable();
    h.disable();
    resolve(stream);
    await flush();
    assert.equal(stream.track.stopped, true);
    assert.equal(state.phase, 'off');
    assert.equal(intervals.size, 0);
  });
  await test('manual recorder failure closes mic', async (make) => {
    failRecorder = true;
    const { h } = make();
    h.talkStart();
    await flush();
    assert.equal(state.notice, 'recording-error');
    assert.equal(stream.track.stopped, true);
  });
  await test('recorder error stops mic and clears timers', async (make) => {
    const { h } = make();
    h.talkStart();
    await flush();
    recorder.onerror();
    assert.equal(state.notice, 'recording-error');
    assert.equal(stream.track.stopped, true);
    assert.equal(timeouts.size, 0);
  });
  await test('device disconnect stops active listening', async (make) => {
    const { h } = make();
    h.enable();
    await flush();
    stream.ended.forEach((f) => f());
    assert.equal(state.notice, 'recording-error');
    assert.equal(stream.track.stopped, true);
    assert.equal(intervals.size, 0);
    assert.equal(context.closed, true);
  });
  await test('processing failure closes mic without unhandled rejection', async (make) => {
    const { h } = make(async () => {
      throw Error('processing');
    });
    h.talkStart();
    await flush();
    const now = Date.now;
    Date.now = () => now() + 1000;
    h.talkStop();
    Date.now = now;
    await flush();
    assert.equal(state.notice, 'recording-error');
    assert.equal(state.phase, 'off');
    assert.equal(stream.track.stopped, true);
  });
  await test('unmount closes device and context', async (make) => {
    const { h, clean } = make();
    h.enable();
    await flush();
    clean.forEach((f) => f());
    assert.equal(stream.track.stopped, true);
    assert.equal(context.closed, true);
    assert.equal(intervals.size, 0);
  });
  console.log(n + ' runtime checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
