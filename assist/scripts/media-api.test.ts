/**
 * Э6: экран «Видео» в TMA — повтор типов сервера (коды ошибок), строгий
 * разбор (закрытый отказ «за логином», deep-link только t.me с cst_),
 * клиент (пути, тело), словари uk/ru/en для каждого кода.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appEn } from '../src/i18n/en';
import { appRu } from '../src/i18n/ru';
import { appUk } from '../src/i18n/uk';
import { ApiError, type ApiClient } from '../src/kit';
import {
  MEDIA_CABINET_ERROR_CODES,
  UI_MAP_SOURCES,
  UI_MAP_VIEWPORTS,
  createMediaApi,
  duration,
  mediaErrorCode,
  parseSiteUiMap,
  parseSiteVideos,
} from '../src/lib/media-api';

const types = readFileSync(
  new URL(
    '../../sites-backend/src/modules/assist-site-media/api-types.ts',
    import.meta.url
  ),
  'utf8'
);

// 1. Коды ошибок — те же, что у сервера.
{
  const m = /MediaCabinetErrorCode =([^;]+);/.exec(types);
  assert.ok(m, 'нет MediaCabinetErrorCode на сервере');
  assert.deepEqual(
    [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort(),
    [...MEDIA_CABINET_ERROR_CODES].sort()
  );
  for (const d of [appRu, appUk, appEn]) {
    for (const c of MEDIA_CABINET_ERROR_CODES) assert.ok(d.media.errors[c]);
  }
}

// 2. Разбор: закрытый отказ и только наш deep-link.
{
  const v = parseSiteVideos({
    siteId: 's1',
    planAllowsVideo: true,
    videos: [
      {
        id: 'v1',
        title: 'Как купить',
        locale: 'ru',
        durationMs: 42_000,
        requiresLogin: false,
        enabled: true,
        syncedAt: 'x',
      },
      { id: 'v2', title: 'Без признака' },
      { id: '../evil', title: 'мусор' },
    ],
    tutorialLink: 'https://t.me/gen_bot/app?startapp=cst_s1',
    uiMap: { pages: 3, stalePages: 1, staleElements: 2, lastCapturedAt: null },
  });
  assert.equal(v.videos.length, 2);
  assert.equal(v.videos[1].requiresLogin, true, 'нет признака — «за логином»');
  assert.equal(v.videos[1].enabled, false);
  assert.equal(v.tutorialLink, 'https://t.me/gen_bot/app?startapp=cst_s1');
  assert.deepEqual(v.uiMap, {
    pages: 3,
    stalePages: 1,
    staleElements: 2,
    lastCapturedAt: null,
  });
  for (const bad of [
    'javascript:alert(1)',
    'https://evil.example/?startapp=cst_s1',
    'https://t.me/gen_bot/app?startapp=other',
  ]) {
    assert.equal(parseSiteVideos({ tutorialLink: bad }).tutorialLink, null);
  }
  assert.equal(duration(42_000), '0:42');
  assert.equal(duration(125_000), '2:05');
  assert.equal(duration(null), '');
  assert.equal(
    mediaErrorCode(new ApiError('VIDEO_PLAN_REQUIRED', 'x', 402)),
    'VIDEO_PLAN_REQUIRED'
  );
  assert.equal(mediaErrorCode(new Error('x')), null);
}

// 2-бис. Э-С Ш4: сводка карты — источники и виды те же, что у сервера;
// разбор строгий (чужие значения вон, подписи — строка ≤ 80); словари.
{
  const list = (name: string) => {
    const m = new RegExp(`${name} =([^;]+);`).exec(types);
    assert.ok(m, `нет ${name} на сервере`);
    return [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(list('SiteUiMapSource'), [...UI_MAP_SOURCES].sort());
  assert.deepEqual(list('SiteUiMapViewport'), [...UI_MAP_VIEWPORTS].sort());
  const m = parseSiteUiMap({
    siteId: 's1',
    pages: 2,
    elements: 7,
    staleElements: 1,
    stalePages: 1,
    bySource: { crawl: 2, tutorial: 1, evil: 9 },
    byStability: { strong: 3, medium: 2, fragile: 2 },
    lastCapturedAt: '2026-10-03T00:00:00.000Z',
    items: [
      {
        host: 'shop.example.com',
        path: '/cart',
        viewports: ['any', 'mobile', 'tv'],
        sources: ['crawl', 'tutorial', 'evil'],
        elements: 5,
        staleElements: 1,
        stale: [
          {
            label: 'x'.repeat(200),
            tag: 'button',
            viewport: 'mobile',
            staleAt: 't',
          },
          { label: 'Без виду', tag: 'a', viewport: 'tablet', staleAt: 't' },
        ],
        lastCapturedAt: null,
      },
      { host: 'shop.example.com', path: 'не шлях' },
    ],
    truncated: true,
  });
  assert.deepEqual(m.bySource, { crawl: 2, tutorial: 1 });
  assert.equal(m.items.length, 1);
  assert.deepEqual(m.items[0].viewports, ['any', 'mobile']);
  assert.deepEqual(m.items[0].sources, ['crawl', 'tutorial']);
  assert.equal(m.items[0].stale.length, 1);
  assert.equal(m.items[0].stale[0].label.length, 80);
  assert.equal(m.truncated, true);
  assert.equal(parseSiteUiMap(null).pages, 0);
  for (const d of [appRu, appUk, appEn]) {
    for (const s of UI_MAP_SOURCES) assert.ok(d.media.map.sources[s]);
    for (const v of [...UI_MAP_VIEWPORTS, 'both'] as const)
      assert.ok(d.media.map.views[v]);
    assert.ok(d.media.map.stale.includes('{e}'));
    assert.ok(d.media.map.stale.includes('{n}'));
  }
}

// 3. Клиент: пути и тело.
{
  const calls: Array<[string, string, unknown]> = [];
  const client = {
    request: async (m: string, p: string, b?: unknown) => {
      calls.push([m, p, b]);
      return m === 'GET'
        ? { siteId: 's1', videos: [] }
        : { id: 'v1', title: 't', requiresLogin: false, enabled: true };
    },
  } as unknown as ApiClient;
  const api = createMediaApi(client);
  await api.list('s1');
  const v = await api.setEnabled('s1', 'v1', true);
  assert.equal(v.enabled, true);
  await api.uiMap('s1');
  assert.deepEqual(calls, [
    ['GET', '/assist/sites/s1/videos', undefined],
    ['PATCH', '/assist/sites/s1/videos/v1', { enabled: true }],
    ['GET', '/assist/sites/s1/ui-map', undefined],
  ]);
  await assert.rejects(api.list('../x'));
  await assert.rejects(api.uiMap('../x'));
}

console.log('media-api: коды, разбор, клиент — ок');
