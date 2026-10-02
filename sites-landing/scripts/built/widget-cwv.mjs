#!/usr/bin/env node
/**
 * Замер «с виджетом и без» (ТЗ §4.5, §9 п.6, §14 Л2; аудит 01.10):
 * Lighthouse mobile, медиана 5 прогонов КАЖДОГО варианта в одинаковых
 * условиях. Вариант «без» — та же сборка, но адрес загрузчика заблокирован
 * (`blockedUrlPatterns`): разница — ровно наш виджет. Пороги приёмки:
 * ΔLCP ≤ 100 мс, ΔTBT ≤ 30 мс, ΔCLS ≤ 0.01. Плюс INP при открытии чата
 * (клик по «Открыть помощника», CPU ×4, медиана 5) ≤ 200 мс.
 *
 * Нужны: собранный лендинг с ключом виджета и адресом стенда на :3010 и
 * стенд `scripts/built/assist-stand.ts` на :3011 (настоящий загрузчик).
 * `--write` — записать результат в `src/lib/widget-measure.json` (его
 * показывает блок «Скорость» на `/widget`).
 *
 * ЛАБОРАТОРНЫЙ ориентир на стенде (мок API, localhost); приёмка — тот же
 * скрипт против живого деплоя: `BASE_URL=https://assist.viral4creators.app`.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.BASE_URL ?? 'http://localhost:3010').replace(/\/$/, '');
const PATHS = (process.env.CWV_PATHS ?? '/uk/assistant,/uk/assistant/widget').split(',');
const RUNS = Number(process.env.CWV_RUNS ?? 5);
const DIST = process.env.WIDGET_DIST ?? path.join(ROOT, '..', 'widget', 'dist');
const CHROME = process.env.CHROME_PATH ?? chromium.executablePath();
const LIMITS = { lcp: 100, tbt: 30, cls: 0.01, inp: 200 };

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

async function lh(url, blocked) {
  const chrome = await chromeLauncher.launch({ chromePath: CHROME, chromeFlags: ['--headless=new', '--no-sandbox'] });
  try {
    const r = await lighthouse(url, { port: chrome.port, output: 'json', logLevel: 'error', onlyCategories: ['performance'], blockedUrlPatterns: blocked });
    const a = r.lhr.audits;
    // Заблокированный запрос тоже попадает в список — считаем только успешные.
    const reqs = a['network-requests'].details.items.filter((i) => i.statusCode >= 200 && i.statusCode < 400).map((i) => i.url);
    return {
      lcp: a['largest-contentful-paint'].numericValue,
      tbt: a['total-blocking-time'].numericValue,
      cls: a['cumulative-layout-shift'].numericValue,
      loader: reqs.some((u) => u.includes('/v1/loader.js')),
      chat: reqs.some((u) => /\/v1\/chat\.|\/w\/v1\/frame/.test(u)),
    };
  } finally {
    await chrome.kill();
  }
}

const results = [];
let failed = false;
for (const p of PATHS) {
  const url = BASE + p;
  const runs = { with: [], without: [] };
  for (let i = 0; i < RUNS; i++) {
    // Чередуем варианты: дрейф машины не попадает в одну сторону.
    runs.with.push(await lh(url, []));
    runs.without.push(await lh(url, ['*/v1/loader.js']));
  }
  if (!runs.with.every((r) => r.loader)) {
    console.error(`FAIL ${p}: в варианте «с виджетом» загрузчик не загрузился — сборка без ключа/стенда?`);
    failed = true;
  }
  if (runs.without.some((r) => r.loader)) {
    console.error(`FAIL ${p}: в варианте «без» загрузчик не заблокирован`);
    failed = true;
  }
  if (runs.with.some((r) => r.chat)) {
    console.error(`FAIL ${p}: iframe/chat.js загрузились без клика`);
    failed = true;
  }
  if (process.env.CWV_VERBOSE) for (const v of ['with', 'without']) console.log(`  ${v}: LCP ${runs[v].map((r) => r.lcp.toFixed(0)).join(' ')}; TBT ${runs[v].map((r) => r.tbt.toFixed(0)).join(' ')}`);
  const m = (v, k) => median(runs[v].map((r) => r[k]));
  const d = { lcp: m('with', 'lcp') - m('without', 'lcp'), tbt: m('with', 'tbt') - m('without', 'tbt'), cls: m('with', 'cls') - m('without', 'cls') };
  const ok = d.lcp <= LIMITS.lcp && d.tbt <= LIMITS.tbt && d.cls <= LIMITS.cls;
  failed ||= !ok;
  results.push({ path: p, with: { lcp: m('with', 'lcp'), tbt: m('with', 'tbt'), cls: m('with', 'cls') }, without: { lcp: m('without', 'lcp'), tbt: m('without', 'tbt'), cls: m('without', 'cls') }, d });
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${p}: LCP ${m('with', 'lcp').toFixed(0)}/${m('without', 'lcp').toFixed(0)} мс (Δ ${d.lcp.toFixed(0)}), TBT ${m('with', 'tbt').toFixed(0)}/${m('without', 'tbt').toFixed(0)} мс (Δ ${d.tbt.toFixed(0)}), CLS Δ ${d.cls.toFixed(3)} — медиана ${RUNS} прогонов, с/без`,
  );
}

// INP при открытии чата: длительность события клика (Event Timing).
const browser = await chromium.launch();
const inps = [];
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    window.__ev = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.interactionId) window.__ev.push(e.duration);
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  });
  await page.goto(`${BASE}/uk/assistant`, { waitUntil: 'load' });
  await page.waitForSelector('div[data-v4c]', { state: 'attached', timeout: 15000 });
  await page.click('[data-testid="playground"] button[data-cta="playground"]');
  await page.waitForSelector('div[data-v4c] >> iframe', { timeout: 10000 });
  await page.waitForTimeout(800);
  inps.push(Math.max(16, ...(await page.evaluate(() => window.__ev))));
  await ctx.close();
}
await browser.close();
const inp = median(inps);
failed ||= inp > LIMITS.inp;
console.log(`${inp <= LIMITS.inp ? 'ok  ' : 'FAIL'} INP при открытии чата (CPU ×4, медиана ${RUNS}): ${inp.toFixed(0)} мс (≤ ${LIMITS.inp})`);

const gz = (f) => zlib.gzipSync(fs.readFileSync(path.join(DIST, 'v1', f)), { level: 9 }).length / 1024;
const loaderKb = gz('loader.js');
const chatKb = gz('chat.js') + gz('chat.css');
console.log(`виджет: загрузчик ${loaderKb.toFixed(1)} КБ, чат ${chatKb.toFixed(1)} КБ gzip`);

if (process.argv.includes('--write') && !failed) {
  const main = results[0];
  const out = {
    date: new Date().toISOString().slice(0, 10),
    runs: RUNS,
    loaderKb: Math.round(loaderKb * 10) / 10,
    chatKb: Math.round(chatKb * 10) / 10,
    dLcpMs: Math.round(main.d.lcp),
    dTbtMs: Math.round(main.d.tbt),
    dCls: Math.round(main.d.cls * 1000) / 1000,
    how: `scripts/built/widget-cwv.mjs: Lighthouse mobile, медиана ${RUNS} прогонов ${main.path} с виджетом и без (адрес загрузчика заблокирован), ${BASE}; INP открытия чата ${inp.toFixed(0)} мс`,
  };
  fs.writeFileSync(path.join(ROOT, 'src/lib/widget-measure.json'), JSON.stringify(out, null, 2) + '\n');
  console.log('записано в src/lib/widget-measure.json');
}
if (failed) {
  console.error('FAIL замер с/без виджета вне порогов §4.5');
  process.exit(1);
}
