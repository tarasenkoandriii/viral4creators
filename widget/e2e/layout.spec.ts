/**
 * Приёмка Э2 п.3 (часть W1, десктоп Chromium): кнопка в каждом из 4 углов,
 * окно раскрывается от угла внутрь, отступы и z-index, своя кнопка
 * (`data-launcher="none"` + `V4CAssist('open')` + якорь), inline в
 * контейнере, «не перекрывать чужое», доступность (button + aria-label,
 * Esc, возврат фокуса, фокус-ловушка), hide/show/position, контраст
 * пресетов в обеих темах (≥ 4.5:1). Живые iOS/Android — владелец.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  chat,
  frameEl,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  panel,
  site,
  stand,
} from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

const VW = 1280;
const VH = 720;

async function boxes(page: Page) {
  const b = (await launcher(page).boundingBox())!;
  const p = await panel(page).boundingBox();
  return { b, p };
}

for (const pos of [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const) {
  test(`угол ${pos}: кнопка в углу с отступами, окно раскрывается внутрь`, async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk);
    await page.setViewportSize({ width: VW, height: VH });
    await page.goto(
      stand('example.localhost', {
        pk,
        attrs: {
          'data-position': pos,
          'data-offset-x': '30',
          'data-offset-y': '40',
        },
      })
    );
    await expect(launcher(page)).toBeVisible();
    const { b } = await boxes(page);
    const right = pos.endsWith('right');
    const bottom = pos.startsWith('bottom');
    expect(Math.round(right ? VW - (b.x + b.width) : b.x)).toBe(30);
    expect(Math.round(bottom ? VH - (b.y + b.height) : b.y)).toBe(40);
    await expect(launcher(page)).toHaveAttribute('aria-label', /чат/i);
    expect(await launcher(page).evaluate((e) => e.tagName)).toBe('BUTTON');
    const z = await launcher(page).evaluate((e) => getComputedStyle(e).zIndex);
    expect(z).toBe('2147483000');
    await openChat(page);
    const { p } = await boxes(page);
    expect(p).not.toBeNull();
    // от угла внутрь: из нижних — над кнопкой, из верхних — под ней; край по той же стороне
    if (bottom) expect(p!.y + p!.height).toBeLessThanOrEqual(b.y);
    else expect(p!.y).toBeGreaterThanOrEqual(b.y + b.height);
    if (right)
      expect(Math.round(p!.x + p!.width)).toBe(Math.round(b.x + b.width));
    else expect(Math.round(p!.x)).toBe(Math.round(b.x));
    expect(p!.y).toBeGreaterThanOrEqual(0);
    expect(p!.y + p!.height).toBeLessThanOrEqual(VH);
  });
}

test('конфиг: угол и отступы из TMA; data-* переопределяет; V4CAssist(position) — на лету', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, {
    config: {
      layout: {
        position: 'top-left',
        offset: { desktop: { x: 50, y: 60 }, mobile: { x: 5, y: 5 } },
        zIndex: 999,
      },
    },
  });
  await page.setViewportSize({ width: VW, height: VH });
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await expect
    .poll(async () => Math.round((await launcher(page).boundingBox())!.x))
    .toBe(50);
  expect(Math.round((await launcher(page).boundingBox())!.y)).toBe(60);
  expect(await launcher(page).evaluate((e) => getComputedStyle(e).zIndex)).toBe(
    '999'
  );
  await page.evaluate(() =>
    (window as unknown as { V4CAssist: (...a: unknown[]) => void }).V4CAssist(
      'position',
      'bottom-right'
    )
  );
  const b = (await launcher(page).boundingBox())!;
  expect(Math.round(VW - b.x - b.width)).toBe(50);
  expect(Math.round(VH - b.y - b.height)).toBe(60);
  await page.goto(
    stand('example.localhost', {
      pk,
      attrs: { 'data-position': 'bottom-left', 'data-z-index': '5' },
    })
  );
  await expect
    .poll(async () =>
      Math.round(VH - (await launcher(page).boundingBox())!.y - 56)
    )
    .toBe(60);
  expect(Math.round((await launcher(page).boundingBox())!.x)).toBe(50);
  expect(await launcher(page).evaluate((e) => getComputedStyle(e).zIndex)).toBe(
    '5'
  );
});

test('своя кнопка: data-launcher="none" — плавающей нет; V4CAssist(open) и якорь открывают; закрытие возвращает фокус', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(
    stand('example.localhost', {
      pk,
      ownButton: true,
      attrs: { 'data-launcher': 'none' },
    })
  );
  await page.waitForTimeout(500);
  await expect(launcher(page)).toBeHidden();
  await expect(frameEl(page)).toHaveCount(0); // лениво: iframe ещё нет
  await page.locator('#own').focus();
  await page.locator('#own').click();
  await expect(panel(page)).toBeVisible();
  await expect(chat(page).locator('.cmp textarea')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('#own')).toBeFocused();
  await page.locator('#anchor').click();
  await expect(panel(page)).toBeVisible();
  expect(new URL(page.url()).hash).toBe(''); // якорь перехвачен, адрес не меняется
});

test('inline: data-container — чат внутри контейнера, без кнопки и окна, высота ≥ 360', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(
    stand('example.localhost', {
      pk,
      container: true,
      attrs: { 'data-container': '#help-chat' },
    })
  );
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  await expect(launcher(page)).toBeHidden();
  const host = page.locator('#help-chat [data-v4c]');
  await expect(host).toHaveCount(1);
  const f = (await frameEl(page).boundingBox())!;
  const c = (await page.locator('#help-chat').boundingBox())!;
  expect(f.height).toBeGreaterThanOrEqual(360);
  expect(f.x).toBeGreaterThanOrEqual(c.x);
  expect(f.y + f.height).toBeLessThanOrEqual(c.y + c.height + 1);
  await expect(chat(page).locator('.hd .x')).toHaveCount(0); // inline — без «закрыть»
  // Контейнер без высоты — минимум 360 px (§3-бис.3).
  await page.goto(
    stand('example.localhost', {
      pk,
      container: 'auto',
      attrs: { 'data-container': '#help-chat' },
    })
  );
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  expect((await frameEl(page).boundingBox())!.height).toBeGreaterThanOrEqual(
    360
  );
  // Селектор — только querySelector: разметка в атрибуте не исполняется.
  await page.goto(
    stand('example.localhost', {
      pk,
      container: true,
      attrs: { 'data-container': '<img src=x onerror=window.__x=1>' },
    })
  );
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(() => (window as unknown as { __x?: number }).__x)
  ).toBeUndefined();
});

test('«не перекрывать чужое»: фиксированный баннер в углу — кнопка сдвигается или уходит в соседний угол', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.setViewportSize({ width: VW, height: VH });
  await page.goto(stand('example.localhost', { pk, obstacle: true }));
  await expect(launcher(page)).toBeVisible();
  const banner = (await page.locator('#cookie-banner').boundingBox())!;
  await expect
    .poll(async () => {
      const b = (await launcher(page).boundingBox())!;
      return b.y + b.height <= banner.y || b.x + b.width <= banner.x;
    })
    .toBe(true);
  // Выключено в конфиге — не двигаем.
  const pk2 = newPk();
  await site(pk2, { config: { layout: { avoidOverlap: false } } });
  await page.goto(stand('example.localhost', { pk: pk2, obstacle: true }));
  await page.waitForTimeout(800);
  const b2 = (await launcher(page).boundingBox())!;
  expect(Math.round(VH - b2.y - b2.height)).toBe(20);
});

test('доступность: Esc в чате закрывает и возвращает фокус на кнопку; Tab не выходит из чата', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  const ta = chat(page).locator('.cmp textarea');
  await ta.focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  const inside = await page
    .frames()
    .find((f) => f.url().includes('/w/v1/frame'))!
    .evaluate(
      () => document.activeElement && document.activeElement !== document.body
    );
  expect(inside).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toBeHidden();
  await expect(launcher(page)).toBeFocused();
  await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
});

test('hide/show и destroy через JS API; очередь вызовов до загрузки', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await expect(launcher(page)).toBeVisible();
  const V = (...a: unknown[]) =>
    page.evaluate(
      (args) =>
        (
          window as unknown as { V4CAssist: (...a: unknown[]) => void }
        ).V4CAssist(...args),
      a
    );
  await V('hide');
  await expect(launcher(page)).toBeHidden();
  await V('show');
  await expect(launcher(page)).toBeVisible();
  await V('ask', 'Вопрос из очереди API');
  await expect(chat(page).locator('.msg.me')).toHaveText(
    'Вопрос из очереди API'
  );
  await V('destroy');
  await expect(page.locator('[data-v4c]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => typeof (window as unknown as { V4CAssist?: unknown }).V4CAssist
    )
  ).toBe('undefined');
  expect((await log()).modelCalls).toHaveLength(1);
});

test('маски путей: hideOn из конфига и data-hide-on скрывают кнопку', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, {
    hosts: [{ origin: 'http://example.localhost:5182', hideOn: ['/spa/*'] }],
  });
  await page.goto(stand('example.localhost', { pk, spa: true }));
  await expect(launcher(page)).toBeVisible();
  await page.locator('#spa-next').click(); // pushState → /spa/2
  await expect(launcher(page)).toBeHidden();
  await page.locator('#spa-back').click();
  await expect(launcher(page)).toBeVisible();
  await page.goto(
    stand('example.localhost', { pk, attrs: { 'data-hide-on': '/page' } })
  );
  await page.waitForTimeout(600);
  await expect(launcher(page)).toBeHidden();
});

test('контраст пресетов: текст на основном цвете и в пузырях ≥ 4.5:1, светлая и тёмная темы', async ({
  page,
}) => {
  const results: string[] = [];
  for (const preset of ['soft', 'strict', 'compact']) {
    for (const theme of ['light', 'dark']) {
      for (const color of ['#1f5fd6', '#ffd400', '#777777', '#0a0a0a']) {
        await mock('reset');
        const pk = newPk();
        await site(pk, {
          config: { brand: { primaryColor: color, preset, theme } },
        });
        await page.goto(stand('example.localhost', { pk }));
        await openChat(page);
        const frame = page
          .frames()
          .find((f) => f.url().includes('/w/v1/frame'))!;
        const pairs = await frame.evaluate(() => {
          const rgb = (s: string) =>
            (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
          const lum = (c: number[]) => {
            const [r, g, b] = c.map((v) => {
              const x = v / 255;
              return x <= 0.03928
                ? x / 12.92
                : Math.pow((x + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          const ratio = (a: string, b: string) => {
            const l1 = lum(rgb(a));
            const l2 = lum(rgb(b));
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          };
          const out: Array<[string, number]> = [];
          const pick = (sel: string, bgSel?: string) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            const bgEl = (
              bgSel ? document.querySelector(bgSel) : el
            ) as HTMLElement | null;
            if (!el || !bgEl) return;
            out.push([
              sel,
              ratio(
                getComputedStyle(el).color,
                getComputedStyle(bgEl).backgroundColor
              ),
            ]);
          };
          pick('.hd .nm span', '.hd');
          pick('.hd .sub', '.hd');
          pick('.greet .bub');
          pick('.ft', '.v4c-chat');
          pick('.sugg button', '.v4c-chat');
          return out;
        });
        for (const [sel, r] of pairs) {
          results.push(`${preset}/${theme}/${color} ${sel} ${r.toFixed(2)}`);
          expect(
            r,
            `${preset}/${theme}/${color} ${sel}`
          ).toBeGreaterThanOrEqual(4.5);
        }
        const btn = await launcher(page).evaluate((e) => [
          getComputedStyle(e).color,
          getComputedStyle(e).backgroundColor,
        ]);
        expect(btn[0]).toMatch(/rgb\((0, 0, 0|255, 255, 255)\)/);
      }
    }
  }
  test
    .info()
    .annotations.push({ type: 'contrast', description: results.join('; ') });
});
