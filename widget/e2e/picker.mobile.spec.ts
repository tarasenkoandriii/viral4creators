/**
 * Э3 (W): режим выбора цели на ТЕЛЕФОНЕ (§5-тер.16 п.6). Владелец открывает
 * ссылку выбора из Telegram во внешнем браузере телефона (`openLink`), т.е.
 * касание — основной путь. Касание не должно глушить синтетический click
 * (иначе выбрать нельзя ничего) и прокрутку страницы, а действие сайта
 * по-прежнему не исполняется. ЭМУЛЯЦИЯ Pixel 7 в Chromium.
 */
import { expect, test } from '@playwright/test';
import { A, log, mock, newPk, site, stand } from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

test('телефон: касание выбирает элемент, действие сайта не исполняется', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { pickerTokens: { tok_goal_mob_1234567890123: A } });
  await page.goto(
    stand('example.localhost', { pk, goalsKit: true, long: true }) +
      '&v4c_goal=tok_goal_mob_1234567890123'
  );
  await expect(page.locator('[data-v4c-picker]')).toHaveCount(1);
  await page.waitForTimeout(500);
  await page.evaluate(() =>
    document.addEventListener('touchstart', () => {
      const w = window as unknown as { __touches?: number };
      w.__touches = (w.__touches || 0) + 1;
    })
  );
  await page.locator('#order').tap();
  await expect.poll(async () => (await log()).picks.length).toBe(1);
  expect((await log()).picks[0]).toMatchObject({
    kind: 'click',
    descriptor: { role: 'button', text: 'оформить заказ' },
  });
  await expect(page.locator('#clicked')).toHaveText('');
  // Ссылка сайта касанием не уводит со страницы.
  await page.locator('#danger').tap();
  await expect.poll(async () => (await log()).picks.length).toBe(2);
  expect(new URL(page.url()).pathname).toBe('/page');
  // Обработчики касаний сайта не видят касаний режима выбора.
  expect(
    await page.evaluate(
      () => (window as unknown as { __touches?: number }).__touches || 0
    )
  ).toBe(0);
});
