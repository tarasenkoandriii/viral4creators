/**
 * Режим выпуска лендинга Story‑Tales — версионируемый конфиг в репозитории
 * (Р-STL-3/4 `doc/STORY-TALES-LANDING-ADAPTED.md`, ТЗ §5 и §11).
 *
 * До авторизованной настройки оператором (`GET /public/story-capabilities`
 * в backend — итерация 2, Р-STL-12) состояние страницы задаёт
 * `release.json` рядом: правка проходит ревью вместе с кодом, файлы
 * демо можно поменять без правки JSX. Здесь — форма конфига, проверка и
 * безопасный откат.
 *
 * ## Главное правило
 *
 * Любой сбой формы — неизвестный режим, лишний или пропущенный ключ,
 * материал без одобрения, внешний адрес, мастер на чужом хосте — даёт
 * **режим `prep`** (§5.1 ТЗ): без демо, без Play, без формы, без цены и
 * покупки. Нельзя молча направить человека в неработающий заказ (§5.4),
 * а «частично годный» конфиг — ровно такой путь. Поэтому проверка не
 * чинит и не выбрасывает отдельные поля, а отвергает конфиг целиком и
 * возвращает список причин (сборка печатает их, тест падает).
 *
 * ## Материалы (Р-STL-9, ST-LPL-11)
 *
 * Каждый публикуемый файл — запись с `approvalId`, источником и правами.
 * Адрес — только `/stories-media/…` этого же сайта (там его накрывает
 * `X-Robots-Tag`, Р-STL-6): внешние хосты, Vercel Blob и протокольно-
 * относительные `//…` запрещены. Забракованный Kling-образец (сессия
 * `benchmark-kling-…`, видео `e64cdbd5-…`) отвергается по любому из
 * признаков в любом строковом поле записи — не «этот один файл», а весь
 * его след: префиксы сессий бенчмарка и путь `sessions/` Blob.
 */
import { LEGAL_DOCS } from '../legal-content';
import { isLocale, locales, type Locale } from '../i18n';
import { isReachableOrigin } from '../site-origin';
import { entryReferralCode, isLandingEntry, normalizeBotUsername } from '../telegram-entry';
import raw from './release.json';

export const RELEASE_MODES = ['prep', 'pilot', 'wizard', 'commercial'] as const;
export type ReleaseMode = (typeof RELEASE_MODES)[number];

/** Публикуемый материал: демо-ролик, аудиоверсия, субтитры, транскрипт. */
export interface StoryMaterial {
  /** `/stories-media/<файл>` — только этот сайт. */
  url: string;
  /** Постер ролика (только у `demo`), тот же префикс. */
  posterUrl?: string;
  /** Язык речи/подписей. */
  locale: Locale;
  /** Фактическая длительность, секунды (у субтитров/транскрипта — ролика). */
  durationSec: number;
  title: string;
  /** Отрывок или полная история — подписывается на странице (§6.3). */
  excerpt: boolean;
  /** Чей голос: настоящая запись, штатный рассказчик, семейный синтез. */
  voiceOrigin: 'recorded' | 'stock-narrator' | 'family-synthetic';
  /** Идентификатор одобрения взрослым редактором (обязателен). */
  approvalId: string;
  /** Откуда материал (съёмка, автор, редакция истории). */
  source: string;
  /** На каком основании публикуется (разрешение, лицензия). */
  rights: string;
}

export type LegalLinkKind = 'offer' | 'terms' | 'privacy' | 'narratorConsent';

export interface StoryRelease {
  releaseMode: ReleaseMode;
  locales: Locale[];
  demo: StoryMaterial | null;
  audioDemo: StoryMaterial | null;
  captions: StoryMaterial | null;
  transcript: StoryMaterial | null;
  catalogEnabled: boolean;
  leadFormEnabled: boolean;
  wizardEnabled: boolean;
  checkoutEnabled: boolean;
  familyVoiceEnabled: boolean;
  syntheticVideoEnabled: boolean;
  wizardUrl: string | null;
  /** Вид ссылки → slug существующей страницы `/legal/<slug>`. */
  legalLinks: Partial<Record<LegalLinkKind, string>>;
  contentVersion: string;
}

