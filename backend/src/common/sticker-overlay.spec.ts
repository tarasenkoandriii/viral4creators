import {
  DEFAULT_STICKER_PLACEMENT,
  STICKER_PLACEMENTS,
  frameWidth,
  isStickerPlacement,
  normalizeStickerPlacement,
  stickerOverlay,
} from './sticker-overlay';

describe('frameWidth', () => {
  it('метка разрешения — это КОРОТКАЯ сторона', () => {
    // Так её понимают и Veo, и Grok: «720p» у вертикального ролика
    // означает ширину 720, а не высоту.
    expect(frameWidth('720p', '9:16')).toBe(720);
    expect(frameWidth('1080p', '9:16')).toBe(1080);
    expect(frameWidth('480p', '9:16')).toBe(480);
  });

  it('у горизонтального кадра короткая сторона — высота', () => {
    expect(frameWidth('720p', '16:9')).toBe(1280);
    expect(frameWidth('1080p', '16:9')).toBe(1920);
  });

  it('квадрат — обе стороны равны', () => {
    expect(frameWidth('1080p', '1:1')).toBe(1080);
  });

  it('неизвестные значения не роняют расчёт', () => {
    for (const [res, ratio] of [
      [null, null],
      ['мусор', '9:16'],
      ['720p', 'мусор'],
      ['720p', '0:0'],
    ] as const) {
      expect(frameWidth(res, ratio)).toBeGreaterThan(0);
    }
  });
});

describe('stickerOverlay', () => {
  const W = 1080;

  it('углы считаются выражениями ffmpeg, а не числами', () => {
    // `W`/`H` — кадр, `w`/`h` — наклейка: пусть сопоставляет overlay.
    // Тогда положение остаётся верным, даже если наш расчёт ширины
    // промахнулся.
    expect(stickerOverlay('bottom-right', W).x).toContain('W-w-');
    expect(stickerOverlay('bottom-right', W).y).toContain('H-h-');
    expect(stickerOverlay('top-left', W).x).not.toContain('W');
    expect(stickerOverlay('top-right', W).y).not.toContain('H');
  });

  it('центр — по центру обеих осей', () => {
    const c = stickerOverlay('center', W);
    expect(c.x).toBe('(W-w)/2');
    expect(c.y).toBe('(H-h)/2');
  });

  it('во весь кадр наклейка шире угловой', () => {
    const full = Number(stickerOverlay('full', W).scale.match(/=(\d+):/)![1]);
    const corner = Number(
      stickerOverlay('bottom-right', W).scale.match(/=(\d+):/)![1],
    );
    expect(full).toBe(W);
    expect(corner).toBeLessThan(full);
  });

  it('вторая сторона округляется до чётного', () => {
    // Нечётная сторона — классический отказ кодировщика на ровном месте.
    for (const placement of STICKER_PLACEMENTS) {
      expect(stickerOverlay(placement, W).scale.endsWith(':-2')).toBe(true);
    }
  });

  it('угловая наклейка масштабируется вместе с кадром', () => {
    // Фиксированные 300 px были бы третью кадра в 720p и седьмой в
    // 4K — «одна и та же наклейка» выглядела бы по-разному.
    const width = (frameW: number) =>
      Number(stickerOverlay('bottom-right', frameW).scale.match(/=(\d+):/)![1]);
    expect(width(480)).toBeLessThan(width(1080));
    expect(width(1080) / width(480)).toBeCloseTo(1080 / 480, 1);
  });

  it('отступ масштабируется вместе с кадром, а не фиксирован в пикселях', () => {
    const small = stickerOverlay('top-left', 480);
    const big = stickerOverlay('top-left', 1080);
    expect(Number(small.x)).toBeLessThan(Number(big.x));
  });

  it('каждое положение даёт годные выражения', () => {
    for (const placement of STICKER_PLACEMENTS) {
      const o = stickerOverlay(placement, W);
      expect(o.scale).toMatch(/^scale=\d+:-2$/);
      expect(o.x.length).toBeGreaterThan(0);
      expect(o.y.length).toBeGreaterThan(0);
    }
  });
});

describe('normalizeStickerPlacement', () => {
  it('чужое значение читается как значение по умолчанию', () => {
    for (const bad of [null, undefined, '', 'куда-нибудь', 42]) {
      expect(normalizeStickerPlacement(bad)).toBe(DEFAULT_STICKER_PLACEMENT);
    }
  });

  it('своё значение сохраняется как есть', () => {
    for (const placement of STICKER_PLACEMENTS) {
      expect(normalizeStickerPlacement(placement)).toBe(placement);
      expect(isStickerPlacement(placement)).toBe(true);
    }
  });
});
