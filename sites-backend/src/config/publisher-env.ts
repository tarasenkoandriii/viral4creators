/**
 * Переменные окружения AI Publisher (P-A0, проектный документ §5.4) — одно
 * место чтения:
 *
 *  - `PUBLISHER_PUBLIC_DATABASE_URL` — строка логин-роли в `publisher_public`
 *    (клиент PublisherPublicDb). Без неё публичный приём закрыт (503),
 *    кабинет работает — это не ошибка старта.
 *  - `PUBLISHER_AI_ALLOW_UNEVALUATED=true` — разрешает AI-вызовы
 *    неоценённых конфигураций (разработка, Р-PUB-16). Правило двух условий,
 *    как у `SITES_DEV_FAKE_GEMINI`: действует только вне production, а в
 *    production — ошибка конфигурации (старт падает).
 *  - `PUBLISHER_BACKUP_DISABLED=true` — крон экспорта пропускает копию с
 *    предупреждением (стенды без Vercel Blob).
 *  - `PUBLISHER_SITE_URL` + `PUBLISHER_REVALIDATE_SECRET` — адрес сайта
 *    продукта (`publisher-site`, только https-origin) и его секрет
 *    `POST /api/revalidate` (Р-PUB-Z2-8): после снятия материала и закрытия
 *    гейта `public_publish` задание `site-revalidate` сбрасывает кэш сайта.
 *    Без них — no-op с предупреждением в журнале (окно ISR ≤ 300 с).
 *  - `PUBLISHER_STAND_CLOCK=true`, `PUBLISHER_STAND_BACKUP_DIR=<путь>` —
 *    только стенд E2E (ниже, Р-PUB-Z2-21/22): вне `development|test` и на
 *    Vercel игнорируются с предупреждением.
 */

export const PUBLISHER_AI_ALLOW_UNEVALUATED_ENV =
  'PUBLISHER_AI_ALLOW_UNEVALUATED';
export const PUBLISHER_BACKUP_DISABLED_ENV = 'PUBLISHER_BACKUP_DISABLED';
export const PUBLISHER_PUBLIC_DATABASE_URL_ENV =
  'PUBLISHER_PUBLIC_DATABASE_URL';

function flag(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === 'true';
}

/** Флаг неоценённых конфигураций запрошен (без учёта окружения). */
export function publisherAiUnevaluatedRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flag(env[PUBLISHER_AI_ALLOW_UNEVALUATED_ENV]);
}

/** Действует: флаг И не production (гейт `ai_use` его читает, P-B2). */
export function publisherAiUnevaluatedAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return publisherAiUnevaluatedRequested(env) && env.NODE_ENV !== 'production';
}

/** Ошибка конфигурации: флаг неоценённых конфигураций в production. */
export function publisherAiUnevaluatedProblem(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return publisherAiUnevaluatedRequested(env) && env.NODE_ENV === 'production'
    ? `${PUBLISHER_AI_ALLOW_UNEVALUATED_ENV} задана в production — неоценённые AI-конфигурации только для разработки (Р-PUB-16)`
    : null;
}

/** Экспорт резервных копий выключен (стенд без Blob). */
export function publisherBackupDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flag(env[PUBLISHER_BACKUP_DISABLED_ENV]);
}

// ── Стенд сквозных маршрутов (Р-PUB-Z2-21/22) ─────────────────────────────
//
// Подменяемые часы и локальное хранилище копий — ТОЛЬКО для стенда E2E
// (`scripts/publisher-e2e.sh`). Правило строже, чем у флага неоценённых
// AI-конфигураций: действуют, только когда запрошены И `NODE_ENV` ровно
// `development` или `test` И процесс не на Vercel (`VERCEL` не задан —
// Vercel ставит его в каждой сборке и функции, включая preview). В любом
// другом окружении запрос игнорируется (часы системные, копии — Blob), а
// причина уходит предупреждением в журнал — старт не падает: стенд не
// должен ронять прод, если переменная случайно попала в настройки.

export const PUBLISHER_STAND_CLOCK_ENV = 'PUBLISHER_STAND_CLOCK';
export const PUBLISHER_STAND_BACKUP_DIR_ENV = 'PUBLISHER_STAND_BACKUP_DIR';

