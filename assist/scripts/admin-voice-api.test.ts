/**
 * Э6-бис (б): вкладка «Голос» «Админки» — повтор типов сервера (коды
 * ошибок, редакция рисков, поля вида настроек), словари uk/ru/en (одни и
 * те же ключи), строгий разбор, клиент (пути, тело).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_VOICE_TEXTS } from '../src/i18n/admin-voice';
import type { ApiClient } from '../src/kit';
import {
  ADMIN_VC_ERROR_CODES,
  ADMIN_VC_RISKS_VERSION,
  createAdminVoiceApi,
  parseAdminVoiceSettings,
} from '../src/lib/admin-voice-api';
import { ADMIN_MODE_TABS } from '../src/lib/admin-mode-api';

const BACK = new URL(
  '../../sites-backend/src/modules/assist-admin-voice/',
  import.meta.url
);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Коды ошибок и редакция рисков — те же, что у сервера.
{
  const errs = read('admin-voice-errors.ts');
  const m = /export type AdminVoiceErrorCode =([^;]+);/.exec(errs);
  assert.ok(m, 'нет AdminVoiceErrorCode на сервере');
  assert.deepEqual(
    [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]),
    [...ADMIN_VC_ERROR_CODES]
  );
  const rules = read('admin-voice-rules.ts');
  assert.ok(
    rules.includes(`ADMIN_VC_RISKS_VERSION = '${ADMIN_VC_RISKS_VERSION}'`),
    'редакция рисков TMA ≠ сервера'
  );
  // Поля вида настроек — все, что отдаёт сервер (api-types.ts).
  const types = read('api-types.ts');
  const body = /export interface AdminVoiceSettingsView \{([\s\S]*?)\n\}/.exec(
    types
  );
  assert.ok(body);
  const keys = [...body![1].matchAll(/^\s{2}(\w+):/gm)].map((x) => x[1]);
  const parsed = parseAdminVoiceSettings({});
  for (const k of keys)
    assert.ok(k in parsed, `TMA не разбирает поле ${k} вида настроек`);
}

// 2. Словари: одни и те же ключи, риски — столько же пунктов.
{
  const shape = (o: unknown): unknown =>
    o && typeof o === 'object' && !Array.isArray(o)
      ? Object.fromEntries(
          Object.entries(o as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, shape(v)])
        )
      : Array.isArray(o)
        ? o.length
        : typeof o;
  assert.deepEqual(shape(ADMIN_VOICE_TEXTS.ru), shape(ADMIN_VOICE_TEXTS.uk));
  assert.deepEqual(shape(ADMIN_VOICE_TEXTS.en), shape(ADMIN_VOICE_TEXTS.uk));
  // Тексты ошибок — только для известных кодов сервера.
  for (const k of Object.keys(ADMIN_VOICE_TEXTS.uk.errors))
    assert.ok((ADMIN_VC_ERROR_CODES as readonly string[]).includes(k), k);
  assert.ok(ADMIN_MODE_TABS.includes('voice'));
}

// 3. Строгий разбор: мусор — умолчания, лишнее — мимо.
{
  const v = parseAdminVoiceSettings({
    state: 'evil',
    rules: { maxSteps: 99, denySelectors: ['.a', 5] },
    hosts: [{ id: 'h1', host: 'admin.shop.com', verified: true, test: 'yes' }],
    report: { id: 't1', result: 'maybe', attempts: -3, problem: 'x' },
    onProblem: 'failed',
    metrics: { plans: 3, done: 'many' },
    secret: 'S',
  });
  assert.equal(v.state, 'off');
  assert.equal(v.rules.maxSteps, 10);
  assert.deepEqual(v.rules.denySelectors, ['.a']);
  assert.equal(v.hosts[0].test, false);
  assert.equal(v.report?.result, null);
  assert.equal(v.report?.attempts, 0);
  assert.equal(v.report?.problem, null);
  assert.equal(v.onProblem, 'failed');
  assert.equal(v.metrics.plans, 3);
  assert.equal(v.metrics.done, 0);
  assert.equal(JSON.stringify(v).includes('"S"'), false);
}

// 4. Клиент: пути, тело, ссылка мастера — только https.
{
  const calls: Array<[string, string, unknown]> = [];
  const client: ApiClient = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      if (path.endsWith('/test-token'))
        return {
          testId: 't1',
          url: 'javascript:alert(1)',
          expiresAt: new Date().toISOString(),
          testHost: true,
        } as T;
      if (path.endsWith('/tests')) return [{ id: 't1' }] as T;
      return {} as T;
    },
  } as ApiClient;
  const api = createAdminVoiceApi(client);
  await api.get('s1');
  await api.patch('s1', {
    state: 'test',
    risksVersion: ADMIN_VC_RISKS_VERSION,
    siteName: 'Shop',
  });
  const tok = await api.testToken('s1', { hostId: 'h1', path: '/orders' });
  assert.equal(tok.url, '', 'не-https ссылка мастера отброшена');
  await api.tests('s1');
  await api.test('s1', 't1');
  assert.deepEqual(
    calls.map(([mth, p]) => `${mth} ${p}`),
    [
      'GET /assist/sites/s1/admin-mode/voice-control',
      'PATCH /assist/sites/s1/admin-mode/voice-control',
      'POST /assist/sites/s1/admin-mode/voice-control/test-token',
      'GET /assist/sites/s1/admin-mode/voice-control/tests',
      'GET /assist/sites/s1/admin-mode/voice-control/tests/t1',
    ]
  );
  assert.deepEqual(calls[1][2], {
    state: 'test',
    risksVersion: ADMIN_VC_RISKS_VERSION,
    siteName: 'Shop',
  });
  await assert.rejects(api.get('a/b'));
  await assert.rejects(api.test('s1', '../x'));
}

console.log('admin-voice-api: ok');
