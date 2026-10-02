/**
 * Модель конфигуратора-превью `/assistant/widget` (Л3, ТЗ §5) — чистая,
 * без React и DOM (проверяется `scripts/widget-draft.test.ts`).
 *
 * Конфигурация — ТА ЖЕ структура вида, что в продукте (`WidgetConfig`
 * из `sites-backend/src/modules/assist-site-setup/widget-config.ts`), без
 * `hosts` и без картинок: анонимный черновик лендинга не хранит чужих
 * файлов (§5.3), логотип живёт только в браузере (`blob:`).
 *
 * ЛОКАЛЬНАЯ КОПИЯ (отступление от §14 Л3 «только через site-tma-kit»):
 * в ките нет ни типов вида, ни проверки контраста — они живут в
 * sites-backend (источник), их зеркала — в `widget/` и `assist/`. Пока их
 * не вынесли в `site-tma-kit` (запрос — в отчёте Л2–Л3), здесь копия
 * перечней и формул контраста; расхождение с источником ловит
 * `scripts/api-contract.test.ts` (сравнение на сотнях цветов и разбор
 * наших черновиков настоящим `parseWidgetConfig`).
 */

export const POSITIONS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
export type Position = (typeof POSITIONS)[number];
export const MOBILE_MODES = ['fullscreen', 'sheet', 'bubble'] as const;
export type MobileMode = (typeof MOBILE_MODES)[number];
export const THEMES = ['light', 'dark', 'auto', 'site'] as const;
export type Theme = (typeof THEMES)[number];
/**
 * Шрифты, которые конфигуратор предлагает СЕЙЧАС: системный и «как на
 * сайте». 6 гарнитур с нашего хостинга (§5.1, контракт Э2 О-6) в виджете
 * ещё не добавлены — предлагать их значило бы показать в предпросмотре
 * то, чего виджет не нарисует (утверждение `widget-fonts` — «скоро»).
 */
export const FONTS_AVAILABLE = ['system', 'site'] as const;
export type Font = (typeof FONTS_AVAILABLE)[number];
export const PRESETS = ['soft', 'strict', 'compact'] as const;
export type Preset = (typeof PRESETS)[number];
/** Иконки кнопки/аватара; `logo` — только с логотипом в кабинете (у черновика картинок нет). */
export const ICONS = ['chat', 'question', 'headset'] as const;
export type Icon = (typeof ICONS)[number];
export const UI_LANGS = ['uk', 'ru', 'en'] as const;
export type UiLang = (typeof UI_LANGS)[number];

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
export const TEXT_LIMITS = { name: 30, greeting: 300, suggestion: 80, suggestions: 3, offsetMax: 200 } as const;
/** Фон чата в светлой и тёмной теме (`WIDGET_SURFACES`). */
export const SURFACES = { light: '#FFFFFF', dark: '#16181D' } as const;
export const WCAG_AA_TEXT = 4.5;
export const WCAG_AA_UI = 3;
/** Пресеты цвета — те же, что в продукте (каждый проходит AA без поправок). */
export const COLOR_PRESETS = ['#2563EB', '#7C3AED', '#DB2777', '#DC2626', '#C2410C', '#047857', '#0F766E', '#1F2937'] as const;
/** Предел тела черновика на сервере (`LANDING_DEFAULTS.widgetDraftMaxBytes`). */
export const DRAFT_MAX_BYTES = 2 * 1024;

export interface Offset {
  x: number;
  y: number;
}

export interface DraftConfig {
  schema: 1;
  brand: {
    primaryColor: string;
    buttonTextColor: 'auto' | string;
    logoAssetId: null;
    avatar: { kind: 'icon'; icon: Icon };
    launcherIcon: Icon;
    name: string;
    font: Font;
    preset: Preset;
    theme: Theme;
    poweredBy: true;
  };
  texts: Partial<Record<UiLang, { greeting: string; suggestions: string[] }>>;
  layout: {
    position: Position;
    offset: { desktop: Offset; mobile: Offset };
    zIndex: number;
    mobile: MobileMode;
    launcher: 'default' | 'none';
    openAt: 'corner' | 'center';
    avoidOverlap: boolean;
    hideOnScrollMobile: boolean;
  };
}

