/**
 * Э3 (W) — интеграционный прогон против НАСТОЯЩЕГО sites-backend
 * (координатор, контракт Э3 §9 п.3): те же переменные, что
 * e2e/integration.spec.ts, плюс обязательные WIDGET_E2E_DB и
 * WIDGET_E2E_SITE_ID (pk_test_ этого сайта, стенд — http://localhost:5182).
 *
 *  - Э3 п.1 со стороны виджета: передача и ответ оператора кладутся в базу
 *    psql (как их пишет H по вебхуку-реплаю), виджет видит ответ опросом
 *    НАСТОЯЩЕГО `GET /widget/v1/state` (роль виджета, `visitorView` H) ≤ 5 с;
 *  - цели и счётчики: маяки загрузчика доходят до A под ролью
 *    (assist_site_goal_events, assist_site_event_counts).
 * Без переменных тесты пропускаются (на моке — handoff.spec.ts, engagement.spec.ts).
 */
import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import {
  INTEGRATION,
  ask,
  chat,
  humanBrowser,
  openChat,
  stand,
  waitAnswer,
} from './fixtures';

const PK = process.env.WIDGET_E2E_PK || '';
const DB = process.env.WIDGET_E2E_DB || '';
const SITE_ID = process.env.WIDGET_E2E_SITE_ID || '';
const RUN = Math.random().toString(36).slice(2, 8);

test.skip(
  !INTEGRATION || !PK || !DB || !SITE_ID,
  'нужны WIDGET_E2E_BACKEND, WIDGET_E2E_PK, WIDGET_E2E_DB, WIDGET_E2E_SITE_ID'
);
test.describe.configure({ mode: 'serial' });

function sql(q: string): string {
  return execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
}
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ACC = () =>
  sql(
    `SELECT "accountId" FROM "sites"."assist_sites" WHERE "siteId" = ${lit(SITE_ID)}`
  );

test.beforeEach(() => {
  sql(`DELETE FROM "sites"."assist_rate_buckets"`);
});

test('Э3 п.1 (интеграция): ответ оператора из базы виден посетителю ≤ 5 с через настоящий GET state', async ({
  page,
}) => {
  const since = new Date().toISOString();
  await page.goto(stand('localhost', { pk: PK }));
  await openChat(page);
  await page.waitForTimeout(1200);
  await ask(page, `Позовите человека (${RUN})`);
  await waitAnswer(page);
  const conv = sql(
    `SELECT id FROM "sites"."assist_site_conversations" WHERE "siteId" = ${lit(SITE_ID)} AND "createdAt" >= ${lit(since)} ORDER BY "createdAt" DESC LIMIT 1`
  );
  expect(conv).not.toBe('');
  const acc = ACC();
  const hid = `w3e2e_h_${RUN}`;
  sql(
    `INSERT INTO "sites"."assist_site_handoffs" ("id","accountId","siteId","conversationId","state","reason","timeoutAt","updatedAt")
     VALUES (${lit(hid)}, ${lit(acc)}, ${lit(SITE_ID)}, ${lit(conv)}, 'waiting', 'visitor', now() + interval '5 minutes', now())`
  );
  // Перезагрузка: окно было открыто — восстановится само (§4-бис.1).
  await page.reload();
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  await expect(chat(page).locator('[data-handoff=waiting]')).toBeVisible();
  await page.waitForTimeout(1000);
  const t0 = Date.now();
  sql(
    `INSERT INTO "sites"."assist_site_messages" ("id","accountId","siteId","conversationId","role","text","streamState","updatedAt")
       VALUES (${lit(`w3e2e_m_${RUN}`)}, ${lit(acc)}, ${lit(SITE_ID)}, ${lit(conv)}, 'operator', ${lit(`Ответ оператора ${RUN}`)}, 'complete', now());
     UPDATE "sites"."assist_site_handoffs" SET "state" = 'active', "takenAt" = now(), "updatedAt" = now() WHERE "id" = ${lit(hid)};
     UPDATE "sites"."assist_site_conversations" SET "stateVersion" = "stateVersion" + 1, "lastMessageAt" = now() WHERE "id" = ${lit(conv)};`
  );
  await expect(chat(page).locator('.msg.op')).toContainText(
    `Ответ оператора ${RUN}`,
    { timeout: 5000 }
  );
  const ms = Date.now() - t0;
  expect(ms).toBeLessThanOrEqual(5000);
  console.log(`Э3 п.1: ответ оператора виден через ${ms} мс`);
  test.info().annotations.push({
    type: 'Э3 п.1 (интеграция)',
    description: `${ms} мс`,
  });
  await expect(chat(page).locator('[data-handoff=active]')).toBeVisible();
  sql(
    `UPDATE "sites"."assist_site_handoffs" SET "state" = 'closed', "closedAt" = now(), "closedBy" = 'system', "updatedAt" = now() WHERE "id" = ${lit(hid)}`
  );
});

test('цели и счётчики (интеграция): маяк загрузчика → A под ролью (unassisted), счётчики суток', async ({
  page,
}) => {
  await humanBrowser(page);
  const acc = ACC();
  const key = `e2e-call-${RUN}`;
  sql(
    `INSERT INTO "sites"."assist_site_goals" ("id","accountId","siteId","key","template","name","detectors","valueMode","status","updatedAt")
     VALUES (${lit(`w3e2e_g_${RUN}`)}, ${lit(acc)}, ${lit(SITE_ID)}, ${lit(key)}, 'call', 'Звонок e2e', '[{"kind":"click","config":{"auto":"tel"}}]', 'none', 'active', now())`
  );
  try {
    const before = Number(
      sql(
        `SELECT coalesce(sum("count"),0) FROM "sites"."assist_site_event_counts" WHERE "siteId" = ${lit(SITE_ID)} AND "kind" = 'widget_view'`
      )
    );
    await page.goto(stand('localhost', { pk: PK, goalsKit: true }));
    await page.waitForTimeout(1500);
    await page.evaluate(() =>
      document
        .getElementById('tel')!
        .addEventListener('click', (e) => e.preventDefault())
    );
    await page.locator('#tel').click();
    await expect
      .poll(() =>
        sql(
          `SELECT "attribution" FROM "sites"."assist_site_goal_events" e JOIN "sites"."assist_site_goals" g ON g.id = e."goalId" WHERE g.key = ${lit(key)}`
        )
      )
      .toBe('unassisted');
    await page.goto('about:blank');
    await expect
      .poll(() =>
        Number(
          sql(
            `SELECT coalesce(sum("count"),0) FROM "sites"."assist_site_event_counts" WHERE "siteId" = ${lit(SITE_ID)} AND "kind" = 'widget_view'`
          )
        )
      )
      .toBeGreaterThan(before);
  } finally {
    sql(
      `DELETE FROM "sites"."assist_site_goals" WHERE "id" = ${lit(`w3e2e_g_${RUN}`)}`
    );
  }
});
