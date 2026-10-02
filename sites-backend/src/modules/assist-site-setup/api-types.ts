/**
 * Формы ответов кабинетных маршрутов виджета и персоны (data внутри конверта
 * `{ success, data, meta }`) — стык W4 (сервер) ↔ W4 (assist/src/lib/
 * widget-api.ts повторяет эти типы и разбирает строго). Даты — ISO,
 * BigInt наружу не отдаётся. Менять — только через координатора.
 */
import type { LeadsConfig } from './leads-config';
import type { InstallGuides } from './snippet';
import type { PersonaConfig } from './persona';
import type { WidgetConfig, WidgetConfigAdjustment } from './widget-config';

export interface WidgetHostView {
  hostId: string;
  /** `https://shop.example.com` (порт — если не 443). */
  origin: string;
  /** pending | verified | expired | revoked — статус ядра. */
  status: string;
  /** Виджет на этом хосте сейчас грузится (verified или льгота 72 ч). */
  widgetAllowed: boolean;
  /** До какого момента действует льгота после отзыва/истечения. */
  graceUntil: string | null;
  /** Включён в ОПУБЛИКОВАННОЙ конфигурации. */
  enabledPublished: boolean;
}

export type WidgetWarningCode =
  | 'low_contrast'
  | 'host_not_verified'
  | 'host_grace'
  | 'powered_by_locked'
  | 'no_enabled_hosts'
  | 'not_published'
  | 'other_chat_in_corner';

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

export interface WidgetSettingsView {
  siteId: string;
  /** null — ключи ещё не выданы (POST …/widget/keys). */
  publicKey: string | null;
  testKey: string | null;
  publishedVersion: number;
  published: WidgetConfig | null;
  draft: WidgetConfig;
  /** Что сервер поправил в последнем сохранении черновика. */
  adjustments: WidgetConfigAdjustment[];
  history: ConfigHistoryItem[];
  hosts: WidgetHostView[];
  warnings: WidgetWarning[];
  /** Готовый тег установки и CSP-фрагмент под текущую настройку (§3-бис.2). */
  snippet: string;
  cspSnippet: string;
  chatPaused: boolean;
  /** Блокировка оператором платформы — только показать. */
  operatorBlocked: boolean;
  /**
   * (W4, необязательные — сверх контракта) origin загрузчика для
   * НАСТОЯЩЕГО предпросмотра в конфигураторе; черновик отличается от
   * опубликованной версии; загруженные картинки бренда сайта.
   */
  widgetOrigin?: string;
  draftChanged?: boolean;
  assets?: AssetView[];
  /**
   * (Э3, T, необязательное) инструкции установки GTM / npm / WordPress и
   * примеры JS API — при выданных ключах (тот же тег, что `snippet`).
   */
  installGuides?: InstallGuides;
}

export interface PersonaGateView {
  /** Прогон поднабора eval при публикации (§4-тер.8); null — не гонялся (нет бюджета). */
  ran: boolean;
  invariantsPassed: boolean;
  /** Блокирует публикацию только провал инвариантов. */
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

export interface PreviewTokenResult {
  /** purpose=site: готовая ссылка `https://<хост>/?<param>=<токен>`. */
  url: string | null;
  /** purpose=tma: токен для загрузчика в конфигураторе. */
  token: string;
  expiresAt: string;
}

export type InstallCheckResult =
  'ok' | 'csp_blocked' | 'not_found' | 'unverified_host' | 'fetch_failed';

export interface InstallCheckView {
  checkedAt: string;
  hosts: Array<{
    hostId: string;
    origin: string;
    result: InstallCheckResult;
    /** Найден тег с нашим pk на главной. */
    tagFound: boolean;
    /** Последний пинг загрузчика с этого origin (ISO) или null. */
    lastPingAt: string | null;
    /** Каких директив CSP не хватает (из заголовка страницы), если удалось понять. */
    missingCsp: string[];
  }>;
}

export interface LeadsConfigView {
  siteId: string;
  config: LeadsConfig;
}

export interface AssetView {
  id: string;
  kind: 'logo' | 'avatar';
  mime: string;
  width: number;
  height: number;
  /** Путь на origin виджета: `/widget/v1/asset/<id>`. */
  path: string;
}
