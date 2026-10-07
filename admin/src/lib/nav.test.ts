// Каталог навигации и помощники «Обзора». В admin/ нет тест-раннера —
// запуск (из admin/):
//   npx --prefix ../sites-landing tsx src/lib/nav.test.ts
// Next не трогает этот файл: в app/ маршрутами становятся только
// page/route/layout, а lib/ — не app/.
//  1. Все 31 рабочая страница в меню ровно по одному разу; каждая ссылка
//     ведёт на существующую страницу; групп восемь, в каждой 2–6.
//  2. Активный пункт: root — только точное совпадение, вложенные
//     маршруты отмечают родителя, соседи с общим началом — нет.
//  3. Запомненное раскрытие: мусор и чужие ключи отбрасываются.
//  4. Возраст, секции и «всё спокойно» на «Обзоре».
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  activeGroupKey,
  activeLabel,
  ALL_NAV_LINKS,
  isNavActive,
  NAV_GROUPS,
  OVERVIEW_LINK,
  parseExpanded,
} from './nav';
import { actionLabel, calmState, formatAge, groupBySeverity } from './attention';
import type { AttentionItem, AttentionView } from './attention';

const appDir = path.join(__dirname, '..', 'app');

// ── 1 ──
const hrefs = ALL_NAV_LINKS.map((l) => l.href);
assert.equal(hrefs.length, 31, 'в меню 31 рабочая страница');
assert.equal(new Set(hrefs).size, hrefs.length, 'без дублей');
assert.equal(NAV_GROUPS.length, 8, 'восемь групп');
for (const g of NAV_GROUPS) {
  assert.ok(g.links.length >= 2 && g.links.length <= 6, `группа «${g.label}»: 2–6 пунктов`);
}
assert.equal(new Set(NAV_GROUPS.map((g) => g.key)).size, NAV_GROUPS.length, 'ключи групп уникальны');
for (const href of hrefs) {
  assert.ok(existsSync(path.join(appDir, href.slice(1), 'page.tsx')), `страница ${href} существует`);
}
assert.ok(existsSync(path.join(appDir, 'page.tsx')), '«Обзор» — app/page.tsx');
assert.equal(OVERVIEW_LINK.href, '/');
// Обратное направление: каждая верхнеуровневая страница есть в меню
// (кроме входа). Новая страница без пункта меню — красный тест.
const topLevelPages = readdirSync(appDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(path.join(appDir, d.name, 'page.tsx')))
  .map((d) => `/${d.name}`)
  .filter((href) => href !== '/login');
assert.deepEqual([...topLevelPages].sort(), [...hrefs].sort(), 'меню покрывает все страницы');
// Аудит: в группах из старой «Системы» больше нет сборной на 12 ссылок.
const ops = NAV_GROUPS.find((g) => g.key === 'ops');
assert.deepEqual(
  ops?.links.map((l) => l.href),
  ['/cron', '/ui-snapshots', '/testing', '/telemetry', '/settings'],
);

// ── 2 ──
assert.equal(isNavActive('/', '/'), true);
assert.equal(isNavActive('/sessions', '/'), false, 'root не активен на других экранах');
assert.equal(isNavActive('/sessions', '/sessions'), true);
assert.equal(isNavActive('/sessions/abc', '/sessions'), true, 'вложенный маршрут');
assert.equal(isNavActive('/sessions/', '/sessions'), true, 'хвостовой слэш');
assert.equal(isNavActive('/sessions?x=1', '/sessions'), true, 'query не мешает');
assert.equal(isNavActive('/users-x', '/users'), false, 'сосед с общим началом');
assert.equal(isNavActive('/assist-platform', '/assistant'), false);
assert.equal(isNavActive(null, '/'), false);
assert.equal(activeGroupKey('/sessions/abc'), 'people');
assert.equal(activeGroupKey('/cron'), 'ops');
assert.equal(activeGroupKey('/'), null);
assert.equal(activeLabel('/'), 'Обзор');
assert.equal(activeLabel('/cron'), 'Запуски по расписанию');
assert.equal(activeLabel('/nope'), null);

// ── 3 ──
assert.equal(parseExpanded(null), null);
assert.equal(parseExpanded('{'), null);
assert.equal(parseExpanded('{"a":1}'), null);
assert.deepEqual(parseExpanded('["ops","nope",3,"people"]'), ['ops', 'people']);

// ── 4 ──
assert.equal(formatAge(0), 'меньше минуты');
assert.equal(formatAge(59_999), 'меньше минуты');
assert.equal(formatAge(60_000), '1 мин');
assert.equal(formatAge(59 * 60_000), '59 мин');
assert.equal(formatAge(3 * 3_600_000), '3 ч');
assert.equal(formatAge(23.9 * 3_600_000), '23 ч');
assert.equal(formatAge(2 * 86_400_000), '2 дн');
assert.equal(formatAge(Number.NaN), 'меньше минуты');
assert.equal(actionLabel('cron-failed'), 'Открыть запуски');
assert.equal(actionLabel('unknown-kind'), 'Открыть');

const item = (id: string, severity: AttentionItem['severity']): AttentionItem => ({
  id,
  severity,
  kind: 'x',
  title: id,
  reason: '',
  since: '2026-10-06T00:00:00.000Z',
  ageMs: 0,
  owner: 'operator',
  href: '/',
});
const grouped = groupBySeverity([item('a', 'info'), item('b', 'blocker'), item('c', 'info')]);
assert.deepEqual(grouped.blocker.map((i) => i.id), ['b']);
assert.deepEqual(grouped.info.map((i) => i.id), ['a', 'c']);
assert.deepEqual(grouped.decision, []);

const view = (items: AttentionItem[], statuses: AttentionView['sources'][number]['status'][]): AttentionView => ({
  generatedAt: '',
  items,
  counts: { blocker: 0, decision: 0, info: 0, total: items.length },
  sources: statuses.map((status, i) => ({ key: `s${i}`, label: `s${i}`, status })),
  truncated: false,
});
assert.equal(calmState(view([], ['ok', 'not_configured'])), 'calm', 'не настроенный источник не мешает');
assert.equal(calmState(view([], ['ok', 'error'])), 'partial', 'упавший источник — не «спокойно»');
assert.equal(calmState(view([item('a', 'info')], ['ok'])), null);

// Оба успешных входа ведут на «Обзор», а не на /sessions.
const login = readFileSync(path.join(appDir, 'login', 'page.tsx'), 'utf8');
assert.equal((login.match(/router\.replace\('\/'\)/g) ?? []).length, 2, 'оба перехода login → /');
assert.ok(!login.includes("router.replace('/sessions')"));
assert.ok(!readFileSync(path.join(appDir, 'page.tsx'), 'utf8').includes('redirect('), 'root — не редирект');

console.log('nav.test.ts: ok');