/**
 * Безопасный режим: всё выключено. Им же заканчивается любая ошибка —
 * поэтому ссылки подвала здесь на общие документы платформы, которые
 * точно существуют (`/legal/offer`, `/legal/terms-of-use`).
 */
export const PREP_FALLBACK: Readonly<StoryRelease> = Object.freeze({
  releaseMode: 'prep',
  locales: [...locales],
  demo: null,
  audioDemo: null,
  captions: null,
  transcript: null,
  catalogEnabled: false,
  leadFormEnabled: false,
  wizardEnabled: false,
  checkoutEnabled: false,
  familyVoiceEnabled: false,
  syntheticVideoEnabled: false,
  wizardUrl: null,
  legalLinks: { offer: 'offer', terms: 'terms-of-use', privacy: 'terms-of-use' },
  contentVersion: 'fallback',
});

/**
 * Признаки забракованного Kling-образца и всего, что с ним связано
 * (исходник §2, Р-STL-9). Сверка без учёта регистра по каждому строковому
 * полю материала.
 */
export const BANNED_MATERIAL_TOKENS = [
  'kling',
  'benchmark-',
  'sessions/',
  'e64cdbd5-7364-40a8-927b-7c26c760a844',
] as const;

/** Единственный разрешённый вид адреса материала. */
const MEDIA_PATH_RE = /^\/stories-media\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const RELEASE_KEYS: ReadonlyArray<keyof StoryRelease> = [
  'releaseMode',
  'locales',
  'demo',
  'audioDemo',
  'captions',
  'transcript',
  'catalogEnabled',
  'leadFormEnabled',
  'wizardEnabled',
  'checkoutEnabled',
  'familyVoiceEnabled',
  'syntheticVideoEnabled',
  'wizardUrl',
  'legalLinks',
  'contentVersion',
];
const MATERIAL_KEYS = [
  'url',
  'posterUrl',
  'locale',
  'durationSec',
  'title',
  'excerpt',
  'voiceOrigin',
  'approvalId',
  'source',
  'rights',
] as const;
const MATERIAL_REQUIRED = MATERIAL_KEYS.filter((k) => k !== 'posterUrl');
/** Поля-адреса и идентификатор — только в них ищутся признаки Kling. */
const BANNED_TOKEN_FIELDS = ['url', 'posterUrl', 'approvalId'] as const;
const VOICE_ORIGINS = ['recorded', 'stock-narrator', 'family-synthetic'] as const;
const LEGAL_LINK_KINDS: readonly LegalLinkKind[] = ['offer', 'terms', 'privacy', 'narratorConsent'];
const BOOLEAN_KEYS = [
  'catalogEnabled',
  'leadFormEnabled',
  'wizardEnabled',
  'checkoutEnabled',
  'familyVoiceEnabled',
  'syntheticVideoEnabled',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Строка содержит признак забракованного материала. */
export function hasBannedToken(value: string): boolean {
  const lower = value.toLowerCase();
  return BANNED_MATERIAL_TOKENS.some((token) => lower.includes(token));
}

/** Адрес материала годен: только `/stories-media/…`, без `..`, `//`, запроса. */
export function isAllowedMediaPath(value: string): boolean {
  return MEDIA_PATH_RE.test(value) && !value.includes('..') && !hasBannedToken(value);
}

function validateMaterial(name: string, value: unknown, errors: string[]): void {
  if (value === null) return;
  if (!isRecord(value)) {
    errors.push(`${name}: ожидается объект материала или null`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!(MATERIAL_KEYS as readonly string[]).includes(key)) errors.push(`${name}.${key}: неизвестное поле`);
  }
  for (const key of MATERIAL_REQUIRED) {
    if (!(key in value)) errors.push(`${name}.${key}: обязательное поле`);
  }
  // Признаки забракованного образца ищутся только в адресах и в
  // идентификаторе одобрения — там, где они означают сам файл. В
  // свободном тексте (`title`, `source`, `rights`) их не ищем: немецкое
  // «So klingt Oma» — не Kling, а отказ всего конфига из-за названия был
  // бы ложной тревогой (находка S3-2 аудита 16.10).
  for (const key of BANNED_TOKEN_FIELDS) {
    const field = value[key];
    if (typeof field === 'string' && hasBannedToken(field)) {
      errors.push(`${name}.${key}: запрещённый материал (забракованный образец/сессия бенчмарка)`);
    }
  }
  if (typeof value.url !== 'string' || !isAllowedMediaPath(value.url)) {
    errors.push(`${name}.url: только /stories-media/… этого сайта`);
  }
  if ('posterUrl' in value) {
    if (name !== 'demo') errors.push(`${name}.posterUrl: постер бывает только у demo`);
    if (typeof value.posterUrl !== 'string' || !isAllowedMediaPath(value.posterUrl)) {
      errors.push(`${name}.posterUrl: только /stories-media/… этого сайта`);
    }
  }
  if (typeof value.locale !== 'string' || !isLocale(value.locale)) errors.push(`${name}.locale: не локаль лендинга`);
  if (typeof value.durationSec !== 'number' || !Number.isFinite(value.durationSec) || value.durationSec <= 0) {
    errors.push(`${name}.durationSec: положительное число секунд`);
  }
  for (const key of ['title', 'approvalId', 'source', 'rights'] as const) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
      errors.push(`${name}.${key}: непустая строка`);
    }
  }
  if (typeof value.excerpt !== 'boolean') errors.push(`${name}.excerpt: true/false`);
  if (!(VOICE_ORIGINS as readonly unknown[]).includes(value.voiceOrigin)) {
    errors.push(`${name}.voiceOrigin: одно из ${VOICE_ORIGINS.join(', ')}`);
  }
}

