/**
 * ST2-U-02 (аудит Story‑Tales 2, 20.10.2026): фото подарка подгоняется под
 * лимит сервера (PNG ≤1024 px, ≤1 МиБ) шагами, а не фиксированными 960 px.
 * Исходный сценарий: снимок 1024×768 / 1000×872 давал PNG 960 px ≈1,1 МиБ
 * и отказ «выберите поменьше». Кодировщик здесь — модель «байты ∝ площадь»
 * (как у PNG фото); реальное кодирование Chromium проверяет Playwright
 * (`/tmp/fx2-ui/pw_fix.py`).
 */
import assert from 'node:assert/strict';
import {
  STORY_PHOTO_MAX_BASE64,
  STORY_PHOTO_MAX_BYTES,
  STORY_PHOTO_MAX_SIDE,
  STORY_PHOTO_TARGET_BYTES,
  base64Bytes,
  base64Length,
  fitSize,
  fitStoryPhoto,
  nextSide,
} from '../src/features/stories/story-photo-fit';

let passed = 0;
async function it(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed += 1;
  console.log('  ✓', name);
}

/** base64 строки нужной длины для `bytes` байт. */
function fakeBase64(bytes: number): string {
  return 'A'.repeat(base64Length(bytes));
}
/** PNG-«фото»: `bytesPerPixel` байт на пиксель холста. */
function encoder(bytesPerPixel: number, log: Array<[number, number]> = []) {
  return async (w: number, h: number) => {
    log.push([w, h]);
    return fakeBase64(Math.round(w * h * bytesPerPixel));
  };
}

async function main() {
  await it('лимиты совпадают с сервером и DTO', () => {
    assert.equal(STORY_PHOTO_MAX_SIDE, 1024);
    assert.equal(STORY_PHOTO_MAX_BYTES, 1024 * 1024);
    // `@MaxLength(1398104)` в story-gifts.controller.ts.
    assert.equal(STORY_PHOTO_MAX_BASE64, 1398104);
    assert.ok(STORY_PHOTO_TARGET_BYTES < STORY_PHOTO_MAX_BYTES);
    assert.equal(base64Bytes('AAAA'), 3);
    assert.equal(base64Bytes('AAA='), 2);
    assert.equal(base64Bytes('AA=='), 1);
  });

  await it('исходный сценарий: фото 1024×768, PNG 960 px ≈1,1 МиБ — теперь проходит', async () => {
    // 960×720 = 691 200 px ≈ 1,1 МиБ → ≈1,6 байта/px (замер аудитора).
    const bpp = 1_095_380 / (960 * 720);
    const log: Array<[number, number]> = [];
    const r = await fitStoryPhoto(1024, 768, encoder(bpp, log));
    assert.ok(base64Bytes(r.base64) <= STORY_PHOTO_TARGET_BYTES);
    assert.ok(r.base64.length <= STORY_PHOTO_MAX_BASE64);
    assert.ok(Math.max(r.width, r.height) <= 1024);
    // Первая попытка — полный допустимый размер, не 960.
    assert.deepEqual(log[0], [1024, 768]);
    assert.ok(log.length >= 2, 'нужно было уменьшить хотя бы раз');
    // Не ужимает сильнее, чем нужно: остаётся больше 600 px.
    assert.ok(r.width > 600, `слишком мелко: ${r.width}`);
  });

  await it('фото 4000×3000 с телефона: старт 1024×768 и уменьшение до лимита', async () => {
    const log: Array<[number, number]> = [];
    const r = await fitStoryPhoto(4000, 3000, encoder(2.2, log));
    assert.deepEqual(log[0], [1024, 768]);
    assert.ok(base64Bytes(r.base64) <= STORY_PHOTO_TARGET_BYTES);
    assert.ok(r.attempts <= 4, `попыток: ${r.attempts}`);
  });

  await it('шум (≈4 байта/px) всё равно укладывается за несколько шагов', async () => {
    const r = await fitStoryPhoto(3000, 3000, encoder(4));
    assert.ok(base64Bytes(r.base64) <= STORY_PHOTO_TARGET_BYTES);
    assert.ok(r.width >= 240);
  });

  await it('маленькое фото не увеличивается и проходит с первого раза', async () => {
    const log: Array<[number, number]> = [];
    const r = await fitStoryPhoto(640, 480, encoder(1.5, log));
    assert.equal(log.length, 1);
    assert.deepEqual([r.width, r.height], [640, 480]);
  });

  await it('невозможно сжать — понятная ошибка про сжатие, не «выберите поменьше»', async () => {
    let message = '';
    try {
      await fitStoryPhoto(4000, 3000, encoder(30));
    } catch (e) {
      message = (e as Error).message;
      assert.equal((e as Error).name, 'StoryPhotoTooLarge');
    }
    assert.ok(/сжать фото до 1 МБ/.test(message), message);
  });

  await it('fitSize и nextSide: пропорции и монотонное уменьшение', () => {
    assert.deepEqual(fitSize(4000, 3000, 1024), { width: 1024, height: 768 });
    assert.deepEqual(fitSize(3000, 4000, 1024), { width: 768, height: 1024 });
    assert.deepEqual(fitSize(500, 400, 1024), { width: 500, height: 400 });
    const s = nextSide(1024, 1_200_000, STORY_PHOTO_TARGET_BYTES);
    assert.ok(s < 1024 && s > 800, String(s));
    // Перерасход на 1 % — всё равно шаг не меньше 8 %.
    assert.ok(nextSide(1000, 1_010_000, 1_000_000) <= 920);
    // Огромный перерасход — шаг ограничен снизу (0,35).
    assert.equal(nextSide(1000, 100_000_000, 1_000_000), 350);
  });

  console.log(`story-photo-fit: ${passed} проверок пройдено`);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
