/**
 * Story‑Tales, проход 3: пилот по приглашению, цена в кредитах,
 * публикация по ссылке и срок хранения. Чистая логика без React и сети —
 * проверяется `scripts/story-pilot.test.ts`. Сервер — источник истины:
 * здесь только разбор ответов по контракту (бриф ST3, «Контракт API») и
 * тексты из словаря `storyTales` выбранного языка интерфейса.
 */
import type { Dictionary } from '../../lib/get-dictionary';
import { INTL_LOCALE } from '../../lib/intl-locale';
import type { StoryConfirmText } from './story-confirm';

export type StoryTalesStrings = Dictionary['storyTales'];
export type StoryUiStrings = Dictionary['storyUi'];

// ── Доступ (`GET /story-gifts/access`) ────────────────────────────────

export type StoryMode = 'owner' | 'pilot' | 'public';
export type StoryAccessReason =
  | 'closed'
  | 'not_invited'
  | 'application_pending'
  | 'terms_required'
  | 'pilot_revoked';
export type StoryApplication = {
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
};
export type StoryAccess = {
  mode: StoryMode;
  allowed: boolean;
  role: 'owner' | 'member' | 'user' | 'revoked' | null;
  reason?: StoryAccessReason;
  /** Отозванный участник: свои сказки — только просмотр, скачивание, удаление. */
  readOnly?: boolean;
  application?: StoryApplication;
  freeGiftAvailable: boolean;
  termsVersion: string;
  seatsLeft?: number;
  /** Необязательно: если сервер сообщает лимит пилота — «до N семей». */
  maxMembers?: number;
};

const MODES: readonly StoryMode[] = ['owner', 'pilot', 'public'];
const REASONS: readonly StoryAccessReason[] = [
  'closed',
  'not_invited',
  'application_pending',
  'terms_required',
  'pilot_revoked',
];

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Ответ сервера → `StoryAccess`. Неизвестный режим или пустой ответ —
 * «закрыто»: ошибка разбора не должна открывать раздел.
 */
export function parseStoryAccess(raw: unknown): StoryAccess {
  const closed: StoryAccess = {
    mode: 'owner',
    allowed: false,
    role: null,
    reason: 'closed',
    freeGiftAvailable: false,
    termsVersion: '',
  };
  if (!raw || typeof raw !== 'object') return closed;
  const r = raw as Record<string, unknown>;
  if (!MODES.includes(r.mode as StoryMode)) return closed;
  const app = r.application as Record<string, unknown> | undefined;
  const application =
    app &&
    typeof app === 'object' &&
    ['pending', 'approved', 'rejected'].includes(app.status as string)
      ? {
          status: app.status as StoryApplication['status'],
          createdAt: typeof app.createdAt === 'string' ? app.createdAt : '',
        }
      : undefined;
  const seatsLeft = num(r.seatsLeft);
  const maxMembers = num(r.maxMembers);
  return {
    mode: r.mode as StoryMode,
    allowed: r.allowed === true,
    role: ['owner', 'member', 'user', 'revoked'].includes(r.role as string)
      ? (r.role as StoryAccess['role'])
      : null,
    ...(REASONS.includes(r.reason as StoryAccessReason)
      ? { reason: r.reason as StoryAccessReason }
      : {}),
    ...(application ? { application } : {}),
    ...(r.readOnly === true ? { readOnly: true } : {}),
    freeGiftAvailable: r.freeGiftAvailable === true,
    termsVersion: typeof r.termsVersion === 'string' ? r.termsVersion : '',
    ...(seatsLeft !== undefined ? { seatsLeft } : {}),
    ...(maxMembers !== undefined ? { maxMembers } : {}),
  };
}

/** Какой экран показать на `#/stories`. */
export type StoryAccessView =
  | 'allowed'
  | 'readonly'
  | 'closed'
  | 'apply'
  | 'full'
  | 'pending'
  | 'rejected'
  | 'terms';

export function storyAccessView(a: StoryAccess): StoryAccessView {
  if (a.allowed) return 'allowed';
  // ST3-U-01: отозванный участник — свои сказки только для чтения
  // (просмотр, скачивание, удаление до конца срока хранения).
  if (a.readOnly || a.reason === 'pilot_revoked' || a.role === 'revoked')
    return a.mode === 'owner' ? 'closed' : 'readonly';
  // Режим владельца: раздела для остальных нет (404-заглушка).
  if (a.mode === 'owner') return 'closed';
  switch (a.reason) {
    case 'terms_required':
      return 'terms';
    case 'application_pending':
      return 'pending';
    case 'not_invited':
      // Заявка — только в пилоте (в `public` такой причины быть не должно).
      if (a.mode !== 'pilot') return 'closed';
      if (a.application?.status === 'pending') return 'pending';
      if (a.application?.status === 'rejected') return 'rejected';
      return a.seatsLeft === 0 ? 'full' : 'apply';
    default:
      return 'closed';
  }
}