export interface WizardHosts {
  /** Адрес TMA (`NEXT_PUBLIC_TMA_URL`). */
  tmaUrl: string;
  /** Имя бота (`NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`). */
  botUsername: string | null;
}

/** Фрагменты (hash-маршруты TMA), с которыми может открываться мастер. */
export const WIZARD_HASH_ROUTES = ['#/stories', '#/projects/new'] as const;

/**
 * `startapp` — только в формате входа с лендинга
 * (`frontend/src/lib/start-param.ts`): `e_<метка>` или
 * `e_<метка>__r_<КОД>`, метка — из закрытого списка `LANDING_ENTRIES`.
 */
export function isEntryStartParam(value: string): boolean {
  const m = /^e_([a-z-]+)(?:__r_([A-Z0-9]{8}))?$/.exec(value);
  if (!m || !isLandingEntry(m[1])) return false;
  return m[2] === undefined || entryReferralCode(m[2]) === m[2];
}

/**
 * Адрес мастера — только TMA этого продукта (находка S3-1 аудита 16.10):
 *
 *  - `https://<origin TMA_URL>/` — тот же origin, что `TMA_URL` (и это не
 *    localhost-дефолт), путь — только `/`; запрос — не больше одного
 *    `entry`, значение — из `LANDING_ENTRIES`; фрагмент — пустой или из
 *    `WIZARD_HASH_ROUTES`;
 *  - `https://t.me/<наш бот>/app` — запрос — не больше одного
 *    `startapp` в формате `isEntryStartParam`, без фрагмента.
 *
 * Логина/пароля, порта, лишних параметров, пути и «хвостов» во фрагменте
 * нет: персональным данным в URL места нет (§4 ТЗ, ST-LPL-07).
 * Проверяется на сборке; флаги покупки/создания позже подтверждает
 * backend (итерация 2), не браузер.
 */
