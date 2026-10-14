import assert from 'node:assert/strict';
import { standOpenApi } from '../src/lib/qa-stand-openapi';
import type { Stand } from '../src/lib/qa-stands-api';
const stand: Stand = {
  id: 'stand',
  revision: 9,
  records: [{ id: 'secret-record', values: ['private@example.com'] }],
  contract: {
    version: 2,
    template: 'generated',
    title: 'Заказы',
    description: 'Учебный стенд',
    fields: ['Сумма'],
    entities: [
      {
        id: 'order',
        title: 'Заказ',
        fields: [
          { name: 'Сумма', type: 'number', required: true, options: [] },
        ],
      },
    ],
    screens: [],
  },
};
const spec = standOpenApi('site', stand);
const path = '/qa/sites/site/stands/stand/mock/records';
assert.ok(spec.paths[path].get);
assert.ok(spec.paths[path].post);
assert.ok(spec.paths[`${path}/{recordId}`].delete);
assert.equal(spec.openapi, '3.0.3');
assert.deepEqual(Object.keys(spec.paths[path]), ['get', 'post']);
assert.deepEqual(spec.paths[path].get!.parameters[0].schema, {
  type: 'string',
  enum: ['order'],
});
assert.equal(spec.paths[path].get!.parameters[0].required, true);
assert.ok(
  spec.paths[`${path}/{recordId}`].delete!.parameters.some(
    (p) => p.in === 'path' && p.required
  )
);
assert.equal(
  spec.paths[path].post!.requestBody.content['application/json'].schema
    .properties.values.items.type,
  'string'
);
assert.deepEqual(
  spec.paths[path].post!.requestBody.content['application/json'].schema
    .required,
  ['values', 'entityId']
);
assert.ok(!JSON.stringify(spec).includes('private@example.com'));
assert.ok(!JSON.stringify(spec).includes('secret-record'));
const template = standOpenApi('site', {
  ...stand,
  contract: {
    title: 'Форма',
    description: 'Простой стенд',
    template: 'records',
    version: 1,
    fields: ['Имя'],
  },
});
assert.ok(template.paths[path].get);
assert.ok(template.paths[path].post);
assert.equal(template.paths[path].get!.parameters[0].required, false);
assert.deepEqual(
  template.paths[path].post!.requestBody.content['application/json'].schema
    .required,
  ['values']
);
assert.equal(template['x-stand-fields'][0].fields[0].name, 'Имя');
console.log(
  'OpenAPI: transport, entity fields, template compatibility and data privacy passed'
);
