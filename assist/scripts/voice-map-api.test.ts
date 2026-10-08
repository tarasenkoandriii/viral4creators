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
  parseMisses,
  parseSnapshotView,
  parseSummary,
  parseVersionDetail,
  parseVersionSummary,
  parseWorkerCheck,
  snapshotDescriptor,
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

// 5. Заход 9: «Снимок» (№108), сверка воркером (№115), отчёт (№116), промахи (№119).
{
  // Разбор «Снимка»: рамки — только с размером; скриншот — только https.
  const sv = parseSnapshotView({
    id: 'j1',
    status: 'done',
    viewport: { width: 390, height: 844 },
    elements: [
      {
        ref: 'e1',
        role: 'button',
        tag: 'button',
        text: 'В кошик',
        assistId: 'add-to-cart',
        box: { x: 10, y: 20, w: 100, h: 40 },
      },
      {
        ref: 'e2',
        role: 'link',
        tag: 'a',
        text: 'Кошик',
        href: 'https://shop.ua/cart',
        box: { x: 0, y: 0, w: 0, h: 10 },
      },
      {
        ref: 'e3',
        role: 'button',
        tag: 'button',
        text: 'x',
        assistId: '"><img>',
      },
    ],
    screenshot: { url: 'javascript:alert(1)' },
  });
  assert.equal(sv.screenshot, null, 'не https — без скриншота');
  assert.deepEqual(sv.elements[0].box, { x: 10, y: 20, w: 100, h: 40 });
  assert.equal(sv.elements[1].box, null);
  assert.equal(sv.elements[2].assistId, null);
  assert.equal(
    parseSnapshotView({
      screenshot: { url: 'https://blob.x/a.png', width: 390 },
    }).screenshot?.url,
    'https://blob.x/a.png'
  );
  // Дескриптор из элемента: путь ссылки, чужой хост — offHost; значений нет.
  assert.deepEqual(snapshotDescriptor(sv.elements[1], 'shop.ua'), {
    tag: 'a',
    role: 'link',
    text: 'Кошик',
    assistId: null,
    hrefPath: '/cart',
    hrefHost: 'shop.ua',
    offHost: false,
    unique: true,
  });
  assert.equal(
    snapshotDescriptor(
      { ...sv.elements[1], href: 'https://evil.io/x' },
      'shop.ua'
    ).offHost,
    true
  );
  assert.equal(
    snapshotDescriptor({ ...sv.elements[0], tag: 'div' }, null).tag,
    'other'
  );

  // Итог сверки: проблемы прогона (только сбои), смешанные шаблоны.
  const ck = parseWorkerCheck({
    status: 'done',
    report: {
      lost: 1,
      fragile: 2,
      pages: [{ ok: true }, { ok: false }],
      dryRun: {
        ok: 3,
        failed: 1,
        skipped: 1,
        forbiddenBlocked: true,
        commands: [
          { key: 'a', text: 'А', outcome: 'ok_map', path: '/' },
          { key: 'b', text: 'Б', outcome: 'wrong', path: '/p' },
        ],
      },
      templates: [
        {
          pathPattern: '/p/*',
          mixed: true,
          pages: [
            { path: '/p/1', same: true },
            { path: '/p/x', same: false },
          ],
        },
        { pathPattern: '/c/*', mixed: false, pages: [] },
      ],
    },
  });
  assert.equal(ck.report?.pagesFailed, 1);
  assert.deepEqual(ck.report?.dryRun?.problems, [
    { key: 'b', text: 'Б', outcome: 'wrong', path: '/p' },
  ]);
  assert.deepEqual(ck.report?.mixed, [
    { pathPattern: '/p/*', paths: ['/p/x'] },
  ]);
  assert.equal(parseWorkerCheck({ status: 'queued' }).report, null);

  // Промахи: ключи и пути — строго.
  const ms = parseMisses({
    days: 7,
    items: [
      {
        key: 'delivery',
        page: '/delivery',
        self: 2,
        notFound: 1,
        wrong: 0,
        done: 5,
      },
      { key: 'BAD KEY', page: '/x' },
      { key: 'ok-key', page: 'javascript:alert(1)' },
    ],
    pages: [
      { page: '/cart', misses: 3 },
      { page: 'x', misses: 1 },
    ],
  });
  assert.deepEqual(
    ms.items.map((x) => [x.key, x.page]),
    [
      ['delivery', '/delivery'],
      ['ok-key', null],
    ]
  );
  assert.deepEqual(ms.pages, [{ page: '/cart', misses: 3 }]);
  assert.equal(
    parseMisses({ items: [{ key: 'a-b', missed: 4 }] }).items[0].missed,
    4,
    'промах карты по цели'
  );

  // Клиент: пути маршрутов; путь отчёта — только этого сайта.
  const calls: Array<[string, string, unknown]> = [];
  let reply: unknown = {};
  const api = createVoiceMapApi({
    request: async (method: string, path: string, body?: unknown) => {
      calls.push([method, path, body]);
      return reply;
    },
  } as unknown as ApiClient);
  reply = { snapshotId: 'job1', status: 'queued' };
  assert.equal(await api.snapshot('s1', 'https://shop.ua/', 'mobile'), 'job1');
  reply = {};
  await api.snapshotView('s1', 'job1');
  await api.workerCheck('s1', 2);
  await api.workerCheckView('s1', 2);
  reply = { revision: 4 };
  assert.equal(await api.draftRevision('s1'), 4);
  reply = { revision: 5 };
  assert.equal(
    await api.patch('s1', 4, [{ op: 'remove-target', key: 'x' }]),
    5
  );
  reply = {
    path: '/assist/sites/s1/voice-map/site/dev-report/TOKEN_abcdefghijklmnopqrst',
    expiresAt: '2026-10-16T10:00:00Z',
    counts: { targets: 3, missing: 2 },
  };
  assert.deepEqual(await api.devReport('s1'), {
    path: '/assist/sites/s1/voice-map/site/dev-report/TOKEN_abcdefghijklmnopqrst',
    expiresAt: '2026-10-16T10:00:00Z',
    targets: 3,
    missing: 2,
  });
  reply = { revoked: 1 };
  assert.equal(await api.revokeDevReport('s1'), 1);
  reply = {
    active: { expiresAt: '2026-10-16T10:00:00Z', views: 3, lastViewedAt: null },
  };
  assert.deepEqual(await api.devReportStatus('s1'), {
    expiresAt: '2026-10-16T10:00:00Z',
    views: 3,
    lastViewedAt: null,
  });
  reply = { active: null };
  assert.equal(await api.devReportStatus('s1'), null);
  reply = { items: [], pages: [] };
  await api.misses('s1');
  assert.deepEqual(
    calls.map(([m, p]) => `${m} ${p}`),
    [
      'POST /assist/sites/s1/voice-map/site/snapshots',
      'GET /assist/sites/s1/voice-map/site/snapshots/job1',
      'POST /assist/sites/s1/voice-map/site/versions/2/worker-check',
      'GET /assist/sites/s1/voice-map/site/versions/2/worker-check',
      'GET /assist/sites/s1/voice-map/site/draft',
      'PATCH /assist/sites/s1/voice-map/site/draft',
      'POST /assist/sites/s1/voice-map/site/dev-report',
      'DELETE /assist/sites/s1/voice-map/site/dev-report',
      'GET /assist/sites/s1/voice-map/site/dev-report',
      'GET /assist/sites/s1/voice-map/site/dev-report',
      'GET /assist/sites/s1/voice-map/site/misses',
    ]
  );
  // Путь не этого сайта (подмена ответа) — отказ; id снимка — только токен.
  reply = { path: 'https://evil.io/x' };
  await assert.rejects(api.devReport('s1'));
  reply = { snapshotId: '../x' };
  await assert.rejects(api.snapshot('s1', 'https://shop.ua/', 'desktop'));
  await assert.rejects(api.snapshotView('s1', '../../x'));
}

// 6. Сервер: маршруты инструментов есть в контроллере (сверка путей).
{
  const ctl = read('assist-site-voice-map/voice-map-tools.controller.ts');
  for (const r of [
    ':id/voice-map/site/dev-report',
    ':id/voice-map/site/misses',
  ])
    assert.ok(ctl.includes(`'${r}'`), `нет маршрута ${r}`);
  assert.ok(
    read('assist-site-voice-map/dev-report.service.ts').includes(
      '/voice-map/site/dev-report/${token}'
    ),
    'путь отчёта сервера = путь, который проверяет клиент'
  );
}

console.log(
  'voice-map-api: типы = сервер, словари, разбор, клиент, снимок, сверка, отчёт, промахи'
);
