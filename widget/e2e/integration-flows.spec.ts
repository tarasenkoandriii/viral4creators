/**
 * Э3 — сквозные сценарии интеграционного прогона (координатор): виджет в
 * Chromium против НАСТОЯЩЕГО sites-backend, бот — через настоящий вебхук
 * `POST /assist/webhook/telegram` (секрет), исходящие вызовы Bot API —
 * локальный мок Telegram (перехват fetch процесса бэкенда, токен фейковый),
 * кабинет — REST с дев-входом, кроны — `GET /cron/*` с CRON_SECRET.
 *
 *  (а) посетитель зовёт человека → карточка уходит оператору в бот →
 *      «Взять» (callback_query) и реплай на карточку → ответ виден
 *      посетителю ≤ 5 с; вопрос посетителя во время передачи — оператору;
 *  (б) цель url «спасибо» + клик tel: → события под ролью → свёртка →
 *      `stats/conversions`;
 *  (в) 👎 → элемент очереди обучения → кластер (крон) → решение golden →
 *      следующий ответ на тот же вопрос — прямым путём (FAQ, без модели);
 *  (г) forget → диалоги удалены, задание хвоста → крон → дословный вариант
 *      убран из проверенного ответа, `fromConversationId` обнулён.
 * Переменные — /tmp/e3int/int-env.sh. Без них — пропуск.
 */
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  INTEGRATION,
  ask,
  chat,
  humanBrowser,
  openChat,
  stand,
  waitAnswer,
} from './fixtures';

const E = process.env;
const API = E.WIDGET_E2E_BACKEND || '';
const PK = E.WIDGET_E2E_PK || '';
const DB = E.WIDGET_E2E_DB || '';
const SITE = E.WIDGET_E2E_SITE_ID || '';
const ACC = E.WIDGET_E2E_ACCOUNT || '';
const OWNER = E.WIDGET_E2E_OWNER || '';
const OP = E.WIDGET_E2E_OPERATOR || '';
const TG = E.WIDGET_E2E_TG_MOCK || '';
const HOOK = E.WIDGET_E2E_WEBHOOK_SECRET || '';
const CRON = E.WIDGET_E2E_CRON_SECRET || '';
const RUN =
  Math.random().toString(36).slice(2).replace(/\d/g, '').slice(0, 6) || 'run';

test.skip(
  !INTEGRATION || !PK || !DB || !SITE || !ACC || !OP || !TG || !HOOK || !CRON,
  'нужны переменные /tmp/e3int/int-env.sh (бэкенд, база, мок Telegram, секреты)'
);
test.describe.configure({ mode: 'serial' });

function sql(q: string): string {
  return execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function cabinet<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  user = OWNER
): Promise<T> {
  const r = await fetch(API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-App': 'assist',
      'X-Dev-User-Id': user,
      'X-Site-Account': ACC,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json().catch(() => null)) as {
    success?: boolean;
    data?: T;
  } | null;
  if (!r.ok || !j?.success)
    throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
  return j.data as T;
}

let upd = Date.now();
async function webhook(update: Record<string, unknown>): Promise<number> {
  const r = await fetch(`${API}/assist/webhook/telegram`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': HOOK,
    },
    body: JSON.stringify({ update_id: upd++, ...update }),
  });
  return r.status;
}

async function cron(name: string): Promise<void> {
  const r = await fetch(`${API}/cron/${name}`, {
    headers: { Authorization: `Bearer ${CRON}` },
  });
  expect(r.status, `крон ${name}`).toBe(200);
}

interface TgCall {
  method: string;
  at: number;
  messageId?: number;
  body: Record<string, unknown>;
}
async function tgLog(): Promise<TgCall[]> {
  return (await (await fetch(`${TG}/__log`)).json()) as TgCall[];
}

test.beforeEach(async () => {
  sql(`DELETE FROM "sites"."assist_rate_buckets"`);
  await fetch(`${TG}/__reset`, { method: 'POST' });
});

const day = (d: number) =>
  new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

