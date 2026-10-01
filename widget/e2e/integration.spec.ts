/**
 * Интеграционный прогон W1 против НАСТОЯЩЕГО sites-backend (контракт Э2
 * §9.3, координатор): стенд проксирует `/widget/v1/*` и `/w/v1/*` на
 * `WIDGET_E2E_BACKEND`, у бэкенда ASSIST_WIDGET_ORIGIN = http://localhost:5181.
 *
 *   WIDGET_E2E_BACKEND=http://localhost:3010 WIDGET_E2E_PK=pk_test_… \
 *     [WIDGET_E2E_DB=postgresql://…/<база> WIDGET_E2E_SITE_ID=…] \
 *     [WIDGET_E2E_FAKE_LOG=<SITES_DEV_FAKE_GEMINI_LOG бэкенда>] \
 *     PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test integration
 *
 * Бэкенд — с dev-заглушкой Gemini (`SITES_DEV_FAKE_GEMINI=true`, только вне
 * production): ответ из первого источника с цитатой и кнопкой заявки,
 * паузы между кусками (`SITES_DEV_FAKE_GEMINI_DELAY_MS`, ≥ 300 мс — чтобы
 * успеть перезагрузить посреди стрима). WIDGET_E2E_FAKE_LOG — файл, куда
 * заглушка пишет каждый вызов модели (счёт «1 вызов на вопрос»).
 * WIDGET_E2E_DB — сверка с базой через psql (лиды, окна лимитов: стенд
 * ходит с одного IP, а сессий — 5/мин на ipHash сайта).
 *
 * pk_test_ пускается только на localhost/127.0.0.1 (контракт §1 п.3) — стенд
 * сайта открывается как http://localhost:5182. Без WIDGET_E2E_BACKEND
 * тесты пропускаются.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import {
  INTEGRATION,
  WIDGET,
  WIDGET_STORAGE_PREFIX,
  ask,
  chat,
  launcher,
  openChat,
  panel,
  stand,
  waitAnswer,
} from './fixtures';
import { widgetResumeCookieName } from '../src/shared/brand';

const PK = process.env.WIDGET_E2E_PK || '';
const HOST = process.env.WIDGET_E2E_SITE_HOST || 'localhost';
const DB = process.env.WIDGET_E2E_DB || '';
const SITE_ID = process.env.WIDGET_E2E_SITE_ID || '';
const FAKE_LOG = process.env.WIDGET_E2E_FAKE_LOG || '';
const SITE = `http://${HOST}:5182`;
/**
 * Метка прогона в вопросах: тот же вопрос с ≥ 3 других visitorId одного
 * ipHash за 10 мин — признак бота (§4.13 п.5), а стенд ходит с одного IP и
 * прогоны повторяются.
 */
const RUN = Math.random().toString(36).slice(2, 7);
const q = (text: string) => `${text} (${RUN})`;

test.skip(!INTEGRATION || !PK, 'нужны WIDGET_E2E_BACKEND и WIDGET_E2E_PK');
test.describe.configure({ mode: 'serial' });

function sql(q: string): string {
  return execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
}