export const Z_INDEX_DEFAULT = 2147483000;

/**
 * Умолчание. Тексты — ПУСТО: в черновик попадают только языки, которые
 * человек правил (иначе три приветствия по 300 знаков кириллицей не
 * влезают в 2 КБ черновика); при применении в TMA остальные языки сайта
 * остаются своими (`applyLandingDraft`: `{ ...current.texts, ...landing.texts }`).
 */
export function defaultDraft(name: string): DraftConfig {
  return {
    schema: 1,
    brand: {
      primaryColor: COLOR_PRESETS[0],
      buttonTextColor: 'auto',
      logoAssetId: null,
      avatar: { kind: 'icon', icon: 'chat' },
      launcherIcon: 'chat',
      name: cleanLine(name, TEXT_LIMITS.name) || 'Assistant',
      font: 'system',
      preset: 'soft',
      theme: 'auto',
      poweredBy: true,
    },
    texts: {},
    layout: {
      position: 'bottom-right',
      offset: { desktop: { x: 20, y: 20 }, mobile: { x: 16, y: 16 } },
      zIndex: Z_INDEX_DEFAULT,
      mobile: 'fullscreen',
      launcher: 'default',
      openAt: 'corner',
      avoidOverlap: true,
      hideOnScrollMobile: false,
    },
  };
}

// ── Текст: те же правила, что у сервера (управляющие/bidi — отказ) ─────

/** Управляющие символы и bidi-«переворачиватели» (как `CONTROL_ALL` сервера). */
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;
const CONTROL_KEEP_NL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g;

/** Однострочный текст: без управляющих, обрезка по кодовым точкам. */
export function cleanLine(s: string, max: number): string {
  return Array.from(s.replace(CONTROL_ALL, '').trim()).slice(0, max).join('').trimEnd();
}

/** Многострочный (приветствие): переводы строк остаются. */
export function cleanMultiline(s: string, max: number): string {
  return Array.from(s.replace(/\r\n?/g, '\n').replace(CONTROL_KEEP_NL, '').trim()).slice(0, max).join('').trimEnd();
}

export function clampOffset(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(TEXT_LIMITS.offsetMax, Math.round(v)));
}

/** HEX из поля ввода: `#abc`/`abc123` → `#AABBCC`/`#ABC123`; мусор — null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) return `#${s.split('').map((c) => c + c).join('')}`.toUpperCase();
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}`.toUpperCase() : null;
}

// ── Контраст WCAG 2.x — копия формул sites-backend widget-config.ts ────

function rgbOf(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hexOf(r: number, g: number, b: number): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase();
}

export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  if (!HEX_COLOR.test(a) || !HEX_COLOR.test(b)) throw new Error('contrastRatio: ожидается #RRGGBB');
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function autoTextColor(bg: string): '#000000' | '#FFFFFF' {
  return contrastRatio(bg, '#000000') >= contrastRatio(bg, '#FFFFFF') ? '#000000' : '#FFFFFF';
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

export function nearestPassingShade(hex: string, ok: (candidate: string) => boolean): string | null {
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

export function lightThemePasses(primary: string, text: string): boolean {
  return (
    contrastRatio(primary, SURFACES.light) >= WCAG_AA_UI &&
    contrastRatio(primary, text === 'auto' ? autoTextColor(primary) : text) >= WCAG_AA_TEXT
  );
}

export interface ThemeColors {
  surface: string;
  primary: string;
  onPrimary: string;
}

/** Цвета чата для светлой и тёмной темы — как `widgetThemeColors` продукта. */
export function themeColors(brand: { primaryColor: string; buttonTextColor: string }): { light: ThemeColors; dark: ThemeColors } {
  const primary = brand.primaryColor.toUpperCase();
  const lightText = brand.buttonTextColor === 'auto' ? autoTextColor(primary) : brand.buttonTextColor.toUpperCase();
  const darkOk = (c: string) => contrastRatio(c, SURFACES.dark) >= WCAG_AA_UI && contrastRatio(c, autoTextColor(c)) >= WCAG_AA_TEXT;
  const darkPrimary = nearestPassingShade(primary, darkOk) ?? '#FFFFFF';
  const explicit = brand.buttonTextColor !== 'auto' ? lightText : null;
  const darkText = explicit && contrastRatio(darkPrimary, explicit) >= WCAG_AA_TEXT ? explicit : autoTextColor(darkPrimary);
  return {
    light: { surface: SURFACES.light, primary, onPrimary: lightText },
    dark: { surface: SURFACES.dark, primary: darkPrimary, onPrimary: darkText },
  };
}

