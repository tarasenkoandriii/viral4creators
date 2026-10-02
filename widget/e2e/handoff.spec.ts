/**
 * Э3 (W): передача человеку со стороны виджета (§3.7; приёмка Э3 п.1 и
 * п.3). На МОКЕ стенда: ответ оператора кладёт `/__mock/operator` (как
 * вебхук-реплай H пишет сообщение в базу); виджет видит его опросом
 * `GET /widget/v1/state` раз в 3 с. Серверная часть ≤ 5 с (вебхук → база →
 * state под ролью) — acceptance/e3/handoff.spec.ts (H) и интеграционный
 * прогон координатора.
 */
import { expect, test, type Page } from '@playwright/test';
import {
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

const HANDOFF = { enabled: true, etaMinutes: 4, etaText: {} };

test.beforeEach(async () => {
  await mock('reset');
});

async function callHuman(page: Page) {
  await chat(page).getByRole('button', { name: 'Позвать человека' }).click();
  const confirm = chat(page).getByRole('alertdialog', {
    name: 'Позвать человека?',
  });
  await expect(confirm).toContainText('Обычно отвечаем за ~4 мин.');
  await confirm.getByRole('button', { name: 'Позвать' }).click();
}

test('Э3 п.1: «позвать человека» → ожидание → ответ оператора появляется ≤ 5 с, подписан «Оператор», без метки ИИ', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { handoff: HANDOFF });
  await page.goto(stand('example.localhost', { pk, queue: true }));
  await page.evaluate(() =>
    (window as unknown as { V4CAssist: (...a: unknown[]) => void }).V4CAssist(
      'identify',
      { name: 'Олена', email: 'olena@example.com', externalId: 'cust-7' }
    )
  );
  await openChat(page);
  await ask(page, 'Хочу поговорить с человеком');
  await waitAnswer(page);
  await callHuman(page);
  await expect(chat(page).locator('[data-handoff=waiting]')).toContainText(
    'Зовём оператора'
  );
  const l = await log();
  expect(l.handoffs).toHaveLength(1);
  // identify — только вместе с передачей (К-3); в чат он не уходил.
  expect(l.handoffs[0].identity).toMatchObject({ externalId: 'cust-7' });
  expect(JSON.stringify(l.modelCalls)).not.toContain('olena@example.com');
  await page.waitForTimeout(1000);
  const t0 = Date.now();
  await mock('operator', { pk, text: 'Здравствуйте, я Ирина, помогу.' });
  const op = chat(page).locator('.msg.op');
  await expect(op).toContainText('Здравствуйте, я Ирина', { timeout: 5000 });
  const ms = Date.now() - t0;
  expect(ms).toBeLessThanOrEqual(5000);
  await expect(op.locator('.who')).toHaveText('Оператор');
  await expect(op.locator('.who.ai')).toHaveCount(0);
  await expect(op.locator('.fb')).toHaveCount(0); // оценка — только ответам ИИ
  await expect(chat(page).locator('.msg.bot .who.ai').first()).toHaveText('ИИ');
  await expect(chat(page).locator('[data-handoff=active]')).toContainText(
    'Оператор в чате'
  );
  console.log(`Э3 п.1: ответ оператора виден через ${ms} мс`);
  test.info().annotations.push({
    type: 'Э3 п.1 (мок)',
    description: `ответ оператора виден через ${ms} мс`,
  });
  // Вопрос во время передачи уходит человеку — модель не зовётся.
  const calls = (await log()).modelCalls.length;
  await ask(page, 'А когда доставка?');
  await expect(chat(page).locator('.msg.me').last()).toContainText(
    'А когда доставка?'
  );
  await page.waitForTimeout(800);
  expect((await log()).modelCalls).toHaveLength(calls);
  await expect(chat(page).locator('.dots')).toHaveCount(0);
});

test('Э3 п.3: посетитель ушёл — ответ оператора виден при возвращении через 23 ч', async ({
  page,
  context,
}) => {
  const pk = newPk();
  await site(pk, { handoff: HANDOFF });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Нужна консультация');
  await waitAnswer(page);
  await callHuman(page);
  await expect(chat(page).locator('[data-handoff=waiting]')).toBeVisible();
  await page.close();
  await mock('operator', { pk, text: 'Ответ оператора через сутки' });
  await mock('set', { clock: 23 * 3600e3 });
  // Новая вкладка через 23 ч: сессии нет — возврат по указателю (resumeKey).
  const back = await context.newPage();
  await back.goto(stand('example.localhost', { pk }));
  await openChat(back);
  await expect(chat(back).locator('.msg.op')).toContainText(
    'Ответ оператора через сутки'
  );
  const s = (await log()).sessions;
  expect(s[s.length - 1].resumed).toBe(true);
});

test('missed → форма заявки; нет операторов → сразу форма; отмена ожидания', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk, { handoff: HANDOFF });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Вопрос');
  await waitAnswer(page);
  // отмена ожидания
  await callHuman(page);
  await chat(page).getByRole('button', { name: 'Не ждать' }).click();
  await expect(chat(page).locator('[data-handoff]')).toHaveCount(0);
  expect((await log()).cancels).toBe(1);
  // новая передача, никто не взял → missed → форма заявки
  await callHuman(page);
  await expect(chat(page).locator('[data-handoff=waiting]')).toBeVisible();
  await mock('operator', { pk, state: 'missed' });
  await expect(chat(page).locator('form.lead')).toBeVisible({ timeout: 5000 });
  await expect(
    chat(page).getByText('Оператор не успел ответить', { exact: false })
  ).toBeVisible();

  const pk2 = newPk();
  await site(pk2, { handoff: HANDOFF, handoffMode: 'lead' });
  await page.goto(stand('example.localhost', { pk: pk2 }));
  await openChat(page);
  await ask(page, 'Вопрос');
  await waitAnswer(page);
  await callHuman(page);
  await expect(chat(page).locator('form.lead')).toBeVisible();
  await expect(
    chat(page).getByText('нет свободных операторов', { exact: false })
  ).toBeVisible();
});

test('передача выключена — кнопки «Позвать человека» нет', async ({ page }) => {
  const pk = newPk();
  await site(pk, {
    handoff: { enabled: false, etaMinutes: null, etaText: {} },
  });
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await expect(
    chat(page).getByRole('button', { name: 'Позвать человека' })
  ).toHaveCount(0);
});

test('склейка стрима (решение 23): поток отдал телефон, база — маску → в ленте текст из state', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  await page.goto(stand('example.localhost', { pk }));
  await openChat(page);
  await ask(page, 'Телефон менеджера? __mask__');
  const bot = chat(page).locator('.msg.bot').last();
  await expect(bot).toContainText('[телефон скрыт]', { timeout: 10_000 });
  await expect(bot).not.toContainText('123 45 67');
});
