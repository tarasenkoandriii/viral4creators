import assert from 'node:assert/strict';
import { parseStartParam } from '../src/kit/start-param';

assert.deepEqual(parseStartParam('inv_abc123'), {
  kind: 'inv',
  value: 'abc123',
});
assert.deepEqual(parseStartParam('sb_X-1'), { kind: 'sb', value: 'X-1' });
assert.deepEqual(parseStartParam('st_site1'), { kind: 'st', value: 'site1' });
assert.equal(parseStartParam('inv_'), null);
assert.equal(parseStartParam('inv_a.b'), null);
assert.equal(parseStartParam('ref_abc'), null);
assert.equal(parseStartParam('x'.repeat(65)), null);
assert.equal(parseStartParam(null), null);
assert.equal(parseStartParam(''), null);

console.log('start-param: ok');
