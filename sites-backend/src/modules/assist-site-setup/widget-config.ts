/**
 * Конфигурация вида виджета (ТЗ §3-бис.1, §3-бис.3) — ОДНА структура на
 * черновик, публикацию, анонимный черновик лендинга (`wd_`, «к Л3») и
 * `V4CAssist('preview', partial)` («к Л2»). Владелец — W4 (контракт Э2).
 *
 * Модуль ЧИСТЫЙ (без Nest/Prisma/env): его читают W2 (публичный конфиг,
 * черновики лендинга, предпросмотр) и W4 (кабинет); зеркало проверок —
 * в загрузчике (`widget/src/loader/config.ts`, W1: «повторно в загрузчике»).
 *
 * Брендинг — вектор XSS на сайте заказчика (аудит 01.10): ПОЛЬЗОВАТЕЛЬСКОГО
 * CSS НЕТ; цвета — строго `^#[0-9a-fA-F]{6}$`; шрифт/пресет/тема/угол/режим —
 * только из перечня (иначе умолчание); тексты — только как данные
 * (`textContent`), с лимитами длины; картинки — только id наших растровых
 * ассетов (assist_site_assets), никаких внешних URL.
 */

import {
  parseEngagementConfig,
  type EngagementConfig,
} from './engagement-config';

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

/** «Как на сайте», системный или один из 6 шрифтов с НАШЕГО хостинга (§3-бис.1, лендинг-ТЗ §17.3 п.6). */
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

/** Языки интерфейса виджета (тексты кнопок/подписей). Э2 — uk/ru/en. */
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

export interface WidgetOffset {
  /** 0–200 px от выбранного угла. */
  x: number;
  y: number;
}

export interface WidgetHostRule {
  /** site_hosts.id — только verified-хосты ЭТОГО сайта (проверка при публикации и в гварде). */
  hostId: string;
  /** «Виджет включён на этом хосте» (§3.6 п.3). */
  enabled: boolean;
  /** Маски путей, где показывать (`/catalog/*`); пусто — везде. */
  pathMasks: string[];
  /** Маски, где НЕ показывать (`/checkout*` предлагается магазинам). */
  hideOn: string[];
}

export interface WidgetConfig {
  schema: 1;
  brand: {
    primaryColor: string;
    /** 'auto' — чёрный/белый по контрасту, иначе HEX (тот же контроль WCAG). */
    buttonTextColor: 'auto' | string;
    /** id ассета (assist_site_assets, kind=logo) или null. */
    logoAssetId: string | null;
    /** Аватар: иконка из набора или ассет. Метка «ИИ» рядом — всегда (К-6). */
    avatar:
      | { kind: 'icon'; icon: WidgetLauncherIcon }
      | { kind: 'asset'; assetId: string };
    launcherIcon: WidgetLauncherIcon;
    name: string;
    font: WidgetFont;
    preset: WidgetPreset;
    theme: WidgetTheme;
    /** «Работает на …» — до Э4 не убирается (Start). */
    poweredBy: boolean;
  };
  /** Приветствие и до 3 подсказок на каждом языке интерфейса. */
  texts: Partial<
    Record<WidgetUiLang, { greeting: string; suggestions: string[] }>
  >;
  layout: {
    position: WidgetPosition;
    offset: { desktop: WidgetOffset; mobile: WidgetOffset };
    zIndex: number;
    mobile: WidgetMobileMode;
    /** none — своя кнопка заказчика (`V4CAssist('open')`, якорь). */
    launcher: 'default' | 'none';
    /** Где открывать чат при своей кнопке. */
    openAt: 'corner' | 'center';
    /** Эвристика «не перекрывать чужое» (§3-бис.3). */
    avoidOverlap: boolean;
    hideOnScrollMobile: boolean;
  };
  hosts: WidgetHostRule[];
  /**
   * Э3 (§3.6 п.4–5, §5-тер.12): проактивные триггеры, лимиты навязчивости,
   * сценарии. Необязательное: версии Э2 без поля читаются как
   * `defaultEngagementConfig()`. Разбор — engagement-config.ts (T).
   */
  engagement?: EngagementConfig;
}

/** Что сервер поправил при сохранении (контраст и т.п.) — показать владельцу. */
export interface WidgetConfigAdjustment {
  path: string;
  /**
   * contrast_darkened | contrast_lightened | enum_default | text_truncated |
   * clamped | powered_by_locked | host_not_verified
   */
  reason: string;
  from: unknown;
  to: unknown;
}

