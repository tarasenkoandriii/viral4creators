/**
 * Приёмка Э6 (план, Приложение А «Этап 6») — браузерная часть в Chromium:
 *  - «показать на экране»: подсветка находит элемент на стенд-сайте по
 *    селектору карты интерфейса (рамка вокруг элемента, подпись
 *    `textContent`, элемент прокручен в окно), клик по странице не
 *    перехватывается; под CSP из инструкции и под Trusted Types — без
 *    нарушений;
 *  - нашёл — ТИХО шлёт сигнал «найдено» (`highlight-seen`, Ш4 (4)) один
 *    раз на просьбу; промаха нет;
 *  - после смены вёрстки (и при неоднозначном селекторе) — ТИХО не
 *    подсвечивает и пишет сигнал «карта устарела» (`highlight-miss`);
 *  - чужие сообщения: страница не может ни заставить загрузчик подсветить,
 *    ни заставить iframe послать сигнал («нашёл» или «не нашёл») о том, о
 *    чём он не просил;
 *  - видео-ответ: ролик играет в окне чата по подписанной ссылке своего
 *    origin (редирект), выключенный ролик — «видео недоступно».
 * Барьеры «ролик сайта A — не на сайте B», «неодобренный — не
 * предлагается» — sites-backend `acceptance/e6/*.spec.ts` (мок W2 их не
 * воспроизводит).
 */
