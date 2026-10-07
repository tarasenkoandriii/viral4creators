/**
 * Клиент браузерного воркера обучалки (Ш3-хвост (3)): подпись принимает
 * проверка sites-backend, маршруты и тела — как у канала, отказы — типами
 * (вызывающий решает «откат в функцию»), подписанный запрос не следует
 * редиректу, кадр — только https, с потолком и сигнатурой изображения.
 */
import {
  SITES_CALLER_TUTORIAL,
  verifySitesRequest,
} from '../../common/sites-internal-signature';
import {
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
} from './sites-internal.client';
import {
  ARTIFACT_MAX_BYTES,
  SitesTutorialWorkerClient,
} from './sites-tutorial-frames.client';

const SECRET = 'f'.repeat(40);
const NOW = new Date('2026-10-07T12:00:00Z');

function client(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  env: NodeJS.ProcessEnv = {
    SITES_BACKEND_URL: 'https://sites.example.app',
    SITES_TUTORIAL_HMAC_SECRET: SECRET,
  },
) {
  const c = new SitesTutorialWorkerClient();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  c.env = env;
  c.now = () => NOW;
  c.fetchImpl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { c, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('SitesTutorialWorkerClient (Ш3-хвост (3))', () => {
  it('кадры: подпись принимает sites-backend; тело — с png2x; редиректы не исполняются', async () => {
    const { c, calls } = client(() =>
      json(200, { success: true, data: { jobId: 'j1', status: 'queued' } }),
    );
    await expect(
      c.framesRequest('4242', 'https://shop.example.com/', {
        image: 'png2x',
      }),
    ).resolves.toEqual({ jobId: 'j1', status: 'queued' });
    const { url, init } = calls[0];
    expect(url).toBe(
      'https://sites.example.app/internal/sites/tutorial/frames/request',
    );
    expect(JSON.parse(init.body as string)).toEqual({
      telegramId: '4242',
      url: 'https://shop.example.com/',
      frames: 1,
      viewport: 'mobile',
      image: 'png2x',
    });
    expect(init.redirect).toBe('error');
    const check = verifySitesRequest(SECRET, {
      method: init.method!,
      path: new URL(url).pathname,
      body: init.body as string,
      headers: init.headers as Record<string, string>,
      nowSeconds: Math.floor(NOW.getTime() / 1000),
      expectedCaller: SITES_CALLER_TUTORIAL,
    });
    expect(check.ok).toBe(true);
  });

  it('раунд: маршруты канала учётных данных; отмена — только ожидающего, пока не попросили иначе', async () => {
    const { c, calls } = client(() =>
      json(200, { success: true, data: { jobId: 'j', status: 'cancelled' } }),
    );
    await c.exploreCancel('tg-1', 'j');
    await c.exploreCancel('tg-1', 'j', '1', true);
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/internal/sites/credentials/tutorial-explore/cancel',
      '/internal/sites/credentials/tutorial-explore/cancel',
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      subject: 'tg-1',
      jobId: 'j',
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      subject: 'tg-1',
      jobId: 'j',
      telegramId: '1',
      running: true,
    });
  });

  it('отказы — типами: 409 с кодом, 5xx/сеть — недоступно, без настроек — не настроено', async () => {
    const r = client(() =>
      json(409, { success: false, error: { code: 'BROWSER_WORKER_DISABLED' } }),
    );
    await expect(r.c.exploreSealKey()).rejects.toMatchObject({
      constructor: SitesRejectedError,
      code: 'BROWSER_WORKER_DISABLED',
    });
    const s = client(() => json(503, { success: false }));
    await expect(s.c.exploreSealKey()).rejects.toBeInstanceOf(
      SitesUnavailableError,
    );
    const n = client(() => Promise.reject(new TypeError('fetch failed')));
    await expect(n.c.exploreSealKey()).rejects.toBeInstanceOf(
      SitesUnavailableError,
    );
    const off = client(() => json(200, {}), {});
    await expect(off.c.exploreSealKey()).rejects.toBeInstanceOf(
      SitesNotConfiguredError,
    );
  });

  it('кадр: только https, без редиректов, потолок и сигнатура JPEG/PNG', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = client(() => new Response(png));
    await expect(
      ok.c.fetchArtifact('https://blob.example/x.png'),
    ).resolves.toMatchObject({ contentType: 'image/png' });
    expect(ok.calls[0].init.redirect).toBe('error');
    await expect(
      ok.c.fetchArtifact('http://blob.example/x.png'),
    ).rejects.toBeInstanceOf(SitesUnavailableError);
    const html = client(() => new Response('<html>'));
    await expect(
      html.c.fetchArtifact('https://blob.example/x'),
    ).rejects.toBeInstanceOf(SitesUnavailableError);
    const big = client(
      () => new Response(Buffer.alloc(ARTIFACT_MAX_BYTES + 1)),
    );
    await expect(
      big.c.fetchArtifact('https://blob.example/x'),
    ).rejects.toBeInstanceOf(SitesUnavailableError);
  });
});
