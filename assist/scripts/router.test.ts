import assert from 'node:assert/strict';
import { parseRoute, routeHref, type Route } from '../src/lib/router';

assert.deepEqual(parseRoute(''), { name: 'home' });
assert.deepEqual(parseRoute('#/'), { name: 'home' });
assert.deepEqual(parseRoute('#/sites'), { name: 'sites' });
assert.deepEqual(parseRoute('#/sites/'), { name: 'sites' });
assert.deepEqual(parseRoute('#/sites/new'), { name: 'site-new' });
assert.deepEqual(parseRoute('#/sites/ck1'), { name: 'site', siteId: 'ck1' });
assert.deepEqual(parseRoute('#/sites/ck1/hosts/h2'), {
  name: 'host',
  siteId: 'ck1',
  hostId: 'h2',
});
assert.deepEqual(parseRoute('#/knowledge'), {
  name: 'section',
  section: 'knowledge',
});
assert.deepEqual(parseRoute('#/widget'), {
  name: 'section',
  section: 'widget',
});
assert.deepEqual(parseRoute('#/dialogs'), {
  name: 'section',
  section: 'dialogs',
});
assert.deepEqual(parseRoute('#/members'), { name: 'members' });
assert.deepEqual(parseRoute('#/members/invite'), { name: 'invite' });
assert.deepEqual(parseRoute('#/sites/ck1/hosts/h2/access'), {
  name: 'host-access',
  siteId: 'ck1',
  hostId: 'h2',
});
assert.equal(parseRoute('#/sites/ck1/hosts/h2/other').name, 'not-found');
assert.equal(parseRoute('#/members/x').name, 'not-found');
assert.deepEqual(parseRoute('#/welcome'), { name: 'welcome' });
// Служебный hash Telegram, мусор и чужие сегменты — не наши пути.
assert.equal(
  parseRoute('#tgWebAppData=abc&tgWebAppVersion=7').name,
  'not-found'
);
assert.equal(parseRoute('#/sites/ck1/hosts').name, 'not-found');
assert.equal(parseRoute('#/sites/a%2Fb').name, 'not-found');
assert.equal(parseRoute('#/sites/ck1/extra').name, 'not-found');
assert.equal(parseRoute('#/knowledge/x').name, 'not-found');

const all: Route[] = [
  { name: 'home' },
  { name: 'welcome' },
  { name: 'sites' },
  { name: 'site-new' },
  { name: 'site', siteId: 's1' },
  { name: 'host', siteId: 's1', hostId: 'h1' },
  { name: 'host-access', siteId: 's1', hostId: 'h1' },
  { name: 'members' },
  { name: 'invite' },
  { name: 'section', section: 'knowledge' },
  { name: 'section', section: 'widget' },
  { name: 'section', section: 'dialogs' },
];
for (const r of all) assert.deepEqual(parseRoute(routeHref(r)), r);

console.log('router: ok');
