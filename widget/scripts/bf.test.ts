/**
 * Чанк поведения bf.js (Э3-бис, К-11) — без браузера, на минимальном
 * «DOM» (`scripts/fake-dom.ts`). Аудит 06.10: текст JS-ошибки сайта уходит
 * в маяк `/widget/v1/pv` (группы ошибок) — ПД в нём (e-mail, номер карты,
 * ключ) маскируются ДО хеша и отправки.
 */
import assert from 'node:assert/strict';
import { installFakeDom } from './fake-dom';
import type { EngageHost } from '../src/engage/host';
import { start } from '../src/bf/index';

installFakeDom();
const g = globalThis as unknown as Record<string, unknown>;
g.matchMedia = () => ({ matches: false });
g.scrollY = 0;

const listeners: Array<[string, (e?: unknown) => void]> = [];
const beacons: string[] = [];
const N = {
  on: (_t: unknown, type: string, fn: (e?: unknown) => void) => {
    listeners.push([type, fn]);
  },
  off: () => undefined,
  later: () => 0,
  beacon: (_u: string, b: string) => {
    beacons.push(b);
    return true;
  },
};
const stop = start(
  {
    N,
    pk: 'pk_test_abcdefgh',
    origin: 'https://assist.example',
    ui: null,
  } as unknown as EngageHost,
  'v'.repeat(16)
);
const on = (type: string) => {
  const l = listeners.find(([t]) => t === type);
  assert.ok(l, `bf.js слушает ${type}`);
  return l[1];
};
on('error')({
  message:
    'Uncaught: user ivan.petrenko@example.com, card 4111 1111 1111 1111, key sk-abcdefghijklmnop',
  filename: 'https://cdn.shop.example/app.js',
});
on('pagehide')();
const body = JSON.parse(beacons[0]) as {
  er: number;
  eg: Array<{ h: string; m: string; s: string }>;
};
assert.equal(body.er, 1);
const m = body.eg[0].m;
assert.ok(!m.includes('@'), `e-mail замаскирован: ${m}`);
assert.ok(!/4111/.test(m), `номер карты замаскирован: ${m}`);
assert.ok(!m.includes('sk-abc'), `ключ замаскирован: ${m}`);
assert.match(m, /^Uncaught: user \[e-mail\]/);
assert.equal(body.eg[0].s, 'cdn.shop.example', 'только хост скрипта');
stop();
console.log('bf: текст JS-ошибки маскируется до маяка — ok');
