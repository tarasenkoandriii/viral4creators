/**
 * Э3 (W): проактивные триггеры и лимиты навязчивости (№41, §5-тер.12),
 * цели и атрибуция в пределах документа (§5-тер.16 п.1, п.7), счётчики
 * событий, `navigator.webdriver`, приватность «без согласия» (п.2), режим
 * выбора цели (п.6), сценарии. На МОКЕ стенда: мок проверяет то же, что
 * сервер W на своей стороне (Origin, белый список полей, формат цели);
 * бизнес-правила A (дедуп/атрибуция) — упрощённая копия (см. шапку мока).
 */
import { expect, test, type Page } from '@playwright/test';
import {
  A,
  OTHER,
  WIDGET,
  ask,
  chat,
  eventKinds,
  humanBrowser,
  launcher,
  log,
  mock,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

const bubble = (page: Page) => page.locator('[data-v4c] .g');

test.beforeEach(async () => {
  await mock('reset');
});

const T_TIME = {
  key: 'delivery',
  enabled: true,
  condition: { kind: 'time_on_page', seconds: 10 },
  pathMasks: [],
  text: { ru: 'Подсказать про доставку?', uk: 'Підказати про доставку?' },
  onAccept: { kind: 'prefill', question: { ru: 'Сколько стоит доставка?' } },
};
const T_SCROLL = {
  key: 'scrolled',
  enabled: true,
  condition: { kind: 'scroll_depth', percent: 5 },
  pathMasks: [],
  text: { ru: 'Нужна помощь с выбором?' },
  onAccept: { kind: 'open' },
};
const engagement = (triggers: unknown[], perVisit: 1 | 2 = 1) => ({
  schema: 1,
  triggers,
  limits: {
    perVisit,
    excludedPaths: ['/checkout*'],
    notOnFirstScreenMobile: true,
  },
  scenarios: [],
});

const GOALS = [
  {
    key: 'thanks',
    detectors: [
      { kind: 'url', config: { pathMask: '/thanks', fromPathMask: null } },
    ],
    valueMode: 'none',
  },
  {
    key: 'purchase',
    detectors: [{ kind: 'js', config: {} }],
    valueMode: 'event',
  },
  {
    key: 'call',
    detectors: [{ kind: 'click', config: { auto: 'tel' } }],
    valueMode: 'none',
  },
  {
    key: 'buy',
    detectors: [
      {
        kind: 'click',
        config: {
          descriptor: {
            assistGoal: 'buy',
            assistId: null,
            role: null,
            text: null,
            tag: null,
          },
          pathMask: null,
        },
      },
    ],
    valueMode: 'none',
  },
  {
    key: 'order',
    detectors: [
      {
        kind: 'click',
        config: {
          descriptor: {
            assistGoal: null,
            assistId: null,
            role: 'button',
            text: 'Оформить заказ',
            tag: 'button',
          },
          pathMask: '/page',
        },
      },
    ],
    valueMode: 'none',
  },
  {
    key: 'sub',
    detectors: [
      {
        kind: 'form_submit',
        config: {
          descriptor: {
            assistGoal: 'sub',
            assistId: null,
            role: 'form',
            text: null,
            tag: 'form',
          },
          pathMask: null,
        },
      },
    ],
    valueMode: 'none',
  },
  {
    key: 'send',
    detectors: [
      {
        kind: 'form_submit',
        config: {
          descriptor: {
            assistGoal: null,
            assistId: null,
            role: 'form',
            text: 'отправить',
            tag: 'form',
          },
          pathMask: null,
        },
      },
    ],
    valueMode: 'none',
  },
];

/** Уйти со страницы — загрузчик отправит пакет счётчиков (pagehide → sendBeacon). */
async function leave(page: Page) {
  const before = (await log()).events.length;
  await page.goto('about:blank');
  // Маяк асинхронный: ждём, пока пакет дойдёт до мока (или 3 с — пакета нет).
  await expect
    .poll(async () => (await log()).events.length, { timeout: 3000 })
    .toBeGreaterThan(before)
    .catch(() => undefined);
}

const goalsOf = async (key?: string) =>
  (await log()).goals.filter((g) => !key || g.goalKey === key);

test.describe('проактивные триггеры: лимиты навязчивости (§5-тер.12, №41)', () => {
  test('не раньше 10 с; пузырь role=status, ничего не открывается само; два условия подряд → один сигнал', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { engagement: engagement([T_TIME, T_SCROLL]) });
    await page.goto(stand('example.localhost', { pk, long: true }));
    await expect(launcher(page)).toBeVisible();
    // Прокрутка выполнила условие scroll сразу, но до 10 с — тишина (п.3).
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(3000);
    await expect(bubble(page)).toHaveCount(0);
    await expect(bubble(page)).toHaveCount(1, { timeout: 12_000 });
    await expect(bubble(page)).toHaveAttribute('role', 'status');
    // Само ничего не открылось (п.1): окна и iframe нет.
    await expect(page.locator('[data-v4c] iframe')).toHaveCount(0);
    await expect(launcher(page)).toHaveAttribute('aria-expanded', 'false');
    // Второе условие и ещё секунды — второго сигнала нет (perVisit = 1).
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(2500);
    await expect(bubble(page)).toHaveCount(1);
    await leave(page);
    const kinds = await eventKinds();
    expect(kinds.filter((k) => k.startsWith('proactive_shown'))).toHaveLength(
      1
    );
    expect(kinds).toContain('widget_view');
  });

  test('закрыл сигнал — до конца визита ни одного (и на следующей странице MPA)', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { engagement: engagement([T_TIME, T_SCROLL], 2) });
    await page.goto(stand('example.localhost', { pk, long: true }));
    await expect(bubble(page)).toHaveCount(1, { timeout: 14_000 });
    await bubble(page)
      .getByRole('button', { name: 'Закрыть подсказку' })
      .click();
    await expect(bubble(page)).toHaveCount(0);
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(2500);
    await expect(bubble(page)).toHaveCount(0);
    await page.locator('#p2').click();
    await expect(page.locator('#h')).toContainText('Страница 2');
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(12_000);
    await expect(bubble(page)).toHaveCount(0);
    await leave(page);
    const kinds = await eventKinds();
    expect(kinds).toContain('proactive_dismissed:delivery');
    expect(kinds.filter((k) => k.startsWith('proactive_shown'))).toHaveLength(
      1
    );
  });

  test('на шаге оплаты (исключённый путь) сигнала нет', async ({ page }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { engagement: engagement([T_TIME]) });
    await page.goto(stand('example.localhost', { pk }, '/checkout/pay'));
    await expect(launcher(page)).toBeVisible();
    await page.waitForTimeout(12_000);
    await expect(bubble(page)).toHaveCount(0);
  });

  test('принять сигнал: окно открывается, вопрос — префилл без автоотправки; первый вопрос — openedBy proactive', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { engagement: engagement([T_TIME]) });
    await page.goto(stand('example.localhost', { pk }));
    await expect(bubble(page)).toHaveCount(1, { timeout: 14_000 });
    await bubble(page)
      .getByRole('button', { name: 'Подсказать про доставку?' })
      .click();
    const ta = chat(page).locator('.cmp textarea');
    await expect(ta).toHaveValue('Сколько стоит доставка?');
    await page.waitForTimeout(800);
    expect((await log()).modelCalls).toHaveLength(0);
    await ta.press('Enter');
    await waitAnswer(page);
    const l = await log();
    expect(l.modelCalls[0].openedBy).toBe('proactive:delivery');
    expect(l.convs[0].openedBy).toBe('proactive:delivery');
  });

  test('статус lead_only — триггеров нет', async ({ page }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { status: 'lead_only', engagement: engagement([T_TIME]) });
    await page.goto(stand('example.localhost', { pk }));
    await page.waitForTimeout(12_000);
    await expect(bubble(page)).toHaveCount(0);
  });
});

