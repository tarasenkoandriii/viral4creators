/**
 * Лабораторный стенд продукта для проверок лендинга (Л2–Л3) — один
 * процесс на одном порту играет `assist-w` (виджет) и `assist-api` (API):
 *
 *  - `/v1/loader.js`, `/v1/chat.js`, `/v1/chat.css` — НАСТОЯЩИЕ файлы
 *    собранного виджета (`../widget/dist`, или `WIDGET_DIST`);
 *  - `/widget/v1/config` — публичный конфиг нашего сайта с
 *    `allowClientPreview` (переключается `POST /__stand/config`), `ping`,
 *    `frame` (HTML iframe как `frame-html.ts`), минимальные `session` и
 *    `state` — чтобы чат стартовал по клику;
 *  - `POST /public/landing/event` — приём событий §10 (как сервер: тело
 *    ≤ 4 КБ, `text/plain` или JSON) с записью в журнал;
 *  - `POST /public/widget-drafts` — черновик вида: проверка НАСТОЯЩИМ
 *    `parseWidgetConfig` из sites-backend (тот же код, что на сервере),
 *    ≤ 2 КБ, без хостов/картинок; CORS — как у сервера для лендинга.
 *
 * Это МОК бизнес-правил (нет базы, лимитов по ipHash, денег) — живой
 * бэкенд без секретов не поднимается; приёмку на настоящем API делает
 * владелец (doc/DEPLOYMENT.md §7.4).
 *
 * Запуск: `npx tsx scripts/built/assist-stand.ts` (порт `STAND_PORT`, 3011).
 * Журнал: `GET /__stand/log`, сброс: `POST /__stand/reset`.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const PORT = Number(process.env.STAND_PORT ?? 3011);
const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.resolve(process.env.WIDGET_DIST ?? path.join(ROOT, '..', 'widget', 'dist'));
const WIDGET_CONFIG = path.join(ROOT, '..', 'sites-backend', 'src', 'modules', 'assist-site-setup', 'widget-config.ts');
const LANDING = (process.env.STAND_LANDING_ORIGINS ?? 'http://localhost:3010,http://127.0.0.1:3010').split(',');

interface Log {
  events: Array<{ contentType: string; origin: string | null; cookie: string | null; body: unknown }>;
  drafts: Array<{ origin: string | null; config: unknown; id: string }>;
  configHits: number;
  pings: number;
  frames: number;
  loaderHits: number;
  requests: string[];
}
const fresh = (): Log => ({ events: [], drafts: [], configHits: 0, pings: 0, frames: 0, loaderHits: 0, requests: [] });
let log = fresh();
let allowClientPreview = true;
let draftStatus: number | null = null;

type ParseFn = (input: unknown) => { ok: boolean; config?: Record<string, unknown>; adjustments?: unknown[]; errors?: unknown[] };
let parseWidgetConfig: ParseFn | null = null;
let defaultConfig: ((name: string) => Record<string, unknown>) | null = null;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(text);
}

async function readBody(req: http.IncomingMessage, max: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function cors(req: http.IncomingMessage): Record<string, string> {
  const o = req.headers.origin;
  return o && LANDING.includes(o) ? { 'access-control-allow-origin': o, vary: 'Origin' } : {};
}

function publicConfig() {
  const cfg = defaultConfig ? defaultConfig('Лендинг') : {};
  delete (cfg as Record<string, unknown>).hosts;
  return {
    status: 'active',
    widgetVersion: 1,
    config: cfg,
    hosts: [],
    allowClientPreview,
    lead: { fields: [{ field: 'name', required: true }], consentText: {} },
    suggestedQuestions: [],
    poweredByUrl: null,
  };
}

const FRAME = [
  '<!doctype html>',
  '<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<link rel="stylesheet" href="/v1/chat.css"><script src="/v1/chat.js" defer></script></head>',
  '<body><div id="app"></div></body></html>',
].join('');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const p = url.pathname;
  log.requests.push(`${req.method} ${p}`);
  try {
    if (p === '/__stand/log') return send(res, 200, log);
    if (p === '/__stand/reset' && req.method === 'POST') {
      log = fresh();
      allowClientPreview = true;
      draftStatus = null;
      return send(res, 200, { ok: true });
    }
    if (p === '/__stand/config' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req, 1000)) ?? '{}') as { allowClientPreview?: boolean; draftStatus?: number | null };
      if (typeof b.allowClientPreview === 'boolean') allowClientPreview = b.allowClientPreview;
      if (b.draftStatus !== undefined) draftStatus = b.draftStatus;
      return send(res, 200, { ok: true });
    }
    const asset = /^\/v1\/(loader\.js|chat\.js|chat\.css)$/.exec(p);
    if (asset) {
      if (asset[1] === 'loader.js') log.loaderHits++;
      const file = path.join(DIST, 'v1', asset[1]);
      if (!fs.existsSync(file)) return send(res, 404, 'нет собранного виджета: cd widget && npm run build');
      // Как CDN Vercel: gzip, если браузер просит (иначе замер веса врёт втрое).
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
      const bytes = fs.readFileSync(file);
      res.writeHead(200, {
        'content-type': asset[1].endsWith('.css') ? 'text/css' : 'text/javascript',
        'cache-control': 'public, max-age=300',
        'access-control-allow-origin': '*',
        ...(gzip ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' } : {}),
      });
      return res.end(gzip ? zlib.gzipSync(bytes, { level: 9 }) : bytes);
    }
    if (p === '/widget/v1/config') {
      log.configHits++;
      return send(res, 200, { success: true, data: publicConfig() }, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    }
    if (p === '/widget/v1/ping') {
      log.pings++;
      res.writeHead(200, { 'content-type': 'image/gif' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }
    if (p === '/w/v1/frame') {
      log.frames++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `frame-ancestors ${LANDING.join(' ')}` });
      return res.end(FRAME);
    }
    if (p === '/widget/v1/session' && req.method === 'POST') {
      await readBody(req, 4096);
      return send(res, 200, {
        success: true,
        data: { visitorToken: 'stand.visitor.token', expiresAt: new Date(Date.now() + 864e5).toISOString(), resumeKey: null, resumed: false, resumeLost: false, preview: false },
      });
    }
    if (p === '/widget/v1/chat' && req.method === 'POST') {
      // Только форма протокола (прогон eval-landing против стенда): модели нет.
      const b = JSON.parse((await readBody(req, 8192)) ?? '{}') as { question?: string };
      log.requests.push(`chat: ${String(b.question ?? '').slice(0, 60)}`);
      return send(res, 200, { success: true, data: { conversationId: 'c1', messageId: 'm1', text: 'Не знаю — на стенді моделі немає.', sources: [], actions: [], refused: false, streaming: false } });
    }
    if (p === '/widget/v1/state') return send(res, 200, { success: true, data: { conversation: null, previousConversationId: null } });

    if (p === '/public/landing/event') {
      if (req.method === 'OPTIONS') return send(res, 204, '', { ...cors(req), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
      const raw = await readBody(req, 4 * 1024);
      if (raw === null) return send(res, 400, { success: false, error: { code: 'BAD_REQUEST' } }, cors(req));
      log.events.push({
        contentType: String(req.headers['content-type'] ?? ''),
        origin: req.headers.origin ?? null,
        cookie: req.headers.cookie ?? null,
        body: JSON.parse(raw),
      });
      res.writeHead(204, cors(req));
      return res.end();
    }
    if (p === '/public/widget-drafts') {
      if (req.method === 'OPTIONS') return send(res, 204, '', { ...cors(req), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' });
      if (draftStatus) return send(res, draftStatus, { success: false, error: { code: draftStatus === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST', message: '' } }, cors(req));
      const origin = req.headers.origin ?? null;
      if (!origin || !LANDING.includes(origin)) return send(res, 403, { success: false, error: { code: 'ORIGIN_DENIED', message: '' } });
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw ?? '{}') as { config?: Record<string, unknown> };
      const c = body.config;
      const bad = () => send(res, 400, { success: false, error: { code: 'BAD_REQUEST', message: '' } }, cors(req));
      if (!c || typeof c !== 'object' || Buffer.byteLength(JSON.stringify(c)) > 2048) return bad();
      if (Array.isArray(c.hosts) && c.hosts.length) return bad();
      const parsed = parseWidgetConfig!({ ...c, hosts: [] });
      if (!parsed.ok) return bad();
      const brand = (parsed.config as { brand: { logoAssetId: unknown; avatar: { kind: string } } }).brand;
      if (brand.logoAssetId !== null || brand.avatar.kind === 'asset') return bad();
      const id = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64url');
      log.drafts.push({ origin, config: c, id });
      return send(res, 200, { success: true, data: { id, expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() } }, cors(req));
    }
    return send(res, 404, 'not found');
  } catch (e) {
    return send(res, 500, String(e));
  }
});

async function main() {
  const wc = (await import(pathToFileURL(WIDGET_CONFIG).href)) as { parseWidgetConfig: ParseFn; defaultWidgetConfig: (n: string) => Record<string, unknown> };
  parseWidgetConfig = wc.parseWidgetConfig;
  defaultConfig = wc.defaultWidgetConfig;
  if (!fs.existsSync(path.join(DIST, 'v1', 'loader.js'))) {
    console.error(`assist-stand: нет ${path.join(DIST, 'v1', 'loader.js')} — соберите виджет: cd widget && npm ci && npm run build`);
    process.exit(1);
  }
  server.listen(PORT, () => console.log(`assist-stand: http://localhost:${PORT} (виджет ${DIST})`));
}

void main();
