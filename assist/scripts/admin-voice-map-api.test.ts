/**
 * Заход 11 (№117): голосовая карта «Админки» в TMA — коды ошибок те же, что
 * у сервера (`assist-admin-voice-map/api-types.ts`); словари uk/ru/en
 * покрывают коды, ворота, статусы, роли и совпадают по ключам; разбор
 * строгий; клиент ходит ровно по маршрутам контроллера «Админки» (не по
 * маршрутам карты «Сайта») и не пропускает чужие идентификаторы в путь;
 * ссылка редактора — только https; операции цели из TMA — форма сервера.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADMIN_VOICE_MAP_TEXTS } from '../src/i18n/admin-voice-map';
import type { ApiClient } from '../src/kit';
import {
  ADMIN_VOICE_MAP_ERROR_CODES,
  MAP_LANGS,
  MAP_TARGET_ROLES,
  createAdminVoiceMapApi,
  namesOp,
  parseAdminSummary,
  parseDraft,
  parseTarget,
  targetOp,
} from '../src/lib/admin-voice-map-api';
import { MAP_GATE_CODES, MAP_VERSION_STATUSES } from '../src/lib/voice-map-api';

const BACK = new URL('../../sites-backend/src/modules/', import.meta.url);
const read = (f: string) => readFileSync(new URL(f, BACK), 'utf8');

// 1. Коды ошибок — повтор сервера.
{
  const src = read('assist-admin-voice-map/api-types.ts');
  const m = /export type AdminVoiceMapErrorCode =([^;]+);/.exec(src);
  assert.ok(m, 'нет AdminVoiceMapErrorCode на сервере');
  const server = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
  assert.deepEqual(server.sort(), [...ADMIN_VOICE_MAP_ERROR_CODES].sort());
}

// 2. Словари: всё покрыто, ключи трёх языков равны.
const keys = (o: unknown, p = ''): string[] =>
  o && typeof o === 'object'
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
        keys(v, `${p}${k}.`)
      )
    : [p];
for (const l of ['uk', 'ru', 'en'] as const) {
  const t = ADMIN_VOICE_MAP_TEXTS[l];
  for (const c of ADMIN_VOICE_MAP_ERROR_CODES)
    assert.ok(t.errors[c], `${l}: нет ошибки ${c}`);
  for (const c of MAP_GATE_CODES) assert.ok(t.gates[c], `${l}: нет ворот ${c}`);
  for (const s of MAP_VERSION_STATUSES)
    assert.ok(t.status[s], `${l}: нет статуса ${s}`);
  for (const r of MAP_TARGET_ROLES)
    assert.ok(t.roles[r], `${l}: нет роли ${r}`);
  for (const x of MAP_LANGS) assert.ok(t.langs[x]);
  for (const [k, v] of Object.entries(t))
    if (typeof v === 'string') assert.ok(v.trim(), `${l}: пусто ${k}`);
}
assert.deepEqual(
  keys(ADMIN_VOICE_MAP_TEXTS.ru).sort(),
  keys(ADMIN_VOICE_MAP_TEXTS.uk).sort()
);
assert.deepEqual(
  keys(ADMIN_VOICE_MAP_TEXTS.en).sort(),
  keys(ADMIN_VOICE_MAP_TEXTS.uk).sort()
);
// Тексты «Админки» не обещают ничего про карту «Сайта» кроме изоляции.
assert.ok(/ніколи не діють/.test(ADMIN_VOICE_MAP_TEXTS.uk.intro));

// 3. Разбор строгий.
{
  assert.equal(parseTarget({ key: 'Bad Key', descriptor: {} }), null);
  const t = parseTarget({
    key: 'orders',
    scope: 'weird',
    descriptor: { text: 'Замовлення', role: 'link' },
    names: { uk: 'Замовлення', xx: 'nope' },
    synonyms: { uk: [{ text: 'список' }, { text: 7 }, 'raw'], ru: 'x' },
    riskComputed: 'now',
    riskOwner: 'confirm',
    denylisted: 'yes',
  });
  assert.ok(t);
  assert.equal(t!.scope, 'page');
  assert.deepEqual(t!.names, { uk: 'Замовлення', ru: '', en: '' });
  assert.deepEqual(t!.synonyms, { uk: ['список'], ru: [], en: [] });
  assert.equal(t!.risk, 'confirm');
  assert.equal(t!.denylisted, false);
  const unknownRisk = parseTarget({
    key: 'x1',
    descriptor: {},
    riskComputed: 'hack',
  });
  assert.equal(unknownRisk!.risk, 'confirm');
  const d = parseDraft({
    revision: 3,
    publishedVersion: 'x',
    content: {
      targets: [{ key: 'ok', descriptor: { text: 'a' } }, { key: '!' }],
      templates: [
        { id: 't-1', name: 'Картка', pathPattern: '/admin/orders/*' },
        { id: 2 },
      ],
    },
    gates: { ok: true },
  });
  assert.equal(d.revision, 3);
  assert.equal(d.publishedVersion, 0);
  assert.deepEqual(
    d.targets.map((x) => x.key),
    ['ok']
  );
  assert.deepEqual(
    d.templates.map((x) => x.id),
    ['t-1']
  );
  assert.equal(d.gates.ok, true);
  const s = parseAdminSummary({
    planAllows: 'true',
    hosts: ['admin.shop.example', 42],
    versions: [{ number: 2, status: 'published' }, { number: 'x' }],
  });
  assert.equal(s.planAllows, false);
  assert.deepEqual(s.hosts, ['admin.shop.example']);
  assert.deepEqual(
    s.versions.map((v) => v.number),
    [2]
  );
}

// 4. Операции цели из TMA — форма сервера (дескриптор: тег по роли).
{
  const op = targetOp({
    key: 'orders',
    text: ' Замовлення ',
    role: 'link',
    scope: 'page',
    pagePath: '/admin',
    names: { uk: 'Замовлення', ru: ' ' },
    synonyms: { uk: ['список замовлень', ' '], en: [] },
  }) as { op: string; target: Record<string, unknown> };
  assert.equal(op.op, 'upsert-target');
  assert.deepEqual(op.target.descriptor, {
    tag: 'a',
    role: 'link',
    text: 'Замовлення',
    unique: true,
  });
  assert.equal(op.target.pagePath, '/admin');
  assert.deepEqual(op.target.names, { uk: 'Замовлення' });
  assert.deepEqual(op.target.synonyms, {
    uk: [{ text: 'список замовлень' }],
    ru: [],
    en: [],
  });
  const deny = targetOp({
    key: 'refund',
    text: 'Повернення',
    role: 'button',
    assistId: 'refund',
    scope: 'template',
    templateId: 't-1',
    names: {},
    synonyms: {},
    denylisted: true,
  }) as { target: Record<string, unknown> };
  assert.equal(deny.target.denylisted, true);
  assert.equal(deny.target.templateId, 't-1');
  assert.deepEqual(deny.target.names, {});
  assert.equal(
    (deny.target.descriptor as Record<string, unknown>).assistId,
    'refund'
  );
  const tb = targetOp({
    key: 'track',
    text: 'Трек',
    role: 'textbox',
    scope: 'site',
    names: {},
    synonyms: {},
  }) as { target: { descriptor: { tag: string } } };
  assert.equal(tb.target.descriptor.tag, 'input');
  const ren = namesOp(
    'orders',
    { uk: 'Замовлення ', ru: '', en: 'Orders' },
    { uk: ['усі замовлення'], ru: [], en: [] }
  ) as { target: Record<string, unknown> };
  // Правка имён — без дескриптора (сервер оставит прежний).
  assert.equal('descriptor' in ren.target, false);
  assert.deepEqual(ren.target.names, { uk: 'Замовлення', en: 'Orders' });
}

// 5. Клиент: маршруты контроллера «Админки», чужой id — не в путь, https.
await (async () => {
  const calls: Array<[string, string, unknown]> = [];
  let reply: unknown = {};
  const client = {
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return reply;
    },
  } as unknown as ApiClient;
  const api = createAdminVoiceMapApi(client);
  const id = 'site_1';
  await api.summary(id);
  await api.draft(id);
  reply = { revision: 4 };
  assert.equal(await api.patch(id, 3, [{ op: 'remove-target', key: 'x' }]), 4);
  reply = { url: 'https://admin.shop.example/?v4c_edit=t', expiresAt: 'x' };
  await api.editorLink(id, {});
  reply = { url: 'javascript:alert(1)' };
  await assert.rejects(api.editorLink(id, {}));
  reply = { revoked: 2 };
  assert.equal(await api.revokeSessions(id), 2);
  reply = {};
  await api.build(id);
  await api.version(id, 2);
  await api.publish(id, 2);
  await api.discard(id, 2);
  await api.rollback(id, 2);
  await api.exportFile(id);
  reply = { accepted: 1, rejected: [{}, {}], signed: true };
  assert.deepEqual(await api.importFile(id, 1, { kind: 'admin' }), {
    accepted: 1,
    rejected: 2,
    signed: true,
  });
  await assert.rejects(api.summary('../x'));
  await assert.rejects(api.version(id, 0));
  const P = `/assist/sites/${id}/admin-mode/voice-map`;
  assert.deepEqual(
    calls.map(([m, p]) => `${m} ${p}`),
    [
      `GET ${P}`,
      `GET ${P}/draft`,
      `PATCH ${P}/draft`,
      `POST ${P}/editor-link`,
      `POST ${P}/editor-link`,
      `DELETE ${P}/editor-sessions`,
      `POST ${P}/versions`,
      `GET ${P}/versions/2`,
      `POST ${P}/versions/2/publish`,
      `POST ${P}/versions/2/discard`,
      `POST ${P}/versions/2/rollback`,
      `GET ${P}/export`,
      `POST ${P}/import`,
    ]
  );
  // Ни одного запроса в карту «Сайта».
  assert.ok(calls.every(([, p]) => !p.includes('/voice-map/site')));
  // Каждый путь клиента объявлен в контроллере «Админки».
  const ctrl = read('assist-admin-voice-map/admin-voice-map.controller.ts');
  const routes = [
    ...ctrl.matchAll(/@(Get|Post|Patch|Delete)\('([^']+)'\)/g),
  ].map((x) => `${x[1].toUpperCase()} ${x[2]}`);
  for (const [m, p] of calls) {
    const rel = p
      .replace(`/assist/sites/${id}/`, ':id/')
      .replace(/\/versions\/2/, '/versions/:n');
    assert.ok(routes.includes(`${m} ${rel}`), `нет маршрута ${m} ${rel}`);
  }
})();

console.log('ok admin-voice-map-api');
