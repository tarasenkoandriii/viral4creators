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
import { PrismaService } from '../../prisma/prisma.service';

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

export interface UsageSnapshot {
  rounds: number;
  liveSessions: number;
  roundsLimit: number;
  liveSessionsLimit: number;
}

@Injectable()
export class ClientSiteTutorialUsageService {
  private readonly logger = new Logger(ClientSiteTutorialUsageService.name);

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
