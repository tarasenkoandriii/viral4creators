import {
  analyzeTimeoutMs,
  ANALYZE_MARGIN_MS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  backoffMs,
  budgetAllows,
  DEFAULT_BACKFILL_CAP,
  DEFAULT_DAILY_USD,
  DEFAULT_DAILY_VIDEO_MINUTES,
  demoQualityDedupeKey,
  isTransientError,
  MAX_ANALYZE_MS,
  MAX_BACKFILL_CAP,
  MIN_ANALYZE_MS,
  nextUtcDay,
  readDemoQualityConfig,
  sha256Hex,
  startOfUtcDay,
} from './demo-quality-queue';
import { GEMINI_MODEL } from '../../common/gemini-model';

describe('ключ дедупликации', () => {
  it('зависит от ролика, содержимого, рубрики и модели', () => {
    const k = demoQualityDedupeKey('a', 'sha', 'v1', 'm');
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(demoQualityDedupeKey('a', 'sha', 'v1', 'm')).toBe(k);
    expect(demoQualityDedupeKey('b', 'sha', 'v1', 'm')).not.toBe(k);
    expect(demoQualityDedupeKey('a', 'sha2', 'v1', 'm')).not.toBe(k);
    expect(demoQualityDedupeKey('a', 'sha', 'v2', 'm')).not.toBe(k);
    expect(demoQualityDedupeKey('a', 'sha', 'v1', 'm2')).not.toBe(k);
  });

  it('sha256 байтов', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('пауза повтора', () => {
  it('2 → 4 → 8 мин, не больше потолка', () => {
    expect(backoffMs(1)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(backoffMs(3)).toBe(4 * BACKOFF_BASE_MS);
    expect(backoffMs(0)).toBe(BACKOFF_BASE_MS);
    expect(backoffMs(20)).toBe(BACKOFF_MAX_MS);
  });
});

describe('сутки UTC', () => {
  it('начало и следующие', () => {
    const now = new Date('2026-10-06T23:59:00.000Z');
    expect(startOfUtcDay(now).toISOString()).toBe('2026-10-06T00:00:00.000Z');
    expect(nextUtcDay(now).toISOString()).toBe('2026-10-07T00:00:00.000Z');
  });
});

describe('временная ли ошибка', () => {
  it.each([
    [{ status: 429 }, true],
    [{ status: 408 }, true],
    [{ status: 500 }, true],
    [{ status: 503 }, true],
    [{ status: 400 }, false],
    [{ status: 403 }, false],
    [{ status: 404 }, false],
    [{ name: 'AbortError' }, true],
    [{ name: 'TimeoutError' }, true],
    [{ code: 'ECONNRESET' }, true],
    [{ code: 'EAI_AGAIN' }, true],
    [new TypeError('fetch failed'), true],
    [new Error('RESOURCE_EXHAUSTED: quota'), true],
    [new Error('invalid argument'), false],
    [null, false],
    ['строка', false],
  ])('%p → %p', (err, expected) => {
    expect(isTransientError(err)).toBe(expected);
  });
});

describe('настройки из env', () => {
  it('по умолчанию выключено, модель соседних проверок, безопасные потолки', () => {
    const c = readDemoQualityConfig({});
    expect(c).toEqual({
      enabled: false,
      frameSignals: false,
      blockPublication: false,
      model: GEMINI_MODEL,
      dailyLimitMicroUsd: DEFAULT_DAILY_USD * 1_000_000,
      dailyVideoMs: DEFAULT_DAILY_VIDEO_MINUTES * 60_000,
      backfillCap: DEFAULT_BACKFILL_CAP,
    });
  });

  it('включение, своя модель, потолки; мусор — к умолчанию; потолок одобренных зажат', () => {
    const c = readDemoQualityConfig({
      TUTORIAL_DEMO_QUALITY_ENABLED: 'true',
      TUTORIAL_DEMO_QUALITY_MODEL: ' gemini-2.5-pro ',
      TUTORIAL_DEMO_QUALITY_DAILY_USD: '0.25',
      TUTORIAL_DEMO_QUALITY_DAILY_VIDEO_MINUTES: '5',
      TUTORIAL_DEMO_QUALITY_BACKFILL_CAP: '1000',
      TUTORIAL_DEMO_QUALITY_FRAME_SIGNALS: 'on',
      TUTORIAL_DEMO_QUALITY_BLOCK: 'yes',
    });
    expect(c).toEqual({
      enabled: true,
      frameSignals: true,
      blockPublication: true,
      model: 'gemini-2.5-pro',
      dailyLimitMicroUsd: 250_000,
      dailyVideoMs: 300_000,
      backfillCap: MAX_BACKFILL_CAP,
    });
    const junk = readDemoQualityConfig({
      TUTORIAL_DEMO_QUALITY_ENABLED: 'нет',
      TUTORIAL_DEMO_QUALITY_DAILY_USD: '-3',
      TUTORIAL_DEMO_QUALITY_DAILY_VIDEO_MINUTES: 'abc',
      TUTORIAL_DEMO_QUALITY_BACKFILL_CAP: '0',
    });
    expect(junk.enabled).toBe(false);
    expect(junk.dailyLimitMicroUsd).toBe(DEFAULT_DAILY_USD * 1_000_000);
    expect(junk.dailyVideoMs).toBe(DEFAULT_DAILY_VIDEO_MINUTES * 60_000);
    expect(junk.backfillCap).toBe(1);
    expect(
      readDemoQualityConfig({ TUTORIAL_DEMO_QUALITY_ENABLED: '1' }).enabled,
    ).toBe(true);
    expect(
      readDemoQualityConfig({ TUTORIAL_DEMO_QUALITY_ENABLED: 'ON' }).enabled,
    ).toBe(true);
    // Флаги захода 7 — независимы от включения проверки и друг от друга.
    const sig = readDemoQualityConfig({
      TUTORIAL_DEMO_QUALITY_FRAME_SIGNALS: '1',
    });
    expect([sig.frameSignals, sig.blockPublication, sig.enabled]).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      readDemoQualityConfig({ TUTORIAL_DEMO_QUALITY_BLOCK: 'нет' })
        .blockPublication,
    ).toBe(false);
  });
});

describe('бюджет', () => {
  const state = {
    limitMicroUsd: 1_000_000,
    spentMicroUsd: 0,
    limitVideoMs: 600_000,
    analyzedVideoMs: 0,
  };

  it('деньги: потрачено меньше потолка — можно; равно — нельзя', () => {
    expect(
      budgetAllows({ ...state, spentMicroUsd: 999_999 }, 10_000).allowed,
    ).toBe(true);
    const r = budgetAllows({ ...state, spentMicroUsd: 1_000_000 }, 10_000);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/\$1\.00/);
  });

  it('минуты: вместе с этим роликом не выше лимита', () => {
    expect(
      budgetAllows({ ...state, analyzedVideoMs: 590_000 }, 10_000).allowed,
    ).toBe(true);
    const r = budgetAllows({ ...state, analyzedVideoMs: 590_001 }, 10_000);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/10 мин/);
  });

  it('нулевой потолок — ничего не тратим', () => {
    expect(budgetAllows({ ...state, limitMicroUsd: 0 }, 1).allowed).toBe(false);
  });
});

describe('таймаут анализа из остатка тика', () => {
  it('мало времени — не начинать; иначе остаток минус запас, не больше потолка', () => {
    expect(analyzeTimeoutMs(MIN_ANALYZE_MS - 1)).toBeNull();
    expect(analyzeTimeoutMs(MIN_ANALYZE_MS)).toBe(
      MIN_ANALYZE_MS - ANALYZE_MARGIN_MS,
    );
    expect(analyzeTimeoutMs(40_000)).toBe(40_000 - ANALYZE_MARGIN_MS);
    expect(analyzeTimeoutMs(600_000)).toBe(MAX_ANALYZE_MS);
  });
});