test('(а) передача: карточка в бот → «Взять» и реплай через вебхук → ответ у посетителя ≤ 5 с; вопрос посетителя — оператору', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(stand('localhost', { pk: PK }));
  await openChat(page);
  await ask(page, `Есть вопрос по доставке ${RUN}`);
  await waitAnswer(page);
  await chat(page).getByRole('button', { name: 'Позвать человека' }).click();
  await chat(page)
    .getByRole('button', { name: 'Позвать', exact: true })
    .click();
  await expect(chat(page).locator('[data-handoff=waiting]')).toBeVisible();

  // Карточка оператору: sendMessage в чат оператора с кнопкой h:take:<id>.
  let card: TgCall | undefined;
  await expect
    .poll(
      async () => {
        card = (await tgLog()).find(
          (c) =>
            c.method === 'sendMessage' &&
            String(c.body.chat_id) === OP &&
            JSON.stringify(c.body).includes('h:take:')
        );
        return !!card;
      },
      { timeout: 10_000 }
    )
    .toBe(true);
  const take = /"(h:take:[A-Za-z0-9_-]+)"/.exec(JSON.stringify(card!.body))![1];
  const handoffId = take.slice('h:take:'.length);
  // В бот — только маскированное, кнопки ≤ 64 байт.
  for (const b of JSON.stringify(card!.body).match(
    /"callback_data":"[^"]*"/g
  ) || [])
    expect(Buffer.byteLength(b.slice(17, -1))).toBeLessThanOrEqual(64);

  expect(
    await webhook({
      callback_query: {
        id: `cb-${RUN}`,
        from: { id: Number(OP), is_bot: false, first_name: 'Op' },
        message: {
          message_id: card!.messageId,
          date: 0,
          chat: { id: Number(OP), type: 'private' },
        },
        data: take,
      },
    })
  ).toBe(200);
  expect(
    sql(
      `SELECT "state" FROM "sites"."assist_site_handoffs" WHERE "id" = ${lit(handoffId)}`
    )
  ).toBe('active');
  expect(
    (await tgLog()).some(
      (c) =>
        c.method === 'answerCallbackQuery' &&
        c.body.callback_query_id === `cb-${RUN}`
    )
  ).toBe(true);

  // Виджет уже увидел «взято» (синхронизировал stateVersion) — дальше ответ
  // оператора доходит ТОЛЬКО новым stateVersion (иначе опрос его пропустит).
  await expect(chat(page).locator('[data-handoff=active]')).toBeVisible({
    timeout: 8000,
  });
  const t0 = Date.now();
  expect(
    await webhook({
      message: {
        message_id: 9001,
        date: 0,
        chat: { id: Number(OP), type: 'private' },
        from: { id: Number(OP), is_bot: false, first_name: 'Op' },
        text: `Ответ оператора ${RUN}: доставим завтра`,
        reply_to_message: { message_id: card!.messageId },
      },
    })
  ).toBe(200);
  await expect(chat(page).locator('.msg.op')).toContainText(
    `Ответ оператора ${RUN}`,
    { timeout: 5000 }
  );
  const ms = Date.now() - t0;
  expect(ms).toBeLessThanOrEqual(5000);
  console.log(`(а) реплай-вебхук → ответ у посетителя: ${ms} мс`);
  test
    .info()
    .annotations.push({ type: 'Э3 п.1 сквозной', description: `${ms} мс` });
  await expect(chat(page).locator('[data-handoff=active]')).toBeVisible();

  // Вопрос посетителя во время передачи — оператору (не модели).
  const before = (await tgLog()).length;
  await ask(page, `А можно к пяти вечера ${RUN}?`);
  await expect
    .poll(
      async () =>
        (await tgLog())
          .slice(before)
          .some(
            (c) =>
              c.method === 'sendMessage' &&
              String(c.body.chat_id) === OP &&
              String(c.body.text).includes(`к пяти вечера ${RUN}`)
          ),
      { timeout: 10_000 }
    )
    .toBe(true);
  // Закрыть передачу (кнопка бота) — посетителю больше не «активна».
  expect(
    await webhook({
      callback_query: {
        id: `cb2-${RUN}`,
        from: { id: Number(OP), is_bot: false, first_name: 'Op' },
        message: {
          message_id: card!.messageId,
          date: 0,
          chat: { id: Number(OP), type: 'private' },
        },
        data: `h:close:${handoffId}`,
      },
    })
  ).toBe(200);
  expect(
    sql(
      `SELECT "state" FROM "sites"."assist_site_handoffs" WHERE "id" = ${lit(handoffId)}`
    )
  ).toBe('closed');
});

