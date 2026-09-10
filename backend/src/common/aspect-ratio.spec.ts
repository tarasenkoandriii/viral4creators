import {
  aspectRatioFamily,
  aspectRatioFromSize,
  isVeoNative,
  normaliseAspectRatio,
  planRender,
  PLATFORM_EXPORT_PRESETS,
  presetByKey,
  veoFrameFor,
} from './aspect-ratio';

describe('aspectRatioFromSize', () => {
  it.each([
    [1080, 1920, '9:16'],
    [1920, 1080, '16:9'],
    [1080, 1440, '3:4'],
    [1440, 1080, '4:3'],
    [1080, 1080, '1:1'],
    [1080, 1350, '4:5'],
    [720, 1280, '9:16'],
    [1280, 720, '16:9'],
    // within 3% → snaps
    [1080, 1900, '9:16'],
    // phone recording 9:19.5 → custom, reduced by gcd
    [1080, 2340, '6:13'],
    [0, 100, '9:16'],
  ])('%d×%d → %s', (w, h, expected) => {
    expect(aspectRatioFromSize(w, h)).toBe(expected);
  });
});

describe('normaliseAspectRatio', () => {
  it('accepts W:H, WxH, W/H; snaps; rejects junk', () => {
    expect(normaliseAspectRatio('9:16')).toBe('9:16');
    expect(normaliseAspectRatio(' 1080x1920 ')).toBe('9:16');
    expect(normaliseAspectRatio('4/3')).toBe('4:3');
    expect(normaliseAspectRatio('21:9')).toBe('21:9');
    expect(normaliseAspectRatio('2560x1080')).toBe('64:27');
    expect(normaliseAspectRatio('vertical')).toBeNull();
    expect(normaliseAspectRatio('0:5')).toBeNull();
    expect(normaliseAspectRatio(null)).toBeNull();
  });
});

describe('veoFrameFor / planRender', () => {
  it('native ratios pass through without reframe', () => {
    expect(planRender('9:16')).toEqual({
      target: '9:16',
      rendered: '9:16',
      reframe: false,
      compositionNote: null,
    });
    expect(planRender('16:9').reframe).toBe(false);
    expect(isVeoNative('3:4')).toBe(false);
  });
  it('portrait/square → 9:16, landscape → 16:9, with a composition note', () => {
    expect(veoFrameFor('3:4')).toBe('9:16');
    expect(veoFrameFor('1:1')).toBe('9:16');
    expect(veoFrameFor('4:5')).toBe('9:16');
    expect(veoFrameFor('4:3')).toBe('16:9');
    expect(veoFrameFor('7:3')).toBe('16:9');
    const p = planRender('3:4');
    expect(p).toMatchObject({ target: '3:4', rendered: '9:16', reframe: true });
    expect(p.compositionNote).toContain('center-cropped from 9:16 to 3:4');
  });
});

describe('aspectRatioFamily (этап 75, автоэкспорт)', () => {
  it('портрет/квадрат — одно семейство 9:16', () => {
    for (const t of ['9:16', '3:4', '1:1', '4:5']) {
      expect(aspectRatioFamily(t)).toBe('9:16');
    }
  });
  it('ландшафт — семейство 16:9', () => {
    for (const t of ['16:9', '4:3']) {
      expect(aspectRatioFamily(t)).toBe('16:9');
    }
  });
  it('семейство — то же самое, что и veoFrameFor (обёртка, не новый расчёт)', () => {
    for (const t of ['9:16', '16:9', '3:4', '4:3', '1:1', '4:5', '7:3']) {
      expect(aspectRatioFamily(t)).toBe(veoFrameFor(t));
    }
  });
});

describe('PLATFORM_EXPORT_PRESETS / presetByKey (этап 75)', () => {
  it('каждый пресет резолвится по своему ключу', () => {
    for (const preset of PLATFORM_EXPORT_PRESETS) {
      expect(presetByKey(preset.key)).toEqual(preset);
    }
  });
  it('неизвестный ключ — null, не бросает', () => {
    expect(presetByKey('unknown-platform')).toBeNull();
  });
  it('tiktok и youtube-shorts — один физический формат, разные ярлыки', () => {
    // PublicationPlatform пока не различает обычный YouTube-ролик и
    // Shorts (открытый вопрос §7.5) — оба валидных пресета сознательно
    // делят один и тот же `format`.
    const tiktok = presetByKey('tiktok')!;
    const shorts = presetByKey('youtube-shorts')!;
    expect(tiktok.format).toBe(shorts.format);
    expect(tiktok.key).not.toBe(shorts.key);
  });
});
