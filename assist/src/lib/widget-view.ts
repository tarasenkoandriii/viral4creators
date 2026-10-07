/**
 * Чистая логика экранов «Виджет», «Персона», мастера: права, вкладки,
 * контраст (живая подсказка до сохранения — сервер всё равно поправит),
 * правка черновика, маски путей, проверка файла картинки, тег
 * предпросмотра, читатели payload лендинга. Без React — проверяется
 * `scripts/widget-view.test.ts`.
 */

import {
  HEX_COLOR as HEX,
  WCAG_AA_TEXT,
  WCAG_AA_UI,
  autoTextColor,
  contrastRatio,
  parseStartParam,
  verifyHostFromStartParam,
  type AccountMember,
} from '../kit';
import { PUBLIC_KEY, safeWidgetOrigin } from './widget-api';
import { WIDGET_LOADER_PATH } from './widget-brand';
import {
  ASSET_MAX_BYTES,
  ASSET_MIMES,
  INSTALL_CHECK_RESULTS,
  WIDGET_SURFACES,
  WIDGET_TEXT_LIMITS,
  type InstallCheckResult,
  type WidgetConfig,
  type WidgetHostRule,
} from './widget-types';

// ── Права ────────────────────────────────────────────────────────────

/**
 * Виджет, персона, лиды, мастер — `assist: manager` (оператор — 403 на
 * сервере). Оператору раздел не показываем вовсе.
 */
export function canManageWidget(me: AccountMember): boolean {
  if (me.role === 'operator') return false;
  return me.role === 'owner' || me.productRoles.assist === 'manager';
}

// ── Вкладки ──────────────────────────────────────────────────────────

export const WIDGET_TABS = [
  'look',
  'install',
  'hosts',
  'leads',
  // Э3 (T): триггеры, лимиты навязчивости, сценарии.
  'engagement',
] as const;
export type WidgetTab = (typeof WIDGET_TABS)[number];

export function isWidgetTab(v: unknown): v is WidgetTab {
  return (
    typeof v === 'string' && (WIDGET_TABS as readonly string[]).includes(v)
  );
}

// ── Контраст (WCAG 2.x) — из кита (widget-look.ts, сверка с сервером) ──

export { autoTextColor, contrastRatio };

/** Цвет текста на кнопке (авто — чёрный/белый). */
export function buttonText(brand: WidgetConfig['brand']): string {
  return brand.buttonTextColor === 'auto' || !HEX.test(brand.buttonTextColor)
    ? autoTextColor(brand.primaryColor)
    : brand.buttonTextColor;
}

/**
 * Подсказка до сохранения: пройдёт ли светлая тема AA без поправки
 * (кнопка к белому ≥ 3:1, текст на кнопке ≥ 4.5:1).
 */
export function contrastHint(brand: WidgetConfig['brand']): {
  ok: boolean;
  text: number;
  ui: number;
} {
  if (!HEX.test(brand.primaryColor)) return { ok: false, text: 1, ui: 1 };
  const text = contrastRatio(brand.primaryColor, buttonText(brand));
  const ui = contrastRatio(brand.primaryColor, WIDGET_SURFACES.light);
  return { ok: text >= WCAG_AA_TEXT && ui >= WCAG_AA_UI, text, ui };
}

/** HEX из поля ввода: `#abc`/`abc123` → `#AABBCC`/`#ABC123`; мусор — null. */
export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s
      .split('')
      .map((c) => c + c)
      .join('')}`.toUpperCase();
  }
  return /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}`.toUpperCase() : null;
}

// ── Черновик ─────────────────────────────────────────────────────────

/** Правило хоста в черновике (нет — добавить выключенным). */
export function hostRule(config: WidgetConfig, hostId: string): WidgetHostRule {
  return (
    config.hosts.find((h) => h.hostId === hostId) ?? {
      hostId,
      enabled: false,
      pathMasks: [],
      hideOn: [],
    }
  );
}

export function withHostRule(
  config: WidgetConfig,
  rule: WidgetHostRule
): WidgetConfig {
  const rest = config.hosts.filter((h) => h.hostId !== rule.hostId);
  return { ...config, hosts: [...rest, rule] };
}

/** Та же маска, что у сервера (`PATH_MASK`). */
export const PATH_MASK = /^\/[A-Za-z0-9\-._~%!$&'()*+,;=:@/]*$/;

/**
 * Маски путей из поля «через запятую или с новой строки». Неверные —
 * отдельно, чтобы показать, что именно не так, а не молча выбросить.
 */
export function parseMasks(input: string): { masks: string[]; bad: string[] } {
  const masks: string[] = [];
  const bad: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const m = raw.trim();
    if (!m) continue;
    if (m.length > WIDGET_TEXT_LIMITS.pathMask || !PATH_MASK.test(m)) {
      bad.push(m);
    } else if (!masks.includes(m)) {
      masks.push(m);
    }
  }
  if (masks.length > WIDGET_TEXT_LIMITS.pathMasks) {
    bad.push(...masks.splice(WIDGET_TEXT_LIMITS.pathMasks));
  }
  return { masks, bad };
}

/** Список из многострочного поля: строки без пустых и дублей. */
export function linesToList(input: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of input.split('\n')) {
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, max);
}

