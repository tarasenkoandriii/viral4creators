/**
 * Трекер (§13.5): тело события по контракту `EventBody` (P-D), `path`
 * всегда, `sessionRef` — только если он есть (режим `none` его не даёт),
 * транспорт — `sendBeacon` с `Blob` `text/plain`, запасной — `fetch`
 * `keepalive` с `text/plain`; клиент не умеет слать `lead_submit_success`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildEvent, EVENT_MAX_BYTES, sendEvent, serializeEvent } from '../src/lib/track';
import { CLIENT_EVENT_NAMES } from '../src/lib/api-types';

const cfg = {
  apiOrigin: 'https://api.example',
  publicKey: 'pp_standPublisherKey0000001',
  consentState: 'not_required' as const,
};
const at = new Date('2026-10-13T10:00:00Z');
let n = 0;
const eq = (a: unknown, b: unknown, m: string) => {
  n++;
  assert.deepEqual(a, b, m);
};

const e1 = buildEvent(
  cfg,
  'content_view',
  {
    path: '/materials/x',
    contentSlug: 'x',
    referrerHost: 't.me',
    attribution: { sessionRef: 'AbCdEf12_-', utm: { source: 'tg' }, placementCode: 'pl-1' },
  },
  'e-1',
  at,
);
eq(
  e1,
  {
    key: cfg.publicKey,
    eventId: 'e-1',
    name: 'content_view',
    path: '/materials/x',
    consentState: 'not_required',
    clientAt: at.toISOString(),
    contentSlug: 'x',
    referrerHost: 't.me',
    placementCode: 'pl-1',
    sessionRef: 'AbCdEf12_-',
    utm: { source: 'tg' },
  },
  'полное событие',
);
const e2 = buildEvent(cfg, 'cta_click', { path: '/', attribution: {} }, 'e-2', at);
eq(
  Object.keys(e2).sort(),
  ['clientAt', 'consentState', 'eventId', 'key', 'name', 'path'],
  'без хранения: ни sessionRef, ни меток',
);

// Транспорт: beacon text/plain.
const sent: Array<{ url: string; type: string; text: Promise<string> }> = [];
const r1 = sendEvent(cfg.apiOrigin, e1, {
  sendBeacon: (url, data) => (sent.push({ url, type: data.type, text: data.text() }), true),
});
eq(r1, 'beacon', 'sendBeacon');
eq(sent[0].url, 'https://api.example/public/publisher/v1/events', 'адрес /events');
eq(sent[0].type, 'text/plain', 'Blob text/plain (не application/json — межсайтовый beacon)');
// beacon отказал → fetch keepalive text/plain.
const fetched: RequestInit[] = [];
const r2 = sendEvent(cfg.apiOrigin, e2, {
  sendBeacon: () => false,
  fetch: (_u, init) => (fetched.push(init), Promise.reject(new Error('offline'))),
});
eq(r2, 'fetch', 'запасной путь');
eq(
  [fetched[0].keepalive, (fetched[0].headers as Record<string, string>)['content-type'], fetched[0].credentials],
  [true, 'text/plain', 'omit'],
  'fetch: keepalive, text/plain, без cookie',
);
eq(sendEvent(cfg.apiOrigin, e2, {}), 'none', 'нет транспорта — без исключения');
eq(
  sendEvent(cfg.apiOrigin, e2, {
    sendBeacon: () => {
      throw new Error('x');
    },
    fetch: () => Promise.resolve(),
  }),
  'fetch',
  'исключение beacon → fetch',
);

// Лимит 2 КБ: лишние поля отбрасываются целиком.
const big = buildEvent(
  cfg,
  'content_view',
  {
    path: '/',
    referrerHost: 'h'.repeat(1200),
    attribution: {
      utm: { source: 'я'.repeat(100), medium: 'я'.repeat(100), campaign: 'я'.repeat(100), content: 'я'.repeat(100) },
      sessionRef: 'AbCdEf12_-',
    },
  },
  'e-3',
  at,
);
const text = serializeEvent(big);
assert.ok(new TextEncoder().encode(text).length <= EVENT_MAX_BYTES, 'событие ≤ 2 КБ');
const parsed = JSON.parse(text);
eq(
  [parsed.utm, parsed.referrerHost, parsed.sessionRef],
  [undefined, undefined, 'AbCdEf12_-'],
  'урезано без потери sessionRef',
);

eq([...CLIENT_EVENT_NAMES], ['content_view', 'cta_click'], 'клиентские события');
// Клиентский код не упоминает событие успеха заявки (его пишет сервер).
const src = ['src/lib/track.ts', 'src/components/Track.tsx', 'src/components/LeadForm.tsx', 'src/lib/lead-form.ts'];
for (const f of src)
  assert.ok(
    !fs.readFileSync(path.join(__dirname, '..', f), 'utf8').includes("'lead_submit_success'"),
    `${f}: клиент не шлёт lead_submit_success`,
  );
n++;
Promise.all(sent.map((s) => s.text)).then((t) => {
  eq(JSON.parse(t[0]).eventId, 'e-1', 'тело beacon — JSON события');
  console.log(
    `ok   track: ${n} проверок — тело EventBody, sessionRef только при хранении, beacon text/plain, запасной fetch keepalive, ≤ 2 КБ, без lead_submit_success`,
  );
});