import { test, expect, type Page } from '@playwright/test';
import {
  WIDGET_MESSAGE_NS,
  WIDGET_PROTOCOL_VERSION,
  ask,
  chat,
  log,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';
import type { StandSpec } from './stand/server';

const INSTRUCTION =
  "default-src 'self'; script-src 'self' {W}; frame-src {W}; img-src 'self' {W}; connect-src 'self' {W}; style-src 'self'";
const TT = `${INSTRUCTION}; require-trusted-types-for 'script'; trusted-types 'none'`;

test.beforeEach(async ({ page }) => {
  await mock('reset');
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`)
    );
  });
});

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

const ring = (page: Page) => page.locator('[data-v4c-highlight]');

async function setup(page: Page, spec: Omit<StandSpec, 'pk'>) {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, lang: 'ru', ...spec }));
  await openChat(page);
  return pk;
}

async function askShow(page: Page, q = '__hl__ Где кнопка «Купить»?') {
  await ask(page, q);
  await waitAnswer(page);
  await chat(page)
    .locator('.msg.bot .act', { hasText: 'Показать на странице' })
    .click();
}

for (const [name, csp] of [
  ['CSP из инструкции', INSTRUCTION],
  ['CSP из инструкции + Trusted Types', TT],
] as const) {
  test(`подсветка находит элемент на стенд-сайте (${name}): рамка вокруг, подпись, прокрутка, нарушений нет`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await setup(page, { uiKit: 'v1', csp });
    await askShow(page);
    await expect(ring(page)).toHaveCount(1);
    const target = page.locator('#cta-buy');
    await expect(target).toBeInViewport();
    // Рамка следует за элементом (плавная прокрутка) и в итоге его обводит.
    await expect
      .poll(async () => {
        const box = await ring(page).boundingBox();
        const t = await target.boundingBox();
        return (
          !!box &&
          !!t &&
          box.x <= t.x &&
          box.y <= t.y &&
          box.x + box.width >= t.x + t.width &&
          box.y + box.height >= t.y + t.height
        );
      })
      .toBe(true);
    // Подпись — текст карты сервера, через textContent (не разметка).
    await expect(
      page.locator('[role="status"]', { hasText: 'Кнопка «Купить»' })
    ).toBeVisible();
    // Слой не перехватывает клики: страница остаётся рабочей.
    expect(
      await ring(page).evaluate((e) => getComputedStyle(e).pointerEvents)
    ).toBe('none');
    // Ш4 (4): «найдено» — один сигнал по элементу, который просили показать.
    await expect.poll(async () => (await log()).highlightSeen.length).toBe(1);
    const seen = (await log()).highlightSeen[0];
    expect(seen).toMatchObject({ elementId: 'u1a2b3c4d' });
    expect(seen.pageUrl).toContain('example.localhost');
    await page.waitForTimeout(300);
    expect((await log()).highlightMisses).toEqual([]);
    expect((await log()).highlightSeen).toHaveLength(1);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    // Нажали на странице — подсветка своё сделала и ушла.
    await page.mouse.click(5, 5);
    await expect(ring(page)).toHaveCount(0);
  });
}

for (const [name, kit] of [
  ['вёрстка сменилась (селектора больше нет)', 'v2'],
  ['селектор неоднозначен (два элемента)', 'dup'],
] as const) {
  test(`${name}: тихо не подсвечивает и пишет сигнал «карта устарела»`, async ({
    page,
  }) => {
    const pk = await setup(page, { uiKit: kit, csp: INSTRUCTION });
    await askShow(page);
    await expect.poll(async () => (await log()).highlightMisses.length).toBe(1);
    const miss = (await log()).highlightMisses[0];
    expect(miss).toMatchObject({ pk, elementId: 'u1a2b3c4d' });
    expect(miss.pageUrl).toContain('example.localhost');
    await expect(ring(page)).toHaveCount(0);
    expect((await log()).highlightSeen).toEqual([]);
    // «Тихо»: посетителю — ни ошибки, ни уведомления.
    await expect(chat(page).locator('.note')).toHaveCount(0);
    expect(await violations(page)).toEqual([]);
  });
}

test('чужие сообщения: страница не может заставить загрузчик подсветить, а iframe — послать сигнал без просьбы', async ({
  page,
}) => {
  const pk = await setup(page, { uiKit: 'v1' });
  await ask(page, 'обычный вопрос');
  await waitAnswer(page);
  // Скрипт страницы шлёт «highlight» самому окну (как будто от iframe).
  await page.evaluate(
    ([ns, v]) => {
      window.postMessage(
        {
          ns,
          v,
          type: 'highlight',
          elementId: 'u1a2b3c4d',
          selector: '#cta-buy',
          caption: 'подделка',
        },
        '*'
      );
    },
    [WIDGET_MESSAGE_NS, WIDGET_PROTOCOL_VERSION] as const
  );
  // …и «highlight-result: не нашёл / нашёл» прямо в iframe (окно того же
  // origin достаёт iframe через открытый shadowRoot).
  for (const found of [false, true])
    await page.evaluate(
      ([ns, v, found]) => {
        const f = document
          .querySelector('[data-v4c]')!
          .shadowRoot!.querySelector('iframe')!;
        f.contentWindow!.postMessage(
          {
            ns,
            v,
            type: 'highlight-result',
            elementId: 'u1a2b3c4d',
            found,
          },
          '*'
        );
      },
      [WIDGET_MESSAGE_NS, WIDGET_PROTOCOL_VERSION, found] as const
    );
  await page.waitForTimeout(800);
  await expect(ring(page)).toHaveCount(0);
  expect((await log()).highlightMisses.filter((m) => m.pk === pk)).toEqual([]);
  expect((await log()).highlightSeen.filter((m) => m.pk === pk)).toEqual([]);
});

test('видео-ответ: ролик играет в окне чата по подписанной ссылке своего origin, CSP без нарушений', async ({
  page,
}) => {
  await setup(page, { csp: INSTRUCTION });
  await ask(page, '__video__ Как оформить заказ?');
  await waitAnswer(page);
  await chat(page)
    .locator('.msg.bot .act', { hasText: 'Смотреть видео' })
    .click();
  const video = chat(page).locator('.vid video');
  await expect(video).toBeVisible();
  expect(await video.getAttribute('src')).toMatch(/^\/widget\/v1\/video\/v1\./);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThanOrEqual(1);
  const l = await log();
  expect(l.videoLinks).toEqual([
    expect.objectContaining({ videoId: 'vid_ok', ok: true }),
  ]);
  expect(l.videoRedirects).toBeGreaterThanOrEqual(1);
  expect(await violations(page)).toEqual([]);
  await chat(page).locator('.vid .lnk').click();
  await expect(video).toHaveCount(0);
});

test('видео-ответ: ролик выключен владельцем к моменту клика — «видео недоступно», плеера нет', async ({
  page,
}) => {
  await setup(page, {});
  await ask(page, '__video__ __video_gone__ Как оформить заказ?');
  await waitAnswer(page);
  await chat(page)
    .locator('.msg.bot .act', { hasText: 'Смотреть видео' })
    .click();
  await expect(
    chat(page).locator('.note', { hasText: 'Видео сейчас недоступно' })
  ).toBeVisible();
  await expect(chat(page).locator('.vid')).toHaveCount(0);
});