export interface ContrastResult {
  /** Цвет после автокоррекции (его и сохраняем — сервер сделал бы то же). */
  primaryColor: string;
  buttonTextColor: 'auto' | string;
  /** Что поправили: null — ничего. */
  adjusted: null | { reason: 'darkened' | 'lightened' | 'text_auto'; from: string; to: string };
  /** Контраст текста на кнопке и кнопки к фону (светлая тема) ПОСЛЕ поправки. */
  text: number;
  ui: number;
}

/**
 * Автокоррекция контраста (§5.2 «контраст WCAG AA — подсказка и
 * автокоррекция, как в TMA»): основной цвет к белому фону ≥ 3:1, текст на
 * кнопке ≥ 4.5:1; не проходит — ближайший проходящий оттенок того же тона
 * (как `enforceContrast` сервера); если не читается заданный цвет текста —
 * текст «авто» (чёрный/белый).
 */
export function enforceContrast(primaryColor: string, buttonTextColor: 'auto' | string): ContrastResult {
  let primary = primaryColor.toUpperCase();
  let text = buttonTextColor === 'auto' ? 'auto' : buttonTextColor.toUpperCase();
  let adjusted: ContrastResult['adjusted'] = null;
  for (let guard = 0; guard < 2; guard++) {
    if (lightThemePasses(primary, text)) break;
    const fixed = nearestPassingShade(primary, (c) => lightThemePasses(c, text));
    if (fixed) {
      adjusted = { reason: luminance(fixed) < luminance(primary) ? 'darkened' : 'lightened', from: primary, to: fixed };
      primary = fixed;
      break;
    }
    adjusted = { reason: 'text_auto', from: text, to: 'auto' };
    text = 'auto';
  }
  const shown = text === 'auto' ? autoTextColor(primary) : text;
  return {
    primaryColor: primary,
    buttonTextColor: text,
    adjusted,
    text: contrastRatio(primary, shown),
    ui: contrastRatio(primary, SURFACES.light),
  };
}

// ── Черновик → сервер, превью, код, deeplink ────────────────────────

/** Черновик для `POST /public/widget-drafts`: тексты очищены, контраст поправлен. */
export function serializeDraft(c: DraftConfig): DraftConfig {
  const fixed = enforceContrast(c.brand.primaryColor, c.brand.buttonTextColor);
  const texts: DraftConfig['texts'] = {};
  for (const lang of UI_LANGS) {
    const t = c.texts[lang];
    if (!t) continue;
    texts[lang] = {
      greeting: cleanMultiline(t.greeting, TEXT_LIMITS.greeting),
      suggestions: t.suggestions
        .map((s) => cleanLine(s, TEXT_LIMITS.suggestion))
        .filter(Boolean)
        .slice(0, TEXT_LIMITS.suggestions),
    };
  }
  return {
    schema: 1,
    brand: {
      ...c.brand,
      primaryColor: fixed.primaryColor,
      buttonTextColor: fixed.buttonTextColor,
      logoAssetId: null,
      avatar: { kind: 'icon', icon: c.brand.avatar.icon },
      name: cleanLine(c.brand.name, TEXT_LIMITS.name) || 'Assistant',
      poweredBy: true,
    },
    texts,
    layout: {
      ...c.layout,
      offset: {
        desktop: { x: clampOffset(c.layout.offset.desktop.x), y: clampOffset(c.layout.offset.desktop.y) },
        mobile: { x: clampOffset(c.layout.offset.mobile.x), y: clampOffset(c.layout.offset.mobile.y) },
      },
    },
  };
}

