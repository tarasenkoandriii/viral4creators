/**
 * Э7 «Админка» в браузере (Chromium + мок `admin-mock.ts`): ТЗ §4-бис.10
 * п.8 «смена JWT с sub=A на sub=B → ни одного сообщения A в окне B, во
 * всех вкладках», отдельный origin iframe (§4.12, У-13), хранилище
 * страницы админки без сессии и `sub`, публичный чат на origin «Админки»
 * не открывается. Подпись JWT, роли и тариф — acceptance/e7 (сервер).
 */
import { test, expect, type Page, type Frame } from '@playwright/test';
import { mock, newPk, stand } from './fixtures';
import { testJwt } from './stand/admin-mock';

const ADMIN = 'http://127.0.0.1:5181';
const HOST = 'admin.example.localhost';

function adminPage(pk: string, sub: string, iat?: number): string {
  return stand(HOST, {
    pk,
    loaderOrigin: ADMIN,
    attrs: {
      'data-mode': 'admin',
      'data-identity': testJwt(sub, iat),
      'data-lang': 'uk',
    },
  });
}

async function adminFrame(page: Page): Promise<Frame> {
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
  return page.frames().find((f) => f.url().includes('/wa/v1/frame'))!;
}

async function askIn(frame: Frame, text: string) {
  await frame.locator('.wa-i').fill(text);
  await frame.locator('.wa-s').click();
  await expect(frame.locator('.wa-ai').last()).toBeVisible();
}

test.beforeEach(async () => {
  await mock('reset');
  await mock('admin-reset');
});

test('«Админка»: iframe — отдельный origin, чат работает, страница админки не хранит ни сессию, ни sub', async ({
  page,
}) => {
  const pk = newPk();
  await page.goto(adminPage(pk, 'emp-A'));
  const f = await adminFrame(page);
  expect(new URL(f.url()).origin).toBe(ADMIN);
  await askIn(f, 'Як оформити повернення?');
  await expect(f.locator('.wa-ai').last()).toContainText('emp-A');
  // Хранилище СТРАНИЦЫ админки: ни токена сессии, ни sub, ни текста.
  const store = await page.evaluate(() =>
    JSON.stringify({
      l: { ...localStorage },
      s: { ...sessionStorage },
      c: document.cookie,
    })
  );
  expect(store).not.toContain('emp-A');
  expect(store).not.toContain('Як оформити');
  // Публичный чат «Сайта» на origin «Админки» не отдаётся (как has/missing host).
  const pub = await page.request.get(`${ADMIN}/w/v1/frame?pk=${pk}`);
  expect(pub.status()).toBe(404);
  const pubApi = await page.request.get(`${ADMIN}/widget/v1/config?pk=${pk}`);
  expect(pubApi.status()).toBe(404);
});

test('§4-бис.10 п.8: смена сотрудника A → B — ни одного сообщения A у B, во всех вкладках', async ({
  context,
}) => {
  const pk = newPk();
  const t1 = await context.newPage();
  await t1.goto(adminPage(pk, 'emp-A'));
  const f1 = await adminFrame(t1);
  await askIn(f1, 'Питання співробітника А');
  await expect(f1.locator('.wa-m')).toHaveCount(2);

  // Вторая вкладка того же сотрудника — та же история (с сервера).
  const t2 = await context.newPage();
  await t2.goto(adminPage(pk, 'emp-A'));
  const f2 = await adminFrame(t2);
  await expect(f2.locator('.wa-m')).toHaveCount(2);

  // В первой вкладке вошёл сотрудник B (новый JWT, позже сброса).
  await t1.goto(adminPage(pk, 'emp-B', Math.floor(Date.now() / 1000) + 2));
  const g1 = await adminFrame(t1);
  await expect(g1.locator('.wa-n')).toBeHidden();
  await expect(g1.locator('.wa-m')).toHaveCount(0);
  await expect(g1.locator('body')).not.toContainText('Питання співробітника А');

  // Вторая вкладка (JWT сотрудника A выписан ДО сброса) — окно очищено и
  // просит обновить страницу: сообщений A больше не видно и там.
  await expect(f2.locator('.wa-m')).toHaveCount(0);
  await expect(f2.locator('.wa-n')).toContainText('оновіть сторінку');

  // B пишет — видит только своё.
  await askIn(g1, 'Питання співробітника Б');
  await expect(g1.locator('.wa-m')).toHaveCount(2);
  await expect(g1.locator('body')).not.toContainText('Питання співробітника А');
});

test('сообщение в ns публичного виджета и кривой JWT iframe «Админки» игнорирует', async ({
  page,
}) => {
  const pk = newPk();
  await page.goto(adminPage(pk, 'emp-A'));
  const f = await adminFrame(page);
  await askIn(f, 'Перше питання');
  // Скрипт страницы шлёт iframe подделку identity в ns публичного виджета.
  // iframe — в закрытом Shadow DOM, `window.frames` его не видит (аудит Э7:
  // прежняя запись через `window.frames` ничего не отправляла) — окно
  // берём через элемент.
  const el = await f.frameElement();
  const sent = await page.evaluate(
    ({ el, origin }) => {
      const w = (el as HTMLIFrameElement).contentWindow;
      if (!w) return false;
      w.postMessage(
        { ns: 'v4c-widget', v: 1, type: 'identity', jwt: 'a.b.c' },
        origin
      );
      w.postMessage(
        { ns: 'v4c-admin', v: 1, type: 'identity', jwt: '<img src=x>' },
        origin
      );
      return true;
    },
    { el, origin: ADMIN }
  );
  expect(sent).toBe(true);
  await expect(f.locator('.wa-m')).toHaveCount(2);
});

test('аудит Э7: повторный init с чужим pk iframe игнорирует (pk — только из адреса iframe)', async ({
  page,
}) => {
  const pk = newPk();
  const other = newPk();
  const sessionPks: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/assist-admin/v1/session')) {
      sessionPks.push(
        (JSON.parse(r.postData() || '{}') as { pk?: string }).pk ?? ''
      );
    }
  });
  await page.goto(adminPage(pk, 'emp-A'));
  const f = await adminFrame(page);
  await askIn(f, 'Перше питання');
  // iframe — в закрытом Shadow DOM: окно берём через его элемент.
  const el = await f.frameElement();
  await page.evaluate(
    ({ el, origin, other, jwt }) => {
      const w = (el as HTMLIFrameElement).contentWindow!;
      w.postMessage(
        {
          ns: 'v4c-admin',
          v: 1,
          type: 'init',
          pk: other,
          parentOrigin: location.origin,
          lang: 'uk',
        },
        origin
      );
      w.postMessage({ ns: 'v4c-admin', v: 1, type: 'identity', jwt }, origin);
    },
    { el, origin: ADMIN, other, jwt: testJwt('emp-A') }
  );
  await expect.poll(() => sessionPks.length).toBeGreaterThan(1);
  expect(sessionPks.every((p) => p === pk)).toBe(true);
});