export type WidgetConfigParse =
  | { ok: true; config: WidgetConfig; adjustments: WidgetConfigAdjustment[] }
  | { ok: false; errors: WidgetConfigError[] };

export interface WidgetConfigError {
  path: string;
  /**
   * type | required | schema | color | control_chars | asset | path_mask |
   * duplicate | too_many | not_allowed (hosts в partial)
   */
  code: string;
}

// ── Цвет: WCAG 2.x ───────────────────────────────────────────────────

/**
 * Фон чата в светлой и тёмной теме — к ним меряется контраст основного
 * цвета (кнопка, пузырь посетителя, ссылки и границы — «иконка/граница»,
 * ≥ 3:1). Чат W1 рисует ЭТИ ЖЕ фоны: менять — вместе.
 */
export const WIDGET_SURFACES = { light: '#FFFFFF', dark: '#16181D' } as const;

/** WCAG 2.2 AA: текст ≥ 4.5:1, иконка кнопки и границы полей ≥ 3:1. */
export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_UI = 3;

/**
 * Пресеты основного цвета для конфигуратора (приёмка Э2 п.3: «контраст
 * пресетов — AA»): каждый проходит без поправок в обеих темах с
 * автоматическим цветом текста (проверяет widget-config.spec.ts).
 */
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

