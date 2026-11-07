// Real shared audio session + deferred responses; no provider or device calls.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { build } = require('esbuild');

async function main() {
  const result = await build({
    entryPoints: [path.resolve(__dirname, '../src/lib/hint-audio-session.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    define: { 'import.meta.env': '{}' },
    plugins: [
      {
        name: 'environment',
        setup(b) {
          b.onResolve(
            { filter: /^(react|\.\/plan-context|\.\/telegram)$/ },
            (a) => ({ path: a.path, namespace: 'environment' })
          );
          b.onLoad({ filter: /.*/, namespace: 'environment' }, (a) => ({
            contents:
              a.path === 'react'
                ? 'export const useEffect=f=>globalThis.__audioEffects?.push(f), useMemo=f=>f(), useState=f=>[typeof f==="function"?f():f,()=>{}];'
                : a.path.includes('telegram')
                  ? 'export const getTelegramWebApp=()=>null;'
                  : 'export const usePlanState=()=>null;',
          }));
        },
      },
    ],
  });
  const played = [];
  global.Audio = class {
    paused = true;
    currentTime = 0;
    muted = false;
    src = '';
    addEventListener() {}
    play() {
      this.paused = false;
      if (!this.muted) played.push(this.src);
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  };
  const mod = new Module(__filename);
  mod.paths = module.paths;
  mod._compile(result.outputFiles[0].text, __filename);
  const audio = mod.exports;
  const deferredSpeech = (url) => {
    const current = audio.captureSpeechTicket();
    let resolve;
    const pending = new Promise((r) => {
      resolve = r;
    });
    const done = pending.then(() => {
      if (current()) audio.sayReply(url, 'proactive');
    });
    return { resolve, done };
  };

  const old = deferredSpeech('old.mp3');
  audio.sayReply('playing.mp3', 'proactive');
  audio.sayReply('queued.mp3', 'proactive');
  audio.stopHint();
  assert.equal(audio.hintPlayer.playing, false);
  old.resolve();
  await old.done;
  assert.deepEqual(played, ['playing.mp3']);
  console.log(
    'PASS Stop clears current/queued audio and rejects delayed response'
  );

  const fresh = deferredSpeech('fresh.mp3');
  fresh.resolve();
  await fresh.done;
  assert.equal(played.at(-1), 'fresh.mp3');
  console.log('PASS new request after Stop can play');

  const muted = deferredSpeech('muted-late.mp3');
  audio.setHintMuted(true);
  audio.setHintMuted(false);
  muted.resolve();
  await muted.done;
  assert.equal(played.includes('muted-late.mp3'), false);
  assert.equal(audio.hintPlayer.playing, false);
  console.log('PASS mute/unmute cannot revive a pending response');

  const repeat = audio.captureSpeechTicket();
  audio.stopHint();
  assert.equal(repeat(), false);
  assert.equal(audio.captureSpeechTicket()(), true);
  console.log(
    'PASS delayed repeat ticket expires while fresh interaction remains usable'
  );

  const listeners = new Map();
  global.__audioEffects = [];
  global.window = {
    localStorage: null,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  audio.useVoiceBudgetOwner();
  const cleanups = global.__audioEffects.map((effect) => effect());
  const identitySpeech = deferredSpeech('previous-account.mp3');
  listeners.get('v4c:identity-changed')();
  identitySpeech.resolve();
  await identitySpeech.done;
  assert.equal(played.includes('previous-account.mp3'), false);
  for (const cleanup of cleanups) cleanup?.();
  assert.equal(listeners.size, 0);
  delete global.window;
  delete global.__audioEffects;
  console.log(
    'PASS identity change invalidates speech and releases its listener'
  );
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
