/**
 * Настройки платформы Э6-бис (г): рубильник голосового управления и
 * канарейка выпусков виджета — разбор, корзина по siteId, кэш.
 */
import {
  parseVoiceControlPlatform,
  parseWidgetRelease,
  readVoiceControlPlatform,
  releaseBucket,
  releaseForSite,
  resetVoiceControlPlatformCache,
} from './voice-control-platform';

describe('настройки голосового управления платформы', () => {
  beforeEach(() => resetVoiceControlPlatformCache());

  it('рубильник: по умолчанию включено; false — выключено', () => {
    expect(parseVoiceControlPlatform(null).enabled).toBe(true);
    expect(
      parseVoiceControlPlatform({ enabled: false, reason: 'violation_sites' }),
    ).toEqual({
      enabled: false,
      reason: 'violation_sites',
      at: null,
    });
    expect(
      parseVoiceControlPlatform({ reason: 'BAD REASON!' }).reason,
    ).toBeNull();
  });

  it('выпуски: канарейка — только вместе со стабильным и не равная ему; доля 1…50', () => {
    expect(parseWidgetRelease({ canary: 'r2' }).canary).toBeNull();
    expect(
      parseWidgetRelease({ stable: 'r1', canary: 'r1' }).canary,
    ).toBeNull();
    expect(parseWidgetRelease({ stable: 'r1', canary: 'r2' }).canary).toBe(
      'r2',
    );
    expect(parseWidgetRelease({ stable: '../x' }).stable).toBeNull();
    expect(parseWidgetRelease({ canaryPercent: 80 }).canaryPercent).toBe(10);
    expect(parseWidgetRelease({ canaryPercent: 25 }).canaryPercent).toBe(25);
  });

  it('корзина по siteId: стабильна и даёт ≈ долю канарейки', () => {
    expect(releaseBucket('site-1')).toBe(releaseBucket('site-1'));
    const rel = parseWidgetRelease({
      stable: 'r1',
      canary: 'r2',
      canaryPercent: 10,
    });
    let canary = 0;
    for (let i = 0; i < 2000; i++)
      if (releaseForSite(`site-${i}`, rel) === 'r2') canary++;
    expect(canary / 2000).toBeGreaterThan(0.07);
    expect(canary / 2000).toBeLessThan(0.13);
    expect(releaseForSite('x', parseWidgetRelease(null))).toBeNull();
  });

  it('чтение: кэш 30 с, сбой базы — прежнее значение', async () => {
    let calls = 0;
    const db = {
      $queryRawUnsafe: async () => {
        calls++;
        return [{ value: { enabled: false } }];
      },
    };
    expect((await readVoiceControlPlatform(db as never, 1000)).enabled).toBe(
      false,
    );
    expect((await readVoiceControlPlatform(db as never, 20_000)).enabled).toBe(
      false,
    );
    expect(calls).toBe(1);
    const broken = {
      $queryRawUnsafe: async () => {
        throw new Error('db');
      },
    };
    expect(
      (await readVoiceControlPlatform(broken as never, 40_000)).enabled,
    ).toBe(false);
  });
});