/** Контраст WCAG 2.x двух HEX-цветов (1…21). */
export function contrastRatio(a: string, b: string): number {
  if (!HEX_COLOR.test(a) || !HEX_COLOR.test(b)) {
    throw new Error('contrastRatio: ожидается #RRGGBB');
  }
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Чёрный или белый — что контрастнее на этом фоне (≥ 4.58:1 всегда). */
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
 * истинно; при равном удалении — более тёмный («мы чуть затемнили
 * цвет»). null — ни один оттенок не подошёл.
 */
export function nearestPassingShade(
  hex: string,
  ok: (candidate: string) => boolean,
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
 * Цвета чата для светлой и тёмной темы (§3-бис.1: «цвета тёмной темы
 * выводятся автоматически, контраст проверяется отдельно для обеих»).
 * Светлая — сохранённый (уже проверенный) цвет; тёмная — ближайший оттенок,
 * проходящий ≥ 3:1 к тёмному фону и ≥ 4.5:1 к тексту на кнопке. Зеркало
 * для чата W1 (`widget/src/chat`) — та же функция.
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

// ── Умолчание ────────────────────────────────────────────────────────

const DEFAULT_GREETING: Record<WidgetUiLang, string> = {
  uk: 'Вітаю! Я ІІ-помічник сайту. Чим можу допомогти?',
  ru: 'Здравствуйте! Я ИИ-помощник сайта. Чем могу помочь?',
  en: 'Hi! I am the AI assistant of this site. How can I help?',
};

/** z-index по умолчанию: ниже 2147483647 — баннеры сайта остаются сверху (§3-бис.3). */
export const WIDGET_DEFAULT_Z_INDEX = 2147483000;

/** Умолчание нового сайта (§3-бис.1: имя «Помощник <сайт>»). */
export function defaultWidgetConfig(siteName: string): WidgetConfig {
  const site = cleanText(String(siteName ?? '')).trim();
  const name = `Помощник ${site}`.trim().slice(0, WIDGET_TEXT_LIMITS.name);
  return {
    schema: 1,
    brand: {
      primaryColor: WIDGET_COLOR_PRESETS[0],
      buttonTextColor: 'auto',
      logoAssetId: null,
      avatar: { kind: 'icon', icon: 'chat' },
      launcherIcon: 'chat',
      name: name.trim() || 'Помощник',
      font: 'system',
      preset: 'soft',
      theme: 'auto',
      poweredBy: true,
    },
    texts: {
      uk: { greeting: DEFAULT_GREETING.uk, suggestions: [] },
      ru: { greeting: DEFAULT_GREETING.ru, suggestions: [] },
      en: { greeting: DEFAULT_GREETING.en, suggestions: [] },
    },
    layout: {
      position: 'bottom-right',
      offset: { desktop: { x: 20, y: 20 }, mobile: { x: 16, y: 16 } },
      zIndex: WIDGET_DEFAULT_Z_INDEX,
      mobile: 'fullscreen',
      launcher: 'default',
      openAt: 'corner',
      avoidOverlap: true,
      hideOnScrollMobile: false,
    },
    hosts: [],
  };
}

// ── Разбор ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Управляющие символы и невидимые «переворачиватели» текста (bidi):
 * имя `‮…` перевернуло бы подпись на чужом сайте. Перевод строки
 * допускается только в приветствии.
 */
const CONTROL =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/;
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

function cleanText(s: string): string {
  return s.replace(CONTROL_ALL, '');
}

/** id ассета/хоста — cuid и подобные; иное — не наш идентификатор. */
export const WIDGET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Маска пути: `/catalog/*`, `/checkout*`. Только печатные символы пути,
 * `*` — подстановка; без схемы/хоста/пробелов/кавычек.
 */
export const PATH_MASK = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

class Ctx {
  readonly errors: WidgetConfigError[] = [];
  readonly adjustments: WidgetConfigAdjustment[] = [];
  err(path: string, code: string) {
    this.errors.push({ path, code });
  }
  adj(path: string, reason: string, from: unknown, to: unknown) {
    this.adjustments.push({ path, reason, from, to });
  }
}

function pickEnum<T extends string>(
  c: Ctx,
  path: string,
  list: readonly T[],
  v: unknown,
  fallback: T,
): T {
  if ((list as readonly unknown[]).includes(v)) return v as T;
  c.adj(path, 'enum_default', v ?? null, fallback);
  return fallback;
}

function pickBool(c: Ctx, path: string, v: unknown, fallback: boolean) {
  if (typeof v === 'boolean') return v;
  c.adj(path, 'enum_default', v ?? null, fallback);
  return fallback;
}

function pickInt(
  c: Ctx,
  path: string,
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    c.adj(path, 'enum_default', v ?? null, fallback);
    return fallback;
  }
  const n = Math.round(v);
  const out = Math.max(min, Math.min(max, n));
  if (out !== v) c.adj(path, 'clamped', v, out);
  return out;
}

function pickText(
  c: Ctx,
  path: string,
  v: unknown,
  max: number,
  opts: { required?: boolean; multiline?: boolean } = {},
): string | null {
  if (typeof v !== 'string') {
    c.err(path, v === undefined || v === null ? 'required' : 'type');
    return null;
  }
  let s = v;
  if (opts.multiline) s = s.replace(/\r\n?/g, '\n');
  const bad = opts.multiline
    ? CONTROL.test(s)
    : CONTROL.test(s) || /[\n\r\t]/.test(s);
  if (bad) {
    c.err(path, 'control_chars');
    return null;
  }
  s = s.trim();
  if (opts.required && !s) {
    c.err(path, 'required');
    return null;
  }
  // Длина — в кодовых точках: эмодзи не режется пополам.
  const chars = Array.from(s);
  if (chars.length > max) {
    const cut = chars.slice(0, max).join('').trimEnd();
    c.adj(path, 'text_truncated', s, cut);
    return cut;
  }
  return s;
}

function pickColor(c: Ctx, path: string, v: unknown): string | null {
  if (typeof v === 'string' && HEX_COLOR.test(v)) return v.toUpperCase();
  // Не умолчание: `red;background:url(//x)` — попытка инъекции или
  // опечатка, владелец должен увидеть отказ (аудит 01.10).
  c.err(path, 'color');
  return null;
}

function pickAssetId(c: Ctx, path: string, v: unknown): string | null {
  if (typeof v === 'string' && WIDGET_ID.test(v)) return v;
  c.err(path, 'asset');
  return null;
}

function parseBrand(c: Ctx, raw: unknown): WidgetConfig['brand'] | null {
  if (!isObj(raw)) {
    c.err('brand', raw === undefined ? 'required' : 'type');
    return null;
  }
  const primary = pickColor(c, 'brand.primaryColor', raw.primaryColor);
  let buttonText: string | null = 'auto';
  if (raw.buttonTextColor !== 'auto' && raw.buttonTextColor !== undefined) {
    buttonText = pickColor(c, 'brand.buttonTextColor', raw.buttonTextColor);
  }
  let logo: string | null = null;
  if (raw.logoAssetId !== null && raw.logoAssetId !== undefined) {
    logo = pickAssetId(c, 'brand.logoAssetId', raw.logoAssetId);
  }
  let avatar: WidgetConfig['brand']['avatar'] = { kind: 'icon', icon: 'chat' };
  const a = raw.avatar;
  if (isObj(a) && a.kind === 'asset') {
    const id = pickAssetId(c, 'brand.avatar.assetId', a.assetId);
    if (id) avatar = { kind: 'asset', assetId: id };
  } else if (isObj(a) && a.kind === 'icon') {
    avatar = {
      kind: 'icon',
      icon: pickEnum(
        c,
        'brand.avatar.icon',
        WIDGET_LAUNCHER_ICONS,
        a.icon,
        'chat',
      ),
    };
  } else {
    c.adj('brand.avatar', 'enum_default', a ?? null, avatar);
  }
  let launcherIcon = pickEnum(
    c,
    'brand.launcherIcon',
    WIDGET_LAUNCHER_ICONS,
    raw.launcherIcon,
    'chat',
  );
  if (launcherIcon === 'logo' && !logo) {
    c.adj('brand.launcherIcon', 'enum_default', 'logo', 'chat');
    launcherIcon = 'chat';
  }
  const name = pickText(c, 'brand.name', raw.name, WIDGET_TEXT_LIMITS.name, {
    required: true,
  });
  const font = pickEnum(c, 'brand.font', WIDGET_FONTS, raw.font, 'system');
  const preset = pickEnum(
    c,
    'brand.preset',
    WIDGET_PRESETS,
    raw.preset,
    'soft',
  );
  const theme = pickEnum(c, 'brand.theme', WIDGET_THEMES, raw.theme, 'auto');
  // До Э4 тарифов нет — действует Start: «Работает на …» не убирается.
  let poweredBy = true;
  if (raw.poweredBy !== true && raw.poweredBy !== undefined) {
    c.adj('brand.poweredBy', 'powered_by_locked', raw.poweredBy, true);
  }
  poweredBy = true;
  if (!primary || !buttonText || name === null) return null;
  return {
    primaryColor: primary,
    buttonTextColor: buttonText,
    logoAssetId: logo,
    avatar,
    launcherIcon,
    name,
    font,
    preset,
    theme,
    poweredBy,
  };
}

function parseTexts(c: Ctx, raw: unknown): WidgetConfig['texts'] {
  const out: WidgetConfig['texts'] = {};
  if (raw === undefined || raw === null) return out;
  if (!isObj(raw)) {
    c.err('texts', 'type');
    return out;
  }
  for (const lang of WIDGET_UI_LANGS) {
    const t = raw[lang];
    if (t === undefined || t === null) continue;
    const base = `texts.${lang}`;
    if (!isObj(t)) {
      c.err(base, 'type');
      continue;
    }
    const greeting =
      t.greeting === undefined || t.greeting === null
        ? ''
        : pickText(
            c,
            `${base}.greeting`,
            t.greeting,
            WIDGET_TEXT_LIMITS.greeting,
            {
              multiline: true,
            },
          );
    const sRaw = t.suggestions ?? [];
    const suggestions: string[] = [];
    if (!Array.isArray(sRaw)) {
      c.err(`${base}.suggestions`, 'type');
    } else {
      sRaw.forEach((s, i) => {
        const v = pickText(
          c,
          `${base}.suggestions[${i}]`,
          s,
          WIDGET_TEXT_LIMITS.suggestion,
        );
        if (v) suggestions.push(v);
      });
      if (suggestions.length > WIDGET_TEXT_LIMITS.suggestions) {
        c.adj(
          `${base}.suggestions`,
          'text_truncated',
          suggestions.length,
          WIDGET_TEXT_LIMITS.suggestions,
        );
        suggestions.length = WIDGET_TEXT_LIMITS.suggestions;
      }
    }
    if (greeting !== null) out[lang] = { greeting, suggestions };
  }
  return out;
}

function parseOffset(c: Ctx, path: string, raw: unknown, def: WidgetOffset) {
  if (!isObj(raw)) {
    if (raw !== undefined) c.adj(path, 'enum_default', raw, def);
    return { ...def };
  }
  const max = WIDGET_TEXT_LIMITS.offsetMax;
  return {
    x: pickInt(c, `${path}.x`, raw.x, 0, max, def.x),
    y: pickInt(c, `${path}.y`, raw.y, 0, max, def.y),
  };
}

function parseLayout(c: Ctx, raw: unknown): WidgetConfig['layout'] {
  const def = defaultWidgetConfig('').layout;
  if (!isObj(raw)) {
    if (raw !== undefined) c.err('layout', 'type');
    return def;
  }
  const off = isObj(raw.offset) ? raw.offset : {};
  return {
    position: pickEnum(
      c,
      'layout.position',
      WIDGET_POSITIONS,
      raw.position,
      def.position,
    ),
    offset: {
      desktop: parseOffset(
        c,
        'layout.offset.desktop',
        off.desktop,
        def.offset.desktop,
      ),
      mobile: parseOffset(
        c,
        'layout.offset.mobile',
        off.mobile,
        def.offset.mobile,
      ),
    },
    zIndex: pickInt(c, 'layout.zIndex', raw.zIndex, 0, 2147483647, def.zIndex),
    mobile: pickEnum(
      c,
      'layout.mobile',
      WIDGET_MOBILE_MODES,
      raw.mobile,
      def.mobile,
    ),
    launcher: pickEnum(
      c,
      'layout.launcher',
      ['default', 'none'] as const,
      raw.launcher,
      def.launcher,
    ),
    openAt: pickEnum(
      c,
      'layout.openAt',
      ['corner', 'center'] as const,
      raw.openAt,
      def.openAt,
    ),
    avoidOverlap: pickBool(
      c,
      'layout.avoidOverlap',
      raw.avoidOverlap,
      def.avoidOverlap,
    ),
    hideOnScrollMobile: pickBool(
      c,
      'layout.hideOnScrollMobile',
      raw.hideOnScrollMobile,
      def.hideOnScrollMobile,
    ),
  };
}

function parseMasks(c: Ctx, path: string, raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.err(path, 'type');
    return [];
  }
  if (raw.length > WIDGET_TEXT_LIMITS.pathMasks) {
    c.err(path, 'too_many');
    return [];
  }
  const out: string[] = [];
  raw.forEach((m, i) => {
    if (
      typeof m !== 'string' ||
      m.length > WIDGET_TEXT_LIMITS.pathMask ||
      !PATH_MASK.test(m)
    ) {
      c.err(`${path}[${i}]`, 'path_mask');
      return;
    }
    if (!out.includes(m)) out.push(m);
  });
  return out;
}

