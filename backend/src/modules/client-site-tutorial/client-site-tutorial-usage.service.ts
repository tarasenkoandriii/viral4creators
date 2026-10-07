/**
 * Дневные лимиты визарда обучалки по сайту заказчика (§9 ТЗ, этап 111).
 *
 * ## Почему отдельная таблица, а не `AiUsage`
 *
 * §9 ТЗ решает это явно: «Заводится собственный счётчик использования
 * (аналог `AiUsage` по форме… но НЕ через `common/ai-pricing.ts`/
 * `AiOperation`, так как здесь нет вызова ИИ)». Дорог здесь не токен
 * модели, а секунды владения контейнером с Chromium: каждый раунд —
 * свежий запуск браузера (~3 секунды холодного старта плюс сама
 * страница), а live-вход держит браузер минутами.
 *
 * ## Почему `INSERT … ON CONFLICT … WHERE`, а не «прочитать и увеличить»
 *
 * Тот же довод, что уже записан в `SerpApiUsage`/`YoutubeSearchUsage`:
 * между чтением и записью помещается второй запрос, и пользователь,
 * открывший визард в двух вкладках, спокойно перебирает лимит. Один
 * запрос с условием в `ON CONFLICT` берёт блокировку строки, параллельный
 * ждёт; ноль затронутых строк означает «лимит выбран» — без отдельного
 * чтения.
 *
 * Слот занимается ДО дорогой операции и возвращается `releaseRound()`,
 * если она в итоге не состоялась (упал запуск браузера, сайт не
 * ответил) — перерасход невозможен, в худшем случае пользователь на
 * секунду видит на единицу меньше остатка, чем есть.
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { hitRateLimit } from '../../common/rate-limit';

/**
 * Значения по умолчанию §9 ТЗ не задаёт — только требует, чтобы лимиты
 * БЫЛИ («дневной лимит НА ПОЛЬЗОВАТЕЛЯ на число раундов» и «отдельный
 * дневной лимит именно на live-сессии»). Выбраны здесь, с обоснованием:
 *
 * - 60 раундов в сутки — это примерно два полных сценария по 30 шагов
 *   (`MAX_DRAFT_STEPS`), то есть «записал обучалку, не понравилось,
 *   переписал заново» укладывается, а бесконечный перебор — нет.
 * - 10 live-сессий в сутки: каждая держит браузер на чужом контейнере до
 *   трёх минут (§7.4.4 п.5) и занимает место под общим потолком реле
 *   (`MAX_CONCURRENT_SESSIONS`, по умолчанию тоже 10). Десять таких
 *   попыток на человека в день — заведомо больше, чем нужно для
 *   честной работы, и заведомо меньше, чем нужно, чтобы занять реле
 *   одному пользователю надолго.
 *
 * Обе переопределяются переменными окружения — как и все остальные
 * дневные лимиты этого проекта.
 */
export const DEFAULT_ROUNDS_PER_DAY = 60;
export const DEFAULT_LIVE_SESSIONS_PER_DAY = 10;

/**
 * П-Т9 (I-Н, принят с оговоркой 06.10.2026): глобальный суточный потолок
 * — общий для всех режимов и «с запасом выше обычной нагрузки». 5000
 * раундов — это 83 человека, выбравших свой суточный лимит целиком
 * (60), то есть заметно выше любой честной нагрузки запуска; 300 живых
 * сессий — 30 человек по 10 при потолке реле 10 одновременных. Порядок
 * источников: `PlatformSetting` (оператор, без редеплоя) → env → эти
 * значения.
 */
export const DEFAULT_GLOBAL_ROUNDS_PER_DAY = 5000;
export const DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY = 300;

/** Ключи `PlatformSetting` П-Т9 (`platform_settings`, без миграции). */
export const SITE_TUTORIAL_PAUSED_KEY = 'site_tutorial_paused';
export const SITE_TUTORIAL_GLOBAL_ROUNDS_KEY =
  'site_tutorial_global_rounds_per_day';
export const SITE_TUTORIAL_GLOBAL_LIVE_KEY =
  'site_tutorial_global_live_sessions_per_day';
/** Сколько держится прочитанная настройка в памяти экземпляра. */
export const SETTINGS_CACHE_MS = 15_000;