/**
 * Владелец видит внутренние инструменты (разбор референсов, реестр
 * редакций, образы рассказчика) и суммы резерва провайдеров; остальным —
 * только цена в кредитах (ST3-U-03, U-07). Вне провайдера — режим владельца.
 */
export function storyIsOwner(a: StoryAccess | null | undefined): boolean {
  return !a || a.role === 'owner';
}

/** Вкладка «Story‑Tales» в навигации: везде, кроме «раздела нет». */
export function storyNavVisible(view: StoryAccessView | null): boolean {
  return view !== null && view !== 'closed';
}

/** Публикация по ссылке есть только в пилоте и открытом режиме. */
export function storySharingEnabled(mode: StoryMode | null | undefined) {
  return mode === 'pilot' || mode === 'public';
}

/** Правила Story‑Tales в `#/legal/…` (слаг согласован с пакетом LEGAL). */
export const STORY_RULES_SLUG = 'story-tales-rules';

export const STORY_SCENARIO_MAX = 500;

/** Текст сценария заявки: пробелы схлопнуты, длина ≤ 500. */
export function storyScenario(
  text: string,
  t: StoryTalesStrings
): { value: string; length: number; error: string | null } {
  const value = text.replace(/\s+/g, ' ').trim();
  return {
    value,
    length: value.length,
    error:
      value.length > STORY_SCENARIO_MAX
        ? fill(t.access.scenarioTooLong, { max: STORY_SCENARIO_MAX })
        : null,
  };
}

/** Тело `POST /story-gifts/pilot/apply`: пустой сценарий не отправляется. */
export function storyApplyBody(text: string): { scenario?: string } {
  const value = text.replace(/\s+/g, ' ').trim();
  return value ? { scenario: value.slice(0, STORY_SCENARIO_MAX) } : {};
}

/** Тело `POST /story-gifts/terms/accept` — только при обоих флажках. */
export function storyTermsBody(
  termsVersion: string,
  adult: boolean,
  agreed: boolean
): { termsVersion: string; adult: true } | null {
  return adult && agreed && termsVersion ? { termsVersion, adult: true } : null;
}

// ── Тексты, числа, даты ───────────────────────────────────────────────

/** `{{key}}` → значение. */
export function fill(
  template: string,
  vars: Record<string, string | number>
): string {
  // ST3-U-10: дата «18 января 2027 г.» перед точкой шаблона не даёт «г..».
  return template.replace(
    /\{\{(\w+)\}\}(\.?)/g,
    (m, k: string, dot: string) => {
      if (!(k in vars)) return m;
      const v = String(vars[k]);
      return v + (dot && v.endsWith('.') ? '' : dot);
    }
  );
}

/** Числовая форма по `Intl.PluralRules` (у en/de/es — только one/other). */
export function plural(
  forms: Partial<Record<Intl.LDMLPluralRule, string>>,
  n: number,
  locale: string
): string {
  const rule = new Intl.PluralRules(INTL_LOCALE[locale] ?? 'ru-RU').select(n);
  return fill(forms[rule] ?? forms.other ?? '', { n });
}

