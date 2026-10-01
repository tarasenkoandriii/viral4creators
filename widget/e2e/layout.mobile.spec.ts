/**
 * Приёмка Э2 п.3 — мобильные режимы в ЭМУЛЯЦИИ (Playwright Pixel 7 =
 * Chromium с вьюпортом 412×839 и touch; НЕ iOS Safari/Android Chrome —
 * их проверяет владелец): fullscreen (умолчание) — на весь экран, кнопка
 * скрыта, прокрутка страницы заблокирована и возвращается; sheet — 85%
 * высоты снизу; bubble — как на десктопе; visualViewport (клавиатура).
 */
import { test, expect } from '@playwright/test';
import { chat, launcher, mock, newPk, panel, site, stand } from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

test('мобильный fullscreen: окно на весь экран, кнопка скрыта, прокрутка страницы заблокирована', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, long: true }));
  const vp = page.viewportSize()!;
  await launcher(page).tap();
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  const p = (await panel(page).boundingBox())!;
  expect(Math.round(p.x)).toBe(0);
  expect(Math.round(p.y)).toBe(0);
  expect(Math.round(p.width)).toBe(vp.width);
  expect(Math.abs(p.height - vp.height)).toBeLessThanOrEqual(1);
  await expect(launcher(page)).toBeHidden();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).overflow
    )
  ).toBe('hidden');
  // «назад»/закрыть в шапке чата
  await chat(page).locator('.hd .x').tap();
  await expect(panel(page)).toBeHidden();
  await expect(launcher(page)).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).overflow
    )
  ).toBe('visible');
});

test('мобильный sheet: лист снизу на 85% высоты', async ({ page }) => {
  const pk = newPk();
  await site(pk, { config: { layout: { mobile: 'sheet' } } });
  await page.goto(stand('example.localhost', { pk }));
  const vp = page.viewportSize()!;
  await expect
    .poll(async () => (await launcher(page).isVisible()) && 1)
    .toBe(1);
  await page.waitForTimeout(300);
  await launcher(page).tap();
  await expect(panel(page)).toBeVisible();
  const p = (await panel(page).boundingBox())!;
  expect(Math.round(p.y + p.height)).toBe(vp.height);
  expect(Math.abs(p.height - vp.height * 0.85)).toBeLessThanOrEqual(2);
  expect(Math.round(p.width)).toBe(vp.width);
});

test('мобильный bubble (data-mobile): окно как на десктопе, кнопка видна, прокрутка не блокируется', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(
    stand('example.localhost', { pk, attrs: { 'data-mobile': 'bubble' } })
  );
  const vp = page.viewportSize()!;
  await launcher(page).tap();
  await expect(panel(page)).toBeVisible();
  const p = (await panel(page).boundingBox())!;
  expect(p.width).toBeLessThan(vp.width);
  await expect(launcher(page)).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).overflow
    )
  ).toBe('visible');
});

test('visualViewport: высота окна следует за видимой областью (виртуальная клавиатура)', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await launcher(page).tap();
  await expect(panel(page)).toBeVisible();
  const vv = await page.evaluate(() => window.visualViewport!.height);
  const host = page.locator('[data-v4c]');
  expect(
    await host.evaluate((h) =>
      (h as HTMLElement).style.getPropertyValue('--vh')
    )
  ).toBe(`${vv}px`);
});

test('скрыть кнопку при прокрутке (hideOnScrollMobile)', async ({ page }) => {
  const pk = newPk();
  await site(pk, { config: { layout: { hideOnScrollMobile: true } } });
  await page.goto(stand('example.localhost', { pk, long: true }));
  await expect(launcher(page)).toBeVisible();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.scrollTo(0, 800));
  await expect
    .poll(() => launcher(page).evaluate((e) => getComputedStyle(e).transform))
    .not.toBe('none');
  await page.evaluate(() => window.scrollTo(0, 100));
  await expect
    .poll(() => launcher(page).evaluate((e) => getComputedStyle(e).transform))
    .toBe('none');
});

test('V4CAssist(hide) при открытом окне — окно закрыто, прокрутка страницы возвращена', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, long: true }));
  await launcher(page).tap();
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  const overflow = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).overflow);
  expect(await overflow()).toBe('hidden');
  await page.evaluate(() =>
    (window as unknown as Record<string, (c: string) => void>)['V4CAssist'](
      'hide'
    )
  );
  await expect.poll(overflow).toBe('visible');
  await page.evaluate(() =>
    (window as unknown as Record<string, (c: string) => void>)['V4CAssist'](
      'show'
    )
  );
  await expect(launcher(page)).toBeVisible();
  await expect(panel(page)).toBeHidden();
});
