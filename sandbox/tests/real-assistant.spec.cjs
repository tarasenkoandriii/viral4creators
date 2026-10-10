// Run after registering the separate sandbox site and publishing its knowledge.
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');
test('real assistant answers a sandbox knowledge question', async ({ request }) => {
  test.setTimeout(120000);
  test.skip(!process.env.ASSIST_SANDBOX_PUBLIC_KEY, 'Sandbox site has not been registered yet');
  const api = process.env.ASSIST_API_URL || 'https://assist-api.viral4creators.app';
  const parentOrigin = new URL(process.env.SANDBOX_URL || 'https://sandbox.viral4creators.app').origin;
  const widgetOrigin = 'https://assist-w.viral4creators.app';
  const sessionResponse = await request.post(api + '/widget/v1/session', {
    headers: { Origin: widgetOrigin },
    data: { pk: process.env.ASSIST_SANDBOX_PUBLIC_KEY, parentOrigin }
  });
  expect(sessionResponse.status()).toBe(200);
  const session = (await sessionResponse.json()).data;
  expect(session.visitorToken).toBeTruthy();
  const answerResponse = await request.post(api + '/widget/v1/chat', {
    headers: { Origin: widgetOrigin, Accept: 'application/json', 'X-Assist-Visitor': session.visitorToken },
    data: { conversationId: null, clientRequestId: randomUUID(), question: 'Как отправить тестовую заявку на этом sandbox-сайте?', page: { url: parentOrigin + '/', title: 'Sandbox — Viral4Creators' }, context: null, uiLang: 'ru' },
    timeout: 90000
  });
  expect(answerResponse.status()).toBe(200);
  const answer = (await answerResponse.json()).data;
  expect(answer.refused).toBe(false);
  expect(answer.streaming).toBe(false);
  expect(answer.messageId).toBeTruthy();
  expect(answer.text).toMatch(/заявк/iu);
  expect(answer.text.length).toBeGreaterThan(30);
});