test('(б) цели: url «спасибо» + клик tel: → события под ролью → свёртка → статистика конверсий', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await humanBrowser(page);
  const thanks = `thanks-${RUN}`;
  const call = `call-${RUN}`;
  for (const g of [
    {
      key: thanks,
      template: 'custom',
      name: `Спасибо ${RUN}`,
      detectors: [
        { kind: 'url', config: { pathMask: '/thanks', fromPathMask: null } },
      ],
    },
    {
      key: call,
      template: 'call',
      name: `Звонок ${RUN}`,
      detectors: [{ kind: 'click', config: { auto: 'tel' } }],
    },
  ])
    await cabinet('POST', `/assist/sites/${SITE}/goals`, {
      ...g,
      valueMode: 'none',
      fixedValue: null,
      currency: null,
    });
  await page.goto(stand('localhost', { pk: PK, goalsKit: true }, '/thanks'));
  await page.waitForTimeout(800);
  await page.evaluate(() =>
    document
      .getElementById('tel')!
      .addEventListener('click', (e) => e.preventDefault())
  );
  await page.locator('#tel').click();
  await page.locator('#tel').click(); // раз на цель за документ
  const events = () =>
    sql(
      `SELECT g.key || ':' || e."attribution" || ':' || e."trust" FROM "sites"."assist_site_goal_events" e
         JOIN "sites"."assist_site_goals" g ON g.id = e."goalId"
        WHERE g."siteId" = ${lit(SITE)} AND g.key IN (${lit(thanks)}, ${lit(call)}) ORDER BY g.key`
    );
  await expect
    .poll(events, { timeout: 10_000 })
    .toBe(`${call}:unassisted:page\n${thanks}:unassisted:page`);
  await cron('assist-analytics-run');
  const conv = await cabinet<{
    goals: Array<{ key: string; total: number; unassisted: number }>;
  }>(
    'GET',
    `/assist/sites/${SITE}/stats/conversions?from=${day(-1)}&to=${day(1)}`
  );
  const byKey = Object.fromEntries(conv.goals.map((g) => [g.key, g]));
  expect(byKey[thanks]).toMatchObject({ total: 1, unassisted: 1 });
  expect(byKey[call]).toMatchObject({ total: 1, unassisted: 1 });
  // Повторная свёртка не удваивает (идемпотентность).
  await cron('assist-analytics-run');
  const again = await cabinet<{ goals: Array<{ key: string; total: number }> }>(
    'GET',
    `/assist/sites/${SITE}/stats/conversions?from=${day(-1)}&to=${day(1)}`
  );
  expect(again.goals.find((g) => g.key === thanks)!.total).toBe(1);
});

async function lastAssistant(page: Page) {
  return chat(page).locator('.msg.bot').last();
}

