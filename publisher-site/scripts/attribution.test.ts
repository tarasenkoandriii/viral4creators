/**
 * Атрибуция сайта (§13.5; AT-F11-01/02, e2e-часть — в e2e.mjs): режим
 * `session` хранит `sessionRef` и первое касание, внутренние переходы его не
 * перезаписывают; режим `none` ничего не хранит и `sessionRef` не отдаёт.
 */
import assert from 'node:assert/strict';
import {
  contentSlugOf,
  eventPathOf,
  looksLikeContact,
  newSessionRef,
  pageAttribution,
  placementFromSearch,
  readSession,
  referrerHostOf,
  SESSION_REF_RE,
  utmFromSearch,
} from '../src/lib/attribution';
import { leadAttribution } from '../src/lib/lead-attribution';
import { PUBLISHER_SESSION_STORAGE_KEY } from '../src/brand';

class Mem {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
class Broken {
  getItem(): string | null {
    throw new Error('SecurityError');
  }
  setItem() {
    throw new Error('QuotaExceeded');
  }
  removeItem() {
    throw new Error('SecurityError');
  }
}
let n = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  n++;
  assert.deepEqual(a, b, msg);
};

eq(
  utmFromSearch('?utm_source=tg&utm_medium=community&utm_campaign=pilot&utm_content=pl-1&utm_term=x&q=1'),
  { source: 'tg', medium: 'community', campaign: 'pilot', content: 'pl-1' },
  'utm: четыре ключа',
);
eq(utmFromSearch('?utm_source=%20%20'), null, 'пустые метки — null');
eq(utmFromSearch(`?utm_source=${'a'.repeat(150)}`)?.source?.length, 100, 'метка ≤ 100');
eq(placementFromSearch('?placement=PL-1'), 'pl-1', 'код размещения в нижнем регистре');
eq(placementFromSearch('?placement=-bad'), null, 'негодный код отбрасывается');
for (let i = 0; i < 50; i++) assert.ok(SESSION_REF_RE.test(newSessionRef()), 'sessionRef ↔ формат сервера');
n++;
eq(newSessionRef(new Uint8Array(16).fill(255)), '_____________________w', 'base64url');

// session: первая страница с метками → запись; внутренняя страница — источник не меняется.
const s = new Mem();
const t0 = new Date('2026-10-13T10:00:00Z');
const a1 = pageAttribution('session', s, { pathname: '/materials/abc-x', search: '?utm_source=tg&placement=pl-1' }, t0);
assert.ok(a1.sessionRef && SESSION_REF_RE.test(a1.sessionRef));
eq(a1.utm, { source: 'tg' }, 'событие первой страницы несёт её метки');
const stored = readSession(s)!;
eq(
  stored.firstTouch,
  { utm: { source: 'tg' }, placementCode: 'pl-1', landedAt: t0.toISOString(), landingPath: '/materials/abc-x' },
  'первое касание',
);
const a2 = pageAttribution('session', s, { pathname: '/', search: '' });
eq(a2, { sessionRef: a1.sessionRef }, 'внутренняя страница: тот же sessionRef, без меток');
const a3 = pageAttribution('session', s, { pathname: '/', search: '?utm_source=fb' });
eq(readSession(s)!.firstTouch.utm, { source: 'tg' }, 'новые метки не перезаписывают первое касание');
eq(a3.sessionRef, a1.sessionRef, 'сессия та же');
eq(
  leadAttribution('session', s, { pathname: '/contact', search: '?material=x' }),
  { sessionRef: a1.sessionRef, utm: { source: 'tg' }, placementCode: 'pl-1' },
  'заявка: sessionRef + первое касание',
);

