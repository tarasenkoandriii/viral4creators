// Real React section + browser events + fixture HTTP server; no production access.
const { build } = require('esbuild');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

async function main() {
  const result = await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {GenerationHistorySection} from './src/features/generation-history/GenerationHistorySection';import {I18nContext} from './src/lib/i18n-context';import {getDictionary} from './src/lib/get-dictionary';const locale=new URLSearchParams(location.search).get('lang')||'en';createRoot(document.getElementById('root')).render(<I18nContext.Provider value={{locale,dict:getDictionary(locale),setLocale:()=>{}}}><main style={{maxWidth:720,margin:'24px auto',padding:12}}><GenerationHistorySection/></main></I18nContext.Provider>);`,
      loader: 'tsx',
      resolveDir: root,
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: {
      'import.meta.env': JSON.stringify({ VITE_API_BASE_URL: '/api' }),
      'process.env.NODE_ENV': '"production"',
    },
    logLevel: 'silent',
  });
  const assets = path.join(root, 'dist/assets');
  const css = fs.readFileSync(
    path.join(
      assets,
      fs.readdirSync(assets).find((name) => name.endsWith('.css'))
    )
  );
  let mode = 'ok',
    owner = 'A';
  const requests = [],
    errors = [];
  const server = http.createServer((req, res) => {
    if (process.argv.includes('--serve') && req.url.startsWith('/__fixture?')) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      if (['ok', 'auth', 'error', 'slow'].includes(q.get('mode')))
        mode = q.get('mode');
      if (['A', 'B'].includes(q.get('owner'))) owner = q.get('owner');
      res.writeHead(303, { Location: '/' });
      res.end();
    } else if (req.url.startsWith('/api/generation-history')) {
      requests.push({ method: req.method, url: req.url });
      const capturedOwner = owner,
        capturedMode = mode;
      const nextPage = new URL(req.url, 'http://localhost').searchParams.has(
        'before'
      );
      const respond = () => {
        if (capturedMode === 'error' || capturedMode === 'auth') {
          res.writeHead(capturedMode === 'auth' ? 401 : 503, {
            'Content-Type': 'application/json',
          });
          res.end(
            JSON.stringify({
              success: false,
              error: { message: 'fixture failure' },
            })
          );
          return;
        }
        const item = (suffix, status) => ({
          id: `${capturedOwner}-${suffix}`,
          sessionId: 'fixture-session',
          status,
          resolution: '720p',
          createdAt: '2026-11-01T12:00:00Z',
        });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              items: nextPage
                ? [item('first', 'processing'), item('second', 'unknown')]
                : [item('first', 'processing')],
              nextCursor: nextPage ? null : `${capturedOwner}-first`,
              coverage: 'session-video-partial',
            },
          })
        );
      };
      if (capturedMode === 'slow') setTimeout(respond, 350);
      else respond();
    } else if (req.url === '/app.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(result.outputFiles[0].contents);
    } else if (req.url === '/style.css') {
      res.setHeader('Content-Type', 'text/css');
      res.end(css);
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body>' +
          (process.argv.includes('--serve')
            ? '<nav aria-label="Local fixture controls">Local mock data only · <a href="/__fixture?mode=ok&owner=A">Account A</a> · <a href="/__fixture?mode=ok&owner=B">Account B</a> · <a href="/__fixture?mode=auth">401</a> · <a href="/__fixture?mode=error">503</a> · <a href="/?lang=uk">UK</a> · <a href="/?lang=de">DE fallback</a></nav>'
            : '') +
          '<div id="root"></div><script src="/app.js"></script></body></html>'
      );
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  if (process.argv.includes('--serve')) {
    console.log(
      `Local history fixture: http://127.0.0.1:${server.address().port}`
    );
    return;
  }
  const { chromium } = require(
    process.env.V4C_PLAYWRIGHT_MODULE || 'playwright'
  );
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.V4C_CHROME_PATH
        ? { executablePath: process.env.V4C_CHROME_PATH }
        : {}),
    });
    const page = await browser.newPage({
      viewport: { width: 360, height: 780 },
    });
    page.on('pageerror', (error) => errors.push(String(error)));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(base);
    await page.getByText('My generation history', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await page.locator('summary').click();
    await page.getByText('Attempt A-first', { exact: false }).waitFor();
    assert.equal(await page.locator('ol li').count(), 1);
    assert.equal(requests.length, 1);
    await page.getByRole('button', { name: 'Show more' }).click();
    await page.getByText('Attempt A-second', { exact: false }).waitFor();
    assert.equal(await page.locator('ol li').count(), 2);
    await page
      .getByText('The dispatch outcome needs checking.', { exact: false })
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: /retry|generate again/i }).count(),
      0
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      true
    );
    if (process.env.V4C_HISTORY_SCREENSHOT)
      await page.screenshot({
        path: process.env.V4C_HISTORY_SCREENSHOT,
        fullPage: true,
      });
    console.log(
      'PASS browser 360px: explicit load, pagination/deduplication, unknown warning, no retry or horizontal overflow'
    );

    mode = 'slow';
    const pending = page.waitForRequest((r) =>
      r.url().includes('/api/generation-history')
    );
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await pending;
    owner = 'B';
    mode = 'ok';
    await page.evaluate(() =>
      window.dispatchEvent(new Event('v4c:identity-changed'))
    );
    await page.getByText('Attempt B-first', { exact: false }).waitFor();
    await page.waitForTimeout(500);
    assert.equal(
      await page.getByText('Attempt A-first', { exact: false }).count(),
      0
    );
    console.log(
      'PASS browser DOM identity event: late account A response cannot overwrite account B'
    );

    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator('ol li').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.getByText('Attempt B-first', { exact: false }).waitFor();
    console.log(
      'PASS browser DOM blur/focus: private rows cleared and reloaded'
    );

    mode = 'auth';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('Sign in to view your history.').waitFor();
    assert.equal(await page.locator('ol li').count(), 0);
    mode = 'error';
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page
      .getByText('History could not be loaded.', { exact: false })
      .waitFor();
    assert.equal(
      await page.getByText('fixture failure', { exact: false }).count(),
      0
    );
    console.log(
      'PASS browser API 401/503: no private rows, safe user-facing messages'
    );

    mode = 'ok';
    for (const lang of ['uk', 'ru', 'de']) {
      await page.goto(`${base}/?lang=${lang}`);
      const expected =
        lang === 'uk'
          ? 'Історія моїх запусків'
          : lang === 'ru'
            ? 'История моих запусков'
            : 'My generation history';
      await page.getByText(expected, { exact: true }).waitFor();
    }
    await page.locator('summary').focus();
    await page.keyboard.press('Enter');
    await page.getByText('Attempt B-first', { exact: false }).waitFor();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement.textContent),
      'Refresh'
    );
    console.log(
      'PASS browser keyboard: summary opens with Enter and Tab reaches Refresh'
    );
    assert.deepEqual(errors, []);
    assert.equal(
      requests.every((r) => r.method === 'GET'),
      true
    );
    console.log(
      'PASS browser UK/RU and DE→EN fallback, no uncaught page errors, all history calls are GET'
    );
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
