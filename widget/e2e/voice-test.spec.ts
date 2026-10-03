/**
 * Э6-бис (г) в Chromium — мастер проверки голосового управления Т-2 на
 * «сайте заказчика» (полигон стенда; проверки и вердикт — настоящий
 * `assist-ui-core`, ui-plan-mock.ts), приёмка §5-бис.10 п.14–15:
 *  - ссылка мастера `?v4c_voicetest=` убирается из адреса, окно открывается,
 *    режим `test`: голосовое управление есть только у тестовой сессии;
 *  - шаг 1 (строгий CSP + Trusted Types): виджет, чанки, 0 нарушений;
 *  - шаг 3: кнопки без имени — в списке и обводятся на странице; «похоже на
 *    опасное» — владелец отмечает каждую;
 *  - шаг 4: сухой прогон — цель подсвечена, на странице 0 событий;
 *  - шаг 5: прогон с нажатием переживает переход MPA (мастер продолжается);
 *  - шаг 6: запреты без звука — 100% заблокированы; отчёт `pass`;
 *  - `Permissions-Policy: microphone=()` — «политика сайта», отчёт `fail`;
 *  - решение владельца п.3: согласие отзывается в меню виджета;
 *  - канарейка: ленивые чанки — из `/v1/r/<выпуск>/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { chat, log, mock, newPk, openChat, origin, site } from './fixtures';

const A = origin('example.localhost');
const VOICE = {
  input: true,
  output: false,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};
const DIST = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/v1'
);

test.beforeEach(async ({ page }) => {
  await mock('reset');
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)
    );
  });
});

const vt = (page: Page) => chat(page).locator('.vt');
const next = (page: Page) =>
  vt(page).locator('button', { hasText: 'Далі' }).click();
const btn = (page: Page, text: string) =>
  vt(page).locator('button', { hasText: text });
const vcLog = async () => (await log()).vc;

async function start(
  page: Page,
  o: { noMic?: boolean; csp?: boolean } = {}
): Promise<string> {
  const pk = newPk();
  const token = `vt${'A'.repeat(30)}${Date.now().toString(36)}`;
  // Режим `test`: у сайта нет `voiceControl` в конфиге — только ссылка мастера.
  await site(pk, { voice: VOICE, vtTokens: [token] });
  const q = `?pk=${encodeURIComponent(pk)}&ux=1${o.noMic ? '&pp=0' : ''}${o.csp ? '&csp=1' : ''}`;
  await page.goto(`${A}/vc/polygon/${q}&v4c_voicetest=${token}`);
  await expect(vt(page)).toBeVisible({ timeout: 15_000 });
  return pk;
}

async function violations(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of page.frames()) {
    try {
      out.push(
        ...(await f.evaluate(
          () => (window as unknown as { __csp?: string[] }).__csp || []
        ))
      );
    } catch {
      /* кадр без доступа */
    }
  }
  return out;
}

