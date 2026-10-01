/**
 * Формы кабинета виджета Э2 — повтор `sites-backend/src/modules/
 * assist-site-setup/{api-types,widget-config,persona,leads-config}.ts`
 * (контракт Э2 §4 W4). Перечни и лимиты сверяет `scripts/widget-api.test.ts`
 * с серверными модулями (импортом — они чистые), поля интерфейсов — по
 * тексту `api-types.ts`.
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

export const WIDGET_PRESETS = ['soft', 'strict', 'compact'] as const;
export type WidgetPreset = (typeof WIDGET_PRESETS)[number];

export const WIDGET_LAUNCHER_ICONS = [
  'chat',
  'question',
  'headset',
  'logo',
] as const;
export type WidgetLauncherIcon = (typeof WIDGET_LAUNCHER_ICONS)[number];

export const WIDGET_UI_LANGS = ['uk', 'ru', 'en'] as const;
export type WidgetUiLang = (typeof WIDGET_UI_LANGS)[number];

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

/** Фоны чата светлой/тёмной темы (как у сервера и чата W1). */
export const WIDGET_SURFACES = { light: '#FFFFFF', dark: '#16181D' } as const;

export interface WidgetOffset {
  x: number;
  y: number;
}

export interface WidgetHostRule {
  hostId: string;
  enabled: boolean;
  pathMasks: string[];
  hideOn: string[];
}

export interface WidgetConfig {
  schema: 1;
  brand: {
    primaryColor: string;
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
  hosts: WidgetHostRule[];
}

export interface WidgetConfigAdjustment {
  path: string;
  reason: string;
  from: unknown;
  to: unknown;
}

export interface WidgetHostView {
  hostId: string;
  origin: string;
  status: string;
  widgetAllowed: boolean;
  graceUntil: string | null;
  enabledPublished: boolean;
}

export const WIDGET_WARNING_CODES = [
  'low_contrast',
  'host_not_verified',
  'host_grace',
  'powered_by_locked',
  'no_enabled_hosts',
  'not_published',
  'other_chat_in_corner',
] as const;
export type WidgetWarningCode = (typeof WIDGET_WARNING_CODES)[number];

export interface WidgetWarning {
  code: WidgetWarningCode;
  hostId?: string;
  details?: string;
}

export interface ConfigHistoryItem {
  version: number;
  publishedAt: string;
  publishedByTelegramId: string | null;
  rolledBackFrom: number | null;
}

export interface AssetView {
  id: string;
  kind: 'logo' | 'avatar';
  mime: string;
  width: number;
  height: number;
  path: string;
}

export interface WidgetSettingsView {
  siteId: string;
  publicKey: string | null;
  testKey: string | null;
  publishedVersion: number;
  published: WidgetConfig | null;
  draft: WidgetConfig;
  adjustments: WidgetConfigAdjustment[];
  history: ConfigHistoryItem[];
  hosts: WidgetHostView[];
  warnings: WidgetWarning[];
  snippet: string;
  cspSnippet: string;
  chatPaused: boolean;
  operatorBlocked: boolean;
  widgetOrigin?: string;
  draftChanged?: boolean;
  assets?: AssetView[];
}

export interface PreviewTokenResult {
  url: string | null;
  token: string;
  expiresAt: string;
}

export const INSTALL_CHECK_RESULTS = [
  'ok',
  'csp_blocked',
  'not_found',
  'unverified_host',
  'fetch_failed',
] as const;
export type InstallCheckResult = (typeof INSTALL_CHECK_RESULTS)[number];

export interface InstallCheckHost {
  hostId: string;
  origin: string;
  result: InstallCheckResult;
  tagFound: boolean;
  lastPingAt: string | null;
  missingCsp: string[];
}

export interface InstallCheckView {
  checkedAt: string;
  hosts: InstallCheckHost[];
}

// ── Персона ──────────────────────────────────────────────────────────

export const PERSONA_TONES = ['business', 'friendly', 'brief'] as const;
export type PersonaTone = (typeof PERSONA_TONES)[number];

export const PERSONA_LANG = /^[a-z]{2}$/;

export const PERSONA_LIMITS = {
  style: 500,
  forbiddenTopics: 20,
  forbiddenTopic: 100,
  stopPhrases: 30,
  stopPhrase: 100,
  examples: 5,
  example: 300,
  handoffTriggers: 10,
  handoffTrigger: 100,
  allowedLangs: 10,
} as const;

export interface PersonaConfig {
  schema: 1;
  tone: PersonaTone;
  style: string;
  languages: { mode: 'auto' | 'fixed'; allowed: string[]; default: string };
  forbiddenTopics: string[];
  stopPhrases: string[];
  examples: string[];
  handoffTriggers: string[];
}

export interface PersonaGateView {
  ran: boolean;
  invariantsPassed: boolean;
  blocked: boolean;
  notes: string[];
}

export interface PersonaSettingsView {
  siteId: string;
  configVersion: number;
  published: PersonaConfig | null;
  draft: PersonaConfig;
  history: ConfigHistoryItem[];
  lastGate: PersonaGateView | null;
}

// ── Форма лида ───────────────────────────────────────────────────────

export const LEAD_FIELDS = ['name', 'phone', 'email', 'comment'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];
export const LEADS_CONSENT_MAX = 1000;

export interface LeadsConfig {
  schema: 1;
  fields: Array<{ field: LeadField; required: boolean }>;
  consentText: Partial<Record<'uk' | 'ru' | 'en', string>>;
  channels: Array<'telegram'>;
}

export interface LeadsConfigView {
  siteId: string;
  config: LeadsConfig;
}

/** Картинка бренда: ≤ 200 КБ, PNG/JPEG/WebP (сервер проверяет сигнатуру). */
export const ASSET_MAX_BYTES = 200 * 1024;
export const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const AVATAR_MIN_SIDE = 128;