/** Дата для человека: «20 октября 2026 г.» / «October 20, 2026». */
export function formatStoryDate(
  iso: string | null | undefined,
  locale: string
) {
  const ts = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(ts)) return '';
  return new Date(ts).toLocaleDateString(INTL_LOCALE[locale] ?? 'ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

/** Доллары эквивалента: «$2.99». */
export function formatChargeUsd(usd: number): string {
  return `$${(Math.round(usd * 100) / 100).toFixed(2)}`;
}

// ── Цена (`charge` сметы) ─────────────────────────────────────────────

export type StoryCharge = {
  credits: number;
  usdEquivalent: number;
  free: boolean;
};

/** `charge` из ответа сметы/подарка (`x.charge`, иначе `x.estimate.charge`). */
export function storyChargeOf(source: unknown): StoryCharge | null {
  if (!source || typeof source !== 'object') return null;
  const s = source as { charge?: unknown; estimate?: { charge?: unknown } };
  const raw = (s.charge ?? s.estimate?.charge) as
    | Record<string, unknown>
    | null
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const credits = num(raw.credits);
  if (credits === undefined || credits < 0) return null;
  return {
    credits,
    usdEquivalent: num(raw.usdEquivalent) ?? 0,
    free: raw.free === true,
  };
}

/** Есть ли что подтверждать: списание кредитов или первая бесплатная. */
export function storyChargeNeedsConfirm(c: StoryCharge | null): boolean {
  return !!c && (c.free || c.credits > 0);
}

/** Строка цены до запуска. */
export function storyChargeLine(
  c: StoryCharge,
  t: StoryTalesStrings,
  locale: string
): string {
  if (c.free) return t.charge.free;
  if (c.credits <= 0) return t.charge.none;
  return fill(t.charge.paid, {
    credits: plural(t.charge.credits, c.credits, locale),
    usd: formatChargeUsd(c.usdEquivalent),
  });
}

/** Абзацы о цене для подтверждения запуска (пусто, если не списывается). */
export function storyChargeParagraphs(
  c: StoryCharge | null,
  t: StoryTalesStrings,
  locale: string
): string[] {
  if (!c) return [];
  if (c.free) return [t.charge.confirmFree];
  if (c.credits <= 0) return [];
  return [
    fill(t.charge.confirmPaid, {
      credits: plural(t.charge.credits, c.credits, locale),
      usd: formatChargeUsd(c.usdEquivalent),
    }),
    t.charge.note,
  ];
}

/** Подтверждение платного запуска сборки (существующий `StoryConfirm`). */
export function storyChargeConfirm(
  c: StoryCharge,
  t: StoryTalesStrings,
  locale: string,
  extra: string[] = []
): StoryConfirmText {
  return {
    // ST3-U-10: бесплатная сборка не называется «платной».
    title: c.free ? t.charge.confirmTitleFree : t.charge.confirmTitle,
    body: [...storyChargeParagraphs(c, t, locale), ...extra],
    items: [],
    confirmLabel: t.charge.confirmButton,
    danger: false,
  };
}

// ── Ошибки по контракту ───────────────────────────────────────────────

type ErrLike = {
  response?: {
    status?: number;
    data?: {
      error?: {
        details?: Record<string, unknown> | null;
        required?: unknown;
        balance?: unknown;
      };
      required?: unknown;
      balance?: unknown;
    };
  };
};

/**
 * Машинный код отказа — только `error.details.code` (его пробрасывает
 * `HttpExceptionFilter`); `error.code` конверта — общий код статуса.
 */
export function storyCode(e: unknown): string | null {
  const code = (e as ErrLike | null)?.response?.data?.error?.details?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * 402 `STORY_CREDITS_REQUIRED` → `{required, balance}`. Числа ищутся в
 * `error.details` (их пробрасывает `HttpExceptionFilter`), затем в самом
 * `error` и в корне ответа; если чисел нет — `null` вместо них.
 */
export function storyCreditsRequired(
  e: unknown
): { required: number | null; balance: number | null } | null {
  const res = (e as ErrLike | null)?.response;
  if (!res) return null;
  const code = storyCode(e);
  if (code !== 'STORY_CREDITS_REQUIRED' && !(res.status === 402 && !code))
    return null;
  const err = res.data?.error;
  const pick = (k: 'required' | 'balance') =>
    num(err?.details?.[k]) ?? num(err?.[k]) ?? num(res.data?.[k]) ?? null;
  return { required: pick('required'), balance: pick('balance') };
}

export function storyCreditsRequiredText(
  info: { required: number | null; balance: number | null },
  t: StoryTalesStrings,
  locale: string,
  fallbackBalance?: number | null
): string {
  const balance = info.balance ?? fallbackBalance ?? null;
  if (info.required === null || balance === null)
    return t.charge.requiredUnknown;
  return fill(t.charge.required, {
    required: plural(t.charge.credits, info.required, locale),
    balance: plural(t.charge.credits, balance, locale),
  });
}

/**
 * Валидатор обещаний (`STORY_PROMISE_*`) и мягкие подсказки
 * (`STORY_HINT_*`) — на языке интерфейса по коду; сервер присылает их
 * по-русски. Неизвестный код — текст сервера как есть.
 */
export function storyPromiseText(
  code: string | null | undefined,
  serverMessage: string,
  t: StoryTalesStrings
): string {
  const map = t.promise as Record<string, string>;
  return (code && map[code]) || serverMessage;
}

// ── Публикация по ссылке ──────────────────────────────────────────────

export type StoryShare = { url: string; expiresAt: string | null };

/** Ответ `POST /story-gifts/:id/share` → ссылка и срок. */
export function parseStoryShare(raw: unknown): StoryShare | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { url?: unknown; expiresAt?: unknown };
  if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) return null;
  return {
    url: r.url,
    expiresAt: typeof r.expiresAt === 'string' ? r.expiresAt : null,
  };
}

