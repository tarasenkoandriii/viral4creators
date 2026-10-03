/**
 * Т-1 (§5-бис.12), уровень «звук малый»: голосовое управление со ЗВУКОМ в
 * Chromium, двумя способами подачи (оба — настоящий путь захвата
 * iframe-чата: `getUserMedia` → MediaRecorder → детектор речи → отправка):
 *
 *  способ 1 — `--use-file-for-fake-audio-capture`: фейковый микрофон
 *    Chromium играет фикстуру с начала при каждом открытии микрофона;
 *  способ 2 — WebAudio-хук ТЕСТОВОЙ сборки голосового чанка (`npm run
 *    build:test-audio` → dist-test/v1/voice.js; стенд отдаёт его по
 *    `/__mock/set {testAudio:true}`): тест подаёт фикстуру в нужный момент
 *    и меряет «начало речи → пауза плана» (§5-бис.5: пауза до распознавания).
 *
 * Фикстуры — мок-синтез конвейера `scripts/t1/*` (слоги, не речь):
 * распознавание — мок стенда (очередь `voiceTexts`), живые голоса и
 * записи дикторов — уровень «звук полный» у владельца.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  MOCK_VOICES,
  concat,
  encodeWav,
  mixAtSnr,
  mockSpeech,
  noise,
  silence,
} from '../scripts/t1/audio';
import { framed } from '../scripts/t1/synth';
import {
  WIDGET,
  chat,
  log,
  mock,
  newPk,
  openChat,
  origin,
  site,
} from './fixtures';
import type { ModelStep } from './stand/ui-plan-mock';

const A = origin('example.localhost');
const VOICE = {
  input: true,
  output: false,
  maxRecordMs: 30_000,
  minSpeechMs: 400,
  endSilenceMs: 1_000,
};
/** Долгий план (подсветки по ~1 с) — успеть сказать «стоп» посреди. */
const SLOW: ModelStep[] = [
  { kind: 'highlight', find: { text: 'Пошук' } },
  { kind: 'highlight', find: { text: 'Синя футболка — 450 грн' } },
  { kind: 'highlight', find: { text: 'Червона футболка — 470 грн' } },
  { kind: 'highlight', find: { text: 'Таблиця розмірів' } },
  { kind: 'fill', find: { text: 'Пошук' }, value: 'футболку' },
];
const CMD = 'знайди футболку';

const vcLog = async () => (await log()).vc;
const mic = (page: Page) => chat(page).locator('.cmp button.mic');

async function start(
  page: Page,
  o: { voiceTexts: string[]; model?: Record<string, ModelStep[]> }
) {
  const pk = newPk();
  await site(pk, {
    voice: VOICE,
    voiceControl: { mode: 'on' },
    vcModel: o.model ?? { [CMD]: SLOW },
    voiceTexts: o.voiceTexts,
  });
  await page.goto(`${A}/vc/polygon/?pk=${encodeURIComponent(pk)}&m=1`);
  await openChat(page);
  // Голос: первое нажатие — согласие виджета, затем запись.
  await mic(page).click();
  await chat(page)
    .locator('.vconsent')
    .getByRole('button', { name: 'Увімкнути' })
    .click();
  return pk;
}

/** «Нажимать за вас?» — разрешение голосового управления (один раз). */
async function allowActing(page: Page) {
  const btn = chat(page).locator('.vconsent button', { hasText: 'Дозволити' });
  await expect(btn).toBeVisible({ timeout: 15_000 });
  await btn.click();
}

