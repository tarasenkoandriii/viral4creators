/**
 * Конфигурация вида (W4): строгий разбор, брендинг как вектор XSS (приёмка
 * Э2 п.5а — цвет-инъекция, имя-XSS), контраст WCAG 2.2 AA для обеих тем и
 * пресетов (приёмка п.3), partial без hosts.
 */
import {
  HEX_COLOR,
  WCAG_AA_TEXT,
  WCAG_AA_UI,
  WIDGET_COLOR_PRESETS,
  WIDGET_SURFACES,
  autoTextColor,
  contrastRatio,
  defaultWidgetConfig,
  nearestPassingShade,
  parseWidgetConfig,
  parseWidgetConfigPatch,
  widgetThemeColors,
  type WidgetConfig,
} from './widget-config';

function ok(input: unknown) {
  const r = parseWidgetConfig(input);
  if (!r.ok) throw new Error(`ожидался успех: ${JSON.stringify(r.errors)}`);
  return r;
}

function fails(input: unknown) {
  const r = parseWidgetConfig(input);
  if (r.ok) throw new Error('ожидался отказ');
  return r.errors;
}

function withBrand(patch: Record<string, unknown>): Record<string, unknown> {
  const d = defaultWidgetConfig('Магазин') as unknown as Record<
    string,
    unknown
  >;
  return { ...d, brand: { ...(d.brand as object), ...patch } };
}

