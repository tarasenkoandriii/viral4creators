/**
 * Формы кабинета виджета Э2 — повтор `sites-backend/src/modules/
 * assist-site-setup/{api-types,widget-config,persona,leads-config}.ts`
 * (контракт Э2 §4 W4). Перечни и лимиты сверяет `scripts/widget-api.test.ts`
 * с серверными модулями (импортом — они чистые), поля интерфейсов — по
 * тексту `api-types.ts`.
 */

import type { EngagementConfig } from './engagement-types';
import type { WidgetHostRule, WidgetLook } from '../kit/widget-look';

// Вид виджета (перечни, лимиты, пресеты, фоны, форма бренда/раскладки) —
// из кита (`site-tma-kit/src/widget-look.ts`, общий с лендингом); здесь —
// только то, что знает кабинет Помощника (хосты, вовлечение).
export {
  HEX_COLOR,
  WIDGET_COLOR_PRESETS,
  WIDGET_FONTS,
  WIDGET_LAUNCHER_ICONS,
  WIDGET_MOBILE_MODES,
  WIDGET_POSITIONS,
  WIDGET_PRESETS,
  WIDGET_SURFACES,
  WIDGET_TEXT_LIMITS,
  WIDGET_THEMES,
  WIDGET_UI_LANGS,
  type WidgetFont,
  type WidgetHostRule,
  type WidgetLauncherIcon,
  type WidgetMobileMode,
  type WidgetOffset,
  type WidgetPosition,
  type WidgetPreset,
  type WidgetTheme,
  type WidgetUiLang,
} from '../kit/widget-look';

export interface WidgetConfig extends WidgetLook {
  hosts: WidgetHostRule[];
  /** Э3 (T): триггеры, лимиты, сценарии — публикуются вместе с видом. */
  engagement?: EngagementConfig;
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
  /** Э3 (T): инструкции GTM / npm / WordPress — при выданных ключах. */
  installGuides?: InstallGuides;
}

/** Повтор `InstallGuides` из `assist-site-setup/snippet.ts`. */
export interface InstallGuides {
  gtm: { html: string };
  npm: { install: string; code: string; react: string };
  wordpress: { pluginSlug: string; siteKey: string; widgetOrigin: string };
  jsApi: { goal: string; identify: string };
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
  procedures: 10,
  procedureWhen: 200,
  procedureSteps: 800,
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
  /** Э3 №19: до 10 «когда — сделай» (сервер не пишет пустой список). */
  procedures?: Array<{ when: string; steps: string }>;
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