export interface PublisherStandSwitch {
  /** Действует (запрошено и окружение стенда). */
  enabled: boolean;
  /** Запрошено, но окружение не стенд: текст предупреждения, иначе null. */
  problem: string | null;
}

/** Окружение стенда: `development|test` и не Vercel. */
export function publisherStandEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = env.NODE_ENV?.trim();
  return (
    (nodeEnv === 'development' || nodeEnv === 'test') && !env.VERCEL?.trim()
  );
}

function standSwitch(
  name: string,
  requested: boolean,
  env: NodeJS.ProcessEnv,
): PublisherStandSwitch {
  if (!requested) return { enabled: false, problem: null };
  if (publisherStandEnvironment(env)) return { enabled: true, problem: null };
  return {
    enabled: false,
    problem: `${name} проигнорирована: только стенд (NODE_ENV=development|test, не Vercel), сейчас NODE_ENV=${env.NODE_ENV ?? '—'}${env.VERCEL ? ', VERCEL' : ''}`,
  };
}

/** Подменяемые часы стенда (`PUBLISHER_STAND_CLOCK=true`). */
export function publisherStandClock(
  env: NodeJS.ProcessEnv = process.env,
): PublisherStandSwitch {
  return standSwitch(
    PUBLISHER_STAND_CLOCK_ENV,
    flag(env[PUBLISHER_STAND_CLOCK_ENV]),
    env,
  );
}

/**
 * Локальное хранилище копий стенда (`PUBLISHER_STAND_BACKUP_DIR=<абсолютный
 * путь>`). Не абсолютный путь — тоже «не действует» с предупреждением.
 */
export function publisherStandBackupDir(
  env: NodeJS.ProcessEnv = process.env,
): PublisherStandSwitch & { dir: string | null } {
  const raw = env[PUBLISHER_STAND_BACKUP_DIR_ENV]?.trim() ?? '';
  const s = standSwitch(PUBLISHER_STAND_BACKUP_DIR_ENV, raw !== '', env);
  if (!s.enabled) return { ...s, dir: null };
  if (!raw.startsWith('/'))
    return {
      enabled: false,
      problem: `${PUBLISHER_STAND_BACKUP_DIR_ENV}: нужен абсолютный путь`,
      dir: null,
    };
  return { ...s, dir: raw };
}

export const PUBLISHER_SITE_URL_ENV = 'PUBLISHER_SITE_URL';
export const PUBLISHER_REVALIDATE_SECRET_ENV = 'PUBLISHER_REVALIDATE_SECRET';
/** Минимум длины секрета — как у `publisher-site/src/app/api/revalidate`. */
export const PUBLISHER_REVALIDATE_SECRET_MIN = 16;

export interface PublisherRevalidateTarget {
  /** `<origin>/api/revalidate` — единственный адрес вызова (без SSRF). */
  url: string;
  secret: string;
}

/**
 * Адрес и секрет ревалидации сайта (Р-PUB-Z2-8). Не задано или ошибка
 * формы — `target: null` и текст причины (без секрета), не ошибка старта.
 * Адрес — только origin: https (http — только localhost вне production),
 * без логина/пароля, пути, запроса и фрагмента.
 */
export function publisherRevalidateTarget(
  env: NodeJS.ProcessEnv = process.env,
): { target: PublisherRevalidateTarget | null; problem: string | null } {
  const rawUrl = env[PUBLISHER_SITE_URL_ENV]?.trim() ?? '';
  const secret = env[PUBLISHER_REVALIDATE_SECRET_ENV]?.trim() ?? '';
  if (!rawUrl && !secret) {
    return {
      target: null,
      problem: `${PUBLISHER_SITE_URL_ENV} и ${PUBLISHER_REVALIDATE_SECRET_ENV} не заданы`,
    };
  }
  if (!rawUrl)
    return { target: null, problem: `${PUBLISHER_SITE_URL_ENV} не задан` };
  if (secret.length < PUBLISHER_REVALIDATE_SECRET_MIN) {
    return {
      target: null,
      problem: `${PUBLISHER_REVALIDATE_SECRET_ENV} не задан или короче ${PUBLISHER_REVALIDATE_SECRET_MIN} символов`,
    };
  }
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { target: null, problem: `${PUBLISHER_SITE_URL_ENV}: не URL` };
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  const schemeOk =
    u.protocol === 'https:' ||
    (u.protocol === 'http:' && local && env.NODE_ENV !== 'production');
  if (
    !schemeOk ||
    u.username ||
    u.password ||
    (u.pathname !== '/' && u.pathname !== '') ||
    u.search ||
    u.hash
  ) {
    return {
      target: null,
      problem: `${PUBLISHER_SITE_URL_ENV}: нужен https-origin без пути, запроса и учётных данных`,
    };
  }
  return {
    target: { url: `${u.origin}/api/revalidate`, secret },
    problem: null,
  };
}

