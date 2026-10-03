/**
 * ТЗ §4-бис.10 (часть W1, Chromium + МОК W2): п.1 MPA 5 страниц, п.2 SPA,
 * п.3 перезагрузка посреди стрима, п.5 две вкладки (текст), п.6 «через
 * день» с подменой часов (CHIPS) и переход example → shop.example, п.7 скан
 * хранилища страницы, п.9 имена каналов; плюс «удалить мой диалог» и 👍/👎.
 * Серверные половины (база, роль, идемпотентность W3, resume между хостами
 * по правилам W2) — спеки W2/W3; здесь мок повторяет только протокол.
 */
import {
  test,
  expect,
  chromium,
  type Page,
  type Frame,
} from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  A,
  SHOP,
  WIDGET_CHANNEL_PREFIX,
  WIDGET_STORAGE_PREFIX,
  ask,
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
  waitAnswer,
} from './fixtures';

test.beforeEach(async () => {
  await mock('reset');
});

function chatFrame(page: Page): Frame {
  const f = page.frames().find((x) => x.url().includes('/w/v1/frame'));
  if (!f) throw new Error('нет iframe чата');
  return f;
}

test('§4-бис.10 п.1 MPA, 5 страниц: открыт, диалог, черновик и прокрутка на месте; каркас ≤ 300 мс', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.addInitScript(() => {
    // Момент появления хоста виджета относительно конца загрузки loader.js.
    const w = window as unknown as { __hostAt?: number };
    new MutationObserver(() => {
      if (!w.__hostAt && document.querySelector('[data-v4c]'))
        w.__hostAt = performance.now();
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(stand('example.localhost', { pk, n: 1 }));
  await openChat(page);
  for (let i = 1; i <= 3; i++) {
    await ask(page, `Вопрос номер ${i}`);
    await waitAnswer(page, i);
  }
  await chat(page).locator('.cmp textarea').fill('недописанный черновик');
  // Прокрутить ленту к первому ответу — это место должно вернуться.
  const firstId = await chat(page)
    .locator('.msg.bot[data-mid]')
    .first()
    .getAttribute('data-mid');
  await chatFrame(page).evaluate((id) => {
    const el = document.querySelector(`[data-mid="${id}"]`) as HTMLElement;
    const feed = document.querySelector('.feed') as HTMLElement;
    feed.scrollTop = el.offsetTop + el.offsetHeight - feed.clientHeight;
    feed.dispatchEvent(new Event('scroll'));
  }, firstId);
  const feedLatency: number[] = [];
  for (let n = 2; n <= 5; n++) {
    const t0 = Date.now();
    await page.locator(`#p${n}`).click();
    await expect(page.locator('#h')).toHaveText(new RegExp(`Страница ${n}`));
    await expect(panel(page)).toBeVisible();
    const skeleton = await page.evaluate(() => {
      const w = window as unknown as { __hostAt?: number };
      const e = performance
        .getEntriesByType('resource')
        .find((r) =>
          r.name.includes('/v1/loader.js')
        ) as PerformanceResourceTiming;
      return (w.__hostAt ?? 1e9) - e.responseEnd;
    });
    expect(skeleton, `каркас окна на стр. ${n}`).toBeLessThanOrEqual(300);
    await expect(chat(page).locator('.msg.me')).toHaveCount(3);
    feedLatency.push(Date.now() - t0);
    await expect(chat(page).locator('.cmp textarea')).toHaveValue(
      'недописанный черновик'
    );
    const visible = await chatFrame(page).evaluate((id) => {
      const el = document.querySelector(`[data-mid="${id}"]`) as HTMLElement;
      const feed = document.querySelector('.feed') as HTMLElement;
      const r = el.getBoundingClientRect();
      const f = feed.getBoundingClientRect();
      return r.bottom <= f.bottom + 2 && r.bottom >= f.top;
    }, firstId);
    expect(visible, `прокрутка на стр. ${n}`).toBe(true);
  }
  feedLatency.sort((a, b) => a - b);
  const p75 = feedLatency[Math.ceil(feedLatency.length * 0.75) - 1];
  test
    .info()
    .annotations.push({ type: 'feed-p75-ms', description: String(p75) });
  expect(p75).toBeLessThanOrEqual(1000);
});

test('§4-бис.10 п.2 SPA: 5 переходов — iframe не перезагружается, контекст страницы в следующем вопросе — новый URL', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk, spa: true }));
  await openChat(page);
  for (let i = 0; i < 5; i++) await page.locator('#spa-next').click();
  await page.locator('#spa-back').click();
  await page.locator('#spa-next').click();
  await ask(page, 'Где я?');
  await waitAnswer(page);
  const l = await log();
  expect(l.requests.filter((r) => r.path === '/w/v1/frame')).toHaveLength(1);
  expect(
    l.requests.filter((r) => r.path === '/widget/v1/session')
  ).toHaveLength(1);
  const pg = l.modelCalls[0].page;
  // 5 × вперёд (/spa/6), назад (popstate → /spa/5), вперёд (/spa/7)
  expect(new URL(pg.url as string).pathname).toBe('/spa/7');
  expect(pg.title).toBe('SPA 7');
});