export function isAllowedWizardUrl(raw: unknown, hosts: WizardHosts): raw is string {
  if (typeof raw !== 'string' || hasBannedToken(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const keys = [...url.searchParams.keys()];
  if (url.hostname === 't.me') {
    const bot = normalizeBotUsername(hosts.botUsername);
    if (!bot || url.pathname !== `/${bot}/app` || url.hash) return false;
    if (keys.some((k) => k !== 'startapp') || keys.length > 1) return false;
    const start = url.searchParams.get('startapp');
    return start === null || isEntryStartParam(start);
  }
  if (!isReachableOrigin(hosts.tmaUrl)) return false;
  let tma: URL;
  try {
    tma = new URL(hosts.tmaUrl);
  } catch {
    return false;
  }
  if (tma.protocol !== 'https:' || url.origin !== tma.origin || url.pathname !== '/') return false;
  if (keys.some((k) => k !== 'entry') || keys.length > 1) return false;
  const entry = url.searchParams.get('entry');
  if (entry !== null && !isLandingEntry(entry)) return false;
  return url.hash === '' || (WIZARD_HASH_ROUTES as readonly string[]).includes(url.hash);
}

export interface ParsedRelease {
  config: StoryRelease;
  /** Пусто — конфиг принят как есть; иначе `config` — `PREP_FALLBACK`. */
  errors: string[];
}

/**
 * Проверка формы конфига. Невалидный → `PREP_FALLBACK` и список причин.
 * Согласованность флагов (мастер без адреса, покупка без мастера, пилот
 * без демо) — НЕ ошибка формы: её разрешает `resolveStoryView`
 * (`cta.ts`), опуская режим до того, который действительно может работать.
 */
export function parseStoryRelease(value: unknown, hosts: WizardHosts): ParsedRelease {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { config: PREP_FALLBACK as StoryRelease, errors: ['конфиг: ожидается объект'] };
  }
  for (const key of Object.keys(value)) {
    if (!(RELEASE_KEYS as readonly string[]).includes(key)) errors.push(`${key}: неизвестное поле`);
  }
  for (const key of RELEASE_KEYS) {
    if (!(key in value)) errors.push(`${key}: обязательное поле`);
  }
  if (!(RELEASE_MODES as readonly unknown[]).includes(value.releaseMode)) {
    errors.push(`releaseMode: одно из ${RELEASE_MODES.join(', ')}`);
  }
  // Пять локалей с одинаковой полнотой (решение 16.10): конфиг не может
  // «выключить» язык — hreflang и переключатель указывают на все пять.
  if (
    !Array.isArray(value.locales) ||
    value.locales.length !== locales.length ||
    !locales.every((l) => (value.locales as unknown[]).includes(l))
  ) {
    errors.push(`locales: ровно ${locales.join(', ')}`);
  }
  for (const name of ['demo', 'audioDemo', 'captions', 'transcript'] as const) {
    validateMaterial(name, value[name], errors);
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof value[key] !== 'boolean') errors.push(`${key}: true/false`);
  }
  if (value.wizardUrl !== null && !isAllowedWizardUrl(value.wizardUrl, hosts)) {
    errors.push('wizardUrl: только TMA этого продукта (TMA_URL или t.me/<бот>/app) или null');
  }
  if (!isRecord(value.legalLinks)) {
    errors.push('legalLinks: объект «вид → slug»');
  } else {
    const slugs = LEGAL_DOCS.map((d) => d.slug);
    for (const [kind, slug] of Object.entries(value.legalLinks)) {
      if (!(LEGAL_LINK_KINDS as readonly string[]).includes(kind)) errors.push(`legalLinks.${kind}: неизвестный вид`);
      // Пустых заглушек нет (§6.11): только существующие `/legal/<slug>`.
      if (typeof slug !== 'string' || !slugs.includes(slug)) {
        errors.push(`legalLinks.${kind}: нет страницы /legal/${String(slug)}`);
      }
    }
    for (const kind of ['offer', 'terms', 'privacy'] as const) {
      if (!(kind in value.legalLinks)) errors.push(`legalLinks.${kind}: обязательная ссылка подвала`);
    }
  }
  if (typeof value.contentVersion !== 'string' || !value.contentVersion.trim()) {
    errors.push('contentVersion: непустая строка');
  }
  if (errors.length) return { config: PREP_FALLBACK as StoryRelease, errors };
  return { config: value as unknown as StoryRelease, errors };
}

/** Сырой конфиг репозитория — для тестов (тот же объект, что ниже проверен). */
export const STORY_RELEASE_RAW: unknown = raw;

/**
 * Проверенный конфиг страницы. Ошибки печатаются при сборке/рендере —
 * страница при этом НЕ падает (ST-LPL-09: сбой конфигурации не оставляет
 * белый экран), а уходит в `prep`. Тест `scripts/stories-release.test.ts`
 * требует, чтобы конфиг репозитория был принят без ошибок.
 */
export function loadStoryRelease(hosts: WizardHosts): StoryRelease {
  const { config, errors } = parseStoryRelease(raw, hosts);
  if (errors.length) {
    console.warn(`[stories] release.json отвергнут, режим prep: ${errors.join('; ')}`);
  }
  return config;
}
