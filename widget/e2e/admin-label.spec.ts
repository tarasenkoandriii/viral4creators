/**
 * Заход 10 (Ш6 (4), Р-З10-15) в браузере: подпись кнопки «Админки» — атрибут
 * `data-label` тега; кнопка и окно — в закрытом Shadow DOM, поэтому подпись
 * видна через `title` iframe (то же значение, что у кнопки и диалога).
 * Мусор (HTML) — подпись по умолчанию на языке тега.
 */
import { test, expect, type Page } from '@playwright/test';
import { mock, newPk, stand } from './fixtures';
import { testJwt } from './stand/admin-mock';

const ADMIN = 'http://127.0.0.1:5181';
const HOST = 'admin.example.localhost';

async function frameTitle(page: Page): Promise<string | null> {
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { V4CAssist?: unknown }).V4CAssist ===
      'function'
  );
  await page.evaluate(() =>
    (window as unknown as { V4CAssist: (c: string) => void }).V4CAssist('open')
  );
  await expect
    .poll(
      () => page.frames().find((f) => f.url().includes('/wa/v1/frame')) ?? null
    )
    .not.toBeNull();
  const f = page.frames().find((x) => x.url().includes('/wa/v1/frame'))!;
  return (await f.frameElement()).getAttribute('title');
}

test.beforeEach(async () => {
  await mock('reset');
  await mock('admin-reset');
});

test('data-label — своя подпись кнопки и окна «Админки»', async ({ page }) => {
  await page.goto(
    stand(HOST, {
      pk: newPk(),
      loaderOrigin: ADMIN,
      attrs: {
        'data-mode': 'admin',
        'data-identity': testJwt('emp-L'),
        'data-lang': 'uk',
        'data-label': 'Помічник Viral4Creators',
      },
    })
  );
  expect(await frameTitle(page)).toBe('Помічник Viral4Creators');
});

test('data-label с HTML — подпись по умолчанию на языке тега', async ({
  page,
}) => {
  await page.goto(
    stand(HOST, {
      pk: newPk(),
      loaderOrigin: ADMIN,
      attrs: {
        'data-mode': 'admin',
        'data-identity': testJwt('emp-M'),
        'data-lang': 'en',
        'data-label': '<img src=x onerror=alert(1)>',
      },
    })
  );
  expect(await frameTitle(page)).toBe('Staff assistant');
});
