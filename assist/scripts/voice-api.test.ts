/**
 * Э5: кабинет голоса в TMA — повтор типов сервера (коды ошибок, причины
 * «выключено»), строгий разбор, клиент (пути, тело, base64 примера),
 * словари uk/ru/en для каждой причины и кода.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { ApiError, type ApiClient } from '../src/kit';
import {
  VOICE_CABINET_ERROR_CODES,
  VOICE_OFF_REASONS,
  createVoiceApi,
  parseVoiceSettings,
  usd,
  voiceErrorCode,
} from '../src/lib/voice-api';

const BACK = new URL(
  '../../sites-backend/src/modules/assist-site-voice/',
  import.meta.url
);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Коды и причины — те же, что у сервера.
{
  const types = read('api-types.ts');
  const m = /VOICE_CABINET_ERROR_CODES = \[([\s\S]*?)\] as const/.exec(types);
  assert.ok(m, 'нет VOICE_CABINET_ERROR_CODES на сервере');
  assert.deepEqual(
    [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]),
    [...VOICE_CABINET_ERROR_CODES]
  );
  const access = read('public/voice-access.ts');
  const r = /export type VoiceOffReason =([^;]+);/.exec(access);
  assert.ok(r, 'нет VoiceOffReason на сервере');
  assert.deepEqual(
    [...r![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort(),
    [...VOICE_OFF_REASONS].sort()
  );
}

// 2. Словари: каждая причина и код — на трёх языках.
for (const d of [appUk, appRu, appEn]) {
  const v = d.setup.persona.voice;
  for (const r of VOICE_OFF_REASONS)
    assert.ok(v.reasons[r], `нет причины ${r}`);
  for (const c of VOICE_CABINET_ERROR_CODES)
    assert.ok(v.errors[c], `нет кода ${c}`);
  assert.ok(/\{spent\}.*\{cap\}/.test(v.spent));
  assert.ok(/\{name\}/.test(v.defaultVoice));
}

// 3. Разбор строгий: мусорные голоса и причины — прочь.
{
  const v = parseVoiceSettings({
    siteId: 's1',
    config: { input: true, output: 'yes', voiceId: 'x"y' },
    available: true,
    reason: 'evil',
    voices: [{ id: 'Maya', gender: 'female' }, { id: '<b>' }, 'x'],
    defaultVoice: 'Maya',
    dailyCapMicroUsd: 1_500_000,
    todaySpentMicroUsd: -5,
  });
  assert.deepEqual(v.config, {
    schema: 1,
    input: true,
    output: false,
    voiceId: null,
  });
  assert.equal(v.reason, null);
  assert.deepEqual(
    v.voices.map((x) => x.id),
    ['Maya']
  );
  assert.equal(v.todaySpentMicroUsd, 0);
  assert.equal(usd(v.dailyCapMicroUsd), '1.50');
}

// 4. Клиент: пути, тело, пример — base64 → байты; не audio/* — ошибка.
async function main() {
  const calls: Array<[string, string, unknown]> = [];
  let reply: unknown = {};
  const client: ApiClient = {
    request: async <T>(method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return reply as T;
    },
  };
  const api = createVoiceApi(client);
  reply = {
    siteId: 's1',
    config: { input: false, output: true, voiceId: null },
  };
  await api.get('s1');
  await api.save('s1', {
    schema: 1,
    input: true,
    output: true,
    voiceId: 'Maya',
  });
  reply = {
    mime: 'audio/mpeg',
    dataBase64: btoa('ID3abc'),
  };
  const s = await api.sample('s1', 'Maya', 'ru');
  assert.equal(new TextDecoder().decode(s.bytes), 'ID3abc');
  assert.deepEqual(calls, [
    ['GET', '/assist/sites/s1/voice-config', undefined],
    [
      'PATCH',
      '/assist/sites/s1/voice-config',
      { config: { schema: 1, input: true, output: true, voiceId: 'Maya' } },
    ],
    [
      'POST',
      '/assist/sites/s1/voice-config/sample',
      { voiceId: 'Maya', lang: 'ru' },
    ],
  ]);
  reply = { mime: 'text/html', dataBase64: 'AAAA' };
  await assert.rejects(api.sample('s1', null, 'uk'));
  await assert.rejects(api.get('../x'));
  assert.equal(
    voiceErrorCode(new ApiError('VOICE_LIMIT', 'x', 429)),
    'VOICE_LIMIT'
  );
  assert.equal(voiceErrorCode(new ApiError('OTHER', 'x', 400)), null);
  console.log('voice-api: типы сервера, словари, разбор, клиент — ok');
}
void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