// ── Картинки ─────────────────────────────────────────────────────────

export type AssetFileProblem = 'type' | 'size' | null;

/** До загрузки: тип по заявке файла и размер (сервер проверит байты). */
export function assetFileProblem(file: {
  type: string;
  size: number;
}): AssetFileProblem {
  if (!(ASSET_MIMES as readonly string[]).includes(file.type)) return 'type';
  if (file.size > ASSET_MAX_BYTES) return 'size';
  return null;
}

// ── Проверка установки ───────────────────────────────────────────────

export function installTone(
  r: InstallCheckResult
): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (r) {
    case 'ok':
      return 'success';
    case 'csp_blocked':
    case 'unverified_host':
      return 'warning';
    case 'fetch_failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function isInstallResult(v: unknown): v is InstallCheckResult {
  return (
    typeof v === 'string' &&
    (INSTALL_CHECK_RESULTS as readonly string[]).includes(v)
  );
}

// ── Предпросмотр: НАСТОЯЩИЙ загрузчик ────────────────────────────────

export interface PreviewTag {
  src: string;
  site: string;
  token: string;
}

/**
 * Тег загрузчика для предпросмотра — только из проверенных частей:
 * origin виджета (https), ключ по формату, токен base64url. Иначе null
 * — в документ ничего не вставляется.
 */
export function previewTag(
  widgetOrigin: string | undefined,
  publicKey: string | null,
  token: string
): PreviewTag | null {
  const origin = safeWidgetOrigin(widgetOrigin);
  if (!origin || !publicKey || !PUBLIC_KEY.test(publicKey)) return null;
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return { src: `${origin}${WIDGET_LOADER_PATH}`, site: publicKey, token };
}

// ── Payload лендинга (лендинг-ТЗ §7.3; контракт Э2 §1 п.17) ──────────

export type LaunchTarget =
  | { name: 'onboarding-url' }
  | { name: 'plan'; plan: string }
  | { name: 'sandbox-transfer'; sandboxId: string }
  | { name: 'widget-draft'; draftId: string }
  | { name: 'stats'; siteId: string; tab: 'overview' }
  | { name: 'verify-host'; host: string };

export interface LaunchAction {
  /** start_param целиком → `POST /assist/acquisition` (одна запись на кабинет). */
  acquisition: string | null;
  target: LaunchTarget | null;
}

/** Тарифы снимка лендинга (`GET /public/assist/plans`). */
export const PLAN_IDS = ['trial', 'start', 'business', 'pro'] as const;

/**
 * Что сделать с `startapp` при запуске: `lp_` — онбординг, `pl_` — экран
 * выбранного тарифа, `sb_` — перенос песочницы, `wd_` — «применить вид
 * из конфигуратора?». Атрибуция — у всех четырёх; `inv_` — приглашение
 * (его разбирает App), остальное — ничего.
 */
export function launchAction(
  startParam: string | null | undefined
): LaunchAction {
  const p = parseStartParam(startParam);
  if (!p) return { acquisition: null, target: null };
  const raw = startParam as string;
  switch (p.kind) {
    case 'lp':
      return { acquisition: raw, target: { name: 'onboarding-url' } };
    case 'pl':
      return {
        acquisition: raw,
        target: (PLAN_IDS as readonly string[]).includes(p.value)
          ? { name: 'plan', plan: p.value }
          : null,
      };
    case 'sb':
      return {
        acquisition: raw,
        target: { name: 'sandbox-transfer', sandboxId: p.value },
      };
    case 'wd':
      return {
        acquisition: raw,
        target: { name: 'widget-draft', draftId: p.value },
      };
    // Э3: кнопка утренней сводки/отчёта недели — экран статистики сайта.
    // Это не атрибуция лендинга: на сервер ничего не шлём.
    case 'st':
      return {
        acquisition: null,
        target: /^[A-Za-z0-9_-]{1,60}$/.test(p.value)
          ? { name: 'stats', siteId: p.value, tab: 'overview' }
          : null,
      };
    // Ш1-хвост: «подтвердить ЭТОТ хост» из обучалки генератора. Не
    // атрибуция; хост — строго (`verifyHostFromStartParam`), иначе главная.
    case 'vh': {
      const host = verifyHostFromStartParam(raw);
      return {
        acquisition: null,
        target: host ? { name: 'verify-host', host } : null,
      };
    }
    default:
      return { acquisition: null, target: null };
  }
}

/**
 * Черновик лендинга поверх черновика сайта: вид и тексты — с лендинга,
 * хосты — свои (лендинг хостов не знает, `hosts` в его конфигурации нет).
 */
export function applyLandingDraft(
  current: WidgetConfig,
  landing: WidgetConfig
): WidgetConfig {
  return {
    ...current,
    brand: {
      ...landing.brand,
      // Картинок у черновика лендинга нет — свои не теряем.
      logoAssetId: current.brand.logoAssetId,
      avatar:
        landing.brand.avatar.kind === 'asset'
          ? current.brand.avatar
          : landing.brand.avatar,
    },
    texts: { ...current.texts, ...landing.texts },
    layout: landing.layout,
    hosts: current.hosts,
  };
}