test('§4-бис.10 п.2 SPA без Navigation API (Safari/Firefox): ловим pushState/replaceState/popstate обёрткой', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.addInitScript(() => {
    delete (window as unknown as { navigation?: unknown }).navigation;
    Object.defineProperty(window, 'navigation', {
      value: undefined,
      configurable: true,
    });
  });
  await page.goto(stand('example.localhost', { pk, spa: true }));
  await openChat(page);
  const pathOf = async (i: number) =>
    new URL((await log()).modelCalls[i].page.url as string).pathname;
  await page.locator('#spa-next').click();
  await page.locator('#spa-next').click(); // pushState → /spa/3
  await ask(page, 'После pushState');
  await waitAnswer(page, 1);
  expect(await pathOf(0)).toBe('/spa/3');
  await page.evaluate(() =>
    history.replaceState(null, '', '/spa/replaced?x=1')
  );
  await ask(page, 'После replaceState');
  await waitAnswer(page, 2);
  expect(await pathOf(1)).toBe('/spa/replaced');
  await page.locator('#spa-back').click(); // popstate → /spa/2
  await expect
    .poll(() => page.evaluate(() => location.pathname))
    .toBe('/spa/2');
  await ask(page, 'После popstate');
  await waitAnswer(page, 3);
  expect(await pathOf(2)).toBe('/spa/2');
  const l = await log();
  expect(l.requests.filter((r) => r.path === '/w/v1/frame')).toHaveLength(1);
});

test('§4-бис.10 п.3 перезагрузка посреди стрима: полный ответ после F5, модель вызвана ровно один раз', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await mock('set', { tokenDelayMs: 150 });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Длинный ответ, пожалуйста');
  await expect(chat(page).locator('.msg.bot').last()).toContainText(
    'Ответ на вопрос'
  );
  await page.waitForTimeout(1000);
  await page.reload();
  // Окно восстановлено открытым (sessionStorage страницы), ответ дописывается из «базы».
  await expect(panel(page)).toBeVisible();
  await expect(chat(page).locator('.msg.bot').last()).toContainText('слово24', {
    timeout: 20_000,
  });
  await expect(chat(page).locator('.msg.bot').last()).toContainText('[S1]');
  await waitAnswer(page);
  const l = await log();
  expect(l.modelCalls).toHaveLength(1);
  expect(l.convs[0].messages).toBe(2);
  // Повтор того же clientRequestId — тот же ответ без нового вызова модели.
  await chatFrame(page).evaluate(
    ([k, q, crid]) =>
      sessionStorage.setItem(k, JSON.stringify({ crid, q, conv: null })),
    [
      `${WIDGET_STORAGE_PREFIX}:${pk}:${A}:pending`,
      'Длинный ответ, пожалуйста',
      l.modelCalls[0].crid,
    ]
  );
  await page.reload();
  await expect(chat(page).locator('.msg.bot').last()).toContainText('слово24');
  expect((await log()).modelCalls).toHaveLength(1);
});

