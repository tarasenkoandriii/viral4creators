/**
 * Публичный конфиг вида виджета — разбор НА КЛИЕНТЕ (загрузчик и iframe).
 * Повтор формы `WidgetPublicConfig` / `WidgetConfig` из sites-backend
 * (`assist-widget/api-types.ts`, `assist-site-setup/widget-config.ts`, W4/W2).
 *
 * Почему проверяем повторно, хотя сервер уже проверил (ТЗ §3-бис.1, аудит
 * 01.10): загрузчик исполняется в origin ЗАКАЗЧИКА, и любое значение бренда,
 * попавшее в DOM как разметка или в стиль конкатенацией, — XSS/CSS-инъекция
 * на чужом сайте. Поэтому здесь правило «не по шаблону — умолчание» (а не
 * отказ, как у сервера): посетитель должен увидеть рабочую кнопку, а не
 * пустое место. Цвета — только `^#[0-9a-fA-F]{6}$`, перечисления — только
 * из списка, тексты — строки с лимитом длины (в DOM — только textContent),
 * картинки — только id наших ассетов (путь строим сами).
 */
import {
  ALWAYS_EXCLUDED,
  parseEngagement,
  parseGoals,
  parseHandoff,
  type Engagement,
  type Goal,
  type HandoffInfo,
} from './engagement';

export const POSITIONS = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
] as const;
export type Position = (typeof POSITIONS)[number];
export const MOBILE_MODES = ['fullscreen', 'sheet', 'bubble'] as const;
export type MobileMode = (typeof MOBILE_MODES)[number];
export const THEMES = ['light', 'dark', 'auto', 'site'] as const;
export type Theme = (typeof THEMES)[number];
export const FONTS = [
  'site',
  'system',
  'inter',
  'roboto',
  'montserrat',
  'manrope',
  'open-sans',
  'rubik',
] as const;
export type Font = (typeof FONTS)[number];
export const PRESETS = ['soft', 'strict', 'compact'] as const;
export type Preset = (typeof PRESETS)[number];
export const ICONS = ['chat', 'question', 'headset', 'logo'] as const;
export type Icon = (typeof ICONS)[number];
export const UI_LANGS = ['uk', 'ru', 'en'] as const;
export type UiLang = (typeof UI_LANGS)[number];
export const LEAD_FIELDS = ['name', 'phone', 'email', 'comment'] as const;
export type LeadField = (typeof LEAD_FIELDS)[number];

export const HEX = /^#[0-9a-fA-F]{6}$/;
/** id ассета — то, что сервер кладёт в путь `/widget/v1/asset/<id>`. */
export const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Лимиты — те же, что WIDGET_TEXT_LIMITS у W4 (§3-бис.1). */
export const LIMITS = {
  name: 30,
  greeting: 300,
  suggestion: 80,
  suggestions: 3,
  pathMask: 200,
  pathMasks: 20,
  offsetMax: 200,
  consent: 1000,
  hosts: 50,
} as const;

/** z-index по умолчанию: ниже максимума на 647 — cookie-баннеры над кнопкой (§3-бис.3). */
export const Z_INDEX_DEFAULT = 2147483000;
export const Z_INDEX_MAX = 2147483647;

export interface Offset {
  x: number;
  y: number;
}