test.describe('цели (§5-тер.16 п.1, п.7) и счётчики', () => {
  test('navigator.webdriver → без аналитики: ни целей, ни счётчиков', async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, { goals: GOALS, engagement: engagement([T_TIME]) });
    await page.goto(
      stand('example.localhost', { pk, goalsKit: true }, '/thanks')
    );
    await expect(launcher(page)).toBeVisible();
    await page.locator('#buy').click();
    await page.evaluate(() =>
      (window as unknown as { V4CAssist: (...a: unknown[]) => void }).V4CAssist(
        'goal',
        'purchase',
        { orderId: 'A-1' }
      )
    );
    await openChat(page);
    await leave(page);
    const l = await log();
    expect(l.goalCalls).toBe(0);
    expect(l.events).toHaveLength(0);
  });

  test('URL «спасибо», js-цель и лид — по одному; двойной orderId — одно; url — раз на документ', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { goals: GOALS });
    await page.addInitScript(() => {
      const w = window as unknown as {
        V4CAssist: ((...a: unknown[]) => void) & { q?: unknown[] };
      };
      w.V4CAssist = function (...a: unknown[]) {
        (w.V4CAssist.q = w.V4CAssist.q || []).push(a);
      } as typeof w.V4CAssist;
      w.V4CAssist('goal', 'purchase', { orderId: 'Q-1' });
    });
    await page.goto(
      stand('example.localhost', { pk, goalsKit: true, spa: true }, '/thanks')
    );
    await expect.poll(async () => (await goalsOf('thanks')).length).toBe(1);
    // Вызов из очереди ДО загрузки загрузчика (страница «спасибо») — не потерян.
    await expect
      .poll(async () => (await goalsOf('purchase')).map((g) => g.orderId))
      .toEqual(['Q-1']);
    // Тот же документ: SPA-переход и возврат на /thanks — второй url-цели нет.
    await page.evaluate(() => {
      history.pushState({}, '', '/page' + location.search);
      history.pushState({}, '', '/thanks' + location.search);
    });
    const V = (args: unknown[]) =>
      page.evaluate(
        (a) =>
          (
            window as unknown as { V4CAssist: (...x: unknown[]) => void }
          ).V4CAssist(...a),
        args
      );
    await V([
      'goal',
      'purchase',
      { orderId: 'A-1042', value: 1299, currency: 'UAH' },
    ]);
    await V([
      'goal',
      'purchase',
      { orderId: 'A-1042', value: 1299, currency: 'UAH' },
    ]);
    // Не цель js / лишнее поле / orderId-контакт — загрузчик не шлёт.
    await V(['goal', 'thanks', { orderId: 'X-1' }]);
    await V(['goal', 'purchase', { orderId: 'ivan@example.com' }]);
    await page.waitForTimeout(600);
    expect(await goalsOf('thanks')).toHaveLength(1);
    const p = (await goalsOf('purchase')).filter((g) => g.orderId !== 'Q-1');
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({
      orderId: 'A-1042',
      value: 1299,
      currency: 'UAH',
      attribution: 'unassisted',
      source: 'loader',
    });
    // Лид Помощника (встроенная цель считает сервер, A) — одна заявка.
    await openChat(page);
    await ask(page, 'Хочу заказать');
    await waitAnswer(page);
    await chat(page).getByRole('button', { name: 'Оставить заявку' }).click();
    await chat(page).locator('input[name=phone]').fill('+380 50 123 45 67');
    await chat(page).locator('input[name=consent]').check();
    await chat(page).locator('form.lead button[type=submit]').click();
    await expect(
      chat(page).getByText('Спасибо!', { exact: false })
    ).toBeVisible();
    expect((await log()).leads).toHaveLength(1);
  });

  test('сервер мока (как W): e-mail в orderId — 422; неизвестное поле события — 400; чужой Origin — 403; text/plain от beacon', async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, { goals: GOALS });
    await page.goto(stand('example.localhost', { pk }));
    const r = await page.evaluate(
      async ({ w, pk }) => {
        const post = (path: string, body: unknown, type = 'application/json') =>
          fetch(w + path, {
            method: 'POST',
            headers: { 'Content-Type': type },
            body: JSON.stringify(body),
          }).then((x) => x.status);
        return {
          email: await post('/widget/v1/goal', {
            pk,
            goalKey: 'purchase',
            detector: 'js',
            docId: 'doc_12345678',
            path: '/page',
            orderId: 'ivan@example.com',
          }),
          unknown: await post('/widget/v1/event', {
            pk,
            events: [{ kind: 'open', key: null, url: '/x' }],
          }),
          plain: await post(
            '/widget/v1/event',
            { pk, events: [{ kind: 'open', key: null }] },
            'text/plain'
          ),
        };
      },
      { w: WIDGET, pk }
    );
    expect(r).toEqual({ email: 422, unknown: 400, plain: 204 });
    await page.goto(stand('other.localhost', { pk, noWidget: true }));
    const foreign = await page.evaluate(
      ({ w, pk }) =>
        fetch(w + '/widget/v1/event', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ pk, events: [{ kind: 'open', key: null }] }),
        }).then((x) => x.status),
      { w: WIDGET, pk }
    );
    expect(foreign).toBe(403);
    expect(OTHER).toContain('other.localhost');
  });

  test('клики: tel:, разметка data-assist-goal, дескриптор (роль+текст+маска); форма — только без preventDefault сайта', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { goals: GOALS });
    await page.goto(stand('example.localhost', { pk, goalsKit: true }));
    await expect(launcher(page)).toBeVisible();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      // tel: — без перехода в звонилку (стенд).
      document
        .getElementById('tel')!
        .addEventListener('click', (e) => e.preventDefault());
    });
    for (let i = 0; i < 2; i++) {
      await page.locator('#tel').click();
      await page.locator('#buy').click();
      await page.locator('#order').click();
    }
    await page.locator('#send-pd').click(); // форма с preventDefault сайта
    await expect(page.locator('#clicked')).toHaveText('ajax');
    await page.waitForTimeout(400);
    // click — раз на цель за документ: и в мок ушло ровно 3 маяка (без iframe — сам загрузчик).
    expect((await log()).goalCalls).toBe(3);
    expect((await goalsOf('call')).length).toBe(1);
    expect((await goalsOf('buy')).length).toBe(1);
    expect((await goalsOf('order')).length).toBe(1);
    expect(await goalsOf('sub')).toHaveLength(0);
    // Обычная форма уходит — цель «попытка отправки».
    await page.locator('#send').click();
    await expect(page).toHaveURL(/\/thanks/);
    await expect.poll(async () => (await goalsOf('send')).length).toBe(1);
  });

  test('атрибуция в пределах документа: клик по ссылке помощника → direct; диалог без клика → assisted; без iframe → unassisted', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { goals: GOALS });
    await page.goto(stand('example.localhost', { pk, goalsKit: true }));
    await page.evaluate(() =>
      document
        .getElementById('tel')!
        .addEventListener('click', (e) => e.preventDefault())
    );
    // 1) без iframe — загрузчик сам: unassisted.
    await page.locator('#buy').click();
    await expect.poll(async () => (await goalsOf('buy')).length).toBe(1);
    expect((await goalsOf('buy'))[0].attribution).toBe('unassisted');
    // 2) диалог, но без клика по действию помощника: assisted.
    await openChat(page);
    await ask(page, 'Что посоветуете?');
    await waitAnswer(page);
    await page.locator('#order').click();
    await expect.poll(async () => (await goalsOf('order')).length).toBe(1);
    expect((await goalsOf('order'))[0]).toMatchObject({
      attribution: 'assisted',
      source: 'iframe',
    });
    // 3) клик по ссылке помощника, затем цель: direct.
    // Ссылка помощника уводит в /catalog: переход гасим ПОСЛЕ обработчика
    // виджета (всплытие до document iframe) — остаёмся в ТОМ ЖЕ документе
    // (атрибуция — только в пределах документа, решение 12).
    const frame = page.frames().find((f) => f.url().startsWith(WIDGET + '/w/'));
    await frame!.evaluate(() =>
      document.addEventListener('click', (e) => e.preventDefault())
    );
    await chat(page).locator('a.act', { hasText: 'Каталог' }).click();
    await page.locator('#tel').click();
    await expect.poll(async () => (await goalsOf('call')).length).toBe(1);
    const call = (await goalsOf('call'))[0];
    expect(call).toMatchObject({ attribution: 'direct', source: 'iframe' });
    expect((call.assist as { link: boolean }).link).toBe(true);
    await leave(page);
    await expect.poll(eventKinds).toContain('link_click');
  });
});