/**
 * П-Т6: не больше стольких РАЗНЫХ логинов на хост у пользователя за
 * `LOGIN_IDENTITY_WINDOW_DAYS` (порог «≥ 10» — решение «максимальный
 * профит» 06.10.2026: у сайта бывает 4+ ролей, гость/покупатель/менеджер/
 * админ). Лимит от перебора чужих логинов (credential stuffing с IP
 * сервера), не ворота режима B.
 */
export const LOGIN_IDENTITIES_PER_HOST = 10;
export const LOGIN_IDENTITY_WINDOW_DAYS = 30;
/**
 * Строки П-Т6 живут в той же таблице `client_site_tutorial_usage` (без
 * миграции): `day` = `li:<HMAC хоста>:<HMAC логина>`, `rounds`/
 * `liveSessions` = 0 (суммы П-Т9 они не трогают), `updatedAt` — последнее
 * использование. Ни хоста, ни логина открытым текстом. Старше окна —
 * убирает крон `client-site-retention`.
 */
export const LOGIN_IDENTITY_DAY_PREFIX = 'li:';

/**
 * П-Т8: не больше стольких НЕУДАЧНЫХ входов за `LOGIN_FAILURE_WINDOW_SEC`
 * — на пользователя и хост (сильнее, чем «на черновик» из текста: черновик
 * можно удалить и начать заново, счёт при этом не обнулится). Удачный
 * вход счёт сбрасывает. Хранение — `rate_limits` (окно от ПЕРВОЙ неудачи,
 * строку закрывшегося окна убирает общий `pruneRateLimits`).
 */
export const LOGIN_FAILURES_PER_WINDOW = 2;
export const LOGIN_FAILURE_WINDOW_SEC = 60 * 60;

/**
 * Ш1-хвост (L5780): «Это мой сайт» (`/verify-site`) — не чаще стольких
 * раз в час на человека: каждый вызов — подписанный запрос в
 * sites-backend и строка `pending` в кабинете сайтов.
 */
export const VERIFY_SITE_PER_HOUR = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC-сутки строкой — тот же приём и тот же формат, что у
 * `SerpApiUsage`: точный ключ без таймзонных сюрпризов `DateTime`. */