/** `WidgetConfig` без `hosts` — то, что отдаёт публичный конфиг. */
export interface ViewConfig {
  brand: {
    primaryColor: string;
    buttonTextColor: 'auto' | string;
    logoAssetId: string | null;
    avatar: { kind: 'icon'; icon: Icon } | { kind: 'asset'; assetId: string };
    launcherIcon: Icon;
    name: string;
    font: Font;
    preset: Preset;
    theme: Theme;
    poweredBy: boolean;
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

export interface HostRule {
  origin: string;
  pathMasks: string[];
  hideOn: string[];
}

export interface PublicConfig {
  status: 'active' | 'lead_only' | 'off';
  widgetVersion: number;
  config: ViewConfig;
  hosts: HostRule[];
  allowClientPreview: boolean;
  lead: {
    fields: Array<{ field: LeadField; required: boolean }>;
    consentText: Partial<Record<UiLang, string>>;
  };
  suggestedQuestions: string[];
  poweredByUrl: string | null;
  /** Э3: триггеры и лимиты навязчивости (engagement.ts) — разбирает iframe и чанк engage.js. */
  engagement: Engagement;
  /** Э3: активные цели с детекторами загрузчика (разбирает чанк engage.js). */
  goals: Goal[];
  /**
   * Э3: сырые `engagement`/`goals` для ленивого чанка engage.js — загрузчик
   * их НЕ разбирает (бюджет 12 КБ), только решает, нужен ли чанк.
   */
  rawEngagement: unknown;
  rawGoals: unknown;
  /** Э3: передача человеку (null — сервер Э2 или сбой у H). */
  handoff: HandoffInfo | null;
}

export function defaultViewConfig(): ViewConfig {
  return {
    brand: {
      primaryColor: '#1f5fd6',
      buttonTextColor: 'auto',
      logoAssetId: null,
      avatar: { kind: 'icon', icon: 'chat' },
      launcherIcon: 'chat',
      name: '',
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

export function defaultPublicConfig(): PublicConfig {
  return {
    status: 'active',
    widgetVersion: 0,
    config: defaultViewConfig(),
    hosts: [],
    allowClientPreview: false,
    lead: {
      fields: [
        { field: 'name', required: false },
        { field: 'phone', required: true },
      ],
      consentText: {},
    },
    suggestedQuestions: [],
    poweredByUrl: null,
    engagement: {
      triggers: [],
      perVisit: 1,
      excludedPaths: ALWAYS_EXCLUDED.slice(),
    },
    goals: [],
    rawEngagement: null,
    rawGoals: null,
    handoff: null,
  };
}

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function oneOf<T extends string>(
  list: readonly T[],
  v: unknown,
  fallback: T
): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

export function hex(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v : fallback;
}

export function intIn(
  v: unknown,
  min: number,
  max: number,
  fallback: number
): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
    ? v
    : fallback;
}

/** Строка как ДАННЫЕ: без управляющих символов, усечена по лимиту. */
export function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const clean = v.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    ''
  );
  return clean.length > max ? clean.slice(0, max) : clean;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function offset(v: unknown, fallback: Offset): Offset {
  if (!isObj(v)) return fallback;
  return {
    x: intIn(v.x, 0, LIMITS.offsetMax, fallback.x),
    y: intIn(v.y, 0, LIMITS.offsetMax, fallback.y),
  };
}

function masks(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const m of v.slice(0, LIMITS.pathMasks)) {
    const s = text(m, LIMITS.pathMask);
    if (s && s.charAt(0) === '/') out.push(s);
  }
  return out;
}

/** origin вида `https://shop.ua[:port]` — без пути, логина, query. */
export function cleanOrigin(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 300) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin === v ? v : null;
  } catch {
    return null;
  }
}

/**
 * Разбор `config` (вид без hosts) поверх базы: каждое поле — по своему
 * правилу, неизвестные ключи отбрасываются. Используется и для полного
 * конфига (база — умолчание), и для `preview(partial)` (база — текущий).
 * `mergeLook` — бренд и раскладка (всё, что рисует ЗАГРУЗЧИК: бюджет
 * 12 КБ, тексты чата ему не нужны), `mergeView` — плюс тексты (iframe).
 */
