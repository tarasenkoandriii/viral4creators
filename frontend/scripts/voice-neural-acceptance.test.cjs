// Real pinned model + synthetic ru/uk speech; no credentials or microphone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const ort = require('onnxruntime-web/wasm');
const { Silero } = require('@ricky0123/vad-web/dist/models');
const root = path.resolve(__dirname, '..');
function load(file) {
  const result = buildSync({
    entryPoints: [file],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
  });
  const m = new Module(file);
  m._compile(result.outputFiles[0].text, file);
  return m.exports;
}
const { decodeWav, framed, noisyFramed, noise } = load(
  root + '/../backend/scripts/greeting-eval/audio.ts'
);
const { initialDetector, stepDetector, rmsOf, SPEECH_DETECTOR_DEFAULTS } = load(
  root + '/src/lib/voice-listen.ts'
);
async function main() {
  ort.env.wasm.numThreads = 1;
  const model = await Silero.new(ort, async () =>
    fs.readFileSync(
      require.resolve('@ricky0123/vad-web/dist/silero_vad_v5.onnx')
    )
  );
  const config = { ...SPEECH_DETECTOR_DEFAULTS, frameMs: 32 };
  let count = 0;
  async function evaluate(pcm) {
    model.reset_state();
    let state = initialDetector(config),
      kept = 0;
    for (let i = 0; i < pcm.length; i += 512) {
      const f = new Float32Array(512);
      f.set(pcm.subarray(i, i + 512));
      const p = await model.process(f);
      const r = stepDetector(state, rmsOf(f), config, false, p.isSpeech);
      state = r.state;
      for (const e of r.events) if (e.type === 'end' && e.keep) kept++;
    }
    return { state, kept };
  }
  try {
    for (const lang of ['ru', 'uk'])
      for (const snr of [null, 20, 15, 10, 5])
        for (const seed of [123, 456, 789]) {
          const { samples } = decodeWav(
            fs.readFileSync(root + `/scripts/fixtures/voice/${lang}.wav`)
          );
          const { state, kept } = await evaluate(
            snr === null
              ? framed(samples)
              : noisyFramed(samples, 'pink', snr, seed)
          );
          assert.equal(
            kept,
            1,
            `${lang} SNR=${snr} seed=${seed}: one completed phrase`
          );
          assert.equal(state.phase, 'idle', 'no recording held by background');
          count++;
        }
    for (const level of [0, 0.01, 0.03, 0.1]) {
      const pcm = noise('pink', 23, 123);
      for (let i = 0; i < pcm.length; i++) pcm[i] *= level;
      const { state, kept } = await evaluate(pcm);
      assert.equal(kept, 0);
      assert.equal(state.stopped, true);
      count++;
    }
    console.log(`${count} real-model voice scenarios passed`);
  } finally {
    await model.release();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
