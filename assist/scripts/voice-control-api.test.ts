/**
 * Э6-бис (а): кабинет голосового управления в TMA — повтор типов сервера
 * (коды ошибок, причины «выключено», состояния, версия текста рисков),
 * словари uk/ru/en, строгий разбор, клиент (пути, тело, risksVersion).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { ApiError, type ApiClient } from '../src/kit';
import {
  VOICE_CONTROL_CABINET_ERROR_CODES,
  VOICE_CONTROL_OFF_REASONS,
  VOICE_CONTROL_STATES,
  createVoiceControlApi,
  defaultRules,
  lines,
  parseVoiceControlSettings,
  voiceControlErrorCode,
} from '../src/lib/voice-control-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');
const quoted = (src: string, re: RegExp) => {
  const m = re.exec(src);
  assert.ok(m, `нет ${re} на сервере`);
  return [...m![1].matchAll(/'([A-Za-z_-]+)'/g)].map((x) => x[1]);
};

// 1. Коды, причины, состояния — те же, что у сервера; версия рисков — есть.
{
  const types = read('assist-site-voice-control/api-types.ts');
  assert.deepEqual(
    quoted(
      types,
      /VOICE_CONTROL_CABINET_ERROR_CODES = \[([\s\S]*?)\] as const/
    ),
    [...VOICE_CONTROL_CABINET_ERROR_CODES]
  );
  assert.ok(/VOICE_CONTROL_RISKS_VERSION = '[a-z0-9-]+'/.test(types));
  const cfg = read('assist-site-voice-control/voice-control-config.ts');
  assert.deepEqual(
    quoted(cfg, /export type VoiceControlOffReason =([^;]+);/).sort(),
    [...VOICE_CONTROL_OFF_REASONS].sort()
  );
  const core = read('assist-ui-core/types.ts');
  assert.deepEqual(
    quoted(core, /VOICE_CONTROL_STATES = \[([\s\S]*?)\] as const/),
    [...VOICE_CONTROL_STATES]
  );
  const rules = read('assist-ui-core/rules.ts');
  assert.ok(/siteDefaultSteps: 6/.test(rules));
  assert.ok(/maxStepsCap: 15/.test(rules));
}

// 2. Словари: каждая причина и код — на трёх языках; рисков ≥ 5, одинаково.
for (const d of [appUk, appRu, appEn]) {
  const v = d.voiceControl;
  for (const r of VOICE_CONTROL_OFF_REASONS)
    assert.ok(v.reasons[r], `нет причины ${r}`);
  for (const c of VOICE_CONTROL_CABINET_ERROR_CODES)
    assert.ok(v.errors[c], `нет кода ${c}`);
  assert.ok(v.risks.items.length >= 5);
  assert.equal(v.risks.items.length, appRu.voiceControl.risks.items.length);
}

// 3. Разбор строгий: мусор — умолчания.
{
  const v = parseVoiceControlSettings({
    siteId: 's1',
    state: 'evil',
    rules: {
      denySelectors: ['.a', 5, 'x'.repeat(300)],
      maxSteps: 99,
      confirmFill: 'yes',
    },
    available: 'true',
    reason: 'nope',
    risksVersion: '<b>',
  });
  assert.equal(v.state, 'off');
  assert.deepEqual(v.rules.denySelectors, ['.a']);
  assert.equal(v.rules.maxSteps, 6);
  assert.equal(v.rules.confirmFill, false);
  assert.equal(v.available, false);
  assert.equal(v.reason, null);
  assert.equal(v.risksVersion, '');
  assert.deepEqual(lines(' /a* \n\n /b '), ['/a*', '/b']);
}

// 4. Клиент: пути и тело (risksVersion — только при включении).
async function main() {
  const calls: Array<[string, string, unknown]> = [];
  const client: ApiClient = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return {
        siteId: 's1',
        state: 'on',
        rules: {},
        available: true,
        risksVersion: 'site-risks-1',
      } as T;
    },
  };
  const api = createVoiceControlApi(client);
  await api.get('s1');
  await api.save('s1', {
    state: 'on',
    rules: defaultRules(),
    risksVersion: 'site-risks-1',
  });
  assert.deepEqual(calls[0], [
    'GET',
    '/assist/sites/s1/voice-control/site',
    undefined,
  ]);
  assert.deepEqual(calls[1][2], {
    state: 'on',
    rules: defaultRules(),
    risksVersion: 'site-risks-1',
  });
  await assert.rejects(api.get('../x'));
  assert.equal(
    voiceControlErrorCode(
      new ApiError('VOICE_CONTROL_RISKS_REQUIRED', 'x', 400)
    ),
    'VOICE_CONTROL_RISKS_REQUIRED'
  );
  assert.equal(voiceControlErrorCode(new ApiError('OTHER', 'x', 400)), null);
  console.log('voice-control-api: типы сервера, словари, разбор, клиент — ok');
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
