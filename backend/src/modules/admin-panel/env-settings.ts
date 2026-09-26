/**
 * env-settings.ts
 *
 * Powers the admin panel's "Настройки" tab (GET /admin/settings) — a
 * list of every env var the app reads, each marked whether it's
 * correctly set, not just present. Pure function of an env-like object
 * (not `process.env` directly) so it can be unit-tested without a live
 * environment — same pattern as admin-auth/dev-login.ts's
 * `isDevAuthAllowed(env = process.env)`.
 *
 * Deliberately never returns a secret's actual value (API keys, DB
 * connection strings with embedded passwords, bot tokens, the cron
 * secret) to the client — only booleans/severity/a human message. A
 * handful of genuinely non-secret vars (NODE_ENV, CORS_ORIGIN, PORT,
 * model names and voice/ffmpeg base URLs, TTL, spend caps, the storage
 * host allowlist, the dev-user-id placeholder) do include their actual
 * value, since there is nothing to leak there and seeing the value is
 * what makes "is this actually configured right" answerable at a glance.
 *
 * Kept in sync by hand with backend/.env.example and
 * backend/src/config/configuration.ts — no env schema/codegen exists in
 * this project (see doc/LOCAL-DEVELOPMENT.md's env-key table, which this
 * mirrors in the admin UI).
 *
 * Ровно поэтому «по рукам» здесь сведено к минимуму там, где это
 * возможно: имена переменных потолков и прайса берутся из тех же
 * модулей, что их и читают (`common/spend-limits.ts`,
 * `common/ai-pricing.ts`). Переменная, добавленная туда, появляется
 * здесь сама; список, который синхронизируют вручную, расходится с
 * кодом на первом же этапе — что и случилось с ключами этапов 31–38.
 *
 * Гарантия «секрет не уходит наружу» держится не на дисциплине автора, а
 * на `env-settings.spec.ts`: он прогоняет функцию с окружением из
 * уникальных строк-маркеров и проверяет, что в ответе видны значения
 * ровно тех переменных, которые перечислены в его allowlist. Добавили
 * `value: raw` новой проверке — тест упадёт и заставит объяснить, почему
 * это не секрет.
 */

import {
  ANONYMOUS_LIMIT_ENV,
  PLAN_LIMIT_ENV,
  TEST_USER_LIMIT_ENV,
  dailyLimitForTestUser,
  dailyLimitForAnonymous,
  dailyLimitForPlan,
} from '../../common/spend-limits';
import { PLAN_IDS } from '../../common/plans';
import { MODEL_RATES, priceEnvKey } from '../../common/ai-pricing';
import { isDevAuthAllowed } from '../admin-auth/dev-login';
import { describeBuild } from '../../common/build-info';

export interface EnvLike {
  [key: string]: string | undefined;
}

export type EnvSeverity = 'ok' | 'warning' | 'critical';

export interface EnvCheckResult {
  /** Env var name (or "A or B" for the two accepted spellings of one setting). */
  key: string;
  /** Section the settings page groups this row under. */
  group: string;
  /** Whether the app needs this to be set at all (in some environment — see message for when). */
  required: boolean;
  /** Whether a non-empty value is present (regardless of whether it's *correct*). */
  set: boolean;
  /** Overall pass/fail once format/placeholder/production-safety rules are applied. */
  ok: boolean;
  severity: EnvSeverity;
  /** Human-readable (Russian, matches the rest of the admin UI) explanation. */
  message: string;
  /** Present only for vars that carry no secret — see file doc comment. */
  value?: string;
}

const PLACEHOLDER_VALUES = new Set([
  'your_google_api_key',
  'your_laozhang_api_key',
  'your_vercel_blob_read_write_token',
  'your_vercel_blob_store_id',
  'your_telegram_bot_token',
  'your_serpapi_api_key',
  'your_youtube_api_key',
]);

function isPlaceholder(value: string | undefined): boolean {
  return value !== undefined && PLACEHOLDER_VALUES.has(value.trim());
}

/** Positive integer check for the numeric limit settings (same rule as configuration.ts's positiveIntFromEnv). */
function isPositiveInt(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value) > 0;
}

function looksLikePostgresUrl(value: string): boolean {
  return (
    /^postgres(ql)?:\/\//.test(value.trim()) && !value.includes('[project-ref]')
  );
}

/** Telegram bot tokens look like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`. */
function looksLikeBotToken(value: string): boolean {
  return /^\d+:[A-Za-z0-9_-]{30,}$/.test(value.trim());
}

/**
 * Один суточный потолок расхода (§26.4). Вынесено в функцию, потому что
 * проверок четыре и различаются они только именем и адресатом.
 *
 * `effectiveMicroUsd` считает `common/spend-limits.ts` — тот же код, что
 * потолок и применяет. Показывать здесь отдельно набранное «10 (по
 * умолчанию)» значило бы завести вторую правду о деньгах.
 */
function spendLimitCheck(
  env: EnvLike,
  key: string,
  effectiveMicroUsd: number,
  who: string,
): EnvCheckResult {
  const raw = env[key];
  const set = raw !== undefined && raw.trim() !== '';
  const parsed = set ? Number(raw) : null;
  // `0` — законное значение и означает «платные вызовы запрещены».
  // А вот мусор потолок не обнуляет: остаётся умолчание из кода, и
  // именно об этом расхождении оператор должен узнать здесь, а не из
  // счёта провайдера.
  const ok = !set || (Number.isFinite(parsed!) && parsed! >= 0);
  const dollars = effectiveMicroUsd / 1_000_000;
  const label =
    who === 'ANONYMOUS'
      ? 'на ВСЕХ анонимных вместе (персонального у них быть не может — UUID сессии минтится бесплатно)'
      : `на пользователя режима ${who}`;
  return {
    key,
    group: 'Режимы и деньги',
    required: false,
    set,
    ok,
    severity: ok ? (effectiveMicroUsd === 0 ? 'warning' : 'ok') : 'warning',
    message: !ok
      ? 'Не похоже на неотрицательное число — потолок остался умолчанием из кода. Молча остановить сервис из-за опечатки хуже, чем работать по коду, поэтому в ноль это НЕ превращается.'
      : effectiveMicroUsd === 0
        ? `Ноль — это «платные вызовы запрещены» ${label}. Законное значение, но если он тут не нарочно, продукт выглядит сломанным.`
        : `Суточный потолок расхода ${label}; окно — от полуночи UTC.`,
    value: `$${dollars} в сутки`,
  };
}