export function mergeLook(base: ViewConfig, raw: unknown): ViewConfig {
  const out: ViewConfig = JSON.parse(JSON.stringify(base));
  if (!isObj(raw)) return out;
  const b = raw.brand;
  if (isObj(b)) {
    const ob = out.brand;
    if ('primaryColor' in b)
      ob.primaryColor = hex(b.primaryColor, ob.primaryColor);
    if ('buttonTextColor' in b)
      ob.buttonTextColor =
        b.buttonTextColor === 'auto'
          ? 'auto'
          : hex(b.buttonTextColor, ob.buttonTextColor);
    if ('logoAssetId' in b)
      ob.logoAssetId =
        typeof b.logoAssetId === 'string' && ASSET_ID.test(b.logoAssetId)
          ? b.logoAssetId
          : null;
    if (isObj(b.avatar)) {
      const a = b.avatar;
      if (
        a.kind === 'asset' &&
        typeof a.assetId === 'string' &&
        ASSET_ID.test(a.assetId)
      )
        ob.avatar = { kind: 'asset', assetId: a.assetId };
      else if (a.kind === 'icon')
        ob.avatar = { kind: 'icon', icon: oneOf(ICONS, a.icon, 'chat') };
    }
    if ('launcherIcon' in b)
      ob.launcherIcon = oneOf(ICONS, b.launcherIcon, ob.launcherIcon);
    if ('name' in b) ob.name = text(b.name, LIMITS.name) ?? ob.name;
    if ('font' in b) ob.font = oneOf(FONTS, b.font, ob.font);
    if ('preset' in b) ob.preset = oneOf(PRESETS, b.preset, ob.preset);
    if ('theme' in b) ob.theme = oneOf(THEMES, b.theme, ob.theme);
    if ('poweredBy' in b) ob.poweredBy = bool(b.poweredBy, ob.poweredBy);
  }
  const l = raw.layout;
  if (isObj(l)) {
    const ol = out.layout;
    if ('position' in l)
      ol.position = oneOf(POSITIONS, l.position, ol.position);
    if (isObj(l.offset)) {
      ol.offset = {
        desktop: offset(l.offset.desktop, ol.offset.desktop),
        mobile: offset(l.offset.mobile, ol.offset.mobile),
      };
    }
    if ('zIndex' in l) ol.zIndex = intIn(l.zIndex, 0, Z_INDEX_MAX, ol.zIndex);
    if ('mobile' in l) ol.mobile = oneOf(MOBILE_MODES, l.mobile, ol.mobile);
    if ('launcher' in l)
      ol.launcher = oneOf(
        ['default', 'none'] as const,
        l.launcher,
        ol.launcher
      );
    if ('openAt' in l)
      ol.openAt = oneOf(['corner', 'center'] as const, l.openAt, ol.openAt);
    if ('avoidOverlap' in l)
      ol.avoidOverlap = bool(l.avoidOverlap, ol.avoidOverlap);
    if ('hideOnScrollMobile' in l)
      ol.hideOnScrollMobile = bool(l.hideOnScrollMobile, ol.hideOnScrollMobile);
  }
  return out;
}

/** Тексты приветствия и подсказок по языкам (только iframe). */
function mergeTexts(out: ViewConfig, raw: unknown): ViewConfig {
  if (!isObj(raw)) return out;
  if (isObj(raw.texts)) {
    for (const lang of UI_LANGS) {
      const t = raw.texts[lang];
      if (!isObj(t)) continue;
      const greeting = text(t.greeting, LIMITS.greeting) ?? '';
      const suggestions = Array.isArray(t.suggestions)
        ? t.suggestions
            .slice(0, LIMITS.suggestions)
            .map((s) => text(s, LIMITS.suggestion))
            .filter((s): s is string => !!s)
        : [];
      out.texts[lang] = { greeting, suggestions };
    }
  }
  return out;
}

export function mergeView(base: ViewConfig, raw: unknown): ViewConfig {
  return mergeTexts(mergeLook(base, raw), raw);
}

/**
 * Разбор ответа `GET /widget/v1/config` для ЗАГРУЗЧИКА: статус, хосты, вид
 * кнопки (бренд и раскладка), предпросмотр, вовлечение и цели. Форма лида,
 * тексты, подсказки и передача — только iframe (`parsePublicConfig`): в
 * бюджет загрузчика 12 КБ их разбор не входит, поля остаются умолчаниями.
 */
export function parseLoaderConfig(raw: unknown): PublicConfig {
  const d = defaultPublicConfig();
  if (!isObj(raw)) return d;
  d.status = oneOf(
    ['active', 'lead_only', 'off'] as const,
    raw.status,
    'active'
  );
  d.widgetVersion = intIn(raw.widgetVersion, 0, 1e9, 0);
  d.config = mergeLook(defaultViewConfig(), raw.config);
  if (Array.isArray(raw.hosts)) {
    for (const h of raw.hosts.slice(0, LIMITS.hosts)) {
      if (!isObj(h)) continue;
      const origin = cleanOrigin(h.origin);
      if (origin)
        d.hosts.push({
          origin,
          pathMasks: masks(h.pathMasks),
          hideOn: masks(h.hideOn),
        });
    }
  }
  d.allowClientPreview = raw.allowClientPreview === true;
  d.rawEngagement = raw.engagement;
  d.rawGoals = raw.goals;
  return d;
}