test('цель, пойманная, пока iframe готов, а сессии ещё нет, — не теряется (уходит после сессии)', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { goals: GOALS });
  await mock('set', { sessionDelayMs: 2500 });
  try {
    await page.goto(stand('example.localhost', { pk, goalsKit: true }));
    await launcher(page).click();
    // iframe отрисован и прислал ready, но токена посетителя ещё нет.
    await expect(chat(page).locator('.cmp textarea')).toBeAttached();
    await expect(chat(page).locator('.cmp textarea')).toBeDisabled();
    await page.waitForTimeout(300);
    await page.locator('#buy').click();
    await expect(chat(page).locator('.cmp textarea')).toBeEnabled({
      timeout: 10_000,
    });
    await expect
      .poll(async () => (await goalsOf('buy')).length, { timeout: 5000 })
      .toBe(1);
    expect((await goalsOf('buy'))[0]).toMatchObject({ source: 'iframe' });
  } finally {
    await mock('set', { sessionDelayMs: 0 });
  }
});

test('приватность «без согласия» (§5-тер.16 п.2): после 5 переходов в хранилищах страницы и iframe нет новых ключей', async ({
  page,
  context,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, { goals: GOALS, engagement: engagement([T_TIME]) });
  await page.goto(stand('example.localhost', { pk, goalsKit: true }));
  await openChat(page);
  await ask(page, 'Привет');
  await waitAnswer(page);
  for (const n of [2, 3, 4, 5, 1]) {
    await page.locator(`#p${n}`).click();
    await expect(page.locator('#h')).toContainText(`Страница ${n}`);
    await page.locator('#buy').click();
  }
  const pageDump = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookie: document.cookie,
  }));
  expect(pageDump.local).toEqual([]);
  expect(pageDump.session).toEqual([`v4c_w:${pk}:ui`]);
  expect(pageDump.cookie).toBe('');
  const frame = page.frames().find((f) => f.url().startsWith(WIDGET + '/w/'));
  const frameDump = await frame!.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  const allowed = ['resume', 'token', 'draft', 'scroll', 'pending'];
  for (const k of [...frameDump.local, ...frameDump.session])
    expect(allowed).toContain(k.split(':').pop());
  // Cookie origin виджета — только CHIPS-указатель.
  const cookies = await context.cookies(WIDGET);
  for (const c of cookies) expect(c.name).toMatch(/^__Host-v4c_resume_/);
  expect(A).toContain('example.localhost');
});