// none: ничего не хранится, прежняя запись удаляется, sessionRef нет.
const none = new Mem();
none.setItem(PUBLISHER_SESSION_STORAGE_KEY, JSON.stringify(stored));
const b1 = pageAttribution('none', none, { pathname: '/materials/abc-x', search: '?utm_source=tg' });
eq(b1, { utm: { source: 'tg' } }, 'none: только метки текущей страницы');
eq(none.m.size, 0, 'none: хранилище пустое');
eq(
  leadAttribution('none', none, { pathname: '/contact', search: '' }),
  {},
  'none: заявка после внутреннего перехода — без источника (сервер: unknown)',
);

const leftover = new Mem();
leftover.setItem(PUBLISHER_SESSION_STORAGE_KEY, JSON.stringify(stored));
eq(
  leadAttribution('none', leftover, { pathname: '/contact', search: '' }),
  {},
  'none: запись, оставшаяся от режима session, в заявку не идёт',
);

// Хранилище недоступно — без исключений и без выдуманной сессии.
eq(
  pageAttribution('session', new Broken(), { pathname: '/', search: '?utm_source=a' }),
  { utm: { source: 'a' } },
  'сломанное хранилище: без sessionRef',
);
eq(pageAttribution('session', null, { pathname: '/', search: '' }), {}, 'нет хранилища');
eq(leadAttribution('session', new Broken(), { pathname: '/contact', search: '' }), {}, 'сломанное хранилище у формы');
const junk = new Mem();
junk.setItem(PUBLISHER_SESSION_STORAGE_KEY, '{"sessionRef":"<script>"}');
eq(readSession(junk), null, 'мусор в хранилище не принимается');

eq(referrerHostOf('https://www.google.com/search?q=x', 'ai-publisher.org'), 'www.google.com', 'referrer → только хост');
eq(referrerHostOf('https://ai-publisher.org/materials', 'ai-publisher.org'), undefined, 'свой хост — не источник');
eq(referrerHostOf('android-app://x', 'a'), undefined, 'не http(s)');
eq(contentSlugOf('/materials/pershyi-material'), 'pershyi-material', 'slug');
// Аудит S3-3: ПД из меток и пути на клиенте не уходят.
eq(
  utmFromSearch(
    '?utm_source=ivan.petrenko%40gmail.com&utm_campaign=%2B380501234567&utm_medium=tg&utm_content=050%20123%2045%2067',
  ),
  { medium: 'tg' },
  'метки, похожие на контакт, отброшены',
);
eq(
  utmFromSearch('?utm_campaign=pilot-2026&utm_content=pl-12'),
  { campaign: 'pilot-2026', content: 'pl-12' },
  'обычные метки с цифрами (до 6 подряд) остаются',
);
eq(
  [
    looksLikeContact('ab@cd'),
    looksLikeContact('+38 (050) 123-45-67'),
    looksLikeContact('１２３４５６７'),
    looksLikeContact('2026-10'),
    looksLikeContact('pilot'),
  ],
  [true, true, true, false, false],
  'looksLikeContact',
);
eq(
  [
    '/',
    '/materials',
    '/materials/',
    '/materials/pershyi-material',
    '/contact',
    '/privacy',
    '/olena%40example.com',
    '/materials/x',
    '/materials/a/b',
    '/api/revalidate',
  ].map(eventPathOf),
  [
    '/',
    '/materials',
    '/materials',
    '/materials/pershyi-material',
    '/contact',
    '/privacy',
    '/404',
    '/404',
    '/404',
    '/404',
  ],
  'path события — только известные маршруты',
);
{
  const st = new Mem();
  pageAttribution('session', st, { pathname: '/ivan%40mail.ua', search: '?utm_source=ivan%40mail.ua' });
  eq(
    [readSession(st)?.firstTouch.landingPath, readSession(st)?.firstTouch.utm],
    ['/404', null],
    'sessionStorage: ни ПД-пути, ни ПД-меток',
  );
}
eq(contentSlugOf('/materials'), undefined, 'список — не материал');
console.log(
  `ok   attribution: ${n} проверок — session (первое касание неизменно, sessionRef), none (ничего не хранится), сбой хранилища, referrer`,
);
