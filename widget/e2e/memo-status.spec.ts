import { test, expect } from '@playwright/test';

test('memo status snapshot is opt-in, read-only and excludes protected text', async ({
  page,
}) => {
  await page.goto('http://localhost:5181/__mock/log');
  await page.setContent(`<button>Отправить</button>
    <p role="status">Заявка принята qa@example.com <span data-assist="never">секрет</span><span hidden>скрыто</span></p>
    <div data-assist="never"><p role="status">запрещено</p></div>
    <div data-ugc><p role="status">отзыв</p></div>
    <p role="status" class="private">закрыто</p>
    <p role="status" style="display:none">невидимо</p>`);
  const messages = await page.evaluate(async () => {
    const path = '/v1/act.js';
    const { start } = await import(path);
    const messages: Array<{
      snapshot: { statusTexts?: string[]; elements: Array<{ text: string }> };
    }> = [];
    const api = start({
      N: {
        on: (target: EventTarget, event: string, fn: EventListener) =>
          target.addEventListener(event, fn),
      },
      post: (m: (typeof messages)[number]) => messages.push(m),
      min() {},
      mark() {},
    });
    api.on({
      type: 'ui-snap',
      rid: 'statuscheck1',
      deny: ['.private'],
      allow: [],
    });
    api.on({
      type: 'ui-snap',
      rid: 'statuscheck2',
      deny: ['.private'],
      allow: [],
      statuses: true,
    });
    return messages;
  });
  expect(messages[0].snapshot.statusTexts).toBeUndefined();
  expect(messages[1].snapshot.statusTexts).toHaveLength(1);
  expect(messages[1].snapshot.statusTexts![0]).toContain('Заявка принята');
  expect(JSON.stringify(messages[1])).not.toMatch(
    /qa@example.com|секрет|скрыто|запрещено|отзыв|закрыто|невидимо/
  );
  expect(messages[1].snapshot.elements.map((e) => e.text)).toEqual([
    'Отправить',
  ]);
  await expect(page.locator('[data-assist="never"]').first()).toContainText(
    'секрет'
  );
});
