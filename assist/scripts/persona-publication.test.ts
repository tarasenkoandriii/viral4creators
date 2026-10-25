import assert from 'node:assert/strict';
import { ApiError, type ApiClient } from '../src/kit';
import { createPersonaApi } from '../src/lib/persona-api';
import { setupErrorText } from '../src/lib/setup-errors';
import { appRu } from '../src/i18n/ru';
import { ru } from '../src/kit/dictionaries/ru';
const calls: string[] = [];
const failure = new ApiError('PERSONA_GATE_FAILED', 'blocked', 409, 'request', {
  reason: 'Инвариант oos-capital-en: нет честного отказа',
});
const regular: ApiClient = {
  async request<T>(method: string, path: string) {
    calls.push(`regular:${method}:${path}`);
    return {} as T;
  },
};
const publication: ApiClient = {
  async request<T>(method: string, path: string): Promise<T> {
    calls.push(`publication:${method}:${path}`);
    throw failure;
  },
};
const api = createPersonaApi(regular, publication);
await api.get('site1');
let caught: unknown;
try {
  await api.publish('site1');
} catch (error) {
  caught = error;
}
assert.equal(caught, failure);
assert.deepEqual(calls, [
  'regular:GET:/assist/sites/site1/persona',
  'publication:POST:/assist/sites/site1/persona/publish',
]);
assert.ok(setupErrorText(failure, appRu, ru).includes('oos-capital-en'));
assert.equal(
  setupErrorText(
    new ApiError('PERSONA_GATE_FAILED', 'blocked', 409, undefined, {
      reason: { secret: 'not text' },
    }),
    appRu,
    ru
  ),
  appRu.setup.errors.PERSONA_GATE_FAILED
);
console.log(
  'Persona publication uses its explicit client once, preserves gate failure details and never retries'
);
