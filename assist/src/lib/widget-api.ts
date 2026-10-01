/**
 * Клиент кабинета виджета Э2 (контракт Э2 §6, «Кабинет»): вид, ключи,
 * публикация/откат, предпросмотр, проверка установки, рубильник,
 * картинки, атрибуция лендинга. Формы — `widget-types.ts`.
 *
 * Разбор строгий, как у `knowledge-api.ts`: бэкенд пишут параллельно,
 * и неожиданное значение не должно стать зелёной галочкой или попасть в
 * стиль/DOM. Правила:
 * - цвет — только `#RRGGBB` (иначе пресет по умолчанию): значение идёт в
 *   CSS-переменную предпросмотра;
 * - перечни — из списка, иначе умолчание; флаги прав и состояний —
 *   строго `true`;
 * - ключи — только `pk_live_`/`pk_test_` + 24 base62, origin виджета —
 *   только https (или localhost стенда): иначе НАСТОЯЩИЙ загрузчик в
 *   предпросмотр не вставляется;
 * - ссылки предпросмотра — только https на хост сайта.
 */

import { ApiError, type ApiClient } from '../kit';
import {
  INSTALL_CHECK_RESULTS,
  WIDGET_COLOR_PRESETS,
  WIDGET_FONTS,
  WIDGET_LAUNCHER_ICONS,
  WIDGET_MOBILE_MODES,
  WIDGET_POSITIONS,
  WIDGET_PRESETS,
  WIDGET_TEXT_LIMITS,
  WIDGET_THEMES,
  WIDGET_UI_LANGS,
  WIDGET_WARNING_CODES,
  type AssetView,
  type ConfigHistoryItem,
  type InstallCheckHost,
  type InstallCheckView,
  type PreviewTokenResult,
  type WidgetConfig,
  type WidgetConfigAdjustment,
  type WidgetHostRule,
  type WidgetHostView,
  type WidgetOffset,
  type WidgetSettingsView,
  type WidgetWarning,
} from './widget-types';

type Obj = Record<string, unknown>;
export const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const text = (v: unknown): string => (typeof v === 'string' ? v : '');
export const str = (v: unknown): string | null =>
  typeof v === 'string' && v ? v : null;
export const strs = (v: unknown): string[] =>
  arr(v).filter((x): x is string => typeof x === 'string' && x.length > 0);
export const oneOf = <T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T
): T =>
  (list as readonly string[]).includes(v as string) ? (v as T) : fallback;
export const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

export const HEX = /^#[0-9a-fA-F]{6}$/;
export const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const PUBLIC_KEY = /^pk_(live|test)_[0-9A-Za-z]{24}$/;

/** Origin виджета для настоящего загрузчика: https (или localhost стенда). */
export function safeWidgetOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    if (u.username || u.password) return null;
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
      return null;
    }
    return u.origin === v.replace(/\/$/, '') ? u.origin : null;
  } catch {
    return null;
  }
}

/** Только https-ссылка (ссылка «посмотреть на сайте»). */
export function safeHttpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v.toUpperCase() : fallback;
}

function offset(v: unknown, def: WidgetOffset): WidgetOffset {
  const o = obj(v);
  const n = (x: unknown, d: number) =>
    typeof x === 'number' && Number.isFinite(x)
      ? Math.max(0, Math.min(WIDGET_TEXT_LIMITS.offsetMax, Math.round(x)))
      : d;
  return { x: n(o.x, def.x), y: n(o.y, def.y) };
}

function hostRule(v: unknown): WidgetHostRule | null {
  const o = obj(v);
  if (typeof o.hostId !== 'string' || !ID.test(o.hostId)) return null;
  return {
    hostId: o.hostId,
    enabled: o.enabled === true,
    pathMasks: strs(o.pathMasks),
    hideOn: strs(o.hideOn),
  };
}