test('мастер Т-2: ссылка убрана из адреса, шаги 1–7 под строгим CSP, сухой прогон — 0 событий, MPA-переход не теряет мастер, отчёт pass', async ({
  page,
}) => {
  await start(page, { csp: true });
  expect(page.url()).not.toContain('v4c_voicetest');
  // 1. Окружение.
  await expect(vt(page).locator('li.ok')).toHaveCount(4, { timeout: 10_000 });
  await next(page);
  // 2. Микрофон (в песочнице разрешения нет — устройство владельца, не провал).
  await btn(page, 'Перевірити мікрофон').click();
  await expect(vt(page)).toContainText(/Мікрофон|дозвіл|Пропущено|натискання/);
  await next(page);
  // 3. Разметка.
  await btn(page, 'Перевірити').click();
  await expect(vt(page)).toContainText('Без доступного імені');
  await btn(page, 'Показати на сторінці').click();
  await expect
    .poll(() => page.locator('[data-v4c-highlight]').count())
    .toBeGreaterThan(0);
  const sus = vt(page).locator('.vtsus li');
  await expect(sus.first()).toBeVisible();
  const n = await sus.count();
  for (let i = 0; i < n; i++)
    await sus.nth(i).locator('button', { hasText: 'Безпечно' }).click();
  await next(page);
  // 4. Сухой прогон: подсветка, на странице ничего не происходит.
  const before = await page.evaluate(() => ({
    url: location.href,
    s: JSON.stringify((window as unknown as { __stand: unknown }).__stand),
  }));
  // Все предложенные команды (неоднозначная без модели — 0 шагов, это честно).
  const shows = vt(page).locator('button', { hasText: /^Показати$/ });
  for (let k = 0; k < 5 && (await shows.count()) > 0; k++) {
    const left = await shows.count();
    await shows.first().click();
    await expect(shows).toHaveCount(left - 1, { timeout: 10_000 });
  }
  await expect
    .poll(() => vt(page).locator('button', { hasText: 'Вірно' }).count())
    .toBeGreaterThanOrEqual(3);
  const rights = vt(page).locator('button', { hasText: 'Вірно' });
  for (let k = 0; k < (await rights.count()); k++) await rights.nth(k).click();
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => ({
    url: location.href,
    s: JSON.stringify((window as unknown as { __stand: unknown }).__stand),
  }));
  expect(after).toEqual(before);
  const dry = (await vcLog()).plans.length;
  expect(dry).toBeGreaterThanOrEqual(3);
  await next(page);
  // 5. С нажатием: команды по одной; переход MPA — мастер продолжается.
  const exec = () => vt(page).locator('button', { hasText: 'Виконати' });
  for (let k = 0; k < 2; k++) {
    await exec().first().click();
    // Согласие «натискати за вас» — один раз на сайт (решение владельца п.3).
    const allow = chat(page).locator('.vconsent button', {
      hasText: 'Дозволити',
    });
    if (await allow.isVisible({ timeout: 2_000 }).catch(() => false))
      await allow.click();
    await expect(vt(page).locator('span.ok')).toHaveCount(k + 1, {
      timeout: 20_000,
    });
  }
  await next(page);
  // 6. Запреты — все заблокированы; отчёт.
  await expect(vt(page).locator('li.bad')).toHaveCount(0);
  expect(await vt(page).locator('li.ok').count()).toBeGreaterThanOrEqual(5);
  await btn(page, 'Отримати звіт').click();
  await expect(vt(page).locator('.vtres')).toHaveText('Пройдено', {
    timeout: 10_000,
  });
  const rep = (await vcLog()).vt.reports.at(-1)!;
  expect(rep.result).toBe('pass');
  expect(rep.body.snapshot).toBeTruthy();
  expect(
    (rep.body.dry as Array<{ ok: number }>).reduce((a, d) => a + d.ok, 0)
  ).toBeGreaterThanOrEqual(3);
  expect(await violations(page)).toEqual([]);
});

test('мастер Т-2: Permissions-Policy microphone=() — «политика сайта», отчёт fail', async ({
  page,
}) => {
  await start(page, { noMic: true });
  await expect(vt(page).locator('li.ok').first()).toBeVisible({
    timeout: 10_000,
  });
  await next(page);
  await expect(vt(page)).toContainText('Permissions-Policy');
  await btn(page, 'Перевірити мікрофон').click();
  await expect(vt(page)).toContainText('Заборонено політикою сайту');
  await next(page);
  await btn(page, 'Перевірити').click();
  await expect(vt(page)).toContainText('Ці кнопки помічник не натисне ніколи');
  await next(page);
  await next(page);
  await next(page);
  await btn(page, 'Отримати звіт').click();
  await expect(vt(page).locator('.vtres')).toHaveText('Не пройдено', {
    timeout: 10_000,
  });
  const rep = (await vcLog()).vt.reports.at(-1)!;
  expect(rep.result).toBe('fail');
  expect(JSON.stringify(rep.items)).toContain('mic_policy_denied');
});

