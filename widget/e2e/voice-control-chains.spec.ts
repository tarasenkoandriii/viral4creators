/**
 * Э6-бис (д) «Цепочки действий и откат» в Chromium (ТЗ §5-бис.15 п.13 п.8,
 * п.10 — браузерная часть): стенды React 18 (контролируемые поля) и Vue 3
 * (`v-model`). Сбой посреди цепочки → перечень сделанного с пометками и
 * «Вернуть как было?» → поля возвращаются из ПАМЯТИ загрузчика (act.js →
 * ленивый undo.js) и переживают blur; прежние значения не уходят ни в один
 * запрос (перехват всех запросов страницы и iframe); после перехода —
 * «поля на прежней странице вернуть не могу», 0 попыток. План проверяет
 * настоящий код (`assist-ui-core`), «модель» — фикстура стенда.
 */
import { expect, test, type Page } from '@playwright/test';
import { chat, log, mock, newPk, openChat, origin, site } from './fixtures';
import type { ModelStep } from './stand/ui-plan-mock';

const A = origin('example.localhost');
const VOICE = {
  input: true,
  output: false,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};
const PRIOR = 'ПРЕЖНЄ-7319';

test.beforeEach(async () => {
  await mock('reset');
});

const composer = (page: Page) => chat(page).locator('.cmp textarea');

async function openIfClosed(page: Page) {
  await page.waitForTimeout(300);
  if (
    await composer(page)
      .isVisible()
      .catch(() => false)
  )
    return;
  await openChat(page);
}

async function say(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

async function allow(page: Page) {
  const btn = chat(page).locator('.vconsent button', { hasText: 'Дозволити' });
  await btn.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await btn.isVisible().catch(() => false)) await btn.click();
}

/** Все тела запросов страницы и iframe — для проверки «значения не уходят». */
function capture(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (r) => {
    out.push(`${r.url()} ${r.postData() ?? ''}`);
  });
  return out;
}

const FAIL_CHAIN: Record<string, ModelStep[]> = {
  'знайди футболка і вибери розмір m': [
    { kind: 'fill', find: { assistId: 'search' }, value: 'футболка' },
    { kind: 'select', find: { assistId: 'size' }, value: 'M' },
    { kind: 'wait', expect: { appear: 'Такого тексту на стенді немає' } },
  ],
  'знайди футболка і відкрий доставку': [
    { kind: 'fill', find: { assistId: 'search' }, value: 'футболка' },
    { kind: 'click', find: { assistId: 'nav-delivery' } },
  ],
};

for (const stand of [
  {
    name: 'React 18',
    base: '/vc/react/catalog',
    q: '#r-q',
    size: '#r-size',
    state: 'react',
  },
  {
    name: 'Vue 3',
    base: '/vc/vue/catalog',
    q: '#v-q',
    size: '#v-size',
    state: 'vue',
  },
]) {
  test(`${stand.name}: сбой на шаге 3 — перечень ↺/⇄, «Повернути» возвращает поля из памяти страницы, значение живёт после blur, в запросах прежних значений нет`, async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, {
      voice: VOICE,
      voiceControl: { mode: 'on' },
      vcModel: FAIL_CHAIN,
    });
    const reqs = capture(page);
    await page.goto(`${A}${stand.base}?pk=${encodeURIComponent(pk)}&m=1`);
    // Посетитель сам что-то ввёл до команды — это и есть «прежнее значение».
    await page.locator(stand.q).fill(PRIOR);
    await openIfClosed(page);
    await say(page, 'Знайди футболка і вибери розмір M');
    await allow(page);
    const fr = chat(page);
    await expect(fr.locator('.poffer')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(stand.q)).toHaveValue('футболка');
    await expect(page.locator(stand.size)).toHaveValue('M');
    // Перечень сделанного — с пометками (поле вне формы — ⇄, §5-бис.15 п.3 п.2).
    await expect(fr.locator('body')).toContainText('Уже зроблено:');
    await expect(fr.locator('body')).toContainText('⇄ виберу «M» у «Розмір»');
    await fr.locator('.poffer button.pyes').click();
    await expect(page.locator(stand.q)).toHaveValue(PRIOR, { timeout: 5_000 });
    await expect(page.locator(stand.size)).toHaveValue('');
    // Контролируемое поле не откатило значение после blur.
    await page.locator(stand.q).evaluate((el) => (el as HTMLElement).blur());
    await page.waitForTimeout(200);
    await expect(page.locator(stand.q)).toHaveValue(PRIOR);
    // Состояние фреймворка тоже получило прежнее значение (не только DOM).
    const fw = await page.evaluate(
      (k) =>
        (window as unknown as Record<string, Record<string, unknown>>).__stand[
          k
        ] as { q: string; size: string },
      stand.state
    );
    expect({ q: fw.q, size: fw.size }).toEqual({ q: PRIOR, size: '' });
    await expect(fr.locator('body')).toContainText(
      'Повернув попереднє значення поля'
    );
    const l = (await log()).vc;
    const report = l.undos.find((u) => u.kind === 'report');
    expect(report && JSON.parse(report.raw)).toEqual({
      results: [
        { i: 1, result: 'done' },
        { i: 0, result: 'done' },
      ],
    });
    // Прежнее значение не покинуло страницу: ни в одном запросе.
    await page.waitForTimeout(300);
    expect(reqs.filter((r) => r.includes(PRIOR))).toEqual([]);
    expect(l.bodies.some((b) => b.includes(PRIOR))).toBe(false);
    expect(l.undos.some((u) => u.raw.includes(PRIOR))).toBe(false);
  });
}

test('«Залишити» — ничего не возвращается, сервер получает «оставить»; без ответа — тоже «оставлено» (В-66)', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, {
    voice: VOICE,
    voiceControl: { mode: 'on' },
    vcModel: FAIL_CHAIN,
  });
  await page.goto(`${A}/vc/react/catalog?pk=${encodeURIComponent(pk)}&m=1`);
  await openIfClosed(page);
  await say(page, 'Знайди футболка і вибери розмір M');
  await allow(page);
  const fr = chat(page);
  await expect(fr.locator('.poffer')).toBeVisible({ timeout: 20_000 });
  await fr.locator('.poffer button.pno').click();
  await expect(fr.locator('body')).toContainText('залишаю як є');
  await expect(page.locator('#r-q')).toHaveValue('футболка');
  const l = (await log()).vc;
  expect(l.undos.map((u) => JSON.parse(u.raw))).toEqual([
    { by: 'offer', decision: 'keep' },
  ]);
});

test('после перехода SPA «відміни останнє» — «поля на попередній сторінці повернути не можу», 0 попыток', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, {
    voice: VOICE,
    voiceControl: { mode: 'on' },
    vcModel: FAIL_CHAIN,
  });
  await page.goto(`${A}/vc/react/catalog?pk=${encodeURIComponent(pk)}&m=1`);
  await openIfClosed(page);
  await say(page, 'Знайди футболка і відкрий доставку');
  await allow(page);
  await expect(page).toHaveURL(/\/vc\/react\/delivery/, { timeout: 20_000 });
  await openIfClosed(page);
  await say(page, 'Відміни останнє');
  const fr = chat(page);
  await expect(fr.locator('body')).toContainText(
    'Поля на попередній сторінці повернути не можу',
    { timeout: 10_000 }
  );
  const l = (await log()).vc;
  expect(l.undos.map((u) => JSON.parse(u.raw))).toEqual([
    { by: 'command' },
    { results: [{ i: 0, result: 'gone' }] },
  ]);
});
