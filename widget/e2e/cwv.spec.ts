/**
 * Приёмка Э2 п.1 (часть W1): установка одной строкой; до клика — ни
 * iframe, ни chat.js; песочничный замер LCP/TBT/CLS с виджетом и без
 * (медиана 5 прогонов, Chromium, CPU ×4) — ОРИЕНТИР, не приёмка: приёмку
 * даёт Lighthouse mobile владельца на стенд-сайте (контракт §8). Пороги —
 * лендинг-ТЗ §17.3 п.5: ΔLCP ≤ 100 мс, ΔTBT ≤ 30 мс, ΔCLS ≤ 0.01.
 * Бюджеты 12/60 КБ gzip — `npm run size` (CI).
 */
import { test, expect, type Browser } from '@playwright/test';
import {
  WIDGET_STORAGE_PREFIX,
  launcher,
  log,
  mock,
  newPk,
  site,
  stand,
} from './fixtures';
import type { StandSpec } from './stand/server';

test.beforeEach(async () => {
  await mock('reset');
});

test('одна строка: только тег — кнопка есть; до клика нет iframe и chat.js', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(
    urls.filter((u) => u.includes('/w/v1/frame') || u.includes('/v1/chat.'))
  ).toEqual([]);
  expect((await log()).pings).toHaveLength(1);
});

interface Vitals {
  lcp: number;
  cls: number;
  tbt: number;
}

async function measure(
  browser: Browser,
  spec: StandSpec,
  restoreOpen = false
): Promise<Vitals> {
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 839 },
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.addInitScript(() => {
    const w = window as unknown as {
      __v: { lcp: number; cls: number; tbt: number };
    };
    w.__v = { lcp: 0, cls: 0, tbt: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__v.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >)
        if (!e.hadRecentInput) w.__v.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__v.tbt += Math.max(0, e.duration - 50);
    }).observe({ type: 'longtask', buffered: true });
  });
  if (restoreOpen) {
    // Окно было открыто на прошлой странице (sessionStorage страницы, §4-бис.1).
    await page.addInitScript(
      ([k]) => sessionStorage.setItem(k, `open:${Date.now()}`),
      [`${WIDGET_STORAGE_PREFIX}:${spec.pk}:ui`]
    );
  }
  await page.goto(stand('example.localhost', spec), { waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const v = await page.evaluate(
    () =>
      (window as unknown as { __v: { lcp: number; cls: number; tbt: number } })
        .__v
  );
  await ctx.close();
  return v;
}

const median = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test('CWV песочницы: медиана 5 прогонов с виджетом и без (закрыт; восстановление открытого — только замер)', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const pk = newPk();
  await site(pk);
  const runs = {
    base: [] as Vitals[],
    closed: [] as Vitals[],
    open: [] as Vitals[],
  };
  for (let i = 0; i < 5; i++) {
    runs.base.push(await measure(browser, { pk, heavy: true, noWidget: true }));
    runs.closed.push(await measure(browser, { pk, heavy: true }));
    runs.open.push(await measure(browser, { pk, heavy: true }, true));
  }
  const m = (k: keyof typeof runs, f: keyof Vitals) =>
    median(runs[k].map((r) => r[f]));
  const rep = (['base', 'closed', 'open'] as const)
    .map(
      (k) =>
        `${k}: LCP ${m(k, 'lcp').toFixed(0)} мс, TBT ${m(k, 'tbt').toFixed(0)} мс, CLS ${m(k, 'cls').toFixed(3)}`
    )
    .join(' | ');
  console.log(`CWV (Chromium песочницы, CPU×4, медиана 5): ${rep}`);
  test.info().annotations.push({ type: 'cwv', description: rep });
  expect(m('closed', 'lcp') - m('base', 'lcp')).toBeLessThanOrEqual(100);
  expect(m('closed', 'tbt') - m('base', 'tbt')).toBeLessThanOrEqual(30);
  expect(m('closed', 'cls') - m('base', 'cls')).toBeLessThanOrEqual(0.01);
  // Открытое окно после load: каркас fixed-позиции не сдвигает вёрстку.
  expect(m('open', 'cls') - m('base', 'cls')).toBeLessThanOrEqual(0.01);
});