test('режим test: обычный посетитель — голосовое управление не включено; повторная ссылка — недействительна', async ({
  page,
}) => {
  const pk = newPk();
  const token = `vt${'B'.repeat(30)}${Date.now().toString(36)}`;
  await site(pk, { voice: VOICE, vtTokens: [token] });
  // Ссылку уже использовали (другой посетитель/вкладка).
  await page.goto(
    `${A}/vc/polygon/?pk=${encodeURIComponent(pk)}&v4c_voicetest=${token}`
  );
  await expect(vt(page)).toBeVisible({ timeout: 15_000 });
  const page2 = await page.context().newPage();
  await page2.goto(
    `${A}/vc/polygon/?pk=${encodeURIComponent(pk)}&v4c_voicetest=${token}`
  );
  await expect(chat(page2).locator('.vt')).toContainText(
    'отримайте нове посилання',
    { timeout: 15_000 }
  );
  // Обычный посетитель (без ссылки): команда — «не ввімкнене», 0 планов.
  const p3 = await page.context().browser()!.newPage();
  await p3.goto(`${A}/vc/polygon/?pk=${encodeURIComponent(pk)}`);
  await openChat(p3);
  const before = (await vcLog()).plans.length;
  await chat(p3).locator('.cmp textarea').fill('відкрий доставку');
  await chat(p3).locator('.cmp textarea').press('Enter');
  await expect(chat(p3).locator('.feed')).toContainText('не ввімкнене', {
    timeout: 10_000,
  });
  expect((await vcLog()).plans.length).toBe(before);
  await p3.close();
});

test('решение владельца п.3: согласие «натискати за вас» отзывается в меню виджета — следующая команда спрашивает снова', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { voice: VOICE, voiceControl: { mode: 'on' } });
  await page.goto(`${A}/vc/polygon/?pk=${encodeURIComponent(pk)}&m=1`);
  await openChat(page);
  const ta = chat(page).locator('.cmp textarea');
  await ta.fill('відкрий доставку');
  await ta.press('Enter');
  const allow = chat(page).locator('.vconsent button', {
    hasText: 'Дозволити',
  });
  await allow.click();
  await page.waitForURL(/\/delivery/, { timeout: 15_000 });
  await expect(chat(page).locator('.cmp textarea')).toBeVisible({
    timeout: 15_000,
  });
  const revoke = chat(page).locator('footer button', {
    hasText: 'Заборонити помічнику натискати',
  });
  await expect(revoke).toBeVisible({ timeout: 10_000 });
  await revoke.click();
  await expect(chat(page).locator('.feed')).toContainText(
    'більше не натискатиме'
  );
  await chat(page).locator('.cmp textarea').fill('відкрий каталог');
  await chat(page).locator('.cmp textarea').press('Enter');
  await expect(chat(page).locator('.vconsent')).toBeVisible();
});

test('канарейка: ленивые чанки загрузчика — из /v1/r/<выпуск>/ сайта', async ({
  page,
}) => {
  const rel = 'e2e-canary';
  const dir = path.join(DIST, 'r', rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ['act.js', 'check.js', 'highlight.js', 'engage.js'])
    fs.copyFileSync(path.join(DIST, f), path.join(dir, f));
  try {
    const pk = newPk();
    await site(pk, {
      voice: VOICE,
      voiceControl: { mode: 'on' },
      release: rel,
    });
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(`${A}/vc/polygon/?pk=${encodeURIComponent(pk)}&m=1`);
    await openChat(page);
    await chat(page).locator('.cmp textarea').fill('знайди футболку');
    await chat(page).locator('.cmp textarea').press('Enter');
    await chat(page)
      .locator('.vconsent button', { hasText: 'Дозволити' })
      .click();
    await expect
      .poll(() => urls.some((u) => u.includes(`/v1/r/${rel}/act.js`)), {
        timeout: 10_000,
      })
      .toBe(true);
    expect(urls.some((u) => /\/v1\/act\.js/.test(u))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