/** Хостов в конфигурации не больше, чем бывает у сайта разумно. */
export const WIDGET_MAX_HOST_RULES = 50;

function parseHosts(c: Ctx, raw: unknown): WidgetHostRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    c.err('hosts', 'type');
    return [];
  }
  if (raw.length > WIDGET_MAX_HOST_RULES) {
    c.err('hosts', 'too_many');
    return [];
  }
  const out: WidgetHostRule[] = [];
  raw.forEach((h, i) => {
    const p = `hosts[${i}]`;
    if (!isObj(h)) {
      c.err(p, 'type');
      return;
    }
    if (typeof h.hostId !== 'string' || !WIDGET_ID.test(h.hostId)) {
      c.err(`${p}.hostId`, 'type');
      return;
    }
    if (out.some((x) => x.hostId === h.hostId)) {
      c.err(`${p}.hostId`, 'duplicate');
      return;
    }
    out.push({
      hostId: h.hostId,
      enabled: pickBool(c, `${p}.enabled`, h.enabled, false),
      pathMasks: parseMasks(c, `${p}.pathMasks`, h.pathMasks),
      hideOn: parseMasks(c, `${p}.hideOn`, h.hideOn),
    });
  });
  return out;
}

/**
 * Контраст (§3-бис.1): основной цвет к светлому фону ≥ 3:1 и текст на
 * кнопке ≥ 4.5:1. Не проходит — ближайший проходящий оттенок; отказаться
 * можно только в сторону БОЛЬШЕГО контраста — поэтому поправка
 * обязательна, а не предложение. Тёмная тема выводится автоматически
 * (widgetThemeColors) и проходит всегда.
 */
