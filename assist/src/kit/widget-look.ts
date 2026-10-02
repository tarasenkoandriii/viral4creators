/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/widget-look.ts */
/**
 * Вид виджета — чистые типы и контраст WCAG (интеграция Э3, запрос
 * лендинга Л3). Один источник для TMA Помощника (`assist/src/lib/
 * widget-types.ts`, `widget-view.ts` импортируют отсюда вместо дублей) и
 * лендинга (`sites-landing`, переключится позже).
 *
 * Зеркало серверного `sites-backend/src/modules/assist-site-setup/
 * widget-config.ts` (владелец формы — сервер): перечни, лимиты, пресеты,
 * фоны тем и функции контраста обязаны совпадать — иначе подсказка «цвет
 * пройдёт AA» в кабинете разойдётся с поправкой сервера. Сверку держит
 * `assist/scripts/widget-look.test.ts` (импортом серверного модуля: он
 * чистый) — значения и результаты функций на тысячах цветов.
 *
 * Отличие одно и нарочное: `contrastRatio` на не-HEX вернёт 1 (экран не
 * падает на недописанном цвете), сервер — бросает.
 */

export const WIDGET_POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;
export type WidgetPosition = (typeof WIDGET_POSITIONS)[number];

export const WIDGET_MOBILE_MODES = ['fullscreen', 'sheet', 'bubble'] as const;
export type WidgetMobileMode = (typeof WIDGET_MOBILE_MODES)[number];

export const WIDGET_THEMES = ['light', 'dark', 'auto', 'site'] as const;
export type WidgetTheme = (typeof WIDGET_THEMES)[number];

/** «Как на сайте», системный или один из 6 шрифтов с нашего хостинга. */
export const WIDGET_FONTS = [
  'site',
  'system',
  'inter',
  'roboto',
  'montserrat',
  'manrope',
  'open-sans',
  'rubik',
] as const;
export type WidgetFont = (typeof WIDGET_FONTS)[number];

/** Скругления/тень/плотность: мягкий / строгий / компактный. */
export const WIDGET_PRESETS = ['soft', 'strict', 'compact'] as const;
export type WidgetPreset = (typeof WIDGET_PRESETS)[number];

export const WIDGET_LAUNCHER_ICONS = [
  'chat',
  'question',
  'headset',
  'logo',
] as const;
export type WidgetLauncherIcon = (typeof WIDGET_LAUNCHER_ICONS)[number];

/** Языки интерфейса виджета. */
export const WIDGET_UI_LANGS = ['uk', 'ru', 'en'] as const;
export type WidgetUiLang = (typeof WIDGET_UI_LANGS)[number];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Лимиты текстов (§3-бис.1). */
export const WIDGET_TEXT_LIMITS = {
  name: 30,
  greeting: 300,
  suggestion: 80,
  suggestions: 3,
  pathMask: 200,
  pathMasks: 20,
  offsetMax: 200,
} as const;

/** Пресеты основного цвета — проходят AA в обеих темах (сервер проверяет). */
export const WIDGET_COLOR_PRESETS = [
  '#2563EB',
  '#7C3AED',
  '#DB2777',
  '#DC2626',
  '#C2410C',
  '#047857',
  '#0F766E',
  '#1F2937',
] as const;

/** Фоны чата светлой/тёмной темы (как у сервера и чата виджета). */
export const WIDGET_SURFACES = { light: '#FFFFFF', dark: '#16181D' } as const;

/** WCAG 2.2 AA: текст ≥ 4.5:1, иконка кнопки и границы полей ≥ 3:1. */
export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_UI = 3;

export interface WidgetOffset {
  /** 0–200 px от выбранного угла. */
  x: number;
  y: number;
}

export interface WidgetHostRule {
  hostId: string;
  enabled: boolean;
  pathMasks: string[];
  hideOn: string[];
}