test('§4-бис.10 п.5 две вкладки: ответ из первой виден во второй ≤ 2 с; окно — своё у каждой', async ({
  context,
}) => {
  const pk = newPk();
  await site(pk);
  const t1 = await context.newPage();
  const t2 = await context.newPage();
  await t1.goto(stand('example.localhost', { pk }));
  await openChat(t1);
  await t2.goto(stand('example.localhost', { pk }));
  await openChat(t2);
  await ask(t1, 'Вопрос из первой вкладки');
  await waitAnswer(t1);
  const t0 = Date.now();
  await expect(chat(t2).locator('.msg.bot').last()).toContainText('слово24', {
    timeout: 2000,
  });
  await expect(chat(t2).locator('.msg.me')).toHaveText(
    'Вопрос из первой вкладки'
  );
  expect(Date.now() - t0).toBeLessThanOrEqual(2000);
  // Закрыли окно во второй — первая не закрылась (состояние окна — во вкладке).
  await launcher(t2).click();
  await expect(panel(t2)).toBeHidden();
  await expect(panel(t1)).toBeVisible();
});

test('§4-бис.10 п.6 «через день» (подмена часов): продолжение по CHIPS-cookie после перезапуска браузера, даже без localStorage iframe', async () => {
  test.setTimeout(90_000);
  const pk = newPk();
  await site(pk);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v4c-e2e-'));
  const launch = () =>
    chromium.launchPersistentContext(dir, {
      viewport: { width: 1280, height: 720 },
    });
  // «Вчера» — часы сервера на 25 ч назад: диалог и visitor-token выданы сутки назад.
  await mock('set', { clock: -25 * 3600e3 });
  let ctx = await launch();
  let page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Вопрос вчера');
  await waitAnswer(page);
  // Стираем копию указателя в localStorage iframe — остаётся только CHIPS-cookie (Safari ≥ 26.2 / Chrome).
  await chatFrame(page).evaluate(() => localStorage.clear());
  await ctx.close(); // перезапуск браузера: sessionStorage (visitor-token) пропал

  await mock('set', { clock: 0 }); // «сегодня»
  ctx = await launch();
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await expect(chat(page).locator('.msg.me')).toHaveText('Вопрос вчера');
  await expect(chat(page).locator('.note.resume')).toBeVisible(); // «продолжить / новый вопрос»
  const s = (await log()).sessions.at(-1)!;
  expect(s).toMatchObject({
    resumed: true,
    cookie: true,
    body: false,
    resumeLost: false,
  });
  // «Новый вопрос» — чистая лента; следующий вопрос — новый диалог.
  await chat(page).getByRole('button', { name: 'Новый вопрос' }).click();
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  await ask(page, 'Вопрос сегодня');
  await waitAnswer(page);
  expect((await log()).convs).toHaveLength(2);
  await ctx.close();

  // Через 8 дней (> 7 сут) — чистое приветствие, без старого диалога.
  await mock('set', { clock: 8 * 24 * 3600e3 });
  ctx = await launch();
  page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  await expect(chat(page).locator('.greet')).toBeVisible();
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('§4-бис.10 п.6 переход example.com → shop.example.com (оба verified одного сайта) — диалог тот же; другой сайт того же eTLD+1 — нет', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk); // A и SHOP
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Вопрос на example');
  await waitAnswer(page);
  await page.goto(stand('shop.example.localhost', { pk }));
  await openChat(page);
  await expect(chat(page).locator('.msg.me')).toHaveText('Вопрос на example');
  const s = (await log()).sessions.at(-1)!;
  expect(s).toMatchObject({ parentOrigin: SHOP, resumed: true, cookie: true });
  // Другой сайт (свой pk) на blog.example.localhost — секция хранилища та же, диалога нет.
  const pk2 = newPk();
  await site(pk2, { allowedOrigins: ['http://blog.example.localhost:5182'] });
  await page.goto(stand('blog.example.localhost', { pk: pk2 }));
  await openChat(page);
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  expect((await log()).sessions.at(-1)!.resumed).toBe(false);
  // Интеграция Э2: blog (pk2) поставил СВОЙ указатель в ту же секцию CHIPS —
  // указатель первого сайта цел: возврат на example в НОВОЙ вкладке (без
  // токена в sessionStorage — новая сессия) — тот же диалог по cookie.
  const back = await page.context().newPage();
  await back.goto(stand('example.localhost', { pk }));
  await openChat(back);
  await expect(chat(back).locator('.msg.me')).toHaveText('Вопрос на example');
  expect((await log()).sessions.at(-1)!).toMatchObject({
    resumed: true,
    resumeLost: false,
    cookie: true,
  });
});