test('(в)+(г) 👎 → очередь → кластер → golden → следующий ответ прямым путём; forget → хвост убирает дословный вариант', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const Q = `Сколько стоит доставка по Киеву ${RUN}?`;
  await page.goto(stand('localhost', { pk: PK }));
  await openChat(page);
  // Первый вопрос сразу после выдачи токена — признак бота (suspicious,
  // §4.13 п.5: только FAQ/шаблон) — ждём, как живой посетитель.
  await page.waitForTimeout(2500);
  await ask(page, Q);
  await waitAnswer(page);
  const conv = sql(
    `SELECT "conversationId" FROM "sites"."assist_site_messages" WHERE "siteId" = ${lit(SITE)} AND "role" = 'visitor' AND "text" = ${lit(Q)} ORDER BY "createdAt" DESC LIMIT 1`
  );
  expect(conv).not.toBe('');
  // 👎 на ответ модели.
  await (
    await lastAssistant(page)
  )
    .locator('.fb button')
    .filter({ hasText: '👎' })
    .click();
  await expect
    .poll(
      () =>
        sql(
          `SELECT "kind" || ':' || "signal" FROM "sites"."assist_site_learning_items" WHERE "conversationId" = ${lit(conv)}`
        ),
      { timeout: 10_000 }
    )
    .toBe('wrong:thumbs_down');

  await cron('assist-learn-rollup');
  const queue = await cabinet<{
    entries: Array<{ entry: string; id: string; examples?: string[] }>;
  }>('GET', `/assist/sites/${SITE}/learning/site/queue?kind=wrong`);
  const cluster = queue.entries.find(
    (e) => e.entry === 'cluster' && (e.examples || []).includes(Q)
  );
  expect(cluster, 'кластер с вопросом посетителя').toBeTruthy();
  // Дев-заглушка эмбеддингов — мешок слов, а фрагмент FAQ векторизуется
  // как «вопрос (варианты)\nответ»: порог прямого пути 0.92 на ней
  // достижим, только если ответ повторяет слова вопроса (живой Gemini —
  // владелец, отчёт координатора).
  const ANSWER = `Сколько стоит доставка по Киеву ${RUN}? 100 грн, один день.`;
  const res = await cabinet<{ status: string; faqId?: string | null }>(
    'POST',
    `/assist/sites/${SITE}/learning/site/queue/${cluster!.id}/resolve`,
    {
      action: 'golden',
      question: `Доставка по Киеву ${RUN}`,
      answer: ANSWER,
      variants: [Q],
    }
  );
  expect(res.status).toBe('resolved');
  const faqId = res.faqId!;
  expect(
    sql(
      `SELECT "fromConversationId" || '|' || ("variantRefs"::text LIKE ${lit(`%${conv}%`)})::text FROM "sites"."assist_site_faq" WHERE "id" = ${lit(faqId)}`
    )
  ).toBe(`${conv}|true`);

  // Следующий ответ на тот же вопрос — прямым путём (FAQ), без модели.
  await ask(page, Q);
  await waitAnswer(page, 2);
  await expect(await lastAssistant(page)).toContainText(ANSWER);
  expect(
    sql(
      `SELECT "answerPath" FROM "sites"."assist_site_messages" WHERE "conversationId" = ${lit(conv)} AND "role" = 'assistant' ORDER BY "createdAt" DESC LIMIT 1`
    )
  ).toBe('faq');

  // (г) forget: диалог удалён, задание хвоста, после крона — варианта нет.
  const forget = page.waitForResponse((r) =>
    r.url().includes('/widget/v1/forget')
  );
  await chat(page).getByRole('button', { name: 'Удалить мой диалог' }).click();
  await chat(page)
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  expect((await forget).status()).toBe(200);
  expect(
    sql(
      `SELECT count(*) FROM "sites"."assist_site_conversations" WHERE "id" = ${lit(conv)}`
    )
  ).toBe('0');
  expect(
    sql(
      `SELECT count(*) FROM "sites"."assist_site_learning_items" WHERE "conversationId" = ${lit(conv)}`
    )
  ).toBe('0');
  expect(
    sql(
      `SELECT coalesce("fromConversationId", 'NULL') FROM "sites"."assist_site_faq" WHERE "id" = ${lit(faqId)}`
    )
  ).toBe('NULL');
  expect(
    Number(
      sql(
        `SELECT count(*) FROM "sites"."assist_site_forget_jobs" WHERE "siteId" = ${lit(SITE)} AND ${lit(conv)} = ANY("conversationIds")`
      )
    )
  ).toBe(1);
  await cron('assist-handoff-tick');
  await expect
    .poll(
      () =>
        sql(
          `SELECT (${lit(Q)} = ANY("variants"))::text || '|' || coalesce("variantRefs"::text, 'NULL') FROM "sites"."assist_site_faq" WHERE "id" = ${lit(faqId)}`
        ),
      { timeout: 10_000 }
    )
    .toBe('false|NULL');
  // Проверенный ответ остался (решение менеджера — не данные посетителя).
  expect(
    sql(
      `SELECT "status" FROM "sites"."assist_site_faq" WHERE "id" = ${lit(faqId)}`
    )
  ).toBe('active');
  // Гигиена общего сайта стенда: убрать ответ из знаний (иначе вопросы о
  // доставке других спеков получат его источником).
  await cabinet(
    'DELETE',
    `/assist/sites/${SITE}/learning/site/golden/${faqId}`
  );
});
