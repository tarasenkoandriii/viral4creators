/**
 * Клиент внутреннего API sites-backend — маршруты Э6 (привязка, ролики,
 * карта): подписанный POST на свой путь, тело как есть, подпись сходится
 * той же чистой проверкой, что у sites-backend.
 */
import {
  SITES_CALLER_TUTORIAL,
  verifySitesRequest,
} from '../../common/sites-internal-signature';
import { SitesInternalClient } from '../sites-internal/sites-internal.client';

const SECRET = 'k'.repeat(40);

describe('SitesInternalClient — Э6', () => {
  function client() {
    const c = new SitesInternalClient();
    const sent: Array<{ url: string; init: RequestInit }> = [];
    c.env = {
      SITES_BACKEND_URL: 'https://sites.example.com',
      SITES_TUTORIAL_HMAC_SECRET: SECRET,
    };
    c.fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ success: true, data: { ok: 1 } }), {
        status: 200,
      });
    }) as typeof fetch;
    return { c, sent };
  }

  it.each([
    [
      'linkSite',
      '/internal/sites/tutorial/site-link',
      (c: SitesInternalClient) => c.linkSite('1001', 'site_A'),
      { telegramId: '1001', siteId: 'site_A' },
    ],
    [
      'syncSiteVideos',
      '/internal/sites/tutorial/site-videos',
      (c: SitesInternalClient) =>
        c.syncSiteVideos('site_A', [], 1_790_000_000_123),
      { siteId: 'site_A', asOf: 1_790_000_000_123, videos: [] },
    ],
    [
      'pushUiMap',
      '/internal/sites/tutorial/ui-map',
      (c: SitesInternalClient) =>
        c.pushUiMap('1001', 'site_A', 'https://a.example.com/', [
          { selector: '#a', tag: 'a', label: 'A' },
        ]),
      {
        telegramId: '1001',
        siteId: 'site_A',
        url: 'https://a.example.com/',
        elements: [{ selector: '#a', tag: 'a', label: 'A' }],
      },
    ],
  ])('%s → подписанный POST %s', async (_n, path, call, body) => {
    const { c, sent } = client();
    await call(c);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe(`https://sites.example.com${path}`);
    expect(JSON.parse(String(sent[0].init.body))).toEqual(body);
    const headers = sent[0].init.headers as Record<string, string>;
    const check = verifySitesRequest(SECRET, {
      method: 'POST',
      path,
      body: String(sent[0].init.body),
      headers,
      nowSeconds: Math.floor(Date.now() / 1000),
      expectedCaller: SITES_CALLER_TUTORIAL,
    });
    expect(check.ok).toBe(true);
  });
});