test.describe('режим выбора цели (§5-тер.16 п.6)', () => {
  test('клик не исполняет действие сайта; поле ввода выбрать нельзя; токен убран из адреса', async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, { pickerTokens: { tok_goal_123456789012345: A } });
    const pickRequests: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('/goal-picker/pick') && r.method() === 'POST')
        pickRequests.push(r.postData() || '');
    });
    await page.goto(
      stand('example.localhost', { pk, goalsKit: true }) +
        '&v4c_goal=tok_goal_123456789012345'
    );
    await expect(page.locator('[data-v4c-picker]')).toHaveCount(1);
    expect(page.url()).not.toContain('v4c_goal');
    await page.waitForTimeout(500);
    await page.locator('#order').click();
    await expect(page.locator('#clicked')).toHaveText('');
    await expect.poll(async () => (await log()).picks.length).toBe(1);
    const pick = (await log()).picks[0];
    expect(pick).toMatchObject({
      kind: 'click',
      path: '/page',
      descriptor: { role: 'button', text: 'оформить заказ', tag: 'button' },
    });
    // Ссылка сайта не уводит со страницы.
    await page.locator('#danger').click();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/page');
    // Поле ввода — подсказка, без выбора: запроса pick с ним нет вовсе.
    const picksBefore = pickRequests.length;
    await page.locator('#field').click();
    await page.locator('#editable').click();
    await page.waitForTimeout(400);
    expect(pickRequests.length).toBe(picksBefore);
    expect((await log()).picks.length).toBe(2); // ссылка выбрана, поле — нет
    expect((await log()).picks[1]).toMatchObject({
      descriptor: { role: 'link', tag: 'a' },
    });
    // Отправка формы перехвачена: адрес тот же.
    await page.locator('#send').click();
    await page.waitForTimeout(400);
    expect(new URL(page.url()).pathname).toBe('/page');
    expect((await log()).picks[2]).toMatchObject({ kind: 'form_submit' });
  });

  test('токен на другой хост или повторный — отказ PICKER_INVALID', async ({
    page,
  }) => {
    const pk = newPk();
    await site(pk, { pickerTokens: { tok_goal_other_12345678901: OTHER } });
    await page.goto(
      stand('example.localhost', { pk, goalsKit: true }) +
        '&v4c_goal=tok_goal_other_12345678901'
    );
    await page.waitForTimeout(800);
    await page.locator('#order').click();
    await page.waitForTimeout(400);
    expect((await log()).picks).toHaveLength(0);
  });
});