function enforceContrast(c: Ctx, brand: WidgetConfig['brand']): void {
  const text = brand.buttonTextColor;
  if (lightThemePasses(brand.primaryColor, text)) return;
  const fixed = nearestPassingShade(brand.primaryColor, (cand) =>
    lightThemePasses(cand, text),
  );
  if (fixed) {
    const darker = luminance(fixed) < luminance(brand.primaryColor);
    c.adj(
      'brand.primaryColor',
      darker ? 'contrast_darkened' : 'contrast_lightened',
      brand.primaryColor,
      fixed,
    );
    brand.primaryColor = fixed;
    return;
  }
  // Заданный текст не читается ни на одном оттенке — авто (чёрный/белый).
  c.adj('brand.buttonTextColor', 'contrast_darkened', text, 'auto');
  brand.buttonTextColor = 'auto';
  enforceContrast(c, brand);
}

/**
 * Строгая проверка ПОЛНОЙ конфигурации (сохранение черновика, публикация,
 * черновик лендинга). Неизвестные ключи отбрасываются; цвет не по шаблону —
 * ошибка (не умолчание: владелец должен увидеть отказ); enum вне перечня —
 * умолчание с adjustment; контраст текста на кнопке и в пузырях — WCAG 2.2
 * AA (≥ 4.5:1 текст, ≥ 3:1 иконка/границы) для светлой и тёмной тем,
 * не проходит — ближайший проходящий оттенок + adjustment `contrast_darkened`.
 */