test('§4-бис.10 п.7 приватность: в хранилище и cookie страницы — только «<pk>:ui», без текста и токенов', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Секретный вопрос +380501112233');
  await waitAnswer(page);
  await chat(page).locator('.cmp textarea').fill('черновик-секрет');
  await page.locator('#p2').click();
  await expect(chat(page).locator('.msg.me')).toHaveCount(1);
  const dump = await page.evaluate(() => {
    const all = (s: Storage) =>
      Object.fromEntries(
        Array.from({ length: s.length }, (_, i) => [
          s.key(i)!,
          s.getItem(s.key(i)!),
        ])
      );
    return {
      local: all(localStorage),
      session: all(sessionStorage),
      cookie: document.cookie,
    };
  });
  expect(dump.local).toEqual({});
  expect(dump.cookie).toBe('');
  expect(Object.keys(dump.session)).toEqual([
    `${WIDGET_STORAGE_PREFIX}:${pk}:ui`,
  ]);
  // Э3: в том же значении — сигналов за визит и «закрыл» (без нового ключа);
  // Э6-бис: пятое поле — «план голосового управления идёт» (флаг, без текста).
  expect(dump.session[`${WIDGET_STORAGE_PREFIX}:${pk}:ui`]).toMatch(
    /^(open|min|closed):\d+:[0-2]:[01]:[01]$/
  );
  const flat = JSON.stringify(dump);
  for (const bad of ['Секретный', '380501112233', 'черновик', 'vt_', 'resume'])
    expect(flat).not.toContain(bad);
  // А в iframe (наш origin) указатель и токен есть — ключи с pk и origin родителя.
  const inFrame = await chatFrame(page).evaluate(() => ({
    l: Object.keys(localStorage),
    s: Object.keys(sessionStorage),
  }));
  expect(inFrame.l).toContain(`${WIDGET_STORAGE_PREFIX}:${pk}:${A}:resume`);
  expect(inFrame.s).toContain(`${WIDGET_STORAGE_PREFIX}:${pk}:${A}:token`);
});

test('§4-бис.10 п.9 имена каналов: BroadcastChannel «<префикс>:<pk>:<origin родителя>», по каналу — только указатели', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.addInitScript(() => {
    if (!location.pathname.startsWith('/w/v1/frame')) return;
    const w = window as unknown as { __bc: string[]; __bcMsg: unknown[] };
    w.__bc = [];
    w.__bcMsg = [];
    const Orig = BroadcastChannel;
    class Rec extends Orig {
      constructor(name: string) {
        super(name);
        w.__bc.push(name);
      }
      postMessage(m: unknown) {
        w.__bcMsg.push(m);
        super.postMessage(m);
      }
    }
    (
      window as unknown as { BroadcastChannel: typeof BroadcastChannel }
    ).BroadcastChannel = Rec;
  });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Текст, который не должен уйти в канал');
  await waitAnswer(page);
  const rec = await chatFrame(page).evaluate(() => {
    const w = window as unknown as { __bc: string[]; __bcMsg: unknown[] };
    return { names: w.__bc, msgs: w.__bcMsg };
  });
  expect(rec.names).toEqual([`${WIDGET_CHANNEL_PREFIX}:${pk}:${A}`]);
  expect(rec.msgs.length).toBeGreaterThan(0);
  for (const m of rec.msgs)
    expect(String(m)).toMatch(/^(message|state):[A-Za-z0-9_-]+$|^reset$/);
});