/** Строгий разбор ответа `GET /widget/v1/config` (поле `data` конверта) — iframe. */
export function parsePublicConfig(raw: unknown): PublicConfig {
  const d = parseLoaderConfig(raw);
  if (!isObj(raw)) return d;
  d.config = mergeView(d.config, raw.config);
  if (isObj(raw.lead)) {
    const lead = raw.lead;
    if (Array.isArray(lead.fields)) {
      const seen: string[] = [];
      const fields: PublicConfig['lead']['fields'] = [];
      for (const f of lead.fields) {
        if (!isObj(f)) continue;
        const field = oneOf(LEAD_FIELDS, f.field, 'name');
        if (f.field !== field || seen.includes(field)) continue;
        seen.push(field);
        fields.push({ field, required: f.required === true });
      }
      if (fields.length) d.lead.fields = fields;
    }
    if (isObj(lead.consentText)) {
      for (const lang of UI_LANGS) {
        const t = text(lead.consentText[lang], LIMITS.consent);
        if (t) d.lead.consentText[lang] = t;
      }
    }
  }
  if (Array.isArray(raw.suggestedQuestions)) {
    d.suggestedQuestions = raw.suggestedQuestions
      .slice(0, LIMITS.suggestions)
      .map((s) => text(s, LIMITS.suggestion))
      .filter((s): s is string => !!s);
  }
  if (
    typeof raw.poweredByUrl === 'string' &&
    /^https:\/\//.test(raw.poweredByUrl)
  ) {
    try {
      d.poweredByUrl = new URL(raw.poweredByUrl).href;
    } catch {
      d.poweredByUrl = null;
    }
  }
  d.handoff = parseHandoff(raw.handoff);
  d.engagement = parseEngagement(raw.engagement);
  d.goals = parseGoals(raw.goals);
  return d;
}

/**
 * `V4CAssist('preview', partial)` («к Л2»): те же правила по каждому полю,
 * `hosts` не принимается никогда (его в ViewConfig просто нет).
 */
export function applyPreviewPatch(
  base: ViewConfig,
  partial: unknown
): ViewConfig {
  return mergeView(base, partial);
}

/** То же для загрузчика: только бренд и раскладка кнопки (тексты рисует iframe). */
export function applyLookPatch(base: ViewConfig, partial: unknown): ViewConfig {
  return mergeLook(base, partial);
}

/** Относительная яркость WCAG 2.x для `#rrggbb`. */
export function luminance(h: string): number {
  const n = parseInt(h.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Цвет текста/иконки на основном цвете: `auto` — чёрный/белый, что контрастнее. */
export function onColor(primary: string, buttonText: 'auto' | string): string {
  // Заданный цвет — только если сам держит AA (4.5:1); иначе «авто». Сервер
  // уже затемнил (W4), это второй замок: чёрный/белый дают ≥ 4.58:1 для ЛЮБОГО фона.
  if (
    buttonText !== 'auto' &&
    HEX.test(buttonText) &&
    contrast(primary, buttonText) >= 4.5
  )
    return buttonText;
  return contrast(primary, '#ffffff') >= contrast(primary, '#000000')
    ? '#ffffff'
    : '#000000';
}

/** Маска пути `/catalog/*` (звёздочка — любые символы) против pathname. */
export function pathMatches(mask: string, path: string): boolean {
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < path.length) {
    if (i < mask.length && mask[i] === path[j]) {
      i++;
      j++;
    } else if (i < mask.length && mask[i] === '*') {
      star = i++;
      mark = j;
    } else if (star >= 0) {
      i = star + 1;
      j = ++mark;
    } else return false;
  }
  while (i < mask.length && mask[i] === '*') i++;
  return i === mask.length;
}

/**
 * Показывать ли виджет на этой странице: хост из списка опубликованных
 * (`hosts`), путь проходит маски, не попал в «скрыть на страницах».
 * Пустой `hosts` — сервер не дал списка (конфиг не получен/тестовый
 * ключ): решает iframe (frame-ancestors + сессия).
 */
export function shownOn(
  cfg: Pick<PublicConfig, 'hosts'>,
  origin: string,
  path: string,
  extraHideOn: string[]
): boolean {
  if (extraHideOn.some((m) => pathMatches(m, path))) return false;
  if (!cfg.hosts.length) return true;
  const h = cfg.hosts.find((x) => x.origin === origin);
  if (!h) return false;
  if (h.hideOn.some((m) => pathMatches(m, path))) return false;
  return !h.pathMasks.length || h.pathMasks.some((m) => pathMatches(m, path));
}