export function parseWidgetConfig(
  input: unknown,
  opts: { verifiedOrigins?: string[] } = {},
): WidgetConfigParse {
  const c = new Ctx();
  if (!isObj(input)) {
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  }
  if (input.schema !== undefined && input.schema !== 1) {
    c.err('schema', 'schema');
  }
  const brand = parseBrand(c, input.brand);
  const texts = parseTexts(c, input.texts);
  const layout = parseLayout(c, input.layout);
  const hosts = parseHosts(c, input.hosts);
  // Э3: вовлечение — строгий разбор engagement-config.ts (неизвестное поле,
  // триггер Э3-бис, ссылка не на verified-хост — ошибка, не умолчание).
  let engagement: EngagementConfig | undefined;
  if (input.engagement !== undefined && input.engagement !== null) {
    const e = parseEngagementConfig(input.engagement, opts);
    if (e.ok) engagement = e.config;
    else {
      for (const x of e.errors) {
        c.err(x.path ? `engagement.${x.path}` : 'engagement', x.code);
      }
    }
  }
  if (c.errors.length || !brand) {
    return { ok: false, errors: c.errors };
  }
  enforceContrast(c, brand);
  return {
    ok: true,
    config: {
      schema: 1,
      brand,
      texts,
      layout,
      hosts,
      ...(engagement ? { engagement } : {}),
    },
    adjustments: c.adjustments,
  };
}

/** Ключи верхнего уровня, которые partial может менять. */
const PATCH_SECTIONS = ['brand', 'texts', 'layout'] as const;

function mergeDeep(base: unknown, patch: unknown): unknown {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    // Прототипные ключи из JSON (`__proto__`) не сливаем никогда.
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      continue;
    }
    out[k] = isObj(v) && isObj(base[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

/**
 * Частичная конфигурация `V4CAssist('preview', partial)` и PATCH черновика:
 * те же правила по каждому полю; `hosts` в partial не принимается никогда.
 * Аватар и тексты языка заменяются целиком (это значения, а не разделы).
 */
export function parseWidgetConfigPatch(
  base: WidgetConfig,
  patch: unknown,
): WidgetConfigParse {
  if (!isObj(patch)) {
    return { ok: false, errors: [{ path: '', code: 'type' }] };
  }
  if ('hosts' in patch) {
    return { ok: false, errors: [{ path: 'hosts', code: 'not_allowed' }] };
  }
  const merged: Obj = {
    schema: 1,
    brand: { ...base.brand },
    texts: { ...base.texts },
    layout: base.layout,
    hosts: base.hosts,
    // Вовлечение partial не меняет (предпросмотр вида), но и не теряет.
    ...(base.engagement ? { engagement: base.engagement } : {}),
  };
  for (const key of PATCH_SECTIONS) {
    const v = patch[key];
    if (v === undefined) continue;
    if (!isObj(v)) {
      return { ok: false, errors: [{ path: key, code: 'type' }] };
    }
    if (key === 'brand') {
      const b: Obj = { ...(merged.brand as Obj) };
      for (const [k, val] of Object.entries(v)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
          continue;
        }
        b[k] = val;
      }
      merged.brand = b;
    } else if (key === 'texts') {
      const t: Obj = { ...(merged.texts as Obj) };
      for (const lang of WIDGET_UI_LANGS) {
        if (v[lang] !== undefined) t[lang] = v[lang];
      }
      merged.texts = t;
    } else {
      merged.layout = mergeDeep(merged.layout, v);
    }
  }
  return parseWidgetConfig(merged);
}