export function getEnvSettings(
  env: EnvLike = process.env as EnvLike,
): EnvCheckResult[] {
  const isProd = env.NODE_ENV === 'production';
  const onVercel = env.VERCEL === '1';
  const results: EnvCheckResult[] = [];

  // ── Сервер ──

  {
    const raw = env.PORT;
    const ok = raw === undefined || (/^\d+$/.test(raw) && Number(raw) > 0);
    results.push({
      key: 'PORT',
      group: 'Сервер',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Порт, на котором слушает бэкенд.'
        : 'Задан, но не похож на число — сервер не запустится.',
      value: raw ?? '3000 (по умолчанию)',
    });
  }

  {
    const raw = env.NODE_ENV;
    const known =
      raw === undefined || ['development', 'production', 'test'].includes(raw);
    results.push({
      key: 'NODE_ENV',
      group: 'Сервер',
      required: false,
      set: raw !== undefined,
      ok: known,
      severity: known ? 'ok' : 'warning',
      message: known
        ? 'Управляет предохранителями прод-режима (ALLOW_DEV_AUTH, secure-cookie и т.д.).'
        : `Незнакомое значение "${raw}" — code проверяет только точное сравнение с "production", остальное трактуется как dev.`,
      value: raw ?? 'development (по умолчанию)',
    });
  }

  // ── База данных ──

  for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
    const raw = env[key];
    const set = Boolean(raw?.trim());
    const ok = set && looksLikePostgresUrl(raw!);
    results.push({
      key,
      group: 'База данных',
      required: true,
      set,
      ok,
      severity: ok ? 'ok' : 'critical',
      message: !set
        ? 'Не задан — без него не сохранится ни одна сессия (см. doc/PRISMA-SUPABASE.md).'
        : ok
          ? 'Похоже на настоящую postgres-строку подключения.'
          : 'Задан, но не похож на реальную postgres-строку (возможно, не заменён плейсхолдер [project-ref]).',
      // Значение не показываем — содержит пароль.
    });
  }

  // ── Хранилище (Vercel Blob) ──

  for (const key of ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID']) {
    const raw = env[key];
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = onVercel || (set && !placeholder);
    results.push({
      key,
      group: 'Хранилище (Vercel Blob)',
      required: !onVercel,
      set,
      ok,
      severity: ok ? 'ok' : onVercel ? 'ok' : 'warning',
      message: onVercel
        ? 'На Vercel с подключённым Blob store аутентификация идёт через OIDC — этот ключ не обязателен.'
        : !set
          ? 'Не задан — загрузка видео/фото товара не будет работать (локально: `vercel env pull`).'
          : placeholder
            ? 'Похоже на незаменённый плейсхолдер из .env.example.'
            : 'Задан.',
    });
  }

  {
    // Не секрет — это список доменов, а не доступ к ним. Значение
    // показываем: весь смысл проверки в том, чтобы увидеть, ЧТО именно
    // разрешено, — «задано» тут не отвечает ни на один вопрос.
    const raw = env.BLOB_PUBLIC_HOSTS;
    const hosts = (raw ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    const suspicious = hosts.filter((h) => h.includes('/') || h.includes(':'));
    const ok = suspicious.length === 0;
    results.push({
      key: 'BLOB_PUBLIC_HOSTS',
      group: 'Хранилище (Vercel Blob)',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !ok
        ? 'Ожидаются ТОЛЬКО имена хостов через запятую — без схемы, порта и пути. Запись со слэшем или двоеточием не совпадёт ни с чем, и картинки со своего домена сервер скачивать откажется.'
        : hosts.length === 0
          ? 'Не задан — сервер скачивает свои картинки только со стандартного домена Vercel Blob (*.public.blob.vercel-storage.com). Задавать нужно, ТОЛЬКО если у хранилища свой домен; пустое значение проверку не отключает.'
          : 'Дополнительные домены хранилища, с которых серверу разрешено скачивать наши же картинки (§12).',
      value: hosts.length ? hosts.join(', ') : 'только домен Vercel Blob',
    });
  }

  // ── AI-ключи ──

  {
    const raw = env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY;
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = set && !placeholder;
    results.push({
      key: 'GEMINI_API_KEY (или GOOGLE_GEMINI_API_KEY)',
      group: 'AI-ключи',
      required: true,
      set,
      ok,
      severity: ok ? 'ok' : 'critical',
      message: !set
        ? 'Не задан — анализ видео и генерация через Veo 3.1 не будут работать.'
        : placeholder
          ? 'Похоже на незаменённый плейсхолдер из .env.example.'
          : 'Задан.',
    });
  }

  {
    const raw = env.GEMINI_MODEL;
    results.push({
      key: 'GEMINI_MODEL',
      group: 'AI-ключи',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Модель Gemini для всех пяти вызовов: разбор видео, релевантность, аудит ролика, распознавание фото, расшифровка голоса. Модели вне прайса пишутся в расход как unpriced.',
      value: raw ?? 'gemini-3.6-flash (по умолчанию)',
    });
  }

  {
    // Найдено при аудите (по прямому запросу, 2026-09-13): генерация
    // промпта/A-B-вариантов/переписывания для Grok-референсов переведена
    // на Gemini (`PromptService`, см. её доккомментарий конструктора) —
    // этот ключ и его модель БОЛЬШЕ НИГДЕ не читаются. Раньше запись была
    // `required: true`/`critical` при отсутствии — ложная тревога:
    // отсутствие этого ключа сейчас ничего не ломает, но старая
    // формулировка убеждала бы в обратном.
    const raw = env.LAOZHANG_API_KEY || env.OPENAI_API_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'LAOZHANG_API_KEY (или OPENAI_API_KEY)',
      group: 'AI-ключи',
      required: false,
      set,
      ok: true,
      severity: 'ok',
      message:
        'Больше не используется — генерация промпта переведена на Gemini (см. GEMINI_API_KEY выше). Можно убрать из .env, если не нужен для чего-то другого.',
    });
  }

  {
    const raw = env.LAOZHANG_API_BASE_URL || env.OPENAI_API_BASE_URL;
    results.push({
      key: 'LAOZHANG_API_BASE_URL',
      group: 'AI-ключи',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Больше не используется — см. примечание к LAOZHANG_API_KEY выше.',
      value: raw ?? '(не используется)',
    });
  }

  // ── Товар / Проект (doc/PRODUCT-PROJECT-SPEC.md) ──
  // Ни один из этих ключей не обязателен для старта — стенд поднимается
  // без них, соответствующий эндпоинт откажет на вызове. Поэтому
  // severity здесь максимум 'warning', не 'critical'.

  {
    const raw = env.SERPAPI_API_KEY;
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = set && !placeholder;
    results.push({
      key: 'SERPAPI_API_KEY',
      group: 'Товар / Проект',
      required: false,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !set
        ? 'Не задан — поиск аналогов товара по фото (SerpApi Google Lens, §6.1 ТЗ) не будет работать; остальное не затронуто.'
        : placeholder
          ? 'Похоже на незаменённый плейсхолдер из .env.example.'
          : 'Задан.',
      // Значение не показываем — секрет.
    });
  }

  {
    const raw = env.SERPAPI_DAILY_LIMIT_PER_USER;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'SERPAPI_DAILY_LIMIT_PER_USER',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Дневной лимит вызовов SerpApi на одного пользователя (§7.5 ТЗ) — ограничивает счёт, SerpApi тарифицируется за запрос.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (50).',
      value: raw ?? '50 (по умолчанию)',
    });
  }

  {
    const raw = env.YOUTUBE_API_KEY;
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = set && !placeholder;
    results.push({
      key: 'YOUTUBE_API_KEY',
      group: 'Товар / Проект',
      required: false,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !set
        ? 'Не задан — поиск референсного видео по YouTube (§6.4 ТЗ) не будет работать; ручная ссылка и загрузка файла работают как раньше.'
        : placeholder
          ? 'Похоже на незаменённый плейсхолдер из .env.example.'
          : 'Задан. Квота YouTube Data API: search.list = 100 units при 10 000/день по умолчанию (~100 поисков/день).',
      // Значение не показываем — секрет.
    });
  }

  {
    const raw = env.YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Дневной лимит поисков YouTube на одного пользователя — квота Google (~100 поисков/день) общая на весь деплой, лимит не даёт одному пользователю израсходовать её за всех.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (20).',
      value: raw ?? '20 (по умолчанию)',
    });
  }

  {
    const raw = env.AUDIT_AUTO_ITERATIONS_LIMIT;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'AUDIT_AUTO_ITERATIONS_LIMIT',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Сколько циклов «аудит → правка промпта → перегенерация» разрешено на один ролик без предупреждения (§11.1 ТЗ) — каждый цикл платный прогон Veo.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (3).',
      value: raw ?? '3 (по умолчанию)',
    });
  }

  {
    const raw = env.PROJECT_LINE_ITEM_LIMIT;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'PROJECT_LINE_ITEM_LIMIT',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Максимум товаров в одной линейке (§7.3 ТЗ, поднят на этапе 68 до 500 ради импорта товарного фида, §47) — ограничивает и UI, и худший случай расходов на SerpApi за один проект.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (500).',
      value: raw ?? '500 (по умолчанию)',
    });
  }

  // Семь переменных ниже (этапы 65–68: пакетная генерация по каталогу,
  // A/B-варианты, импорт товарного фида) реально читаются кодом
  // (`config/configuration.ts`) и задокументированы в doc/DEPLOYMENT.md,
  // но до пятого аудита (Д-3.4) отсутствовали здесь — при том что этот
  // файл в собственном доккомментарии обещает покрывать «каждую
  // переменную, которую читает приложение». Не секреты, у всех есть
  // безопасные дефолты — severity не выше 'warning'.

  {
    const raw = env.CATALOG_BATCH_CRON_BATCH;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'CATALOG_BATCH_CRON_BATCH',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Сколько строк пакетной генерации по каталогу (§44, этап 65) обрабатывает один тик крона.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (10).',
      value: raw ?? '10 (по умолчанию)',
    });
  }

  {
    const raw = env.CATALOG_BATCH_MAX_ATTEMPTS;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'CATALOG_BATCH_MAX_ATTEMPTS',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'После скольких неудачных попыток строка пакетной генерации по каталогу помечается терминально FAILED (бэкофф 2^попытка минут между попытками).'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (5).',
      value: raw ?? '5 (по умолчанию)',
    });
  }

  {
    const raw = env.AB_TEST_CRON_BATCH;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'AB_TEST_CRON_BATCH',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Сколько строк A/B-вариантов одного ролика (TODO §III.6, этап 66) обрабатывает один тик крона.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (10).',
      value: raw ?? '10 (по умолчанию)',
    });
  }

  {
    const raw = env.AB_TEST_MAX_ATTEMPTS;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'AB_TEST_MAX_ATTEMPTS',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'После скольких неудачных попыток строка A/B-варианта помечается терминально FAILED.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (5).',
      value: raw ?? '5 (по умолчанию)',
    });
  }

  {
    const raw = env.PRODUCT_FEED_IMPORT_CRON_BATCH;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'PRODUCT_FEED_IMPORT_CRON_BATCH',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Сколько строк импорта товарного фида (§47, этап 68) обрабатывает один тик крона (фаза заведения позиций).'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (50).',
      value: raw ?? '50 (по умолчанию)',
    });
  }

  {
    const raw = env.PRODUCT_FEED_IMPORT_MAX_ATTEMPTS;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'PRODUCT_FEED_IMPORT_MAX_ATTEMPTS',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'После скольких неудачных попыток запуск/строка импорта товарного фида помечается терминально FAILED.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (5).',
      value: raw ?? '5 (по умолчанию)',
    });
  }

  {
    const raw = env.PRODUCT_FEED_IMPORT_MAX_BYTES;
    const ok = raw === undefined || isPositiveInt(raw);
    results.push({
      key: 'PRODUCT_FEED_IMPORT_MAX_BYTES',
      group: 'Товар / Проект',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Максимальный размер тела скачиваемого фида в байтах (§47) — защита от чрезмерно большого файла на серверлес-функции; проверяется и потоково (Д-3.2, пятый аудит), не только по Content-Length.'
        : 'Задан, но не похож на положительное целое — бэкенд молча откатится на значение по умолчанию (8388608, 8 МБ).',
      value: raw ?? '8388608 (8 МБ, по умолчанию)',
    });
  }

  // ── Постобработка ролика (ТЗ §16.1, этап 34) ──
  //
  // Обрезка кадра и наложение озвучки идут ОДНОЙ командой ffmpeg уже
  // после рендера. Без ключа продукт работает — ролик остаётся в родном
  // кадре Veo, — но человек, который ждал 4:5 и получил 9:16, приходит
  // проверять настройки именно сюда. Поэтому «не задан» здесь жёлтый, а
  // не зелёный: до этапа 39 этой строки не было вовсе, и вкладка молча
  // показывала «всё в порядке» при неработающей обрезке.

  {
    const raw = env.FFMPEG_API_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'FFMPEG_API_KEY',
      group: 'Постобработка ролика',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — обрезка кадра под неродной формат и наложение своей звуковой дорожки работают.'
        : 'Не задан — ролик остаётся в том формате, который отдал Veo (16:9 или 9:16), а своя озвучка не накладывается, даже если синтез настроен. Интерфейс пишет об этом пометкой, ошибки не будет.',
      // Значение не показываем — секрет.
    });
  }

  {
    const raw = env.FFMPEG_API_BASE_URL;
    const ok = raw === undefined || /^https?:\/\//.test(raw.trim());
    results.push({
      key: 'FFMPEG_API_BASE_URL',
      group: 'Постобработка ролика',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'База API обрезки. Менять нужно, только если поднят свой совместимый сервис.'
        : 'Задан, но не похож на URL — запросы уйдут в никуда, и постобработка будет падать на каждом ролике.',
      value: raw ?? 'https://verygoodffmpeg.com/api (по умолчанию)',
    });
  }

  // ── Озвучка (ТЗ §15, этапы 35–36) ──

  {
    const raw = env.VOICE_API_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'VOICE_API_KEY',
      group: 'Озвучка',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — реплики читает выбранный голос (ElevenLabs), каталог голосов и проба голоса в манифесте работают.'
        : 'Не задан — реплики произносит сам Veo, как до этапа 35: голос каждый раз новый, своего у бренда нет. Это мягкий фоллбек, а не сбой; режим озвучки в манифесте при этом ни на что не влияет.',
      // Значение не показываем — секрет.
    });
  }

  {
    // Идентификатор голоса — не секрет: он публичный в каталоге
    // провайдера, и увидеть, КАКОЙ голос стоит умолчанием, — весь смысл
    // строки.
    const raw = env.VOICE_ID;
    results.push({
      key: 'VOICE_ID',
      group: 'Озвучка',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Голос по умолчанию. Бренд выбирает свой в манифесте — это значение работает, только пока он не выбран.',
      value: raw ?? 'EXAVITQu4vr4xnSDxMaL (по умолчанию)',
    });
  }

  {
    const raw = env.VOICE_MODEL;
    results.push({
      key: 'VOICE_MODEL',
      group: 'Озвучка',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Модель синтеза. Умолчание умеет украинский и русский — это рынки продукта, и менять его стоит, только зная, что новая модель их тоже умеет.',
      value: raw ?? 'eleven_multilingual_v2 (по умолчанию)',
    });
  }

  // ── Resemble AI — второй провайдер синтеза (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md) ──

  {
    // Переключатель, не секрет — какой из провайдеров сейчас активен
    // видно так же прямо, как ELEVENLABS/RESEMBLE в отчёте расходов.
    // Показываем значение как задано (без нормализации регистра) — тот
    // же принцип, что у соседних не-секретных переменных этого файла;
    // `.toLowerCase()` — только для сверки со списком известных
    // значений (та же логика, что в tts.module.ts), не для отображения.
    const raw = env.TTS_PROVIDER?.trim();
    const normalized = raw?.toLowerCase();
    const known =
      normalized === undefined ||
      normalized === 'elevenlabs' ||
      normalized === 'resemble';
    results.push({
      key: 'TTS_PROVIDER',
      group: 'Озвучка',
      required: false,
      set: raw !== undefined,
      ok: known,
      severity: known ? 'ok' : 'warning',
      message: known
        ? 'Активный провайдер синтеза. Не задан — ElevenLabs (обратная совместимость по умолчанию).'
        : 'Неизвестное значение — модуль тихо откатится на ElevenLabs (tts.module.ts), ожидались "elevenlabs" или "resemble".',
      value: raw ?? 'elevenlabs (по умолчанию)',
    });
  }

  {
    const raw = env.RESEMBLE_API_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'RESEMBLE_API_KEY',
      group: 'Озвучка',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — при TTS_PROVIDER=resemble реплики читает голос Resemble; каталог голосов и проба в манифесте работают.'
        : 'Не задан — при TTS_PROVIDER=resemble синтез будет пропускаться (мягкий фоллбек, не сбой), как если бы TTS вовсе не был настроен.',
      // Значение не показываем — секрет.
    });
  }

  {
    // У Resemble нет универсального голоса каталога (в отличие от
    // VOICE_ID/ElevenLabs) — если не задан и бренд не выбрал свой,
    // синтез Resemble пропускается с понятной причиной, а не выдуманным
    // ID (resemble.service.ts).
    const raw = env.RESEMBLE_VOICE_ID;
    results.push({
      key: 'RESEMBLE_VOICE_ID',
      group: 'Озвучка',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Голос Resemble по умолчанию. Бренд выбирает свой в манифесте — это значение работает, только пока он не выбран; у Resemble нет универсального голоса по умолчанию, так что без этой переменной и без выбора в манифесте синтез Resemble будет пропускаться.',
      value: raw ?? '(не задано — универсального умолчания у Resemble нет)',
    });
  }

  // ── Разделение дорожки (docs-tz/TZ-Voice-Replace-Keep-Background.md) ──

  {
    const raw = env.REPLICATE_API_TOKEN;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'REPLICATE_API_TOKEN',
      group: 'Озвучка',
      required: false,
      set,
      ok: true,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — разделение дорожки МОЖЕТ работать, но само по себе не включается: нужен ещё выключатель «Фон при дубляже» на этой же вкладке (умолчание — выключено).'
        : 'Не задан — дубляж выбрасывает исходную дорожку целиком, как и раньше: голос останется на тишине. Это рабочее состояние, а не сбой.',
      // Значение не показываем — секрет.
    });
  }

  {
    // Версия модели, а не её имя: у Replicate вызов адресуется хешем
    // версии, и «взять какую-нибудь» нельзя — счёт придёт настоящий.
    const raw = env.REPLICATE_DEMUCS_VERSION;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'REPLICATE_DEMUCS_VERSION',
      group: 'Озвучка',
      required: false,
      set,
      ok: true,
      severity: 'ok',
      message:
        'Хеш версии модели разделения (htdemucs) на Replicate. Без него разделение не вызывается даже при заданном токене: адресовать вызов некуда.',
      value: raw ?? '(не задано — разделение выключено)',
    });
  }

  {
    const raw = env.REPLICATE_DEMUCS_INPUT;
    results.push({
      key: 'REPLICATE_DEMUCS_INPUT',
      group: 'Озвучка',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      message:
        'Необязательное переопределение тела запроса к модели (JSON; ссылка подставляется вместо "{{source}}"). Нужно, только если схема входа у модели отличается от умолчания — тогда это правка переменной, а не деплой.',
      value:
        raw ?? '(не задано — умолчание из replicate-separation.service.ts)',
    });
  }

  // ── Клонирование голоса (этап 73, TODO п.32) ──

  {
    const raw = env.RESEMBLE_WEBHOOK_SECRET;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'RESEMBLE_WEBHOOK_SECRET',
      group: 'Клонирование голоса',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — Resemble подтверждает готовность клона вебхуком (POST /voices/webhook/resemble?secret=...).'
        : 'Не задан — вебхук отвечает 503, готовность голоса определяется только poll-фоллбеком (более медленно, но рабочий путь — §5.4 TTS-спека).',
      // Значение не показываем — секрет.
    });
  }

  {
    // Тот же `API_PUBLIC_URL`, что уже собирает callback OAuth-каналов
    // (`tiktok-oauth.service.ts`/`google-oauth.service.ts`) и вебхук
    // WayForPay (`billing.service.ts`) — отдельная переменная под ещё
    // один callback была бы дублем одного и того же смысла («публичный
    // адрес ЭТОГО backend»), который на проде разъехался бы с первым при
    // забытом обновлении одной из двух копий.
    const raw = env.API_PUBLIC_URL;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'API_PUBLIC_URL',
      group: 'Клонирование голоса',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Публичный адрес backend — используется, среди прочего, для сборки callback_uri вебхука Resemble (см. также OAuth-каналы и вебхук WayForPay).'
        : 'Не задан — callback_uri вебхука Resemble не собирается, клонирование голоса работает только через poll-фоллбек (§5.4 TTS-спека).',
      value: raw ?? undefined,
    });
  }

  // ── Пилот говорящего AI-аватара (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md, этап 72) ──

  {
    const raw = env.HEDRA_API_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'HEDRA_API_KEY',
      group: 'Пилот AI-аватара',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — оператор может запустить рендер аватар-ролика (POST /admin/actors/:sessionId/generate). Голос берётся из RESEMBLE_API_KEY выше.'
        : 'Не задан — ручной запуск пилота отвечает понятной ошибкой, остальной продукт не затронут.',
      // Значение не показываем — секрет.
    });
  }

  // ── Обучалка (fixture-исполнитель сценариев, TutorialScenarioRunnerService
  //    / UiSnapshotRunnerService, doc/DEPLOYMENT.md) ──
  //
  // Без этих трёх кроны `tutorial-scenario-run` и `ui-snapshot-run` не
  // падают — они тихо возвращают `{skipped: "..."}` (fail-closed, не
  // fail-crash), и до этого аудита оператор узнавал об этом только по
  // логу конкретного прогона в «Кронах». Строки здесь — чтобы это было
  // видно на вкладке «Настройки» заранее, а не постфактум.

  {
    const raw = env.FIXTURE_USER_TOKEN;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'FIXTURE_USER_TOKEN',
      group: 'Обучалка',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — регресс-раннер обучалки (tutorial-scenario-run/ui-snapshot-run) аутентифицируется заголовком X-Fixture-Token и может пройти дальше проверки окружения.'
        : 'Не задан — tutorial-scenario-run и ui-snapshot-run скипаются с "фикстурный вход не настроен", ещё до обращения к базе. Сгенерировать: openssl rand -hex 16.',
      // Значение не показываем — секрет (см. .env.example: секретный токен фикстурного входа).
    });
  }

  {
    // Не секрет: это просто идентификатор фикстурного пользователя
    // (telegramId), не даёт доступа сам по себе — доступ даёт
    // FIXTURE_USER_TOKEN выше. Видеть значение нужно, чтобы свериться с
    // тем, что заведено в БД. В отличие от VOICE_ID/VOICE_MODEL выше,
    // у этой переменной НЕТ кодового умолчания
    // (`fixture-token.ts:fixtureTelegramIdFromHeader` fail-closed
    // возвращает null без неё) — «fixture-tutorial-runner» в
    // .env.example лишь рекомендованное значение, поэтому не заданная
    // переменная здесь жёлтая, а не зелёная с мнимым умолчанием.
    const raw = env.FIXTURE_TELEGRAM_ID;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'FIXTURE_TELEGRAM_ID',
      group: 'Обучалка',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Telegram ID фикстурного пользователя. Саму запись User с этим telegramId в базе создаёт отдельная кнопка «Завести фикстурного пользователя» ниже (или разовый `npm run seed:fixture-user`) — без нее раннеры скипаются с "фикстурный пользователь не заведён", даже если все три переменные этой группы заданы.'
        : 'Не задан — tutorial-scenario-run и ui-snapshot-run скипаются с "фикстурный вход не настроен", ещё до обращения к базе. Кодового умолчания нет; рекомендованное значение из .env.example — fixture-tutorial-runner.',
      value: raw,
    });
  }

  {
    const raw = env.TMA_PUBLIC_URL;
    const ok = raw === undefined || /^https?:\/\//.test(raw.trim());
    results.push({
      key: 'TMA_PUBLIC_URL',
      group: 'Обучалка',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? (raw ? 'ok' : 'warning') : 'warning',
      message: !ok
        ? 'Задан, но не похож на URL — регресс-раннер откроет headless-браузером страницу, которой нет, и каждый шаг сценария будет падать.'
        : raw
          ? 'Публичный адрес TMA (frontend) — регресс-раннер открывает его headless-браузером и проходит по шагам обучалки как реальный пользователь.'
          : 'Не задан — tutorial-scenario-run и ui-snapshot-run скипаются с "фикстурный вход не настроен", ещё до обращения к базе.',
      value: raw,
    });
  }

  // ── Обучалка по САЙТУ ЗАКАЗЧИКА (doc/CLIENT-SITE-TUTORIAL-SPEC.md,
  //    этапы 111–114) — отдельная фича, не путать с группой выше ──
  //
  // Все четыре необязательны, но молчат по-разному, и оператору важно
  // видеть чем: без ключа шифрования визард отвечает ошибкой на первом
  // же раунде, а без адреса реле просто не показывается кнопка живого
  // входа, и остальное работает.

  {
    const raw = env.SITE_TUTORIAL_TOKEN_KEY;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'SITE_TUTORIAL_TOKEN_KEY',
      group: 'Обучалка по сайту заказчика',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — cookie jar и тестовые учётные данные заказчика шифруются AES-256-GCM. Ключ СВОЙ, отдельно от CHANNEL_TOKEN_KEY/PAYMENT_TOKEN_KEY: разные секреты разной чувствительности не делят ключ.'
        : 'Не задан — визард обучалки по сайту заказчика откажет на первом же раунде: складывать живые куки чужого сайта в базу открытым текстом нельзя. Сгенерировать: openssl rand -base64 32.',
      // Значение не показываем — это ключ шифрования.
    });
  }

  {
    const raw = env.LIVE_LOGIN_RELAY_URL;
    const ok = raw === undefined || /^https?:\/\//.test(raw.trim());
    results.push({
      key: 'LIVE_LOGIN_RELAY_URL',
      group: 'Обучалка по сайту заказчика',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? (raw ? 'ok' : 'warning') : 'warning',
      message: !ok
        ? 'Задан, но не похож на URL — backend не сможет ни поднять живую сессию, ни забрать её результат.'
        : raw
          ? 'HTTP-адрес сервиса live-login-relay. Если LIVE_LOGIN_RELAY_WS_URL не задан, из него же склеивается wss-адрес для браузера — тогда этот адрес обязан быть публичным.'
          : 'Не задан — кнопка живого входа (капча/2FA/SSO) не показывается вовсе, вход по тестовым учётным данным работает. Это штатная мягкая деградация, а не поломка.',
      value: raw,
    });
  }

  {
    const raw = env.LIVE_LOGIN_RELAY_SECRET;
    const set = Boolean(raw?.trim());
    const relaySet = Boolean(env.LIVE_LOGIN_RELAY_URL?.trim());
    results.push({
      key: 'LIVE_LOGIN_RELAY_SECRET',
      group: 'Обучалка по сайту заказчика',
      required: false,
      set,
      ok: set || !relaySet,
      severity: set ? 'ok' : relaySet ? 'warning' : 'ok',
      message: set
        ? 'Задан — уходит реле заголовком X-Relay-Secret. У реле он fail-closed: без совпадения оно отвечает 401 на всё.'
        : relaySet
          ? 'Адрес реле задан, а секрет — нет: реле ответит 401 на КАЖДЫЙ вызов, и живой вход будет падать вместо того, чтобы просто не показываться. Задайте оба или ни одного.'
          : 'Не задан — как и адрес реле выше; живой вход выключен целиком, это штатное состояние.',
      // Значение не показываем — секрет.
    });
  }

  {
    const raw = env.LIVE_LOGIN_RELAY_WS_URL;
    const ok = raw === undefined || /^wss?:\/\//.test(raw.trim());
    results.push({
      key: 'LIVE_LOGIN_RELAY_WS_URL',
      group: 'Обучалка по сайту заказчика',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !ok
        ? 'Ожидается адрес вида wss://… — именно он уезжает в браузер пользователя для видеопотока живой сессии.'
        : raw
          ? 'Публичный wss-адрес реле для браузера — нужен, когда backend ходит к реле по внутреннему адресу, а браузер по внешнему.'
          : 'Не задан — wss-адрес склеивается из LIVE_LOGIN_RELAY_URL заменой схемы. Нормально, пока тот адрес публичный.',
      value: raw,
    });
  }

  // ── Режимы и деньги (ТЗ §23, §26) ──

  {
    const raw = env.PLANS_BILLING_ENABLED;
    // Код сравнивает строго с 'true'; всё остальное — «выключено». Это
    // нормально до тех пор, пока в переменной не окажется '1' или 'yes':
    // человек будет уверен, что оплату включил.
    const known =
      raw === undefined ||
      raw.trim() === '' ||
      ['true', 'false'].includes(raw.trim());
    const enabled = raw?.trim() === 'true';
    results.push({
      key: 'PLANS_BILLING_ENABLED',
      group: 'Режимы и деньги',
      required: false,
      set: raw !== undefined,
      ok: known,
      severity: known ? 'ok' : 'warning',
      message: !known
        ? 'Ожидается ровно "true" или "false" — код сравнивает строго с "true", поэтому "1"/"yes"/"TRUE" читаются как выключено, а выглядят как включено.'
        : enabled
          ? // Этап 62: с оплатой PATCH /api/me/plan ведёт себя по-разному —
            // на LITE это запрос отмены (доступ до конца периода, крон
            // сам понизит), на STANDARD/PREMIUM — 403 со ссылкой на
            // POST /api/billing/checkout/subscription.
            'Оплата включена: понижение до LITE через PATCH /api/me/plan становится запросом отмены подписки (доступ остаётся до конца оплаченного периода), повышение до STANDARD/PREMIUM — 403 с указанием на POST /api/billing/checkout/subscription.'
          : 'Оплаты нет: все три режима бесплатны и переключаются самим пользователем — период обкатки (§23). Правила доступа от этого не зависят, они читаются из common/plans.ts в обоих случаях.',
      value: raw ?? 'false (по умолчанию)',
    });
  }

  // Суточные потолки расхода. Имена переменных берём из того же модуля,
  // который их читает, а эффективное значение считаем его же функцией:
  // строка «10 (по умолчанию)», разошедшаяся с кодом, здесь опаснее, чем
  // её отсутствие.
  for (const plan of PLAN_IDS) {
    const key = PLAN_LIMIT_ENV[plan];
    results.push(spendLimitCheck(env, key, dailyLimitForPlan(plan, env), plan));
  }
  results.push(
    spendLimitCheck(
      env,
      ANONYMOUS_LIMIT_ENV,
      dailyLimitForAnonymous(env),
      'ANONYMOUS',
    ),
  );
  // Потолок тестовых аккаунтов (TODO §III п.37) — здесь по той же
  // причине, что и остальные: его задают в окружении, и «сколько на
  // самом деле» должно быть видно в одном месте с прочими потолками.
  results.push(
    spendLimitCheck(
      env,
      TEST_USER_LIMIT_ENV,
      dailyLimitForTestUser(env),
      'TEST_USER',
    ),
  );

  {
    // Прайс (§26). Проверяем не значения, а сам факт: какие ставки
    // переопределены и нет ли среди переменных опечатки. Опечатка в
    // имени — самая дорогая ошибка в этой группе: переменная выглядит
    // заданной, а расход считается по старой ставке, и заметить это
    // можно только по отчёту, который для того и заведён.
    const valid = new Set<string>();
    for (const model of Object.keys(MODEL_RATES)) {
      for (const kind of [
        'input',
        'cached',
        'output',
        'second',
        'call',
        'chars',
      ] as const) {
        valid.add(priceEnvKey(model, kind));
      }
    }
    const given = Object.keys(env).filter(
      (k) => k.startsWith('AI_PRICE_') && (env[k] ?? '').trim() !== '',
    );
    const unknown = given.filter((k) => !valid.has(k));
    const bad = given.filter((k) => {
      const n = Number(env[k]);
      return !Number.isFinite(n) || n < 0;
    });
    const ok = unknown.length === 0 && bad.length === 0;
    results.push({
      key: 'AI_PRICE_* (переопределения прайса)',
      group: 'Режимы и деньги',
      required: false,
      set: given.length > 0,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: unknown.length
        ? `Не соответствуют ни одной ставке и ни на что не влияют: ${unknown.join(', ')}. Имя строится как AI_PRICE_<МОДЕЛЬ>_<INPUT|CACHED|OUTPUT|SECOND|CALL|CHARS>, где в модели всё, кроме букв и цифр, заменено подчёркиванием.`
        : bad.length
          ? `Не похожи на неотрицательное число: ${bad.join(', ')}. Мусор ставку НЕ обнуляет — останется значение из кода, то есть отчёт о деньгах будет считать по старой цене.`
          : given.length
            ? `Переопределены ставки: ${given.join(', ')}. Значение — в долларах, как на странице прайса провайдера.`
            : 'Переопределений нет — считается по прайсу из common/ai-pricing.ts. Ставки Veo и GPT-5 там помечены как требующие проверки: перед тем как верить колонке с деньгами, сверьте их с провайдером.',
      // Имена переменных показываем, значения — нет: смысл строки в том,
      // ЧТО переопределено, а сами ставки видны на вкладке «Расходы»
      // рядом с версией прайса.
    });
  }

  // ── Оплата (ТЗ §41, этап 62) ──
  //
  // Независимо от PLANS_BILLING_ENABLED (та переменная — про
  // самостоятельное переключение бесплатных режимов, см. выше): покупка
  // подписки/пакета кредитов через `POST /billing/checkout/*` работает
  // сама по себе, свои ключи для каждого способа оплаты проверяет
  // `TelegramStarsService`/`WayForPayService` при первом обращении, а не
  // при старте — поэтому все проверки здесь `warning`, не `critical`:
  // без ключей маршруты оплаты просто отвечают понятной ошибкой, а не
  // валят сервис.

  {
    // ТЗ §41.3: первая входящая точка от Telegram в проекте — секрет из
    // `X-Telegram-Bot-Api-Secret-Token`, который сам Telegram эхом
    // присылает после `setWebhook` (см. doc/DEPLOYMENT.md). Формат тот
    // же, что у CRON_SECRET — сравнение constant-time, fail-closed.
    const raw = env.TELEGRAM_WEBHOOK_SECRET;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'TELEGRAM_WEBHOOK_SECRET',
      group: 'Оплата',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — POST /billing/webhook/telegram сверяет секрет constant-time. Убедитесь, что тот же секрет зарегистрирован в setWebhook (doc/DEPLOYMENT.md).'
        : 'Не задан — POST /billing/webhook/telegram отвечает 503 на любой запрос: покупки через Telegram Stars не будут завершаться (pre_checkout_query/successful_payment некому обработать).',
      // Значение не показываем — секрет.
    });
  }

  {
    // Не секрет: это же поле формы (merchantAccount), которое WayForPay
    // показывает плательщику на странице оплаты — прятать его в админке
    // смысла нет, а видеть, ЧТО именно задано, полезно при отладке.
    const raw = env.WAYFORPAY_MERCHANT_ACCOUNT;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'WAYFORPAY_MERCHANT_ACCOUNT',
      group: 'Оплата',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — используется в подписанной форме покупки и в проверке вебхука WayForPay.'
        : 'Не задан — оплата картой через WayForPay недоступна (POST /billing/checkout/* с method=WAYFORPAY вернёт понятную ошибку); Telegram Stars это не затрагивает.',
      value: raw ?? undefined,
    });
  }

  {
    const raw = env.WAYFORPAY_MERCHANT_SECRET;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'WAYFORPAY_MERCHANT_SECRET',
      group: 'Оплата',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — им подписывается форма покупки и проверяется подпись вебхука/квитанции WayForPay (HMAC-MD5, ТЗ §41.2).'
        : 'Не задан — оплата картой через WayForPay недоступна: без секрета нечем ни подписать форму, ни проверить, что вебхук действительно от WayForPay.',
      // Значение не показываем — секрет.
    });
  }

  {
    // Тоже не секрет — то же поле формы (merchantDomainName), что и
    // MERCHANT_ACCOUNT: домен, зарегистрированный в личном кабинете
    // WayForPay для этого мерчант-аккаунта.
    const raw = env.WAYFORPAY_DOMAIN;
    const set = Boolean(raw?.trim());
    results.push({
      key: 'WAYFORPAY_DOMAIN',
      group: 'Оплата',
      required: false,
      set,
      ok: set,
      severity: set ? 'ok' : 'warning',
      message: set
        ? 'Задан — должен совпадать с доменом, зарегистрированным в личном кабинете WayForPay для этого мерчант-аккаунта, иначе форма покупки будет отклонена.'
        : 'Не задан — оплата картой через WayForPay недоступна.',
      value: raw ?? undefined,
    });
  }

  {
    // Тот же формат, что CHANNEL_TOKEN_KEY (token-crypto.ts, этап 61):
    // 32 байта после base64-декода — этим ключом шифруется recToken
    // регулярных списаний WayForPay (Subscription.recTokenEnc) перед
    // тем, как лечь в базу. Свой ключ, не общий с CHANNEL_TOKEN_KEY: у
    // разных секретов разное время жизни и разные последствия утечки.
    const raw = env.PAYMENT_TOKEN_KEY;
    const set = Boolean(raw?.trim());
    let validFormat = false;
    if (set) {
      try {
        validFormat = Buffer.from(raw!.trim(), 'base64').length === 32;
      } catch {
        validFormat = false;
      }
    }
    // Аудит 2026-09-08, Г-6.1: было `!set || validFormat` — незаданный
    // ключ считался зелёным (`ok: true`), хотя сообщение ниже честно
    // говорит «автопродление недоступно» — то есть функция реально не
    // работает. Соседние проверки этой группы (WAYFORPAY_SECRET,
    // WAYFORPAY_DOMAIN выше) все считают незаданное необязательное поле
    // `ok: false`/`warning`, а не зелёным — здесь было единственное
    // исключение, из-за которого `env-settings.spec.ts` («без ключей все
    // пять проверок жёлтые») был красным на этом одном пункте.
    const ok = set && validFormat;
    results.push({
      key: 'PAYMENT_TOKEN_KEY',
      group: 'Оплата',
      required: false,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !set
        ? 'Не задан — автопродление подписки картой (WayForPay) недоступно: recToken негде хранить зашифрованным. Разовые покупки и Stars не затронуты (у Stars продление делает сам Telegram).'
        : validFormat
          ? 'Задан, формат похож на правильный (32 байта после base64-декода).'
          : 'Задан, но НЕ похож на 32 байта после base64-декода — шифрование recToken будет падать при каждой попытке. Сгенерировать: openssl rand -base64 32.',
      // Значение не показываем — секрет.
    });
  }

  // ── CORS ──

  {
    const raw = env.CORS_ORIGIN;
    const isDefaultLocalhost = !raw || raw.trim() === 'http://localhost:5173';
    const ok = !isProd || !isDefaultLocalhost;
    results.push({
      key: 'CORS_ORIGIN',
      group: 'CORS',
      required: isProd,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'critical',
      message: ok
        ? 'Разрешённые источники для CORS и для CSRF-проверки Origin у админ-сессии.'
        : 'В production не задан (или всё ещё localhost) — ни фронтенд, ни админка не смогут ходить в API.',
      value: raw ?? 'http://localhost:5173 (по умолчанию)',
    });
  }

  // ── Сессии ──

  {
    const raw = env.SESSION_TTL_HOURS;
    const ok = raw === undefined || (/^\d+$/.test(raw) && Number(raw) > 0);
    results.push({
      key: 'SESSION_TTL_HOURS',
      group: 'Сессии',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? 'Через сколько часов сессия считается истёкшей (см. cron cleanup-sessions).'
        : 'Задан, но не похож на положительное целое число.',
      value: raw ?? '24 (по умолчанию)',
    });
  }

  // Этап 51 (В-4.6): невостребованные разборы библиотеки живут не дольше
  // этого срока; 0 выключает чистку.
  {
    const raw = env.LIBRARY_UNUSED_TTL_DAYS;
    const ok = raw === undefined || /^\d+$/.test(raw);
    results.push({
      key: 'LIBRARY_UNUSED_TTL_DAYS',
      group: 'Сессии',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: ok
        ? raw === '0'
          ? 'Чистка невостребованных разборов библиотеки выключена — таблица растёт без ограничения.'
          : 'Через сколько дней разбор с нулём использований удаляется суточной уборкой (cron cleanup-sessions).'
        : 'Задан, но не похож на целое число дней.',
      value: raw ?? '180 (по умолчанию)',
    });
  }

  // ── Cron ──

  {
    // Этап 54 (Б-3.3): без секрета крон ЗАКРЫТ (503), а не открыт. На
    // dev-стенде его открывают те же два предохранителя, что dev-вход.
    const raw = env.CRON_SECRET;
    const set = Boolean(raw?.trim());
    const devStand = isDevAuthAllowed(env);
    const ok = set || devStand;
    results.push({
      key: 'CRON_SECRET',
      group: 'Cron',
      required: !devStand,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: set
        ? 'Задан — все три крон-маршрута (report, cleanup-sessions, sweep-orphans) сверяют Bearer-токен constant-time.'
        : devStand
          ? 'Не задан — на dev-стенде (ALLOW_DEV_AUTH=true вне production) крон открыт для curl.'
          : 'Не задан — крон-маршруты отвечают 503 и НЕ работают: ни отчёта, ни уборки сессий, ни метлы. Задайте значение (openssl rand -hex 16) и в Vercel, и здесь.',
      // Значение не показываем — секрет.
    });
  }

  // ── Telegram-логин ──

  {
    // ТЗ §28 (этап 45): два служебных канала. Не заданы — сервис молчит,
    // и это нормальное состояние стенда, а не ошибка; но на проде это
    // значит, что о сбое узнают от пользователя.
    const alerts = env.TELEGRAM_ALERTS_CHAT_ID;
    const stats = env.TELEGRAM_STATS_CHAT_ID;
    const bot = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
    for (const [key, raw, what] of [
      ['TELEGRAM_ALERTS_CHAT_ID', alerts, 'ошибок'],
      ['TELEGRAM_STATS_CHAT_ID', stats, 'статистики'],
    ] as Array<[string, string | undefined, string]>) {
      const set = Boolean(raw?.trim());
      results.push({
        key,
        group: 'Telegram-логин',
        required: false,
        set,
        ok: !set || bot,
        severity: !set ? 'warning' : bot ? 'ok' : 'warning',
        message: !set
          ? `Не задан — канал ${what} молчит, о сбоях узнают от пользователей.`
          : bot
            ? `Канал ${what} настроен: бот пишет в этот чат.`
            : `Чат задан, но TELEGRAM_BOT_TOKEN пуст — отправлять некому.`,
        value: raw ?? undefined,
      });
    }

    // Пороги сторожа остатков (этап 143, аудит того же этапа). Стоят
    // здесь не для полноты списка: ноль означает «не сторожить», и
    // выключенный нулём сторож не виден больше НИГДЕ — ни на
    // «Балансах», ни в истории крона иначе как числом «сторожили
    // ноль». Экран настроек это единственное место, где «сторож
    // выключен» можно увидеть, не зная, что его надо искать.
    for (const [key, raw, what] of [
      ['BALANCE_ALERT_USD', env.BALANCE_ALERT_USD, 'в долларах'],
      [
        'BALANCE_ALERT_ELEVENLABS_CHARACTERS',
        env.BALANCE_ALERT_ELEVENLABS_CHARACTERS,
        'в символах ElevenLabs',
      ],
      [
        'BALANCE_ALERT_SERPAPI_SEARCHES',
        env.BALANCE_ALERT_SERPAPI_SEARCHES,
        'в поисках SerpApi',
      ],
    ] as Array<[string, string | undefined, string]>) {
      const off = raw?.trim() === '0';
      const bad = raw !== undefined && !off && !isPositiveInt(raw.trim());
      results.push({
        key,
        group: 'Telegram-логин',
        required: false,
        set: raw !== undefined,
        ok: !bad,
        severity: bad ? 'warning' : off ? 'warning' : 'ok',
        message: bad
          ? 'Задан, но не похож на число — бэкенд молча возьмёт умолчание. Порог, про который вы думаете, что он свой, а он не свой, хуже отсутствующего.'
          : off
            ? `Ноль — сторож остатка ${what} ВЫКЛЮЧЕН целиком, включая сообщение «остаток не читается».`
            : `Порог остатка ${what}: ниже него крон balances-watch пишет в канал ошибок.`,
        value: raw ?? '(умолчание)',
      });
    }
  }

  {
    const raw = env.TELEGRAM_BOT_TOKEN;
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = !set || (!placeholder && looksLikeBotToken(raw!));
    results.push({
      key: 'TELEGRAM_BOT_TOKEN',
      group: 'Telegram-логин',
      required: false,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !set
        ? 'Не задан — настоящий Telegram-логин не работает, но dev-обход это не блокирует (см. doc/TELEGRAM-ADMIN.md).'
        : ok
          ? 'Задан, формат похож на настоящий bot-токен.'
          : placeholder
            ? 'Похоже на незаменённый плейсхолдер из .env.example.'
            : 'Задан, но формат не похож на настоящий bot-токен (ожидается вид "123456789:AA...").',
      // Значение не показываем — секрет.
    });
  }

  {
    const raw = env.ADMIN_LOGIN_BOT_TOKEN;
    const set = Boolean(raw?.trim());
    const placeholder = isPlaceholder(raw);
    const ok = !set || (!placeholder && looksLikeBotToken(raw!));
    results.push({
      key: 'ADMIN_LOGIN_BOT_TOKEN',
      group: 'Telegram-логин',
      required: false,
      set,
      ok,
      severity: ok ? 'ok' : 'warning',
      message: !set
        ? 'Не задан — Login Widget админки использует TELEGRAM_BOT_TOKEN (нужен отдельный токен только если у админки свой бот через /setdomain).'
        : ok
          ? 'Задан, формат похож на настоящий bot-токен.'
          : 'Задан, но формат не похож на настоящий bot-токен.',
      // Значение не показываем — секрет.
    });
  }

  // ── Dev-обход (только не-прод) ──

  {
    const raw = env.ALLOW_DEV_AUTH;
    const enabled = raw === 'true';
    const ok = !enabled || !isProd;
    results.push({
      key: 'ALLOW_DEV_AUTH',
      group: 'Dev-обход',
      required: false,
      set: raw !== undefined,
      ok,
      severity: ok ? (enabled ? 'warning' : 'ok') : 'critical',
      message: !ok
        ? 'КРИТИЧНО: включён вместе с NODE_ENV=production — открывает dev-вход в TMA и в /admin/auth/dev-login на проде. Уберите немедленно.'
        : enabled
          ? 'Включён — dev-вход в TMA и /admin/auth/dev-login открыт (второй предохранитель, NODE_ENV!=="production", пока держит).'
          : 'Выключен (или не задан) — dev-вход недоступен.',
      value: raw ?? 'false (по умолчанию)',
    });
  }

  {
    const raw = env.DEV_USER_ID;
    results.push({
      key: 'DEV_USER_ID',
      group: 'Dev-обход',
      required: false,
      set: raw !== undefined,
      ok: true,
      severity: 'ok',
      // В-6.25: бэкенд эту переменную поведенчески не читает — реально
      // работают VITE_DEV_USER_ID (TMA) и NEXT_PUBLIC_DEV_USER_ID (админка),
      // которые docker-compose.dev.yml выводит из неё. Строка здесь —
      // напоминание об этом, а не признак настройки сервера.
      message:
        'Стенд: значение, из которого docker-compose выводит VITE_DEV_USER_ID (TMA шлёт его как X-Dev-User-Id) и NEXT_PUBLIC_DEV_USER_ID (кнопка dev-входа админки). Сам бэкенд его не читает — dev-пользователь приходит заголовком.',
      value: raw ?? '123 (по умолчанию)',
    });
  }

  {
    // Версия сборки (этап 154). Не переменная настройки, а диагностика:
    // оператору нужно уметь ответить «на какой сборке это было», и
    // единственное место, где это видно человеку, — здесь. Наружу, в
    // `/health`, коммит не уходит: там записано «ни версий, ни имён
    // хостов», и отменять это ради удобства нельзя.
    const info = describeBuild(env);
    results.push({
      key: 'BUILD_ID',
      group: 'Версия',
      required: false,
      set: info.build !== 'dev',
      ok: true,
      severity: info.build === 'dev' ? 'warning' : 'ok',
      message:
        info.build === 'dev'
          ? 'Сборка неопознана: ни BUILD_ID, ни VERCEL_GIT_COMMIT_SHA. На стенде это норма, на проде — значит, что по тикету нельзя понять, на какой версии он снят.'
          : 'Версия, которую сервер сообщает о себе. Она же попадёт в тикеты тестировщиков.',
      value: info.build,
    });
  }

  return results;
}