test('сценарий: шаги (выбор, текст), финал «заявка» — ответы в комментарий; счётчики старт/финиш', async ({
  page,
}) => {
  await humanBrowser(page);
  const pk = newPk();
  await site(pk, {
    engagement: {
      schema: 1,
      triggers: [],
      limits: { perVisit: 1, excludedPaths: [], notOnFirstScreenMobile: true },
      scenarios: [
        {
          key: 'pick-tour',
          enabled: true,
          title: { ru: 'Подобрать тур' },
          showInGreeting: true,
          steps: [
            {
              key: 'where',
              question: { ru: 'Куда хотите?' },
              answer: {
                type: 'choice',
                options: [
                  { key: 'sea', label: { ru: 'Море' } },
                  { key: 'mnt', label: { ru: 'Горы' } },
                ],
              },
            },
            {
              key: 'who',
              question: { ru: 'Сколько человек?' },
              answer: { type: 'number', min: 1, max: 10 },
            },
          ],
          final: { kind: 'lead' },
        },
      ],
    },
  });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await chat(page).getByRole('button', { name: 'Подобрать тур' }).click();
  await chat(page).getByRole('button', { name: 'Море' }).click();
  const n = chat(page).locator('.scen input');
  await n.fill('3');
  await chat(page).locator('.scen button[type=submit]').click();
  await expect(chat(page).locator('textarea[name=comment]')).toHaveValue(
    'Куда хотите? — Море; Сколько человек? — 3'
  );
  // Ответы сценария в сеть не ушли (только в памяти iframe до заявки).
  expect(JSON.stringify((await log()).requests)).not.toContain('Море');
  await leave(page);
  const kinds = await eventKinds();
  expect(kinds).toContain('scenario_started:pick-tour');
  expect(kinds).toContain('scenario_done:pick-tour');
});

