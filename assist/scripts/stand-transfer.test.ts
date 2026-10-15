import assert from 'node:assert/strict';
import { transferable, parseFormSnapshot } from '../src/lib/stand-transfer';
assert.equal(
  transferable({ name: 'Название', type: 'text' }, 'Prepared title'),
  true
);
for (const field of [
  { name: 'Client Secret', type: 'text' },
  { name: 'Ключ', type: 'text' },
  { name: 'name', type: 'text', generated: 'mock-key' },
  { name: 'state', type: 'select' },
])
  assert.equal(transferable(field, 'Prepared title'), false);
for (const value of [
  'MOCK_KEY_123',
  'MOCK icon',
  'https://example.invalid/cb',
  'Bearer abc',
  'sk-abc',
])
  assert.equal(transferable({ name: 'name', type: 'text' }, value), false);
assert.equal(
  transferable({ name: 'status', type: 'text' }, 'approved', 'status'),
  false
);
const good = {
  url: 'https://sandbox.viral4creators.app/',
  version: 'capture-v1',
  fields: [{ id: 'field_12345678', type: 'text', required: true }],
};
assert.equal(parseFormSnapshot(good).fields.length, 1);
for (const input of [
  { ...good, values: ['secret'] },
  { ...good, url: good.url + '?token=secret' },
  { ...good, fields: [{ ...good.fields[0], value: 'secret' }] },
  { ...good, fields: [good.fields[0], good.fields[0]] },
])
  assert.throws(() => parseFormSnapshot(input));
console.log(
  'Transfer export excludes credentials, generated/state fields and unknown snapshot values'
);

assert.equal(
  transferable(
    { name: 'Website', type: 'url' },
    'https://company.com/?token=secret'
  ),
  false
);

assert.equal(
  transferable({ name: 'API Key', type: 'text' }, 'user-selected-data'),
  false
);
