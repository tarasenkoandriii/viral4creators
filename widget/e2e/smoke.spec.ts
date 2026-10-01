/** Дымовой проход: одна строка установки → кнопка → чат → ответ стримом, без ошибок в консоли. */
import { test, expect } from '@playwright/test';
import {
  ask,
  chat,
  launcher,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

test('дымовой: кнопка → чат → ответ стримом, без ошибок', async ({ page }) => {
  await mock('reset');
  const pk = newPk();
  await site(pk);
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(stand('example.localhost', { pk }));
  await expect(launcher(page)).toBeVisible();
  await openChat(page);
  await ask(page, 'Сколько стоит доставка?');
  await waitAnswer(page);
  await expect(chat(page).locator('.msg.bot').last()).toContainText(
    'Ответ на вопрос'
  );
  expect(errors).toEqual([]);
});
