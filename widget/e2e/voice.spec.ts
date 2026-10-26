/**
 * Э5: голос в iframe-чате — e2e в Chromium с фейковым микрофоном
 * (`--use-fake-device-for-media-stream` + `--use-file-for-fake-audio-capture`
 * — тот же способ, что Т-1 §5-бис.12 п.1: настоящий путь захвата —
 * `allow="microphone"` на iframe, `getUserMedia` в стороннем iframe,
 * MediaRecorder, детектор речи на устройстве, отправка). Разрешение
 * микрофона — `--use-fake-ui-for-media-stream` (без диалога браузера);
 * согласие ВИДЖЕТА — своё и проверяется.
 *
 * Звук фикстуры — синтетический «слог» (гармоники 140 Гц с огибающей
 * 4 Гц), не речь: распознавание — мок W2 (стенд), живой Soniox и живые
 * iOS/Android — у владельца (doc/DEPLOYMENT.md §6.13).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  ask,
  chat,
  log,
  newPk,
  openChat,
  site,
  stand,
  waitAnswer,
} from './fixtures';

/** WAV 16 кГц моно: 0.5 с тишины, 1.4 с «речи», 3 с тишины. */
function speechWav(): string {
  const rate = 16_000;
  const parts = [0.5, 1.4, 3];
  const n = Math.floor(parts.reduce((a, b) => a + b, 0) * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  const from = parts[0] * rate;
  const to = (parts[0] + parts[1]) * rate;
  for (let i = 0; i < n; i++) {
    let v = 0;
    if (i >= from && i < to) {
      const t = i / rate;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      for (let h = 1; h <= 8; h++)
        v += Math.sin(2 * Math.PI * 140 * h * t + h) / h;
      v *= 0.25 * env;
    }
    b.writeInt16LE(
      Math.max(-32767, Math.min(32767, Math.round(v * 32767))),
      44 + i * 2
    );
  }
  const file = path.join(os.tmpdir(), `v4c-e5-speech-${process.pid}.wav`);
  fs.writeFileSync(file, b);
  return file;
}

const WAV = speechWav();

test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV}%noloop`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

const VOICE = {
  input: true,
  output: true,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};

async function voiceSite(o: Parameters<typeof site>[1] = {}) {
  const pk = newPk();
  await site(pk, { voice: VOICE, ...o });
  return pk;
}

/** Нарушения CSP/Trusted Types (iframe: script-src 'self', media-src blob:, TT 'none'). */
function cspErrors(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (
      /Content Security Policy|TrustedHTML|TrustedScript|Trusted Type/i.test(t)
    )
      out.push(t);
  });
  return out;
}

async function open(page: Page, pk: string) {
  await page.goto(stand('example.localhost', { pk, lang: 'uk' }));
  await openChat(page);
}

const mic = (page: Page) => chat(page).locator('.cmp button.mic');
/** Записи и озвучки ЭТОГО сайта (лог мока общий на прогон). */
const voiceOf = async (pk: string) =>
  (await log()).voice.filter((v) => v.pk === pk);
const ttsOf = async (pk: string) =>
  (await log()).tts.filter((v) => v.pk === pk);
const bar = (page: Page) => chat(page).locator('.vbar');

test('голоса нет в конфиге — ни кнопки микрофона, ни чанка voice.js', async ({
  page,
}) => {
  const pk = newPk();
  await site(pk);
  const chunk: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/voice.js')) chunk.push(r.url());
  });
  await open(page, pk);
  await expect(chat(page).locator('.cmp textarea')).toBeEnabled();
  await expect(mic(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(chunk).toEqual([]);
});

test('push-to-talk: согласие называет слушателя; индикатор; фраза кончилась тишиной → текст ушёл вопросом с билетом', async ({
  page,
}) => {
  const pk = await voiceSite();
  const csp = cspErrors(page);
  const chunk: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/v1/voice.js')) chunk.push(r.url());
  });
  await page.goto(stand('example.localhost', { pk, lang: 'uk' }));
  // До открытия чата голосовой чанк не грузится (iframe ещё нет).
  expect(chunk).toEqual([]);
  await openChat(page);
  await expect(mic(page)).toBeVisible();
  await expect.poll(() => chunk.length).toBe(1);
  // Первое нажатие — только согласие: микрофон ещё закрыт, записи нет.
  await mic(page).click();
  const consent = chat(page).locator('.vconsent');
  await expect(consent).toContainText('ІІ-помічник цього сайту');
  await expect(consent).toContainText('одразу видаляється');
  await expect(bar(page)).toHaveCount(0);
  expect(await voiceOf(pk)).toHaveLength(0);
  await consent.getByRole('button', { name: 'Увімкнути' }).click();
  // Индикатор записи — видимый, с таймером и кнопкой «стоп».
  await expect(bar(page)).toContainText('Слухаю');
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
  // Фраза кончается тишиной ~1 с — запись уходит сама.
  await expect(bar(page)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await voiceOf(pk)).length).toBe(1);
  const v = (await voiceOf(pk))[0];
  expect(v.type).toMatch(/^audio\/(webm|ogg|mp4)/);
  expect(v.bytes).toBeGreaterThan(1_000);
  await expect(chat(page).locator('.msg.me').last()).toContainText(
    'Скільки коштує доставка?'
  );
  await expect(chat(page).locator('.msg.me .who').last()).toContainText(
    'голосом'
  );
  await waitAnswer(page);
  const calls = (await log()).modelCalls;
  expect(calls.at(-1)).toMatchObject({
    question: 'Скільки коштує доставка?',
    voiceTicket: expect.stringMatching(/^v1\./),
  });
  // Второй раз согласие не спрашивается — сразу запись.
  await mic(page).click();
  await expect(bar(page)).toBeVisible();
  await expect(chat(page).locator('.vconsent')).toHaveCount(0);
  // «Стоп» кнопкой — запись уходит сразу.
  await chat(page).locator('.vbar .lnk').click();
  await expect(bar(page)).toHaveCount(0, { timeout: 10_000 });
  expect(csp).toEqual([]);
});

test('потолок голоса — одно уведомление, кнопки голоса пропали, чат отвечает текстом', async ({
  page,
}) => {
  const pk = await voiceSite({ voiceMode: 'limit' });
  await open(page, pk);
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect(chat(page).locator('.note[role="status"]')).toHaveText(
    'Голос на сьогодні вичерпано — пишіть текстом.',
    { timeout: 15_000 }
  );
  await expect(mic(page)).toHaveCount(0);
  await ask(page, 'Скільки коштує доставка?');
  await waitAnswer(page);
  await expect(chat(page).locator('.spk')).toHaveCount(0);
  await expect(chat(page).locator('.msg.bot').last()).toContainText(
    'Ответ на вопрос'
  );
  expect(await voiceOf(pk)).toHaveLength(1);
});

test('«не розчув» — уведомление, голос остаётся', async ({ page }) => {
  const pk = await voiceSite({ voiceMode: 'not_heard' });
  await open(page, pk);
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect(chat(page).locator('.note[role="status"]')).toContainText(
    'Не розчув',
    {
      timeout: 15_000,
    }
  );
  await expect(mic(page)).toBeVisible();
});

test('озвучка ответа: кнопка у ответа, звук из POST /tts, «стоп» повторным нажатием', async ({
  page,
}) => {
  const pk = await voiceSite({ voice: { ...VOICE, input: false } });
  const csp = cspErrors(page);
  await open(page, pk);
  await expect(mic(page)).toHaveCount(0);
  await ask(page, 'Скільки коштує доставка?');
  await waitAnswer(page);
  const spk = chat(page).locator('.msg.bot .spk').last();
  await spk.click();
  await expect.poll(async () => (await ttsOf(pk)).length).toBe(1);
  expect((await ttsOf(pk))[0].ok).toBe(true);
  await expect(spk).toHaveAttribute('aria-pressed', 'true');
  // 0.4 с тона — доиграл сам.
  await expect(spk).toHaveAttribute('aria-pressed', 'false', {
    timeout: 5_000,
  });
  await spk.click();
  // Explicit cancel remains available while preparing; play cannot cancel itself.
  await chat(page)
    .getByRole('button', { name: 'Зупинити озвучення', exact: true })
    .click();
  await expect(spk).toHaveAttribute('aria-pressed', 'false');
  await expect(spk).toHaveAttribute('aria-label', 'Озвучити відповідь');
  expect(csp).toEqual([]);
});

test('две вкладки: микрофон в первой гаснет, когда включают во второй (§4-бис.10 п.5)', async ({
  context,
}) => {
  const pk = await voiceSite();
  const p1 = await context.newPage();
  const p2 = await context.newPage();
  await open(p1, pk);
  await open(p2, pk);
  await mic(p1).click();
  await chat(p1)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect(bar(p1)).toBeVisible();
  // Согласие — общее для вкладок (localStorage iframe): вторая пишет сразу.
  await mic(p2).click();
  await expect(bar(p2)).toBeVisible();
  await expect(bar(p1)).toHaveCount(0);
  await expect(bar(p2)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(async () => (await voiceOf(pk)).length).toBe(1);
  await p1.waitForTimeout(500);
  expect(await voiceOf(pk)).toHaveLength(1);
});

test('закрыли чат во время записи — запись брошена; после перезагрузки микрофон сам не открывается (Р-28)', async ({
  page,
}) => {
  const pk = await voiceSite();
  await open(page, pk);
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect(bar(page)).toBeVisible();
  await chat(page).locator('.cmp textarea').press('Escape');
  await page.waitForTimeout(3_500);
  expect(await voiceOf(pk)).toHaveLength(0);
  await page.reload();
  await openChat(page);
  await expect(mic(page)).toHaveClass(/paused/);
  await expect(mic(page)).toHaveAttribute('aria-label', /на паузі/);
  await expect(bar(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(await voiceOf(pk)).toHaveLength(0);
});

test.afterAll(() => {
  fs.rmSync(WAV, { force: true });
});

test('streaming: real PCM chunks, one final redemption, no async upload', async ({
  page,
}) => {
  const errors = cspErrors(page);
  const pk = await voiceSite({ voice: { ...VOICE, streaming: true } });
  let grants = 0,
    finals = 0,
    audio = 0,
    asyncUploads = 0;
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/widget/v1/voice') asyncUploads++;
  });
  await page.route('**/widget/v1/voice/stream', async (route) => {
    grants++;
    await route.fulfill({
      json: {
        success: true,
        data: {
          url: 'wss://relay.example/voice/stream',
          grant: 'bound-grant',
          signature: 'mock-signature',
        },
      },
    });
  });
  await page.route('**/widget/v1/voice/stream/final', async (route) => {
    finals++;
    expect(route.request().postDataJSON()).toEqual({
      grant: 'bound-grant',
      receipt: 'signed-final',
      signature: 'sealed',
    });
    await route.fulfill({
      json: {
        success: true,
        data: { text: 'Як оплатити?', voiceTicket: 'mock-final-ticket' },
      },
    });
  });
  await page.routeWebSocket('wss://relay.example/voice/stream', (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== 'string') {
        expect(message.length % 2).toBe(0);
        audio += message.length;
        return;
      }
      if (message === '')
        ws.send(
          JSON.stringify({
            type: 'final',
            receipt: 'signed-final',
            signature: 'sealed',
          })
        );
      else if (message.startsWith('{'))
        ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await open(page, pk);
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect.poll(() => finals, { timeout: 15000 }).toBe(1);
  await expect.poll(() => audio).toBeGreaterThan(0);
  await expect(bar(page)).toBeHidden();
  expect(grants).toBe(1);
  expect(asyncUploads).toBe(0);
  expect(errors).toEqual([]);
});

test('streaming Stop cancels capture and never creates fallback or another stream', async ({
  page,
}) => {
  const pk = await voiceSite({ voice: { ...VOICE, streaming: true } });
  let grants = 0,
    finals = 0,
    sockets = 0,
    chunks = 0;
  const uploads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/widget/v1/voice') uploads.push(r.url());
  });
  await page.route('**/widget/v1/voice/stream', async (route) => {
    grants++;
    await route.fulfill({
      json: {
        success: true,
        data: {
          url: 'wss://relay.example/voice/stream',
          grant: 'g',
          signature: 's',
        },
      },
    });
  });
  await page.route('**/widget/v1/voice/stream/final', async (route) => {
    finals++;
    await route.fulfill({
      json: { success: true, data: { text: 'late', voiceTicket: 'ticket' } },
    });
  });
  await page.routeWebSocket('wss://relay.example/voice/stream', (ws) => {
    sockets++;
    ws.onMessage((message) => {
      if (typeof message !== 'string') chunks++;
      else if (message.startsWith('{'))
        ws.send(JSON.stringify({ type: 'ready' }));
    });
  });
  await open(page, pk);
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  await expect.poll(() => chunks).toBeGreaterThan(0);
  await chat(page)
    .getByRole('button', { name: 'Stop — зупинити голос і дії', exact: true })
    .click();
  await expect(bar(page)).toBeHidden();
  const before = chunks;
  await page.waitForTimeout(1000);
  expect(chunks).toBe(before);
  expect(grants).toBe(1);
  expect(sockets).toBe(1);
  expect(finals).toBe(0);
  expect(uploads).toEqual([]);
});

test('slow audio preparation stays visible and does not require repeated play taps', async ({
  page,
}) => {
  const pk = await voiceSite({ voice: { ...VOICE, input: false } });
  await open(page, pk);
  await ask(page, 'Скільки коштує доставка?');
  await waitAnswer(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route('**/widget/v1/tts', async (route) => {
    requests++;
    await held;
    await route.continue();
  });
  await chat(page)
    .getByRole('button', { name: 'Озвучити відповідь', exact: true })
    .click();
  const preparing = chat(page).getByRole('button', {
    name: 'Готуємо озвучення…',
    exact: true,
  });
  await expect(preparing).toBeVisible();
  await expect(preparing).toBeDisabled();
  await expect(
    chat(page).getByRole('button', { name: 'Зупинити озвучення', exact: true })
  ).toBeEnabled();
  await expect.poll(() => requests).toBe(1);
  release();
  await expect(preparing).toHaveCount(0);
  await expect.poll(async () => (await ttsOf(pk)).length).toBe(1);
});
