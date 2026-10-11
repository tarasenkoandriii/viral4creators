import assert from 'node:assert/strict';
import {
  qaAccess,
  qaLabels,
  qaListInput,
  emptyQaCase,
} from '../src/lib/qa-editor';
import { parseRoute, routeHref } from '../src/lib/router';
const roles = { qa: 'none', assist: 'manager', assistAdmin: 'none' } as const;
assert.deepEqual(qaAccess({ role: 'manager', productRoles: roles }), {
  read: false,
  write: false,
});
assert.deepEqual(qaAccess({ role: 'owner', productRoles: roles }), {
  read: true,
  write: true,
});
assert.deepEqual(
  qaAccess({ role: 'operator', productRoles: { ...roles, qa: 'viewer' } }),
  { read: true, write: false }
);
assert.deepEqual(
  qaAccess({ role: 'operator', productRoles: { ...roles, qa: 'admin' } }),
  { read: true, write: true }
);
assert.equal(qaListInput('login, login'), null);
assert.equal(qaListInput('a'.repeat(65)), null);
assert.equal(
  qaListInput(Array.from({ length: 21 }, (_, i) => String(i)).join(',')),
  null
);
assert.deepEqual(qaListInput(' login , voice, '), ['login', 'voice']);
assert.deepEqual(qaListInput(''), []);
const a = emptyQaCase(),
  b = emptyQaCase();
a.steps[0].action = 'changed';
assert.equal(b.steps[0].action, '');
for (const locale of ['ru', 'uk', 'en'] as const)
  assert.ok(
    Object.values(qaLabels(locale)).every(
      (v) => typeof v === 'string' && v.length > 0
    )
  );
const route = { name: 'qa-cases', siteId: 'cm-test' } as const;
assert.deepEqual(parseRoute(routeHref(route)), route);
assert.equal(parseRoute('#/sites/../qa-cases').name, 'not-found');
console.log(
  'QA editor roles, limits, draft isolation, locale and route checks passed'
);
