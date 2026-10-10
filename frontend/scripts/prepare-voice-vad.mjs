import { mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const target = resolve(
  dirname(require.resolve('../package.json')),
  'public/voice-vad'
);
const vad = dirname(require.resolve('@ricky0123/vad-web'));
const ort = dirname(require.resolve('onnxruntime-web/wasm'));
await mkdir(target, { recursive: true });
for (const file of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) {
  await copyFile(resolve(vad, file), resolve(target, file));
}
for (const file of [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
]) {
  await copyFile(resolve(ort, file), resolve(target, file));
}