export function parseWidgetConfig(v: unknown): WidgetConfig {
  const o = obj(v);
  const b = obj(o.brand);
  const l = obj(o.layout);
  const off = obj(l.offset);
  const av = obj(b.avatar);
  const texts: WidgetConfig['texts'] = {};
  const t = obj(o.texts);
  for (const lang of WIDGET_UI_LANGS) {
    if (t[lang] === undefined) continue;
    const x = obj(t[lang]);
    texts[lang] = {
      greeting: text(x.greeting),
      suggestions: strs(x.suggestions).slice(0, WIDGET_TEXT_LIMITS.suggestions),
    };
  }
  return {
    schema: 1,
    brand: {
      primaryColor: color(b.primaryColor, WIDGET_COLOR_PRESETS[0]),
      buttonTextColor:
        b.buttonTextColor === 'auto'
          ? 'auto'
          : color(b.buttonTextColor, 'auto'),
      logoAssetId:
        typeof b.logoAssetId === 'string' && ID.test(b.logoAssetId)
          ? b.logoAssetId
          : null,
      avatar:
        av.kind === 'asset' &&
        typeof av.assetId === 'string' &&
        ID.test(av.assetId)
          ? { kind: 'asset', assetId: av.assetId }
          : {
              kind: 'icon',
              icon: oneOf(WIDGET_LAUNCHER_ICONS, av.icon, 'chat'),
            },
      launcherIcon: oneOf(WIDGET_LAUNCHER_ICONS, b.launcherIcon, 'chat'),
      name: text(b.name),
      font: oneOf(WIDGET_FONTS, b.font, 'system'),
      preset: oneOf(WIDGET_PRESETS, b.preset, 'soft'),
      theme: oneOf(WIDGET_THEMES, b.theme, 'auto'),
      // До Э4 «Работает на …» не убирается — показываем как есть.
      poweredBy: b.poweredBy !== false,
    },
    texts,
    layout: {
      position: oneOf(WIDGET_POSITIONS, l.position, 'bottom-right'),
      offset: {
        desktop: offset(off.desktop, { x: 20, y: 20 }),
        mobile: offset(off.mobile, { x: 16, y: 16 }),
      },
      zIndex:
        typeof l.zIndex === 'number' &&
        Number.isInteger(l.zIndex) &&
        l.zIndex >= 0
          ? Math.min(l.zIndex, 2147483647)
          : 2147483000,
      mobile: oneOf(WIDGET_MOBILE_MODES, l.mobile, 'fullscreen'),
      launcher: l.launcher === 'none' ? 'none' : 'default',
      openAt: l.openAt === 'center' ? 'center' : 'corner',
      avoidOverlap: l.avoidOverlap !== false,
      hideOnScrollMobile: l.hideOnScrollMobile === true,
    },
    hosts: arr(o.hosts)
      .map(hostRule)
      .filter((x): x is WidgetHostRule => !!x),
  };
}

function parseHost(v: unknown): WidgetHostView | null {
  const o = obj(v);
  if (typeof o.hostId !== 'string' || !ID.test(o.hostId)) return null;
  return {
    hostId: o.hostId,
    origin: text(o.origin),
    status: oneOf(
      ['pending', 'verified', 'expired', 'revoked'] as const,
      o.status,
      'pending'
    ),
    widgetAllowed: o.widgetAllowed === true,
    graceUntil: str(o.graceUntil),
    enabledPublished: o.enabledPublished === true,
  };
}

function parseWarning(v: unknown): WidgetWarning | null {
  const o = obj(v);
  if (!(WIDGET_WARNING_CODES as readonly unknown[]).includes(o.code)) {
    return null;
  }
  const w: WidgetWarning = { code: o.code as WidgetWarning['code'] };
  if (typeof o.hostId === 'string' && ID.test(o.hostId)) w.hostId = o.hostId;
  if (typeof o.details === 'string') w.details = o.details;
  return w;
}

export function parseHistory(v: unknown): ConfigHistoryItem[] {
  return arr(v).map((x) => {
    const o = obj(x);
    return {
      version: count(o.version),
      publishedAt: text(o.publishedAt),
      publishedByTelegramId: str(o.publishedByTelegramId),
      rolledBackFrom:
        typeof o.rolledBackFrom === 'number' ? count(o.rolledBackFrom) : null,
    };
  });
}

export function parseAsset(v: unknown): AssetView | null {
  const o = obj(v);
  if (typeof o.id !== 'string' || !ID.test(o.id)) return null;
  return {
    id: o.id,
    kind: o.kind === 'avatar' ? 'avatar' : 'logo',
    mime: text(o.mime),
    width: count(o.width),
    height: count(o.height),
    // Путь строим сами: значение сервера в src не попадает.
    path: `/widget/v1/asset/${o.id}`,
  };
}

function parseAdjustment(v: unknown): WidgetConfigAdjustment {
  const o = obj(v);
  return { path: text(o.path), reason: text(o.reason), from: o.from, to: o.to };
}

export function parseWidgetSettings(v: unknown): WidgetSettingsView {
  const o = obj(v);
  const pk = typeof o.publicKey === 'string' && PUBLIC_KEY.test(o.publicKey);
  const tk = typeof o.testKey === 'string' && PUBLIC_KEY.test(o.testKey);
  const out: WidgetSettingsView = {
    siteId: text(o.siteId),
    publicKey: pk ? (o.publicKey as string) : null,
    testKey: tk ? (o.testKey as string) : null,
    publishedVersion: count(o.publishedVersion),
    published: o.published ? parseWidgetConfig(o.published) : null,
    draft: parseWidgetConfig(o.draft),
    adjustments: arr(o.adjustments).map(parseAdjustment),
    history: parseHistory(o.history),
    hosts: arr(o.hosts)
      .map(parseHost)
      .filter((x): x is WidgetHostView => !!x),
    warnings: arr(o.warnings)
      .map(parseWarning)
      .filter((x): x is WidgetWarning => !!x),
    snippet: pk ? text(o.snippet) : '',
    cspSnippet: text(o.cspSnippet),
    chatPaused: o.chatPaused === true,
    operatorBlocked: o.operatorBlocked === true,
  };
  const origin = safeWidgetOrigin(o.widgetOrigin);
  if (origin) out.widgetOrigin = origin;
  if (typeof o.draftChanged === 'boolean') out.draftChanged = o.draftChanged;
  if (Array.isArray(o.assets)) {
    out.assets = o.assets.map(parseAsset).filter((x): x is AssetView => !!x);
  }
  return out;
}