// ── Reddit Manual MVP, пакет P-R (reddit-manual-mvp-adapted.md §M1.0) ─────
//
// `PUBLISHER_REDDIT_ENABLED=true` включает раздел «Reddit» (маршруты
// `/publisher/products/:pid/reddit/**` и `features.reddit` продукта). По
// умолчанию выключен: маршруты отвечают 404 `PUB_NOT_FOUND` без `details`.
// Флаг читается на каждом запросе (переключение без пересборки). Флаг
// продукта не вводится (Р-RD-9).
//
// `PUBLISHER_REDDIT_AI_ENABLED=true` (M2, §M2.3 «Kill switch») разрешает
// маршрут генерации `…/reddit/briefs/:id/generate`; по умолчанию выключен —
// маршрут отвечает 409 `PUB_AI_DISABLED {generator, manual:true}` без
// записи вызова, экран показывает ручной редактор. Независимо от флага
// генератор работает только допущенным (`enabledInP0`, гейт `ai_use`,
// eval 2.3). Исследование (M1) и ручной путь от флага не зависят.

export const PUBLISHER_REDDIT_ENABLED_ENV = 'PUBLISHER_REDDIT_ENABLED';

/** Раздел Reddit включён (`PUBLISHER_REDDIT_ENABLED=true`). */
export function publisherRedditEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flag(env[PUBLISHER_REDDIT_ENABLED_ENV]);
}

/**
 * Платформенный сайт вкладки «Reddit» Админки (P-R-ADM, Р-RD-ADM-1): первый
 * id из `ASSIST_INTERNAL_SITE_IDS` (тот же список, что у тарифа внутреннего
 * тенанта `assist-billing/subscription-state.ts`; = `ASSIST_LANDING_SITE_ID`
 * backend). Разбор — тот же (запятая или пробел, `[A-Za-z0-9_-]{1,64}`);
 * своя копия — Publisher не импортирует модули помощника (`publisher-scope`).
 * null — список пуст: Админке нечего заводить.
 */
export const PUBLISHER_PLATFORM_SITE_IDS_ENV = 'ASSIST_INTERNAL_SITE_IDS';

export function publisherPlatformSiteId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env[PUBLISHER_PLATFORM_SITE_IDS_ENV]?.trim();
  if (!raw) return null;
  for (const v of raw.split(/[\s,]+/)) {
    const id = v.trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return id;
  }
  return null;
}

export const PUBLISHER_REDDIT_AI_ENABLED_ENV = 'PUBLISHER_REDDIT_AI_ENABLED';

/**
 * Стендовый fake-провайдер AI (`PUBLISHER_STAND_FAKE_AI=true`, P-R M2,
 * Р-RD-73): модель без сети для E2E-RD-02 и стендовое включение
 * `pub.reddit.draft`. Правило стенда (Р-PUB-Z2-21): только
 * `NODE_ENV=development|test` и не Vercel, иначе игнор с предупреждением.
 */
export const PUBLISHER_STAND_FAKE_AI_ENV = 'PUBLISHER_STAND_FAKE_AI';

export function publisherStandFakeAi(
  env: NodeJS.ProcessEnv = process.env,
): PublisherStandSwitch {
  return standSwitch(
    PUBLISHER_STAND_FAKE_AI_ENV,
    flag(env[PUBLISHER_STAND_FAKE_AI_ENV]),
    env,
  );
}

/** Генерация Reddit-черновиков включена (`PUBLISHER_REDDIT_AI_ENABLED=true`). */
export function publisherRedditAiEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return flag(env[PUBLISHER_REDDIT_AI_ENABLED_ENV]);
}