/** Детерминированный ГПСЧ — свойство проверяется на одних и тех же цветах. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function assertThemesPass(brand: WidgetConfig['brand']) {
  const t = widgetThemeColors(brand);
  expect(
    contrastRatio(t.light.primary, WIDGET_SURFACES.light),
  ).toBeGreaterThanOrEqual(WCAG_AA_UI);
  expect(
    contrastRatio(t.light.primary, t.light.onPrimary),
  ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
  expect(
    contrastRatio(t.dark.primary, WIDGET_SURFACES.dark),
  ).toBeGreaterThanOrEqual(WCAG_AA_UI);
  expect(
    contrastRatio(t.dark.primary, t.dark.onPrimary),
  ).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
}

describe('contrastRatio (WCAG 2.x)', () => {
  it('известные значения', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Классический пограничный серый: 4.48 — НЕ проходит AA для текста.
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#2563EB', '#FFFFFF')).toBeCloseTo(5.17, 2);
  });

  it('симметрична и не принимает не-HEX', () => {
    expect(contrastRatio('#123456', '#ABCDEF')).toBeCloseTo(
      contrastRatio('#ABCDEF', '#123456'),
      10,
    );
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow();
  });

  it('авто-цвет текста всегда даёт ≥ 4.5:1', () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const hex = `#${Math.floor(r() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`.toUpperCase();
      expect(contrastRatio(hex, autoTextColor(hex))).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });
});

describe('defaultWidgetConfig', () => {
  it('проходит собственную проверку без поправок; имя — «Помощник <сайт>»', () => {
    const d = defaultWidgetConfig('Магазин чайников');
    const r = ok(d);
    expect(r.adjustments).toEqual([]);
    expect(r.config).toEqual(d);
    expect(d.brand.name).toBe('Помощник Магазин чайников');
    expect(d.brand.poweredBy).toBe(true);
    expect(d.layout.zIndex).toBe(2147483000);
  });

  it('длинное имя сайта режется до 30 символов', () => {
    expect(
      Array.from(defaultWidgetConfig('x'.repeat(100)).brand.name).length,
    ).toBe(30);
  });
});

describe('приёмка 5а: брендинг не становится разметкой/CSS', () => {
  it('цвет `red;background:url(//x)` — отказ (не умолчание)', () => {
    for (const bad of [
      'red;background:url(//x)',
      '#fff;background:url(//x)',
      '#ffffff;x',
      'red',
      '#fff',
      'rgb(0,0,0)',
      '#GGGGGG',
      ' #2563EB',
      '#2563EB ',
      12,
      null,
    ]) {
      expect(fails(withBrand({ primaryColor: bad }))).toContainEqual({
        path: 'brand.primaryColor',
        code: 'color',
      });
    }
    expect(
      fails(withBrand({ buttonTextColor: 'red;background:url(//x)' })),
    ).toContainEqual({ path: 'brand.buttonTextColor', code: 'color' });
  });

  it('имя `<img src=x onerror=…>` хранится как ТЕКСТ, без изменений', () => {
    const name = '<img src=x onerror=alert(1)>';
    const r = ok(withBrand({ name }));
    expect(r.config.brand.name).toBe(name);
    // Тексты — тоже данные: никакой «очистки», которая изменила бы смысл.
    const t = ok({
      ...withBrand({}),
      texts: { uk: { greeting: '<script>x</script>', suggestions: ['"><b>'] } },
    });
    expect(t.config.texts.uk).toEqual({
      greeting: '<script>x</script>',
      suggestions: ['"><b>'],
    });
  });

  it('управляющие и bidi-символы в имени — отказ', () => {
    for (const bad of ['Имя‮переворот', 'a\u0000b', 'две\nстроки', 'z​w']) {
      expect(fails(withBrand({ name: bad }))).toContainEqual({
        path: 'brand.name',
        code: 'control_chars',
      });
    }
  });

  it('картинки — только id наших ассетов, не URL', () => {
    expect(
      fails(withBrand({ logoAssetId: 'https://evil.example/x.svg' })),
    ).toContainEqual({ path: 'brand.logoAssetId', code: 'asset' });
    expect(
      fails(withBrand({ avatar: { kind: 'asset', assetId: 'javascript:x' } })),
    ).toContainEqual({ path: 'brand.avatar.assetId', code: 'asset' });
  });

  it('пользовательского CSS нет: неизвестные ключи отбрасываются', () => {
    const r = ok({
      ...withBrand({ css: 'body{display:none}', style: 'x' }),
      customCss: '*{}',
    });
    expect(Object.keys(r.config.brand)).not.toContain('css');
    expect(Object.keys(r.config.brand)).not.toContain('style');
    expect(Object.keys(r.config)).not.toContain('customCss');
  });

  it('enum вне перечня — умолчание с поправкой', () => {
    const r = ok(
      withBrand({ font: 'Comic Sans; x', preset: 'evil', theme: 'url(x)' }),
    );
    expect(r.config.brand.font).toBe('system');
    expect(r.config.brand.preset).toBe('soft');
    expect(r.config.brand.theme).toBe('auto');
    expect(r.adjustments.map((a) => a.path)).toEqual(
      expect.arrayContaining(['brand.font', 'brand.preset', 'brand.theme']),
    );
  });
});

describe('контраст WCAG 2.2 AA (приёмка п.3)', () => {
  it('пресеты цвета проходят в обеих темах БЕЗ поправок', () => {
    for (const color of WIDGET_COLOR_PRESETS) {
      const r = ok(withBrand({ primaryColor: color }));
      expect(r.adjustments).toEqual([]);
      expect(r.config.brand.primaryColor).toBe(color);
      assertThemesPass(r.config.brand);
      // Тёмная тема пресета — тоже без смены оттенка там, где он и так читается.
      expect(
        HEX_COLOR.test(widgetThemeColors(r.config.brand).dark.primary),
      ).toBe(true);
    }
  });

  it('жёлтый на белом — затемняется до ≥ 3:1 с поправкой contrast_darkened', () => {
    const r = ok(withBrand({ primaryColor: '#FFFF00' }));
    expect(r.config.brand.primaryColor).not.toBe('#FFFF00');
    expect(r.adjustments).toContainEqual(
      expect.objectContaining({
        path: 'brand.primaryColor',
        reason: 'contrast_darkened',
        from: '#FFFF00',
      }),
    );
    assertThemesPass(r.config.brand);
  });

  it('заданный белый текст на светлом цвете — цвет затемняется до 4.5:1', () => {
    const r = ok(
      withBrand({ primaryColor: '#60A5FA', buttonTextColor: '#FFFFFF' }),
    );
    expect(
      contrastRatio(r.config.brand.primaryColor, '#FFFFFF'),
    ).toBeGreaterThanOrEqual(4.5);
    expect(r.config.brand.buttonTextColor).toBe('#FFFFFF');
    assertThemesPass(r.config.brand);
  });

  it('заданный тёмный текст — подбирается оттенок, где читаются и текст, и граница', () => {
    const r = ok(
      withBrand({ primaryColor: '#111111', buttonTextColor: '#000000' }),
    );
    const p = r.config.brand.primaryColor;
    expect(contrastRatio(p, '#000000')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(p, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(r.adjustments[0].reason).toBe('contrast_lightened');
  });

  it('свойство: любой цвет после разбора проходит AA в светлой и тёмной теме', () => {
    const r = rng(42);
    for (let i = 0; i < 400; i++) {
      const hex = () =>
        `#${Math.floor(r() * 0xffffff)
          .toString(16)
          .padStart(6, '0')}`;
      const text = r() < 0.5 ? 'auto' : hex();
      const res = ok(withBrand({ primaryColor: hex(), buttonTextColor: text }));
      assertThemesPass(res.config.brand);
    }
  });

  it('ближайший оттенок — минимальный сдвиг светлоты', () => {
    const shade = nearestPassingShade(
      '#FFFF00',
      (c) => contrastRatio(c, '#FFFFFF') >= 3,
    );
    expect(shade).not.toBeNull();
    expect(contrastRatio(shade!, '#FFFFFF')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(shade!, '#FFFFFF')).toBeLessThan(3.3);
  });
});

describe('«Работает на …» и прочие поля', () => {
  it('poweredBy=false до Э4 — принудительно true с поправкой', () => {
    const r = ok(withBrand({ poweredBy: false }));
    expect(r.config.brand.poweredBy).toBe(true);
    expect(r.adjustments).toContainEqual(
      expect.objectContaining({ reason: 'powered_by_locked' }),
    );
  });

  it('иконка «логотип» без логотипа — «чат»', () => {
    const r = ok(withBrand({ launcherIcon: 'logo', logoAssetId: null }));
    expect(r.config.brand.launcherIcon).toBe('chat');
  });

  it('длинные тексты режутся с поправкой; лишние подсказки — тоже', () => {
    const r = ok({
      ...withBrand({ name: 'Я'.repeat(40) }),
      texts: {
        uk: {
          greeting: 'п'.repeat(400),
          suggestions: ['a', 'b', 'c', 'd', 'e'.repeat(100)],
        },
        de: { greeting: 'Hallo', suggestions: [] },
      },
    });
    expect(Array.from(r.config.brand.name).length).toBe(30);
    expect(r.config.texts.uk!.greeting.length).toBe(300);
    expect(r.config.texts.uk!.suggestions).toEqual(['a', 'b', 'c']);
    expect(Object.keys(r.config.texts)).toEqual(['uk']);
    expect(
      r.adjustments.filter((a) => a.reason === 'text_truncated').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('отступы — 0–200, z-index — целое в диапазоне', () => {
    const d = defaultWidgetConfig('x');
    const r = ok({
      ...d,
      layout: {
        ...d.layout,
        offset: { desktop: { x: -5, y: 999 }, mobile: { x: 10.4, y: 'x' } },
        zIndex: 1e12,
      },
    });
    expect(r.config.layout.offset.desktop).toEqual({ x: 0, y: 200 });
    expect(r.config.layout.offset.mobile).toEqual({ x: 10, y: 16 });
    expect(r.config.layout.zIndex).toBe(2147483647);
  });

  it('маски путей: только путь; мусор — отказ; дубли хоста — отказ', () => {
    const d = defaultWidgetConfig('x');
    const good = ok({
      ...d,
      hosts: [
        {
          hostId: 'h1',
          enabled: true,
          pathMasks: ['/catalog/*'],
          hideOn: ['/checkout*'],
        },
      ],
    });
    expect(good.config.hosts[0].hideOn).toEqual(['/checkout*']);
    expect(
      fails({
        ...d,
        hosts: [
          {
            hostId: 'h1',
            enabled: true,
            pathMasks: ['javascript:x'],
            hideOn: [],
          },
        ],
      }),
    ).toContainEqual({ path: 'hosts[0].pathMasks[0]', code: 'path_mask' });
    expect(
      fails({
        ...d,
        hosts: [
          { hostId: 'h1', enabled: true },
          { hostId: 'h1', enabled: false },
        ],
      }),
    ).toContainEqual({ path: 'hosts[1].hostId', code: 'duplicate' });
  });

  it('не объект / чужая схема — отказ', () => {
    expect(fails(null)).toEqual([{ path: '', code: 'type' }]);
    expect(fails([])).toEqual([{ path: '', code: 'type' }]);
    expect(fails({ ...defaultWidgetConfig('x'), schema: 2 })).toContainEqual({
      path: 'schema',
      code: 'schema',
    });
  });
});

describe('parseWidgetConfigPatch («к Л2» preview, PATCH)', () => {
  const base = defaultWidgetConfig('Магазин');

  it('hosts в partial — отказ всегда', () => {
    const r = parseWidgetConfigPatch(base, { hosts: [] });
    expect(r).toEqual({
      ok: false,
      errors: [{ path: 'hosts', code: 'not_allowed' }],
    });
  });

  it('частичная правка сливается и проходит те же правила', () => {
    const r = parseWidgetConfigPatch(base, {
      brand: { primaryColor: '#FFFF00' },
      layout: { position: 'top-left', offset: { mobile: { x: 50 } } },
    });
    if (!r.ok) throw new Error('ожидался успех');
    expect(r.config.layout.position).toBe('top-left');
    expect(r.config.layout.offset.mobile).toEqual({ x: 50, y: 16 });
    expect(r.config.layout.offset.desktop).toEqual(base.layout.offset.desktop);
    expect(r.config.brand.name).toBe(base.brand.name);
    expect(r.config.brand.primaryColor).not.toBe('#FFFF00');
    const bad = parseWidgetConfigPatch(base, {
      brand: { primaryColor: 'red;background:url(//x)' },
    });
    expect(bad.ok).toBe(false);
  });

  it('прототипные ключи не загрязняют объект', () => {
    const patch = JSON.parse(
      '{"brand":{"__proto__":{"polluted":1}},"layout":{"__proto__":{"polluted":1}}}',
    );
    const r = parseWidgetConfigPatch(base, patch);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