export function parsePreviewToken(v: unknown): PreviewTokenResult {
  const o = obj(v);
  const token =
    typeof o.token === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(o.token)
      ? o.token
      : '';
  return { url: safeHttpsUrl(o.url), token, expiresAt: text(o.expiresAt) };
}

function parseInstallHost(v: unknown): InstallCheckHost | null {
  const o = obj(v);
  if (typeof o.hostId !== 'string' || !ID.test(o.hostId)) return null;
  return {
    hostId: o.hostId,
    origin: text(o.origin),
    // Неизвестный итог — НЕ «ok»: самый осторожный — «не найден».
    result: oneOf(INSTALL_CHECK_RESULTS, o.result, 'not_found'),
    tagFound: o.tagFound === true,
    lastPingAt: str(o.lastPingAt),
    missingCsp: strs(o.missingCsp).filter((d) => /^[a-z-]{3,30}$/.test(d)),
  };
}

export function parseInstallCheck(v: unknown): InstallCheckView {
  const o = obj(v);
  return {
    checkedAt: text(o.checkedAt),
    hosts: arr(o.hosts)
      .map(parseInstallHost)
      .filter((x): x is InstallCheckHost => !!x),
  };
}

export interface AssetUpload {
  kind: 'logo' | 'avatar';
  mime: string;
  dataBase64: string;
}

export interface WidgetApi {
  get(siteId: string): Promise<WidgetSettingsView>;
  ensureKeys(siteId: string): Promise<WidgetSettingsView>;
  saveDraft(siteId: string, config: WidgetConfig): Promise<WidgetSettingsView>;
  publish(siteId: string): Promise<WidgetSettingsView>;
  rollback(siteId: string, version: number): Promise<WidgetSettingsView>;
  previewToken(
    siteId: string,
    body: { purpose: 'site'; hostId: string } | { purpose: 'tma' }
  ): Promise<PreviewTokenResult>;
  checkInstall(siteId: string): Promise<InstallCheckView>;
  setPaused(siteId: string, chatPaused: boolean): Promise<WidgetSettingsView>;
  uploadAsset(siteId: string, body: AssetUpload): Promise<AssetView>;
  /** Атрибуция лендинга (`lp_`/`pl_`/`sb_`/`wd_`) — первый запуск. */
  acquisition(payload: string): Promise<{ recorded: boolean }>;
  /** «к Л3»: черновик вида с лендинга (`wd_<id>`). */
  landingDraft(id: string): Promise<WidgetConfig>;
}

function seg(id: string): string {
  if (!ID.test(id)) throw new ApiError('bad_request', 'bad id', 400);
  return id;
}

export function createWidgetApi(client: ApiClient): WidgetApi {
  const site = (id: string) => `/assist/sites/${seg(id)}/widget`;
  const view = async (p: Promise<unknown>) => parseWidgetSettings(await p);
  return {
    get: async (id) => view(client.request('GET', site(id))),
    ensureKeys: async (id) => view(client.request('POST', `${site(id)}/keys`)),
    saveDraft: async (id, config) =>
      view(client.request('PATCH', `${site(id)}/draft`, { config })),
    publish: async (id) => view(client.request('POST', `${site(id)}/publish`)),
    rollback: async (id, ver) =>
      view(client.request('POST', `${site(id)}/rollback/${count(ver)}`)),
    previewToken: async (id, body) =>
      parsePreviewToken(
        await client.request('POST', `${site(id)}/preview-token`, body)
      ),
    checkInstall: async (id) =>
      parseInstallCheck(
        await client.request('POST', `${site(id)}/check-install`)
      ),
    setPaused: async (id, chatPaused) =>
      view(client.request('PATCH', `${site(id)}/controls`, { chatPaused })),
    uploadAsset: async (id, body) => {
      const a = parseAsset(
        await client.request('POST', `${site(id)}/assets`, body)
      );
      if (!a) throw new ApiError('bad_response', 'asset', 200);
      return a;
    },
    acquisition: async (payload) => {
      const o = obj(
        await client.request('POST', '/assist/acquisition', { payload })
      );
      return { recorded: o.recorded === true };
    },
    landingDraft: async (id) => {
      const o = obj(
        await client.request('GET', `/assist/widget-drafts/${seg(id)}`)
      );
      return parseWidgetConfig(o.config);
    },
  };
}
