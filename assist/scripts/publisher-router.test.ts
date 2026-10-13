/**
 * AI Publisher (P-G1, §14.1, §14.3): разбор хеш-маршрутов раздела
 * `#/sites/:siteId/publisher[/<раздел>[/<id>]][?k=v]` и обратная сборка;
 * прежние маршруты не задеты; реестр — уникальные слаги, разделы P-G1 из
 * §14.1 на месте, группы известны.
 */
import assert from 'node:assert/strict';
import {
  parsePubQuery,
  parseRoute,
  routeHref,
  type Route,
} from '../src/lib/router';
import {
  HIDDEN_SECTIONS,
  NAV_GROUPS,
  PUBLISHER_HOME_CARDS,
  PUBLISHER_SECTIONS,
  findSection,
  sectionEnabled,
} from '../src/screens/publisher/registry';

const pub = (
  siteId: string,
  section: string | null,
  id: string | null,
  query?: Record<string, string>
): Route => ({
  name: 'publisher',
  siteId,
  section,
  id,
  ...(query ? { query } : {}),
});

assert.deepEqual(parseRoute('#/sites/s1/publisher'), pub('s1', null, null));
assert.deepEqual(parseRoute('#/sites/s1/publisher/'), pub('s1', null, null));
assert.deepEqual(
  parseRoute('#/sites/s1/publisher/sources'),
  pub('s1', 'sources', null)
);
assert.deepEqual(
  parseRoute('#/sites/s1/publisher/materials/c_1'),
  pub('s1', 'materials', 'c_1')
);
assert.deepEqual(
  parseRoute('#/sites/s1/publisher/materials?status=approved&owner=m1'),
  pub('s1', 'materials', null, { status: 'approved', owner: 'm1' })
);
assert.deepEqual(
  parseRoute('#/sites/s1/publisher/audit?objectType=content&objectId=c1'),
  pub('s1', 'audit', null, { objectType: 'content', objectId: 'c1' })
);
// Раздел P-G2 разбирается тем же правилом (реестр, а не router.ts).
assert.deepEqual(
  parseRoute('#/sites/s1/publisher/leads/l1'),
  pub('s1', 'leads', 'l1')
);
// Мусор — «не найдено», а не чужой раздел.
assert.equal(parseRoute('#/sites/s1/publisher/Sources').name, 'not-found');
assert.equal(parseRoute('#/sites/s1/publisher/sources/../x').name, 'not-found');
assert.equal(parseRoute('#/sites/s1/publisher/a/b/c').name, 'not-found');
assert.equal(parseRoute('#/sites/s%201/publisher').name, 'not-found');
// Опасные значения фильтров отбрасываются, прочие остаются.
assert.deepEqual(parsePubQuery('status=ok&x=<script>&&owner=m1&bad%=1'), {
  status: 'ok',
  owner: 'm1',
});
assert.deepEqual(parsePubQuery(''), {});
// Обратная сборка и круг «href → parse».
for (const r of [
  pub('s1', null, null),
  pub('s1', 'launch', null),
  pub('s1', 'briefs', 'b1'),
  pub('s1', 'materials', null, { owner: 'm1', status: 'approved' }),
]) {
  assert.deepEqual(parseRoute(routeHref(r)), r, routeHref(r));
}
assert.equal(
  routeHref(pub('s1', 'materials', null, { status: 'a', owner: 'm' })),
  '#/sites/s1/publisher/materials?owner=m&status=a'
);
// id без раздела не печатается.
assert.equal(routeHref(pub('s1', null, 'x')), '#/sites/s1/publisher');
// Прежние маршруты не задеты (в т.ч. `?` у не-Publisher — «не найдено»).
assert.deepEqual(parseRoute('#/sites/s1/qa-runs'), {
  name: 'qa-runs',
  siteId: 's1',
});
assert.deepEqual(parseRoute('#/sites/s1'), { name: 'site', siteId: 's1' });
assert.equal(parseRoute('#/sites/s1?x=1').name, 'not-found');
assert.deepEqual(parseRoute('#/sites/s1/admin-mode/roles'), {
  name: 'admin-mode',
  siteId: 's1',
  tab: 'settings',
  focus: 'roles',
});

// ═══ Реестр ═══════════════════════════════════════════════════════════════
const keys = PUBLISHER_SECTIONS.map((s) => s.key);
assert.equal(new Set(keys).size, keys.length, 'дубль раздела в реестре');
for (const s of PUBLISHER_SECTIONS) {
  assert.ok(/^[a-z][a-z0-9-]{0,31}$/.test(s.key), s.key);
  assert.ok(NAV_GROUPS.includes(s.group), `${s.key}: группа ${s.group}`);
  for (const l of ['uk', 'ru', 'en'] as const) {
    assert.ok(s.label(l).trim(), `${s.key}: пустая подпись ${l}`);
  }
  assert.ok(typeof s.Screen === 'function', `${s.key}: нет экрана`);
  // Слаг разбирается роутером.
  const r = parseRoute(`#/sites/s1/publisher/${s.key}`);
  assert.equal(r.name, 'publisher', s.key);
}
// Разделы P-G1 §14.1 (оболочка, обзор — без сегмента).
for (const k of [
  'launch',
  'sources',
  'questions',
  'brand',
  'plan',
  'briefs',
  'materials',
  'qa',
  'calendar',
  'ai',
  'roles',
  'audit',
]) {
  const s = findSection(k);
  assert.ok(s && s.owner === 'P-G1', `нет раздела P-G1 ${k}`);
}
assert.ok(HIDDEN_SECTIONS.has('briefs'));
// P-R: раздел «Reddit» — за флагом `features.reddit` и `reddit.read`
// (AT-RD-17: флаг выключен — вкладки нет, прямая ссылка — «не найден»).
{
  const rd = findSection('reddit');
  assert.ok(rd && rd.owner === 'P-R' && rd.group === 'content');
  assert.deepEqual(rd!.actions, ['reddit.read']);
  assert.equal(rd!.feature, 'reddit');
  assert.equal(sectionEnabled(rd!, { reddit: false }), false);
  assert.equal(sectionEnabled(rd!, { reddit: true }), true);
  // Разделы P0 от флага не зависят.
  for (const s of PUBLISHER_SECTIONS.filter((x) => x.key !== 'reddit'))
    assert.equal(sectionEnabled(s, { reddit: false }), true, s.key);
  for (const sec of ['reddit/ro1', 'reddit?tab=rules&projectId=rp1'])
    assert.equal(parseRoute(`#/sites/s1/publisher/${sec}`).name, 'publisher');
}
assert.equal(findSection('teleport'), null);
assert.equal(findSection(null), null);
const cardKeys = PUBLISHER_HOME_CARDS.map((c) => c.key);
assert.equal(new Set(cardKeys).size, cardKeys.length, 'дубль карточки обзора');

console.log('publisher-router: ok');