/** Тело публикации: только после подтверждения текста §11.3. */
export const STORY_SHARE_BODY = { acknowledgePublic: true } as const;

/**
 * Карточка (`GET :id`) требует отдельного согласия рассказчика на
 * публичную ссылку (его голос или образ звучит в сказке).
 */
export function storyNarratorConsentRequired(gift: unknown): boolean {
  return (
    (gift as { narratorPublicConsentRequired?: unknown } | null)
      ?.narratorPublicConsentRequired === true
  );
}

/**
 * ST3-U-15: согласие рассказчика нужно и ещё не дано для текущей
 * одобренной сборки (поле BE `narratorPublicConsentPending` в `GET :id`).
 * Только оно включает просьбу о согласии при действующей ссылке;
 * `narratorPublicConsentRequired` — для первой выдачи ссылки.
 */
export function storyNarratorConsentPending(gift: unknown): boolean {
  return (
    (gift as { narratorPublicConsentPending?: unknown } | null)
      ?.narratorPublicConsentPending === true
  );
}

/** Тело `POST :id/share`; согласие рассказчика — только когда требуется. */
export function storyShareBody(
  narratorConsentRequired: boolean
):
  | { acknowledgePublic: true }
  | { acknowledgePublic: true; narratorPublicConsent: true } {
  return narratorConsentRequired
    ? { ...STORY_SHARE_BODY, narratorPublicConsent: true }
    : { ...STORY_SHARE_BODY };
}

/** Кнопка «Получить ссылку»: режим с публикацией + одобренный выпуск. */
export function storyCanShare(
  mode: StoryMode | null | undefined,
  status: string
): boolean {
  return storySharingEnabled(mode) && status === 'APPROVED';
}

type ShareFields = {
  share?: { expiresAt?: unknown } | null;
  shareExpiresAt?: unknown;
  retention?: { shareExpiresAt?: unknown } | null;
};
const SHARE_KEYS = ['share', 'shareExpiresAt'] as const;

/**
 * Конец действующей публичной ссылки из карточки: `retention.shareExpiresAt`
 * (только активная), `share.expiresAt` или `shareExpiresAt` строки. Истёкшая
 * ссылка — `null`: после срока можно получить новую.
 */
export function storySharedUntil(
  gift: unknown,
  now: number = Date.now()
): string | null {
  const g = (gift ?? {}) as ShareFields;
  for (const v of [
    g.retention?.shareExpiresAt,
    g.share?.expiresAt,
    g.shareExpiresAt,
  ]) {
    if (typeof v === 'string' && Date.parse(v) > now) return v;
  }
  return null;
}

/** Сообщает ли карточка состояние публикации (даже если ссылки нет). */
export function storyShareKnown(gift: unknown): boolean {
  if (!gift || typeof gift !== 'object') return false;
  const g = gift as ShareFields;
  return (
    SHARE_KEYS.some((k) => k in g) ||
    (!!g.retention &&
      typeof g.retention === 'object' &&
      'shareExpiresAt' in g.retention)
  );
}

export function storyShareConfirm(
  t: StoryTalesStrings,
  narratorConsentRequired = false
): StoryConfirmText {
  return {
    title: t.share.title,
    body: [t.share.body],
    items: [],
    note: t.share.note,
    confirmLabel: t.share.confirm,
    danger: false,
    ...(narratorConsentRequired
      ? { requiredCheck: t.share.narratorConsent }
      : {}),
  };
}

export function storyUnshareConfirm(t: StoryTalesStrings): StoryConfirmText {
  return {
    title: t.share.unshareTitle,
    body: [t.share.unshareBody],
    items: [],
    confirmLabel: t.share.unshare,
    danger: true,
  };
}

// ── Срок хранения ─────────────────────────────────────────────────────

export type StoryRetention = {
  purgeAt: string | null;
  warning: boolean;
  /** `published` — раньше удаления закончится публичная ссылка. */
  basis?: 'unfinished' | 'finished' | 'published' | null;
};