/** Способ 1 — флаги на весь файл (браузер один); хук способа 2 подменяет `getUserMedia` поверх. */
const file = path.join(os.tmpdir(), `v4c-t1-cmd-${process.pid}.wav`);
fs.writeFileSync(file, encodeWav(framed(mockSpeech(CMD, MOCK_VOICES[0]))));
test.use({
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${file}%noloop`,
    ],
  },
});
test.describe('способ 1: --use-file-for-fake-audio-capture', () => {
  test.beforeEach(async () => {
    await mock('reset');
  });

  test('команда голосом → план идёт; микрофон плана слышит речь → пауза → «стоп» → план остановлен, поле не заполнено', async ({
    page,
  }) => {
    const pk = await start(page, { voiceTexts: [CMD, 'стоп'] });
    await allowActing(page);
    await expect
      .poll(async () => (await vcLog()).plans.length, { timeout: 15_000 })
      .toBe(1);
    const plan = (await vcLog()).plans[0];
    expect(plan.text).toBe(CMD);
    expect(plan.source).toBe('voice');
    // Вторая запись — микрофон плана: та же фикстура снова → «стоп».
    await expect
      .poll(async () => (await vcLog()).stops.map((s) => s.by), {
        timeout: 20_000,
      })
      .toEqual(['voice']);
    await expect(page.locator('[data-v4c-act]')).toHaveCount(0);
    expect((await log()).voice.filter((v) => v.pk === pk)).toHaveLength(2);
    await page.waitForTimeout(1500);
    expect(await page.locator('#q').inputValue()).toBe('');
  });
});

test.describe('способ 2: WebAudio-хук тестовой сборки', () => {
  test.skip(
    !fs.existsSync(path.join(process.cwd(), 'dist-test', 'v1', 'voice.js')),
    'нет dist-test — npm run build:test-audio'
  );
  test.beforeEach(async ({ page }) => {
    await mock('reset');
    await mock('set', { testAudio: true });
    // Момент паузы плана — сообщение iframe → загрузчик (видно странице).
    await page.addInitScript(() => {
      const w = window as unknown as { __pauses: number[] };
      w.__pauses = [];
      window.addEventListener('message', (e) => {
        const d = e.data as { type?: string; on?: boolean } | null;
        if (d && d.type === 'ui-pause' && d.on === true)
          w.__pauses.push(Date.now());
      });
    });
  });
  test.afterAll(async () => {
    await fetch(`${WIDGET}/__mock/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testAudio: false }),
    }).catch(() => undefined);
  });

  const frame = (page: Page): Frame => {
    const f = page.frames().find((x) => x.url().startsWith(WIDGET));
    if (!f) throw new Error('нет iframe виджета');
    return f;
  };
  type Hook = {
    feed(pcm: number[], rate: number): Promise<number>;
    opened(): number;
  };
  const opened = (page: Page) =>
    frame(page).evaluate(
      () =>
        (
          window as unknown as { __v4cTestAudio?: Hook }
        ).__v4cTestAudio?.opened() ?? -1
    );
  /** Подать звук, не дожидаясь конца; вернуть момент начала подачи. */
  const feed = (page: Page, s: Float32Array) =>
    frame(page).evaluate(
      ([pcm]) =>
        new Promise<number>((resolve) => {
          const h = (window as unknown as { __v4cTestAudio: Hook })
            .__v4cTestAudio;
          const t = Date.now();
          void h.feed(pcm, 16_000);
          resolve(t);
        }),
      [Array.from(s)] as const
    );

  test('«стоп» голосом посреди плана: пауза плана ≤ 150 мс от начала речи (до распознавания), затем стоп', async ({
    page,
  }) => {
    await start(page, { voiceTexts: [CMD, 'стоп'] });
    await expect.poll(() => opened(page)).toBe(1);
    await feed(page, framed(mockSpeech(CMD, MOCK_VOICES[1])));
    await allowActing(page);
    await expect(page.locator('[data-v4c-act]')).toBeAttached({
      timeout: 15_000,
    });
    // Микрофон плана открыт — говорим «стоп» (речь с первого сэмпла).
    await expect.poll(() => opened(page), { timeout: 10_000 }).toBe(2);
    await page.waitForTimeout(300); // калибровка шумового пола детектора
    const at = await feed(
      page,
      concat(mockSpeech('стоп', MOCK_VOICES[2]), silence(2))
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (window as unknown as { __pauses: number[] }).__pauses.length
          ),
        { timeout: 5_000 }
      )
      .toBeGreaterThan(0);
    const pausedAt = (
      await page.evaluate(
        () => (window as unknown as { __pauses: number[] }).__pauses
      )
    )[0];
    const latency = pausedAt - at;
    test
      .info()
      .annotations.push({ type: 'pause-ms', description: String(latency) });
    expect(latency).toBeGreaterThanOrEqual(0);
    expect(latency).toBeLessThanOrEqual(150);
    await expect
      .poll(async () => (await vcLog()).stops.map((s) => s.by), {
        timeout: 15_000,
      })
      .toEqual(['voice']);
    await expect(page.locator('[data-v4c-act]')).toHaveCount(0);
    expect(await page.locator('#q').inputValue()).toBe('');
  });

  test('команда в шуме «кафе» при SNR 10 дБ — услышана и выполнена; «только шум» — ни одного плана', async ({
    page,
  }) => {
    const pk = await start(page, {
      voiceTexts: ['', CMD],
      model: {
        [CMD]: [{ kind: 'fill', find: { text: 'Пошук' }, value: 'футболку' }],
      },
    });
    await expect.poll(() => opened(page)).toBe(1);
    // Только шум (разговор рядом), громко: распознавание — пусто → не команда.
    const n = noise('cafe', 3, 77).map((x) => x * 2);
    await feed(page, concat(silence(0.4), n, silence(1.6)));
    await expect
      .poll(async () => (await log()).voice.filter((v) => v.pk === pk).length, {
        timeout: 15_000,
      })
      .toBe(1);
    await page.waitForTimeout(500);
    expect((await vcLog()).plans).toHaveLength(0);
    // Команда в шуме — новая запись нажатием.
    await mic(page).click();
    await expect.poll(() => opened(page)).toBe(2);
    const clean = framed(mockSpeech(CMD, MOCK_VOICES[3]));
    const { mix } = mixAtSnr(
      clean,
      noise('cafe', clean.length / 16_000, 5),
      10
    );
    await feed(page, mix);
    await allowActing(page);
    await expect(page.locator('#q')).toHaveValue('футболку', {
      timeout: 15_000,
    });
    expect((await vcLog()).plans).toHaveLength(1);
  });
});
