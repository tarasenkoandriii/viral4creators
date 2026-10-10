const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '..');
async function main() {
  const result = await build({
    entryPoints: [root + '/src/lib/voice-neural.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    plugins: [
      {
        name: 'model-harness',
        setup(b) {
          b.onResolve(
            { filter: /^(onnxruntime-web|@ricky0123\/vad-web)/ },
            (a) => ({ path: a.path, namespace: 'model' })
          );
          b.onLoad({ filter: /.*/, namespace: 'model' }, (a) => ({
            contents: a.path.includes('models')
              ? 'export const Silero={new:async()=>global.__model};'
              : a.path.includes('resampler')
                ? 'export class Resampler{process(input){return [input]}}'
                : a.path.includes('messages')
                  ? 'export const Message={AudioFrame:"frame",SpeechStop:"stop"}'
                  : 'export const env={wasm:{}};',
          }));
        },
      },
    ],
  });
  const originalFetch = global.fetch;
  let count = 0;
  async function check(name, fn) {
    let releases = 0,
      active = 0,
      maxActive = 0,
      resolve;
    global.__model = {
      process: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        if (resolve) await new Promise((r) => resolve(r));
        active--;
        return { isSpeech: 0.9 };
      },
      release: async () => {
        releases++;
      },
    };
    class Worklet {
      constructor() {
        this.port = { onmessage: null, postMessage() {}, close() {} };
      }
      connect() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    global.AudioWorkletNode = Worklet;
    const ctx = {
      audioWorklet: { addModule: async () => {} },
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      destination: {},
    };
    const m = new Module(root + '/neural-harness.cjs');
    m._compile(result.outputFiles[0].text, root + '/neural-harness.cjs');
    await fn({
      create: m.exports.createNeuralVoiceDetector,
      ctx,
      Worklet,
      releases: () => releases,
      maxActive: () => maxActive,
      setPending: (f) => (resolve = f),
    });
    count++;
    console.log('PASS ' + name);
  }
  try {
    await check(
      'destroy before start releases the loaded model once',
      async ({ create, ctx, releases }) => {
        const v = await create(
          {},
          ctx,
          () => {},
          () => {}
        );
        await v.destroy();
        await v.destroy();
        assert.equal(releases(), 1);
        await assert.rejects(v.start());
      }
    );
    await check(
      'worklet initialization failure still releases model',
      async ({ create, ctx, releases }) => {
        ctx.audioWorklet.addModule = async () => {
          throw Error('asset');
        };
        const v = await create(
          {},
          ctx,
          () => {},
          () => {}
        );
        await assert.rejects(v.start());
        await v.destroy();
        assert.equal(releases(), 1);
      }
    );
    await check(
      'disable during worklet load prevents audio graph creation',
      async ({ create, ctx, releases }) => {
        let finish;
        ctx.audioWorklet.addModule = () => new Promise((r) => (finish = r));
        ctx.createMediaStreamSource = () => {
          throw Error('stale graph');
        };
        const v = await create(
          {},
          ctx,
          () => {},
          () => {}
        );
        const start = v.start();
        const stop = v.destroy();
        finish();
        await start;
        await stop;
        assert.equal(releases(), 1);
      }
    );
    await check(
      'script processor fallback serializes inference and stops callbacks',
      async ({ create, ctx, maxActive, releases }) => {
        ctx.audioWorklet = undefined;
        ctx.sampleRate = 16000;
        let processor;
        ctx.createScriptProcessor = () =>
          (processor = { connect() {}, disconnect() {}, onaudioprocess: null });
        let delivered = 0;
        const v = await create(
          {},
          ctx,
          () => delivered++,
          () => {
            throw Error('inference');
          }
        );
        await v.start();
        const event = {
          inputBuffer: { getChannelData: () => new Float32Array(512) },
          outputBuffer: { getChannelData: () => new Float32Array(512) },
        };
        for (let i = 0; i < 10; i++) processor.onaudioprocess(event);
        for (let i = 0; i < 100; i++) await Promise.resolve();
        assert.equal(delivered, 10);
        assert.equal(maxActive(), 1);
        for (let i = 0; i < 10; i++) processor.onaudioprocess(event);
        await v.destroy();
        assert.equal(delivered, 10);
        assert.equal(processor.onaudioprocess, null);
        assert.equal(releases(), 1);
        assert.ok(maxActive() <= 1);
      }
    );
  } finally {
    global.fetch = originalFetch;
  }
  console.log(count + ' neural lifecycle checks passed');
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