test('мок проверяет Origin на маршрутах по visitor-token (как sites-backend)', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  const token = await chat(page)
    .locator('body')
    .evaluate(() => {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i)!;
        if (k.endsWith(':token'))
          return JSON.parse(sessionStorage.getItem(k)!).t as string;
      }
      return '';
    });
  expect(token).not.toBe('');
  const call = (origin: string | null, method = 'POST') =>
    fetch(`${WIDGET}/widget/v1/${method === 'POST' ? 'handoff' : 'state'}`, {
      method,
      headers: {
        'X-Assist-Visitor': token,
        'Content-Type': 'application/json',
        ...(origin ? { Origin: origin } : {}),
      },
      body: method === 'POST' ? '{}' : undefined,
    }).then((r) => r.status);
  expect(await call(A)).toBe(403); // токен со страницы сайта — нет
  expect(await call(null)).toBe(403); // POST без Origin — нет
  expect(await call(WIDGET)).toBe(200); // iframe — да
  expect(await call(null, 'GET')).toBe(200); // same-origin GET без Origin — да
  expect(await call(A, 'GET')).toBe(403);
});

test.describe('ленивый чанк engage.js (интеграция Э3: бюджет загрузчика 12 КБ)', () => {
  test('цели до загрузки чанка не теряются: url «спасибо» и клик по tel: — после загрузки, по одному', async ({
    page,
  }) => {
    await humanBrowser(page);
    const pk = newPk();
    await site(pk, { goals: GOALS });
    // Чанк держим, пока страница не «наработает» цели.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let chunkHits = 0;
    await page.route('**/v1/engage.js', async (route) => {
      chunkHits++;
      await gate;
      await route.continue();
    });
    await page.goto(
      stand('example.localhost', { pk, goalsKit: true }, '/thanks')
    );
    await expect(launcher(page)).toBeVisible();
    await page.evaluate(() =>
      document
        .getElementById('tel')!
        .addEventListener('click', (e) => e.preventDefault())
    );
    await page.locator('#tel').click();
    await page.locator('#tel').click();
    await page.waitForTimeout(500);
    // Чанк запрошен (клик = первое взаимодействие), но ещё не исполнен — целей нет.
    expect(chunkHits).toBe(1);
    expect((await log()).goalCalls).toBe(0);
    release();
    await expect
      .poll(async () => (await goalsOf()).map((g) => g.goalKey).sort())
      .toEqual(['call', 'thanks']);
    await page.waitForTimeout(400);
    expect((await log()).goalCalls).toBe(2);
  });

  test('без целей и триггеров чанк не грузится вовсе; с целями — только после load (не на критическом пути)', async ({
    page,
  }) => {
    await humanBrowser(page);
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    const pk = newPk();
    await site(pk);
    await page.goto(stand('example.localhost', { pk, goalsKit: true }));
    await expect(launcher(page)).toBeVisible();
    await page.locator('#buy').click();
    await page.waitForTimeout(3500);
    expect(urls.some((u) => u.includes('/v1/engage.js'))).toBe(false);

    const pk2 = newPk();
    await site(pk2, { goals: GOALS });
    let loadAt = 0;
    let chunkAt = 0;
    page.on('load', () => (loadAt = Date.now()));
    page.on('request', (r) => {
      if (r.url().includes('/v1/engage.js') && !chunkAt) chunkAt = Date.now();
    });
    await page.goto(stand('example.localhost', { pk: pk2, goalsKit: true }));
    await expect.poll(() => chunkAt, { timeout: 8000 }).toBeGreaterThan(0);
    expect(loadAt).toBeGreaterThan(0);
    expect(chunkAt).toBeGreaterThanOrEqual(loadAt);
  });
});
