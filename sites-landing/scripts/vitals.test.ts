/**
 * Приёмник полевых CWV `POST /api/vitals` (§9 п.7): открыт всем, поэтому
 * в журнал функции пишет только перечислимое — имя метрики, число,
 * оценку и путь из списка страниц сайта. Произвольный текст в журнал
 * не проходит ни через одно поле; мусор — 400, большое тело — 413.
 */
import assert from 'node:assert/strict';
import { POST } from '../src/app/api/vitals/route';
import { KNOWN_VITAL_PATHS, OTHER_PATH, parseVital, VITAL_BODY_LIMIT } from '../src/lib/vitals';
import { locales } from '../src/lib/i18n';
import { PAGES } from '../src/lib/pages';

const GOOD = { name: 'LCP', value: 1234.5678, rating: 'good', path: '/uk/assistant/pricing' };

// ── Разбор ──
assert.deepEqual(parseVital(GOOD), { name: 'LCP', value: 1234.568, rating: 'good', path: '/uk/assistant/pricing' });
for (const bad of [
  null,
  'LCP',
  { ...GOOD, name: 'FID' },
  { ...GOOD, value: -1 },
  { ...GOOD, value: Number.NaN },
  { ...GOOD, value: '1' },
  { ...GOOD, value: 600_001 },
  { ...GOOD, rating: 'great' },
  { ...GOOD, path: 'uk' },
  { ...GOOD, path: '/uk?email=a@b.c' },
  { ...GOOD, path: `/${'a'.repeat(300)}` },
]) {
  assert.equal(parseVital(bad), null, `принято: ${JSON.stringify(bad)}`);
}
// Каждая страница сайта × локаль — как есть; любой другой путь — `other`.
for (const l of locales) for (const p of PAGES) assert.ok(KNOWN_VITAL_PATHS.has(`/${l}${p.path}`), `/${l}${p.path} не в списке`);
assert.ok(KNOWN_VITAL_PATHS.has('/legal/privacy') && KNOWN_VITAL_PATHS.has('/en/assistant/pilot/status/sent'));
for (const free of ['/my-email-john-smith-at-example-com', '/uk/assistant/pricing/x', '/call-me/380501234567']) {
  assert.equal(parseVital({ ...GOOD, path: free })?.path, OTHER_PATH, `свободный текст «${free}» прошёл в журнал`);
}

// ── Обработчик ──
async function main() {
  const logged: string[] = [];
  const saved = console.log;
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  const post = (body: string) =>
    POST(new Request('http://localhost:3010/api/vitals', { method: 'POST', body, headers: { 'content-type': 'application/json' } }));
  try {
    assert.equal((await post(JSON.stringify(GOOD))).status, 204);
    assert.equal((await post(JSON.stringify({ ...GOOD, path: '/secret-text-in-log' }))).status, 204);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ ...GOOD, extra: 'x' }))).status, 204);
    assert.equal((await post(JSON.stringify({ ...GOOD, pad: 'x'.repeat(VITAL_BODY_LIMIT) }))).status, 413);
  } finally {
    console.log = saved;
  }
  assert.equal(logged.length, 3, `строк журнала: ${logged.length}`);
  for (const line of logged) {
    const rec = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(Object.keys(rec).sort(), ['path', 'rating', 'value', 'vital'], `лишние поля в журнале: ${line}`);
    assert.ok(!line.includes('secret-text') && !line.includes('extra'), `в журнал попал чужой текст: ${line}`);
  }
  assert.equal(JSON.parse(logged[1]).path, OTHER_PATH);
  console.log(
    `ok   /api/vitals: в журнал — только метрика, число, оценка и путь из ${KNOWN_VITAL_PATHS.size} страниц сайта (иначе «${OTHER_PATH}»); мусор — 400, > ${VITAL_BODY_LIMIT} — 413`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
