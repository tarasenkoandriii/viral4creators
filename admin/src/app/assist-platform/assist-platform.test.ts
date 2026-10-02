// Вкладка «Помощник» (аудит фронта 02.10). В admin/ нет тест-раннера —
// запуск: `npx --prefix ../sites-landing tsx src/app/assist-platform/assist-platform.test.ts`
// (из admin/). Next не трогает этот файл: в app/ маршрутами становятся
// только page/route/layout.
//  1. Потолок платформы: опечатка не снимает потолок (NaN → JSON null).
//  2. Срок ручного тарифа/продления — 1…730.
//  3. Каждое изменяющее действие страницы идёт через confirmThen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { confirmThen, parseCapUsd, parseDays } from '../../lib/assist-platform';

// ── 1 ──
assert.deepEqual(parseCapUsd(''), { ok: true, value: null });
assert.deepEqual(parseCapUsd('  '), { ok: true, value: null });
assert.deepEqual(parseCapUsd('5'), { ok: true, value: 5 });
assert.deepEqual(parseCapUsd('5,5'), { ok: true, value: 5.5 });
assert.deepEqual(parseCapUsd('12.25'), { ok: true, value: 12.25 });
for (const bad of ['abc', '-1', '1001', '1e3', '5$', 'NaN', 'Infinity', '1,2,3']) {
  assert.deepEqual(parseCapUsd(bad), { ok: false }, `потолок «${bad}»`);
}

// ── 2 ──
assert.equal(parseDays(30), 30);
for (const bad of [0, -5, 731, 1.5, Number.NaN]) assert.equal(parseDays(bad), null, `дней ${bad}`);

// ── 3 ──
let ran = 0;
const run = async () => ++ran;
assert.equal(confirmThen('?', run, () => false), null);
assert.equal(ran, 0, 'действие без подтверждения');
void confirmThen('?', run, () => true);
assert.equal(ran, 1);

const page = readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
const MUTATING = ['setPlan', 'extend', 'setSite', 'message', 'addToEval', 'addOptOut', 'removeOptOut', 'setSettings'];
for (const name of MUTATING) {
  const re = new RegExp(`assistApi\\s*\\.${name}\\(`, 'g');
  const hits = [...page.matchAll(re)];
  assert.ok(hits.length > 0, `${name}: вызова нет на странице`);
  for (const m of hits) {
    // Вызов — только вторым аргументом confirmThen(…)/act(…): `, () => assistApi.x(`,
    // и ближе к нему, чем обработчик onClick/onSubmit (иначе это стрелка самого обработчика).
    const before = page.slice(Math.max(0, m.index! - 400), m.index);
    assert.ok(/,\s*\(\)\s*=>\s*$/.test(before), `${name}: вызов не вторым аргументом подтверждения`);
    const guard = Math.max(before.lastIndexOf('confirmThen('), before.lastIndexOf('act('));
    const handler = Math.max(before.lastIndexOf('onClick='), before.lastIndexOf('onSubmit='));
    assert.ok(guard > handler, `${name}: вызов мимо подтверждения`);
  }
}
// `act` сам спрашивает подтверждение.
assert.ok(/const act = \(text: string, run: \(\) => Promise<AssistAccountDetail>\) => \{\s*const p = confirmThen\(text, run\);\s*if \(!p\) return;/.test(page), 'act без confirmThen');
assert.ok(/confirmThen\(text, \(\) => assistApi\.setSettings\(body\)\)/.test(page), 'настройки без подтверждения');
assert.ok(!/Number\(cap\)/.test(page), 'потолок снова через Number()');

console.log('assist-platform: ok');
