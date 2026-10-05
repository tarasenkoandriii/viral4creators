/**
 * Э6-тер: голосовая карта в TMA — коды ворот, статусы версий и коды ошибок
 * кабинета те же, что у сервера; словари uk/ru/en покрывают их и совпадают
 * по ключам; разбор строгий; клиент ходит по маршрутам контроллера и не
 * пропускает чужие идентификаторы в путь; ссылка редактора — только https.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import type { ApiClient } from '../src/kit';
import {
  MAP_GATE_CODES,
  MAP_VERSION_STATUSES,
  VOICE_MAP_ERROR_CODES,
  createVoiceMapApi,
  parseSummary,
  parseVersionDetail,
  parseVersionSummary,
} from '../src/lib/voice-map-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');
const quoted = (src: string, re: RegExp) => {
  const m = re.exec(src);
  assert.ok(m, `нет ${re} на сервере`);
  return [...m![1].matchAll(/'([A-Za-z_-]+)'/g)].map((x) => x[1]);
};

// 1. Повтор типов сервера.
{
  const core = read('assist-ui-core/voice-map.ts');
  assert.deepEqual(
    quoted(core, /export type MapGateCode =([^;]+);/).sort(),
    [...MAP_GATE_CODES].sort()
  );
  assert.deepEqual(
    quoted(core, /MAP_VERSION_STATUSES = \[([\s\S]*?)\] as const/),
    [...MAP_VERSION_STATUSES]
  );
  const api = read('assist-site-voice-map/api-types.ts');
  const server = quoted(api, /export type VoiceMapErrorCode =([^;]+);/).filter(
    (c) => c.startsWith('VOICE_MAP_')
  );
  assert.deepEqual(server.sort(), [...VOICE_MAP_ERROR_CODES].sort());
}

// 2. Словари: каждый код ворот, статус и ошибка — на трёх языках; ключи равны.
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        keys(v, `${p}${k}.`)
      )
    : [p];
for (const d of [appUk, appRu, appEn]) {
  const m = d.voiceControl.voiceMap;
  for (const c of MAP_GATE_CODES) assert.ok(m.gates[c], `нет ворот ${c}`);
  for (const s of MAP_VERSION_STATUSES)
    assert.ok(m.status[s], `нет статуса ${s}`);
  for (const e of VOICE_MAP_ERROR_CODES)
    assert.ok(m.errors[e], `нет ошибки ${e}`);
}
assert.deepEqual(
  keys(appUk.voiceControl.voiceMap).sort(),
  keys(appRu.voiceControl.voiceMap).sort()
);
assert.deepEqual(
  keys(appEn.voiceControl.voiceMap).sort(),
  keys(appRu.voiceControl.voiceMap).sort()
);

// 3. Разбор строгий.
{
  assert.equal(parseVersionSummary({ number: 'x', status: 'published' }), null);
  const v = parseVersionSummary({
    number: 3,
    status: 'evil',
    requestedVia: 'x',
  });
  assert.equal(v?.status, 'held');
  assert.equal(v?.requestedVia, 'tma');
  const s = parseSummary({
    publishedVersion: 2,
    versions: [{ number: 2, status: 'published' }, null, { number: 0 }],
    draftGates: { ok: false, problems: [{ code: 'nope', key: 'a' }] },
    hosts: ['shop.ua', 5],
  });
  assert.equal(s.versions.length, 1);
  assert.equal(s.draftGates.problems[0].code, 'text');
  assert.deepEqual(s.hosts, ['shop.ua']);
  const d = parseVersionDetail({
    number: 1,
    status: 'checking',
    content: {
      targets: [
        {
          key: 'pay',
          names: {},
          descriptor: { text: 'Оплатити' },
          riskComputed: 'never',
          riskOwner: 'now',
          denylisted: true,
        },
      ],
    },
  });
  // Риск в списке — итоговый (владелец не понижает).
  assert.equal(d?.targets[0].risk, 'never');
}

// 4. Клиент: пути контроллера; чужой id в путь не попадает; ссылка — только https.
{
  const calls: Array<[string, string, unknown]> = [];
  let reply: unknown = {};
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return reply;
    },
  } as unknown as ApiClient;
  const api = createVoiceMapApi(client);
  await api.summary('site1');
  reply = {
    url: 'https://shop.ua/?v4c_edit=t',
    expiresAt: '2026-10-05T10:00:00Z',
  };
  await api.editorLink('site1', { path: '/p' });
  await api.publish('site1', 3);
  await api.rollback('site1', 2);
  await api.revokeSessions('site1');
  assert.deepEqual(
    calls.map(([m, p]) => `${m} ${p}`),
    [
      'GET /assist/sites/site1/voice-map/site',
      'POST /assist/sites/site1/voice-map/site/editor-link',
      'POST /assist/sites/site1/voice-map/site/versions/3/publish',
      'POST /assist/sites/site1/voice-map/site/versions/2/rollback',
      'DELETE /assist/sites/site1/voice-map/site/editor-sessions',
    ]
  );
  await assert.rejects(api.summary('../x'));
  await assert.rejects(api.publish('site1', 0));
  reply = { url: 'javascript:alert(1)' };
  await assert.rejects(api.editorLink('site1', {}));
}

console.log('voice-map-api: типы = сервер, словари, разбор, клиент');