/** Бренд, тексты и раскладка — то, что видно (без хостов и вовлечения). */
export interface WidgetLook {
  schema: 1;
  brand: {
    primaryColor: string;
    /** 'auto' — чёрный/белый по контрасту, иначе HEX. */
    buttonTextColor: 'auto' | string;
    logoAssetId: string | null;
    avatar:
      | { kind: 'icon'; icon: WidgetLauncherIcon }
      | { kind: 'asset'; assetId: string };
    launcherIcon: WidgetLauncherIcon;
    name: string;
    font: WidgetFont;
    preset: WidgetPreset;
    theme: WidgetTheme;
    poweredBy: boolean;
  };
  texts: Partial<
    Record<WidgetUiLang, { greeting: string; suggestions: string[] }>
  >;
  layout: {
    position: WidgetPosition;
    offset: { desktop: WidgetOffset; mobile: WidgetOffset };
    zIndex: number;
    mobile: WidgetMobileMode;
    launcher: 'default' | 'none';
    openAt: 'corner' | 'center';
    avoidOverlap: boolean;
    hideOnScrollMobile: boolean;
  };
}

// ── Цвет: WCAG 2.x ───────────────────────────────────────────────────

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст WCAG 2.x двух HEX-цветов (1…21); не-HEX — 1. */
export function contrastRatio(a: string, b: string): number {
  if (!HEX_COLOR.test(a) || !HEX_COLOR.test(b)) return 1;
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Чёрный или белый — что контрастнее на этом фоне. */
export function autoTextColor(bg: string): '#000000' | '#FFFFFF' {
  return contrastRatio(bg, '#000000') >= contrastRatio(bg, '#FFFFFF')
    ? '#000000'
    : '#FFFFFF';
}

function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number): string {
  if (s === 0) return hexOf(l * 255, l * 255, l * 255);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return hexOf(ch(h + 1 / 3) * 255, ch(h) * 255, ch(h - 1 / 3) * 255);
}

/**
 * Ближайший по светлоте (HSL) оттенок того же тона, для которого `ok`
 * истинно; при равном удалении — более тёмный. null — ни один не подошёл.
 */
export function nearestPassingShade(
  hex: string,
  ok: (candidate: string) => boolean
): string | null {
  const start = hex.toUpperCase();
  if (ok(start)) return start;
  const [h, s, l] = toHsl(start);
  for (let step = 1; step <= 200; step++) {
    const d = step / 200;
    for (const cand of [l - d, l + d]) {
      if (cand < 0 || cand > 1) continue;
      const c = fromHsl(h, s, cand);
      if (ok(c)) return c;
    }
  }
  return null;
}

export interface WidgetThemeColors {
  surface: string;
  primary: string;
  onPrimary: string;
}

/**
 * Цвета чата для светлой и тёмной темы: светлая — сохранённый цвет;
 * тёмная — ближайший оттенок, проходящий ≥ 3:1 к тёмному фону и ≥ 4.5:1 к
 * тексту на кнопке (как сервер и чат виджета).
 */
export function widgetThemeColors(brand: {
  primaryColor: string;
  buttonTextColor: string;
}): { light: WidgetThemeColors; dark: WidgetThemeColors } {
  const primary = brand.primaryColor.toUpperCase();
  const lightText =
    brand.buttonTextColor === 'auto'
      ? autoTextColor(primary)
      : brand.buttonTextColor.toUpperCase();
  const darkOk = (c: string) =>
    contrastRatio(c, WIDGET_SURFACES.dark) >= WCAG_AA_UI &&
    contrastRatio(c, autoTextColor(c)) >= WCAG_AA_TEXT;
  const darkPrimary = nearestPassingShade(primary, darkOk) ?? '#FFFFFF';
  const explicit = brand.buttonTextColor !== 'auto' ? lightText : null;
  const darkText =
    explicit && contrastRatio(darkPrimary, explicit) >= WCAG_AA_TEXT
      ? explicit
      : autoTextColor(darkPrimary);
  return {
    light: { surface: WIDGET_SURFACES.light, primary, onPrimary: lightText },
    dark: {
      surface: WIDGET_SURFACES.dark,
      primary: darkPrimary,
      onPrimary: darkText,
    },
  };
}

/** Проходит ли пара (основной цвет, текст на нём) в светлой теме. */
export function lightThemePasses(primary: string, text: string): boolean {
  return (
    contrastRatio(primary, WIDGET_SURFACES.light) >= WCAG_AA_UI &&
    contrastRatio(primary, text === 'auto' ? autoTextColor(primary) : text) >=
      WCAG_AA_TEXT
  );
}
