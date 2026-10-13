#!/usr/bin/env node
/**
 * Интеграция Z-2b, E2E-02 (публичная часть): собранный сайт (`next start`)
 * против НАСТОЯЩЕГО sites-backend, а не стенда `stand.ts`. Браузер видит
 * сайт по https на домене продукта (`SITE_HOST`, по умолчанию `pubsite.test`):
 * локальный https-прокси (самоподписанный сертификат на время прогона) →
 * `next start`. Порт :443 не занимается (предаудит DEF-C-01, Р-PUB-Z2-28):
 * TLS-фронт сайта слушает свободный порт, Chromium ходит через локальный
 * CONNECT-прокси (`proxy` запуска), который туннелирует ТОЛЬКО
 * `<SITE_HOST>:443` в этот фронт, — Origin остаётся `https://<SITE_HOST>`,
 * а два стенда одновременно не конфликтуют.
 * Origin формы и событий — `https://<SITE_HOST>`: его пропускает только
 * подтверждённый хост продукта (live), как на проде.
 *
 * Путь посетителя: внешняя метка (`utm_*`, `placement`) → материал (текст —
 * согласованная версия) → внутренний переход → CTA → форма → успех с номером
 * обращения. Итог — JSON (`OUT`): номер, sessionRef, заголовок, ошибки
 * консоли. Драйвер кабинета (`assist/scripts/publisher-e2e.ts`) проверяет
 * заявку по этому номеру уже в кабинете.
 *
 *   SITE_HOST=pubsite.test NEXT_PORT=3020 CTX=/tmp/pub-e2e/e2e-a.json \
 *   WORK=/tmp/pub-e2e OUT=/tmp/pub-e2e/site.json node scripts/built/z-e2e-site.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { chromium } from 'playwright-core';

const HOST = process.env.SITE_HOST ?? 'pubsite.test';
const NEXT_PORT = Number(process.env.NEXT_PORT ?? 3020);
const WORK = process.env.WORK ?? '/tmp/pub-e2e';
const OUT = process.env.OUT ?? `${WORK}/site.json`;
// Итог фазы a драйвера кабинета: материал (slug, заголовок) и код закупки.
const CTX = process.env.CTX ? JSON.parse(readFileSync(process.env.CTX, 'utf8')).ctx : {};
const SLUG = process.env.SLUG ?? CTX.article?.slug;
const TITLE = process.env.TITLE ?? CTX.article?.title ?? '';
const PLACEMENT = process.env.PLACEMENT ?? CTX.placement?.code ?? '';
const PERSON = {
  name: 'Олена Тестова',
  contact: `olena.e2e.${Date.now().toString(36)}@example.com`,
  business: 'shop.example',
  task: 'Потрібні статті для блогу магазину',
};
if (!SLUG) throw new Error('SLUG не задан');

// ── TLS-фронт (свободный порт) → next start; CONNECT-прокси для Chromium ──
const key = `${WORK}/site-key.pem`;
const cert = `${WORK}/site-cert.pem`;
if (!existsSync(cert)) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      `/CN=${HOST}`,
      '-addext',
      `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: 'ignore' },
  );
}
const proxy = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const up = http.request(
    { host: '127.0.0.1', port: NEXT_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: HOST } },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const tlsPort = proxy.address().port;
// CONNECT-туннель: только домен продукта на :443 → TLS-фронт. Playwright
// пускает через прокси и loopback (`<-loopback>`): обычные HTTP-запросы
// браузера к API стенда (`http://localhost:<порт>`) прокси пересылает —
// только на loopback; прочее — 403.
const tunnel = http.createServer((req, res) => {
  let target;
  try {
    target = new URL(req.url ?? '');
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (target.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(target.hostname)) {
    res.writeHead(403);
    res.end();
    return;
  }
  const up = http.request(
    {
      host: '127.0.0.1',
      port: Number(target.port || 80),
      path: `${target.pathname}${target.search}`,
      method: req.method,
      headers: req.headers,
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  up.on('error', () => {
    res.writeHead(502);
    res.end();
  });
  req.pipe(up);
});
tunnel.on('connect', (req, client, head) => {
  const [host, port = '443'] = String(req.url ?? '').split(':');
  if (host !== HOST || port !== '443') {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const up = net.connect(tlsPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
  });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
});
await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
const tunnelPort = tunnel.address().port;

const BASE = `https://${HOST}`;
const result = { base: BASE, slug: SLUG, person: PERSON, checks: [], consoleErrors: [] };
const check = (ok, msg, evidence) => result.checks.push({ ok: Boolean(ok), msg, evidence });

// Прокси окружения (песочница агента) — мимо: сайт и API локальные.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)));
const browser = await chromium.launch({
  env,
  proxy: { server: `http://127.0.0.1:${tunnelPort}` },
});
try {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && result.consoleErrors.push(m.text()));
  page.on('pageerror', (e) => result.consoleErrors.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams({
    utm_source: 'venue',
    utm_medium: 'paid',
    utm_campaign: 'pilot',
    ...(PLACEMENT ? { placement: PLACEMENT, utm_content: PLACEMENT } : {}),
  });
  const r = await page.goto(`${BASE}/materials/${SLUG}?${q}`, {
    waitUntil: 'load',
    referer: 'https://venue.example/post/1',
  });
  check(r?.status() === 200, `страница материала ${r?.status()}`);
  const h1 = (await page.textContent('h1'))?.trim() ?? '';
  check(!TITLE || h1 === TITLE, 'заголовок страницы = согласованной версии', { h1, expected: TITLE });
  const body = (await page.textContent('[data-testid="material-body"]')) ?? '';
  check(body.length > 0, 'текст материала в HTML', { chars: body.length });
  // Внутренний переход и обратно (сессия одна).
  await page.click('.crumbs a');
  await page.waitForURL(`${BASE}/materials`);
  await page.click(`a[href="/materials/${SLUG}"]`);
  await page.waitForURL(`${BASE}/materials/${SLUG}`);
  await page.click('[data-cta="material-next"]');
  await page.waitForURL(new RegExp(`/contact\\?material=${SLUG}$`));
  await page.waitForSelector('form[data-ready="1"]');
  await page.fill('#lf-name', PERSON.name);
  await page.check('#lf-method-email');
  await page.fill('#lf-contact', PERSON.contact);
  await page.fill('#lf-business', PERSON.business);
  await page.fill('#lf-task', PERSON.task);
  // Двойной клик — одна отправка (AT-CORE-04).
  await page.dblclick('button[type="submit"]');
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="form-status"]');
      const st = el?.getAttribute('data-status');
      return st === 'success' || st === 'error' || st === 'unknown' || st === 'limited';
    },
    null,
    { timeout: 30000 },
  );
  const status = await page.getAttribute('[data-testid="form-status"]', 'data-status');
  const text = (await page.textContent('[data-testid="form-status"]')) ?? '';
  result.leadRef = /L-[A-Z0-9]+/.exec(text)?.[0] ?? null;
  // `pub_sref` — JSON сессии атрибуции (`{sessionRef, firstTouch}`).
  const sref = await page.evaluate(() => sessionStorage.getItem('pub_sref'));
  try {
    result.sessionRef = JSON.parse(sref ?? 'null')?.sessionRef ?? null;
  } catch {
    result.sessionRef = sref;
  }
  check(status === 'success' && result.leadRef, 'отправка формы — успех с номером обращения', {
    status,
    text: text.slice(0, 200),
  });
  check(result.consoleErrors.length === 0, 'ошибки консоли', result.consoleErrors);
  // Без JS текст читается; неизвестный материал — 404.
  const raw = await fetch(`http://127.0.0.1:${NEXT_PORT}/materials/${SLUG}`, { headers: { host: HOST } });
  check(raw.status === 200 && (await raw.text()).includes(TITLE), 'HTML без JS содержит заголовок');
  const unknown = await page.goto(`${BASE}/materials/net-takoho-materialu`, { waitUntil: 'load' });
  check(unknown?.status() === 404, `неизвестный материал → ${unknown?.status()}`);
  await ctx.close();
} finally {
  await browser.close();
  proxy.close();
  tunnel.close();
}
writeFileSync(OUT, JSON.stringify(result, null, 2));
const failed = result.checks.filter((c) => !c.ok);
console.log(`z-e2e-site: проверок ${result.checks.length}, ошибок ${failed.length}; номер ${result.leadRef}`);
for (const f of failed) console.log(`FAIL ${f.msg} ${JSON.stringify(f.evidence ?? '')}`);
process.exitCode = failed.length ? 1 : 0;