/** Вызовов модели ответа (стрим) по журналу dev-заглушки. */
function modelCalls(): number {
  if (!FAKE_LOG || !fs.existsSync(FAKE_LOG)) return 0;
  return fs
    .readFileSync(FAKE_LOG, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"op":"stream"')).length;
}

test.beforeEach(() => {
  // Окна лимитов живут в базе; стенд ходит с одного IP (x-forwarded-for прокси).
  if (DB) {
    sql(`DELETE FROM "sites"."assist_rate_buckets"`);
    // Каждый вопрос — через модель (стрим), а не из семантического кэша.
    sql(`DELETE FROM "sites"."assist_site_semantic_cache"`);
  }
});

/**
 * Открыть чат и выждать > 1 с: первый вопрос в первую секунду жизни токена —
 * признак бота (§4.13 п.5, `botTokenAgeMs`) → ответ только из FAQ/кэша/шаблона.
 */
async function openAsHuman(page: Page) {
  await openChat(page);
  await page.waitForTimeout(1_200);
}

async function lastBotText(page: Page): Promise<string> {
  return (await chat(page).locator('.msg.bot .bub').last().innerText()).trim();
}

test('интеграция: конфиг, frame-ancestors, сессия + CHIPS-cookie своего pk, ответ стримом с источником, перезагрузка, хранилище страницы', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const frameHeaders: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/w/v1/frame'))
      frameHeaders.push(r.headers()['content-security-policy'] || '');
  });
  await page.goto(stand(HOST, { pk: PK }));
  await expect(launcher(page)).toBeVisible();
  await openChat(page);
  // Настоящий заголовок sites-backend: pk_test_ — только localhost/127.0.0.1.
  expect(frameHeaders[0]).toMatch(
    /frame-ancestors http:\/\/localhost:\* https:\/\/localhost:\* http:\/\/127\.0\.0\.1:\* https:\/\/127\.0\.0\.1:\*;/
  );
  expect(frameHeaders[0]).toContain("require-trusted-types-for 'script'");
  // CHIPS-cookie указателя — с именем СВОЕГО pk (интеграция Э2).
  const names = (await context.cookies(WIDGET)).map((c) => c.name);
  expect(names).toContain(widgetResumeCookieName(PK));
  await page.waitForTimeout(1_200);
  await ask(page, q('Сколько стоит доставка по Киеву?'));
  await waitAnswer(page);
  const answer = await lastBotText(page);
  expect(answer).toContain('100 грн');
  await expect(chat(page).locator('.msg.bot .src').last()).toContainText(
    'Доставка'
  );
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await expect(chat(page).locator('.msg.me')).toHaveCount(1);
  const keys = await page.evaluate(() => [
    ...Object.keys(localStorage),
    ...Object.keys(sessionStorage),
    document.cookie,
  ]);
  expect(keys.filter(Boolean)).toEqual([`${WIDGET_STORAGE_PREFIX}:${PK}:ui`]);
});