function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function positiveIntFromEnv(raw: string | undefined, fallback: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Решение П-Т9 перед раундом/живой сессией. */
export type GlobalAvailability = 'ok' | 'paused' | 'global_limit';

export interface UsageSnapshot {
  rounds: number;
  liveSessions: number;
  roundsLimit: number;
  liveSessionsLimit: number;
}

@Injectable()
export class ClientSiteTutorialUsageService {
  private readonly logger = new Logger(ClientSiteTutorialUsageService.name);

  /** Тесты подменяют env и часы кэша настроек. */
  env: NodeJS.ProcessEnv = process.env;
  private readonly settingsCache = new Map<
    string,
    { value: string | null; expiresAt: number }
  >();
  private warnedNoLoginSecret = false;

  /**
   * Секрет для хешей ключей П-Т6/П-Т8 (отметки `li:` живут 30 дней — по
   * ним нельзя давать перебрать хост/логин словарём). Производный от
   * `SITE_TUTORIAL_TOKEN_KEY` — он на проде обязателен для самой фичи
   * (`requireSecretKey()` в оркестраторе роняет explore/login без него),
   * поэтому НЕ фолбэчим на `CRON_SECRET`/публичную соль, как общий
   * rate-limit. Без ключа (dev) — фиксированная соль и один warn: ломать
   * локальный запуск незачем, а на проде ключ есть.
   */
  private loginKeySecret(): string {
    const raw = this.env.SITE_TUTORIAL_TOKEN_KEY?.trim();
    if (raw) {
      return createHmac('sha256', raw)
        .update('site-tutorial-login-identity-v1')
        .digest('hex');
    }
    if (!this.warnedNoLoginSecret) {
      this.warnedNoLoginSecret = true;
      this.logger.warn(
        'SITE_TUTORIAL_TOKEN_KEY не задан — отметки лимитов входа (П-Т6/П-Т8) считаются с dev-солью; на проде ключ обязателен',
      );
    }
    return 'dev-only-site-tutorial-login-salt';
  }

  /** Хеш подлежащего (хост, логин, пользователь) ключом обучалки. */
  private subject(...parts: string[]): string {
    return createHmac('sha256', this.loginKeySecret())
      .update(parts.join('|'))
      .digest('hex');
  }

  constructor(private readonly prisma: PrismaService) {}

  get roundsLimit(): number {
    return positiveIntFromEnv(
      process.env.SITE_TUTORIAL_ROUNDS_PER_DAY,
      DEFAULT_ROUNDS_PER_DAY,
    );
  }

  get liveSessionsLimit(): number {
    return positiveIntFromEnv(
      process.env.SITE_TUTORIAL_LIVE_SESSIONS_PER_DAY,
      DEFAULT_LIVE_SESSIONS_PER_DAY,
    );
  }

  /** Занимает слот раунда. `false` — дневной лимит выбран. */
  async reserveRound(userId: string, now: Date = new Date()): Promise<boolean> {
    const day = utcDay(now);
    const limit = this.roundsLimit;
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "client_site_tutorial_usage" ("id", "userId", "day", "rounds", "liveSessions", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${day}, 1, 0, NOW())
      ON CONFLICT ("userId", "day") DO UPDATE
        SET "rounds" = "client_site_tutorial_usage"."rounds" + 1, "updatedAt" = NOW()
        WHERE "client_site_tutorial_usage"."rounds" < ${limit}
    `;
    return affected > 0;
  }

  /** Возврат слота, если раунд так и не состоялся (браузер не
   * запустился, сайт не ответил). Ниже нуля не опускаемся — лишний
   * возврат не должен дарить квоту. */
  async releaseRound(userId: string, now: Date = new Date()): Promise<void> {
    const day = utcDay(now);
    await this.prisma.$executeRaw`
      UPDATE "client_site_tutorial_usage"
      SET "rounds" = GREATEST("rounds" - 1, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${day}
    `;
  }

  /** То же самое для live-сессий входа — отдельный, более дорогой
   * ресурс (§7.4.8). */
  async reserveLiveSession(
    userId: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const day = utcDay(now);
    const limit = this.liveSessionsLimit;
    const affected = await this.prisma.$executeRaw`
      INSERT INTO "client_site_tutorial_usage" ("id", "userId", "day", "rounds", "liveSessions", "updatedAt")
      VALUES (gen_random_uuid()::text, ${userId}, ${day}, 0, 1, NOW())
      ON CONFLICT ("userId", "day") DO UPDATE
        SET "liveSessions" = "client_site_tutorial_usage"."liveSessions" + 1, "updatedAt" = NOW()
        WHERE "client_site_tutorial_usage"."liveSessions" < ${limit}
    `;
    return affected > 0;
  }

  async releaseLiveSession(
    userId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const day = utcDay(now);
    await this.prisma.$executeRaw`
      UPDATE "client_site_tutorial_usage"
      SET "liveSessions" = GREATEST("liveSessions" - 1, 0), "updatedAt" = NOW()
      WHERE "userId" = ${userId} AND "day" = ${day}
    `;
  }

  // ── П-Т9: выключатель и глобальный суточный потолок ──────────────────

  /**
   * Значение `PlatformSetting` с коротким кэшем экземпляра (тот же приём и
   * тот же срок, что у `PlatformSettingsService`). Сбой базы — `null`:
   * выключатель — тормоз на инцидент, а не дверь, и недоступная настройка
   * не должна закрывать обучалку всем.
   */
  private async setting(key: string): Promise<string | null> {
    const hit = this.settingsCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    let value: string | null = null;
    try {
      const row = (await this.prisma.platformSetting.findUnique({
        where: { key },
      })) as { value: string } | null;
      value = row?.value ?? null;
    } catch (err) {
      this.logger.warn(
        `настройка ${key} не прочитана (${(err as Error)?.name ?? 'Error'}) — считаем незаданной`,
      );
    }
    this.settingsCache.set(key, {
      value,
      expiresAt: Date.now() + SETTINGS_CACHE_MS,
    });
    return value;
  }

  /** Выключатель из админки: `true`/`1`/`on`/`yes` — обучалка на паузе. */
  async paused(): Promise<boolean> {
    const raw = (await this.setting(SITE_TUTORIAL_PAUSED_KEY))
      ?.trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
  }

  async globalRoundsLimit(): Promise<number> {
    return positiveIntFromEnv(
      (await this.setting(SITE_TUTORIAL_GLOBAL_ROUNDS_KEY)) ?? undefined,
      positiveIntFromEnv(
        this.env.SITE_TUTORIAL_GLOBAL_ROUNDS_PER_DAY,
        DEFAULT_GLOBAL_ROUNDS_PER_DAY,
      ),
    );
  }

  async globalLiveSessionsLimit(): Promise<number> {
    return positiveIntFromEnv(
      (await this.setting(SITE_TUTORIAL_GLOBAL_LIVE_KEY)) ?? undefined,
      positiveIntFromEnv(
        this.env.SITE_TUTORIAL_GLOBAL_LIVE_SESSIONS_PER_DAY,
        DEFAULT_GLOBAL_LIVE_SESSIONS_PER_DAY,
      ),
    );
  }

  /**
   * Можно ли сейчас поднимать браузер (`round`) или живую сессию (`live`)
   * — по выключателю и по сумме за UTC-сутки по ВСЕМ пользователям. Чтение
   * отдельно от резерва: потолок «с запасом», и перебор на число
   * одновременных запросов на стыке ему не страшен (в отличие от
   * личного лимита, который остаётся атомарным). Сбой подсчёта —
   * пропускаем (тот же довод, что у выключателя).
   */
  async availability(
    kind: 'round' | 'live',
    now: Date = new Date(),
  ): Promise<GlobalAvailability> {
    if (await this.paused()) return 'paused';
    const day = utcDay(now);
    const limit =
      kind === 'round'
        ? await this.globalRoundsLimit()
        : await this.globalLiveSessionsLimit();
    try {
      const rows =
        kind === 'round'
          ? await this.prisma.$queryRaw<Array<{ n: number | bigint | null }>>`
              SELECT COALESCE(SUM("rounds"), 0)::int AS "n"
              FROM "client_site_tutorial_usage" WHERE "day" = ${day}
            `
          : await this.prisma.$queryRaw<Array<{ n: number | bigint | null }>>`
              SELECT COALESCE(SUM("liveSessions"), 0)::int AS "n"
              FROM "client_site_tutorial_usage" WHERE "day" = ${day}
            `;
      const used = Number(rows[0]?.n ?? 0);
      return used >= limit ? 'global_limit' : 'ok';
    } catch (err) {
      this.logger.warn(
        `глобальный счёт обучалки недоступен (${(err as Error)?.name ?? 'Error'}) — пропускаем`,
      );
      return 'ok';
    }
  }

  // ── П-Т6: разные логины на хост ─────────────────────────────────────

  /** Ключ строки П-Т6 и префикс хоста — HMAC, без открытого текста. */
  loginIdentityKeys(
    host: string,
    login: string,
  ): { prefix: string; key: string } {
    const hostKey = this.subject('stl-host', host.toLowerCase()).slice(0, 24);
    const loginKey = this.subject(
      'stl-login',
      host.toLowerCase(),
      login.trim().toLowerCase(),
    ).slice(0, 24);
    const prefix = `${LOGIN_IDENTITY_DAY_PREFIX}${hostKey}:`;
    return { prefix, key: `${prefix}${loginKey}` };
  }

  /**
   * Отметить логин на хосте. `false` — это НОВЫЙ логин, а разных уже
   * `LOGIN_IDENTITIES_PER_HOST` за окно (отказ). Уже известный логин
   * проходит всегда. Один условный запрос: строка заводится только если
   * логин известен или счёт в окне меньше порога.
   */
  async reserveLoginIdentity(
    userId: string,
    host: string,
    login: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const { prefix, key } = this.loginIdentityKeys(host, login);
    const since = new Date(now.getTime() - LOGIN_IDENTITY_WINDOW_DAYS * DAY_MS);
    const like = `${prefix}%`;
    const limit = LOGIN_IDENTITIES_PER_HOST;
    // Советская блокировка на (пользователь, хост) внутри транзакции:
    // без неё два параллельных INSERT оба проходили COUNT < limit и
    // заводили 11-ю и 12-ю отметки (проверено). Лок сериализует проверку
    // и вставку по одному ключу, не трогая остальных.
    const lockKey = `stl-id:${this.subject('lock', userId, host.toLowerCase())}`;
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const affected = await tx.$executeRaw`
          INSERT INTO "client_site_tutorial_usage" ("id", "userId", "day", "rounds", "liveSessions", "updatedAt")
          SELECT gen_random_uuid()::text, ${userId}, ${key}, 0, 0, NOW()
          WHERE EXISTS (
              SELECT 1 FROM "client_site_tutorial_usage"
              WHERE "userId" = ${userId} AND "day" = ${key} AND "updatedAt" > ${since}
            )
            OR (
              SELECT COUNT(*) FROM "client_site_tutorial_usage"
              WHERE "userId" = ${userId} AND "day" LIKE ${like} AND "updatedAt" > ${since}
            ) < ${limit}
          ON CONFLICT ("userId", "day") DO UPDATE SET "updatedAt" = NOW()
        `;
        return affected > 0;
      });
    } catch (err) {
      this.logger.warn(
        `счёт логинов обучалки недоступен (${(err as Error)?.name ?? 'Error'}) — вход пропущен`,
      );
      return true;
    }
  }

  // ── П-Т8: неудачные входы ───────────────────────────────────────────

  private loginFailureKey(userId: string, host: string): string {
    return `stl-login-fail|${this.subject('u', userId, host.toLowerCase())}`;
  }

  /**
   * Сколько ждать до следующей попытки входа (мс); 0 — можно. Окно — от
   * ПЕРВОЙ неудачи, не календарный час: «попробуйте через N мин» честное.
   */
  async loginRetryAfterMs(
    userId: string,
    host: string,
    now: Date = new Date(),
  ): Promise<number> {
    const windowMs = LOGIN_FAILURE_WINDOW_SEC * 1000;
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ count: number; windowStart: Date }>
      >`
        SELECT "count", "windowStart" FROM "rate_limits"
        WHERE "key" = ${this.loginFailureKey(userId, host)}
      `;
      const row = rows[0];
      if (!row) return 0;
      const ends = new Date(row.windowStart).getTime() + windowMs;
      if (ends <= now.getTime()) return 0;
      return Number(row.count) >= LOGIN_FAILURES_PER_WINDOW
        ? ends - now.getTime()
        : 0;
    } catch (err) {
      this.logger.warn(
        `счёт неудачных входов обучалки недоступен (${(err as Error)?.name ?? 'Error'}) — вход пропущен`,
      );
      return 0;
    }
  }

  /** Неудачный вход: +1 в окне от первой неудачи (или новое окно). */
  async recordLoginFailure(
    userId: string,
    host: string,
    now: Date = new Date(),
  ): Promise<void> {
    const since = new Date(now.getTime() - LOGIN_FAILURE_WINDOW_SEC * 1000);
    try {
      await this.prisma.$executeRaw`
        INSERT INTO "rate_limits" ("key", "windowStart", "count")
        VALUES (${this.loginFailureKey(userId, host)}, ${now}, 1)
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE
            WHEN "rate_limits"."windowStart" > ${since} THEN "rate_limits"."count" + 1
            ELSE 1 END,
          "windowStart" = CASE
            WHEN "rate_limits"."windowStart" > ${since} THEN "rate_limits"."windowStart"
            ELSE ${now} END
      `;
    } catch (err) {
      this.logger.warn(
        `неудачный вход обучалки не посчитан (${(err as Error)?.name ?? 'Error'})`,
      );
    }
  }

  /** Удачный вход сбрасывает счёт неудач. */
  async clearLoginFailures(userId: string, host: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "rate_limits" WHERE "key" = ${this.loginFailureKey(userId, host)}
      `;
    } catch {
      // Не сбросили — окно истечёт само.
    }
  }

  // ── Ш1-хвост: частота «Это мой сайт» ────────────────────────────────

  /** Через сколько мс можно снова (0 — можно сейчас; вызов засчитан). */
  async hitVerifySite(userId: string, now: Date = new Date()): Promise<number> {
    const key = `stl-verify-site|${this.subject('u', userId)}`;
    const verdict = await hitRateLimit(
      this.prisma,
      key,
      3600,
      now,
      this.logger,
    );
    return verdict.count > VERIFY_SITE_PER_HOUR
      ? verdict.retryAfterSec * 1000
      : 0;
  }

  /** Остаток на сегодня — для экрана визарда, чтобы «лимит исчерпан»
   * не было сюрпризом посреди работы. */
  async snapshot(
    userId: string,
    now: Date = new Date(),
  ): Promise<UsageSnapshot> {
    const day = utcDay(now);
    const row = await this.prisma.clientSiteTutorialUsage.findUnique({
      where: { userId_day: { userId, day } },
    });
    return {
      rounds: row?.rounds ?? 0,
      liveSessions: row?.liveSessions ?? 0,
      roundsLimit: this.roundsLimit,
      liveSessionsLimit: this.liveSessionsLimit,
    };
  }
}