export function storyRetentionOf(gift: unknown): StoryRetention | null {
  const r = (gift as { retention?: unknown } | null)?.retention as
    | Record<string, unknown>
    | null
    | undefined;
  if (!r || typeof r !== 'object') return null;
  return {
    purgeAt: typeof r.purgeAt === 'string' ? r.purgeAt : null,
    warning: r.warning === true,
    basis: ['unfinished', 'finished', 'published'].includes(r.basis as string)
      ? (r.basis as StoryRetention['basis'])
      : null,
  };
}

/** Предупреждение «будет удалено <дата>» — только при `warning` и дате. */
export function storyRetentionWarning(
  gift: unknown,
  t: StoryTalesStrings,
  locale: string
): { title: string; badge: string; body: string; link: boolean } | null {
  const r = storyRetentionOf(gift);
  if (!r?.warning) return null;
  const date = formatStoryDate(r.purgeAt, locale);
  if (!date) return null;
  // Раньше удаления закончится публичная ссылка: удаляется не сказка.
  if (r.basis === 'published')
    return {
      title: t.retention.linkTitle,
      badge: fill(t.retention.linkBadge, { date }),
      body: fill(t.retention.linkBody, { date }),
      link: true,
    };
  return {
    title: t.retention.title,
    badge: fill(t.retention.badge, { date }),
    body: fill(t.retention.body, { date }),
    link: false,
  };
}

// ── Ответы сервера на языке интерфейса (ST3-U-05) ─────────────────────

const CYRILLIC = /[А-Яа-яЁёІіЇїЄєҐґ]/;

/**
 * Текст, пришедший с сервера (он пишет по-русски). В интерфейсе ru — как
 * есть; в остальных языках кириллица заменяется локализованным запасным
 * текстом — русской строки в uk/en/de/es быть не должно.
 */
export function storyServerText(
  text: string | null | undefined,
  locale: string,
  fallback: string
): string {
  if (!text) return fallback;
  return locale === 'ru' || !CYRILLIC.test(text) ? text : fallback;
}

/** Препятствия сметы видео (сервер присылает их текстом без кода). */
export function storyBlockerText(
  text: string,
  s: StoryUiStrings,
  locale: string
): string {
  if (locale === 'ru') return text;
  if (!CYRILLIC.test(text)) return text;
  const b = s.blockers;
  if (/^Нужно подтверждение согласия/.test(text)) return b.consent;
  if (/^Часть речи этого голоса/.test(text)) return b.busy;
  if (/^Пилот: три сборки/.test(text)) return b.daily;
  if (/^Оставшегося бюджета/.test(text)) return b.budget;
  const long = /^Итог .*?([\d.,]+) с — длиннее (\d+) с/.exec(text);
  if (long) return fill(b.tooLong, { seconds: long[1], max: long[2] });
  return b.other;
}

/** 409 `STORY_PRICE_CHANGED` → новая цена из `error.details.charge`. */
export function storyPriceChanged(
  e: unknown
): { charge: StoryCharge | null } | null {
  if (storyCode(e) !== 'STORY_PRICE_CHANGED') return null;
  const details = (
    e as { response?: { data?: { error?: { details?: unknown } } } }
  ).response?.data?.error?.details;
  return { charge: storyChargeOf(details) };
}

/** Коды, после которых нужно перечитать доступ (экран правил / read-only). */
export function storyAccessCode(e: unknown): boolean {
  const code = storyCode(e);
  return (
    code === 'STORY_TERMS_REQUIRED' ||
    code === 'STORY_TERMS_OUTDATED' ||
    code === 'STORY_PILOT_REVOKED'
  );
}

// ── Язык ответов сервера Story (согласия, права каталога) ─────────────

/**
 * Сервер Story отдаёт тексты (согласия на голос и запись, права каталога)
 * только на ru/uk/en, иначе en. Язык берётся из `Accept-Language`, а браузер
 * шлёт свой — поэтому запросы Story явно несут язык интерфейса; de/es → en.
 */
export function storyAcceptLanguage(locale: string): 'ru' | 'uk' | 'en' {
  return locale === 'ru' || locale === 'uk' ? locale : 'en';
}

/** Запрос относится к Story‑Tales (`/story-gifts…`, `/story-gift/…`, `/public/story-…`). */
export function isStoryApiPath(url: string | null | undefined): boolean {
  if (!url) return false;
  const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api(?=\/)/, '');
  return /^\/?(story-gifts?(\/|$|\?)|public\/story-)/.test(path);
}