test('«удалить мой диалог»: подтверждение → диалог и указатель стёрты, новая сессия без resume; вторая вкладка сброшена', async ({
  context,
}) => {
  const pk = newPk();
  await site(pk);
  const page = await context.newPage();
  const other = await context.newPage();
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Удалите меня');
  await waitAnswer(page);
  await other.goto(stand('example.localhost', { pk }));
  await openChat(other);
  await expect(chat(other).locator('.msg.me')).toHaveCount(1);
  const before = await log();
  const oldVisitor = before.sessions[0].visitorId;
  await chat(page).getByRole('button', { name: 'Удалить мой диалог' }).click();
  await chat(page)
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  await expect(chat(page).getByText('Диалог удалён.')).toBeVisible();
  await expect(chat(other).locator('.msg.me')).toHaveCount(0, {
    timeout: 3000,
  });
  const l = await log();
  expect(l.forgets).toBe(1);
  expect(l.convs).toHaveLength(0);
  const after = l.sessions.slice(before.sessions.length);
  expect(after.length).toBeGreaterThan(0);
  expect(after[0].resumed).toBe(false); // новый посетитель, указатель стёрт
  for (const s of after) expect(s.visitorId).not.toBe(oldVisitor);
  await page.reload();
  await openChat(page);
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
});

test('👍/👎 и «позвать человека» → форма лида', async ({ page }) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Оцените меня');
  await waitAnswer(page);
  await chat(page).getByRole('button', { name: 'Бесполезный ответ' }).click();
  await expect(chat(page).getByText('Спасибо за оценку')).toBeVisible();
  const fb = (await log()).feedback;
  expect(fb).toHaveLength(1);
  expect(fb[0].rating).toBe(-1);
  expect(typeof fb[0].messageId).toBe('string');
  // Лид без согласия — не уходит.
  await chat(page).getByRole('button', { name: 'Оставить заявку' }).click();
  await chat(page).locator('input[name=phone]').fill('+380 50 000 00 00');
  await chat(page).locator('form.lead button[type=submit]').click();
  await expect(chat(page).getByRole('alert')).toHaveText(
    'Нужно согласие на обработку данных.'
  );
  expect((await log()).leads).toHaveLength(0);
  await expect(chat(page).locator('.lead .cons span')).toHaveText(
    'Согласен на обработку данных (стенд)'
  );
});

test('ошибки стрима: site_quota → форма лида с текстом; upstream → «повторить?»', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'error:site_quota');
  await expect(
    chat(page).getByText('Лимит ответов на сегодня исчерпан', { exact: false })
  ).toBeVisible();
  await expect(chat(page).locator('form.lead')).toBeVisible();
  await ask(page, 'error:upstream');
  await expect(
    chat(page).getByRole('button', { name: 'Повторить' })
  ).toBeVisible();
  await expect(frameEl(page)).toHaveCount(1);
});

test('поток закрылся без meta — заглушка «печатает…» не висит, предложен повтор', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'вопрос __empty_stream__');
  await expect(
    chat(page).getByRole('button', { name: 'Повторить' })
  ).toBeVisible();
  await expect(chat(page).locator('.msg.bot .dots')).toHaveCount(0);
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
});