export function draftBytes(c: DraftConfig): number {
  return new TextEncoder().encode(JSON.stringify(c)).length;
}

/**
 * Частичный вид для `V4CAssist('preview', partial)` (§4.3) — только то,
 * что меняет вид; виджет применяет его ТОЛЬКО при `allowClientPreview`
 * с сервера (иначе молча игнорирует) и только на этой вкладке.
 */
export function previewPatch(c: DraftConfig): Record<string, unknown> {
  const s = serializeDraft(c);
  // z-index нашей страницы не трогаем: он у живого виджета свой.
  const { zIndex, ...layout } = s.layout;
  void zIndex;
  return { brand: s.brand, texts: s.texts, layout };
}

/** Сниппет установки (§5.3 «Получить код»): только `data-*` позиции/отступов. */
export function installSnippet(loaderSrc: string, c: DraftConfig, keyPlaceholder: string): string {
  const l = c.layout;
  const attrs = [
    `async`,
    `src="${loaderSrc}"`,
    `data-site="${keyPlaceholder}"`,
    `data-position="${l.position}"`,
    `data-offset-x="${clampOffset(l.offset.desktop.x)}"`,
    `data-offset-y="${clampOffset(l.offset.desktop.y)}"`,
    `data-mobile="${l.mobile}"`,
  ];
  if (l.launcher === 'none') attrs.push('data-launcher="none"');
  return `<script ${attrs.join(' ')}></script>`;
}

/** id черновика с сервера: 128 бит base64url (≤ 60 символов — лимит `startapp`). */
export const DRAFT_ID_RE = /^[A-Za-z0-9_-]{16,57}$/;

/** `t.me/<бот>?startapp=wd_<id>` — читатель `wd_` в TMA: «применить вид из конфигуратора?». */
export function tmaDraftLink(bot: string, draftId: string): string {
  if (!DRAFT_ID_RE.test(draftId)) throw new Error('tmaDraftLink: негодный id черновика');
  return `https://t.me/${encodeURIComponent(bot)}?startapp=wd_${draftId}`;
}

export type DraftResult =
  | { ok: true; id: string; expiresAt: string }
  | { ok: false; code: 'RATE_LIMITED' | 'BAD_REQUEST' | 'ORIGIN_DENIED' | 'NETWORK' | 'UNEXPECTED' };

/** Строгий разбор ответа `POST /public/widget-drafts` (конверт `{ success, data }`). */
export function parseDraftResponse(status: number, body: unknown): DraftResult {
  const o = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (o && o.success === true && o.data && typeof o.data === 'object') {
    const d = o.data as Record<string, unknown>;
    if (typeof d.id === 'string' && DRAFT_ID_RE.test(d.id) && typeof d.expiresAt === 'string' && !Number.isNaN(Date.parse(d.expiresAt))) {
      return { ok: true, id: d.id, expiresAt: d.expiresAt };
    }
    return { ok: false, code: 'UNEXPECTED' };
  }
  const code = o && o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>).code : null;
  if (code === 'RATE_LIMITED' || status === 429) return { ok: false, code: 'RATE_LIMITED' };
  if (code === 'ORIGIN_DENIED') return { ok: false, code: 'ORIGIN_DENIED' };
  if (code === 'BAD_REQUEST' || status === 400) return { ok: false, code: 'BAD_REQUEST' };
  return { ok: false, code: 'UNEXPECTED' };
}

/** Растровый логотип только в браузере (§5.1): PNG/JPEG/WebP, ≤ 2 МБ, SVG — нет. */
export const LOGO_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export function logoProblem(file: { type: string; size: number }): 'type' | 'size' | null {
  if (!(LOGO_MIMES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > LOGO_MAX_BYTES) return 'size';
  return null;
}

/** Сигнатура байтов: тип по содержимому, а не по имени файла. */
export function sniffRaster(bytes: Uint8Array): (typeof LOGO_MIMES)[number] | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}
