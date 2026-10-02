/**
 * Э3 (W): лимит навязчивости §5-тер.12 п.3 на телефоне — не на первом
 * экране (ЭМУЛЯЦИЯ Pixel 7 в Chromium; живые устройства — владелец).
 */
import { expect, test } from '@playwright/test';
import { humanBrowser, launcher, mock, newPk, site, stand } from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

test('телефон: на первом экране сигнала нет, после прокрутки — есть', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    engagement: {
      schema: 1,
      triggers: [
        {
          key: 'mob',
          enabled: true,
          condition: { kind: 'time_on_page', seconds: 10 },
          pathMasks: [],
          text: { ru: 'Подсказать?' },
          onAccept: { kind: 'open' },
        },
        {
          key: 'mob-scroll',
          enabled: true,
          condition: { kind: 'scroll_depth', percent: 30 },
          pathMasks: [],
          text: { ru: 'Помочь с выбором?' },
          onAccept: { kind: 'open' },
        },
      ],
      limits: { perVisit: 1, excludedPaths: [], notOnFirstScreenMobile: true },
      scenarios: [],
    },
  });
  await page.goto(stand('example.localhost', { pk, long: true }));
  await expect(launcher(page)).toBeVisible();
  await page.waitForTimeout(12_000);
  await expect(page.locator('[data-v4c] .g')).toHaveCount(0);
  await page.evaluate(() => window.scrollTo(0, window.innerHeight * 1.5));
  await expect(page.locator('[data-v4c] .g')).toHaveCount(1, {
    timeout: 3000,
  });
  // Ничего не открылось само.
  await expect(page.locator('[data-v4c] iframe')).toHaveCount(0);
});