test('интеграция: F5 посреди стрима — ответ дописан из базы, модель вызвана один раз', async ({
  page,
}) => {
  test.skip(!FAKE_LOG, 'нужен WIDGET_E2E_FAKE_LOG (журнал dev-заглушки)');
  test.setTimeout(120_000);
  await page.goto(stand(HOST, { pk: PK }));
  await openAsHuman(page);
  const before = modelCalls();
  await ask(page, q('Какая гарантия на ноутбуки?'));
  // Первый кусок уже на экране, ответ ещё не дописан (нет 👍/👎).
  await expect
    .poll(async () => (await lastBotText(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(await chat(page).locator('.msg.bot .fb').count()).toBe(0);
  await page.reload();
  await expect(panel(page)).toBeVisible();
  await waitAnswer(page);
  expect(await lastBotText(page)).toContain('два года');
  expect(modelCalls() - before).toBe(1);
  await expect(chat(page).locator('.msg.me')).toHaveCount(1);
});

test('интеграция: лид из кнопки ответа — принят сервером, в базе поля зашифрованы', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const leadsBefore =
    DB && SITE_ID
      ? Number(
          sql(
            `SELECT count(*) FROM "sites"."assist_site_leads" WHERE "siteId" = '${SITE_ID}'`
          )
        )
      : 0;
  await page.goto(stand(HOST, { pk: PK }));
  await openAsHuman(page);
  await ask(page, q('Можно вернуть товар?'));
  await waitAnswer(page);
  await chat(page)
    .getByRole('button', { name: 'Оставить заявку' })
    .last()
    .click();
  const form = chat(page).locator('form.lead');
  await expect(form).toBeVisible();
  const lead = page.waitForResponse((r) => r.url().includes('/widget/v1/lead'));
  for (const name of await form.locator('input:not([type=checkbox])').all()) {
    const n = await name.getAttribute('name');
    if (n === 'name') await name.fill('Олег');
    if (n === 'phone') await name.fill('+380501234567');
    if (n === 'email') await name.fill('oleg@example.com');
  }
  await form.locator('input[name=consent]').check();
  await form.locator('button[type=submit]').click();
  expect((await lead).status()).toBe(200);
  await expect(chat(page).locator('.lead[role=status]')).toBeVisible();
  if (DB && SITE_ID) {
    const rows = sql(
      `SELECT "fieldsEnc" FROM "sites"."assist_site_leads" WHERE "siteId" = '${SITE_ID}' ORDER BY "createdAt"`
    ).split('\n');
    expect(rows.length).toBe(leadsBefore + 1);
    expect(rows.at(-1)).not.toContain('380501234567');
    expect(rows.at(-1)).not.toContain('Олег');
  }
});

/** visitorId из visitor-token (полезная нагрузка — base64url JSON до точки). */
function visitorOf(body: unknown): string {
  const t = (body as { data: { visitorToken: string } }).data.visitorToken;
  return (
    JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8')) as {
      visitorId: string;
    }
  ).visitorId;
}

test('интеграция: «удалить мой диалог» — диалоги стёрты, cookie своего pk стёрта, дальше — другой посетитель без истории', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const first = page.waitForResponse((x) =>
    x.url().includes('/widget/v1/session')
  );
  await page.goto(stand(HOST, { pk: PK }));
  await openAsHuman(page);
  const oldVisitor = visitorOf(await (await first).json());
  await ask(page, q('Удалите меня, пожалуйста'));
  await waitAnswer(page);
  const forget = page.waitForResponse((r) =>
    r.url().includes('/widget/v1/forget')
  );
  await chat(page).getByRole('button', { name: 'Удалить мой диалог' }).click();
  await chat(page)
    .getByRole('button', { name: 'Удалить', exact: true })
    .click();
  const r = await forget;
  expect(r.status()).toBe(200);
  expect((await r.json()).data.conversationsDeleted).toBe(1);
  expect(await r.headerValue('set-cookie')).toContain(
    `${widgetResumeCookieName(PK)}=; Path=/; Max-Age=0`
  );
  await expect(chat(page).getByText('Диалог удалён.')).toBeVisible();
  await expect(chat(page).locator('.msg.me')).toHaveCount(0);
  if (DB && SITE_ID) {
    expect(
      sql(
        `SELECT count(*) FROM "sites"."assist_site_conversations" WHERE "siteId" = '${SITE_ID}' AND "visitorId" = '${oldVisitor}'`
      )
    ).toBe('0');
    expect(
      sql(
        `SELECT count(*) FROM "sites"."assist_site_visitor_resumes" WHERE "siteId" = '${SITE_ID}' AND "visitorId" = '${oldVisitor}'`
      )
    ).toBe('0');
  }
  // Новая вкладка: прежнего посетителя не восстановить (указатель стёрт).
  const fresh = await page.context().newPage();
  const session = fresh.waitForResponse((x) =>
    x.url().includes('/widget/v1/session')
  );
  await fresh.goto(stand(HOST, { pk: PK }));
  await openChat(fresh);
  expect(visitorOf(await (await session).json())).not.toBe(oldVisitor);
  await expect(chat(fresh).locator('.msg.me')).toHaveCount(0);
});

test('интеграция: ORIGIN_DENIED — сессия для чужого хоста (pk_test_ вне localhost) и чужой Origin запроса', async () => {
  const call = (origin: string, parentOrigin: string) =>
    fetch(`${WIDGET}/widget/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ pk: PK, parentOrigin }),
    });
  const foreign = await call(WIDGET, 'http://other.localhost:5182');
  expect(foreign.status).toBe(403);
  expect(
    ((await foreign.json()) as { error: { code: string } }).error.code
  ).toBe('ORIGIN_DENIED');
  const own = await call(WIDGET, SITE);
  expect(own.status).toBe(200);
  // Запрос не с origin виджета (страница заказчика зовёт API напрямую).
  const direct = await call(SITE, SITE);
  expect(direct.status).toBe(403);
  expect(direct.headers.get('access-control-allow-origin')).toBeNull();
});

test('интеграция: чужой origin — iframe не рисуется (frame-ancestors настоящего бэкенда)', async ({
  page,
}) => {
  const chatJs: string[] = [];
  page.on(
    'request',
    (r) => r.url().includes('/v1/chat.js') && chatJs.push(r.url())
  );
  await page.goto(stand('other.localhost', { pk: PK, directFrame: true }));
  await page.waitForTimeout(2000);
  expect(chatJs).toEqual([]);
});
