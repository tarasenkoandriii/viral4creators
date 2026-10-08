/**
 * Заход 10, Р-З10-3 (в): проигрыватель примера голоса (VoiceSection) —
 * один элемент звука, разблокировка в жесте до `await`, второе нажатие
 * играет пример из памяти, при уходе с экрана звук гаснет (pause +
 * removeAttribute('src') + load()) и URL отзываются.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SamplePlayer,
  silentWav,
  type AudioLike,
} from '../src/screens/widget/sample-player';

class FakeAudio implements AudioLike {
  src = '';
  log: string[] = [];
  paused = true;
  /** Отказ браузера (вне жеста) для ближайших вызовов play(). */
  deny = 0;
  play(): Promise<void> {
    this.log.push(`play ${this.src}`);
    if (this.deny > 0) {
      this.deny--;
      const e = new Error('blocked');
      e.name = 'NotAllowedError';
      return Promise.reject(e);
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.log.push('pause');
    this.paused = true;
  }
  removeAttribute(name: 'src'): void {
    this.log.push(`remove ${name}`);
    this.src = '';
  }
  load(): void {
    this.log.push('load');
  }
}

function setup() {
  const audios: FakeAudio[] = [];
  const urls: string[] = [];
  const revoked: string[] = [];
  let n = 0;
  const player = new SamplePlayer({
    createAudio: () => {
      const a = new FakeAudio();
      audios.push(a);
      return a;
    },
    createUrl: () => {
      const u = `blob:${++n}`;
      urls.push(u);
      return u;
    },
    revokeUrl: (u) => revoked.push(u),
  });
  return { player, audios, urls, revoked };
}

const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

// 1. Нажатие: prime() синхронно играет беззвучный звук на том же элементе,
// пример после await — тот же элемент, один Audio на раздел.
{
  const { player, audios } = setup();
  player.prime();
  assert.equal(audios.length, 1);
  assert.deepEqual(audios[0].log, ['play blob:1']);
  assert.equal(await player.load('Maya|uk', blob), 'played');
  assert.equal(audios.length, 1);
  assert.equal(audios[0].src, 'blob:2');
  assert.equal(audios[0].paused, false);
  assert.ok(player.has('Maya|uk'));
  assert.ok(!player.has('Adam|uk'));
}

// 2. Уход с экрана: pause() + пустой src, оба URL отозваны, дальше — тишина.
{
  const { player, audios, revoked } = setup();
  player.prime();
  await player.load('Maya|uk', blob);
  player.dispose();
  const a = audios[0];
  assert.equal(a.paused, true);
  assert.equal(a.src, '');
  assert.deepEqual(a.log.slice(-3), ['pause', 'remove src', 'load']);
  assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2']);
  assert.ok(!player.has('Maya|uk'));
  // Пример пришёл уже после ухода — не играет.
  player.prime();
  assert.equal(await player.load('Maya|uk', blob), 'blocked');
  assert.equal(audios.length, 1);
  assert.equal(a.paused, true);
}

// 3. Браузер отказал (NotAllowedError) — пример в памяти; второе нажатие
// играет его синхронно (play() вызван до возврата из replay), без запроса.
{
  const { player, audios, urls } = setup();
  player.prime();
  audios[0].deny = 1;
  assert.equal(await player.load('Maya|uk', blob), 'blocked');
  assert.ok(player.has('Maya|uk'));
  const before = audios[0].log.length;
  const p = player.replay();
  // pause, remove src, load, play — синхронно, до возврата из replay.
  assert.equal(audios[0].log.length, before + 4);
  assert.equal(audios[0].log[audios[0].log.length - 1], 'play blob:2');
  assert.equal(await p, 'played');
  assert.equal(urls.length, 2);
}

// 4. Повтор во время звучания — прежний звук остановлен, не наложение.
{
  const { player, audios, revoked } = setup();
  player.prime();
  await player.load('Maya|uk', blob);
  player.prime();
  assert.equal(audios[0].log[audios[0].log.length - 4], 'pause');
  await player.load('Adam|uk', blob);
  assert.deepEqual(revoked, ['blob:2']);
  assert.equal(audios.length, 1);
}

// 5. Беззвучный WAV — корректный заголовок RIFF/WAVE, тишина (128).
{
  const b = silentWav();
  assert.equal(b.type, 'audio/wav');
  const bytes = new Uint8Array(await b.arrayBuffer());
  const text = (from: number, len: number) =>
    String.fromCharCode(...bytes.slice(from, from + len));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 4), 'WAVE');
  assert.equal(text(36, 4), 'data');
  assert.equal(bytes.length, 44 + 80);
  assert.ok(bytes.slice(44).every((x) => x === 128));
}

// 6. VoiceSection пользуется проигрывателем: dispose при уходе, prime до
// await, и нигде нет `new Audio(…).play()` после await.
{
  const src = readFileSync(
    new URL('../src/screens/widget/VoiceSection.tsx', import.meta.url),
    'utf8'
  );
  assert.ok(/p\.dispose\(\)/.test(src));
  assert.ok(!/new Audio\([^)]+\)\.play\(\)/.test(src));
  const listen = src.slice(src.indexOf('const listen'));
  assert.ok(
    listen.indexOf('p.prime()') < listen.indexOf('await voice.sample'),
    'prime() — до первого await'
  );
}

console.log('sample-player: ok');
