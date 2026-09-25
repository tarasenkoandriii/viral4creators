/**
 * Ограничение частоты запросов — в базе, а не в памяти (этап 54, Б-3.7).
 *
 * ## Почему не `@nestjs/throttler`
 *
 * Готовый троттлер держит счётчики в памяти экземпляра. На Vercel
 * экземпляров много и живут они недолго, то есть каждый видит малую долю
 * запросов и обнуляется, не досчитав: лимит «30 в минуту» превращается в
 * «30 в минуту на каждый холодный старт», и перебор его не замечает.
 * Это ровно тот класс ошибок, который закрывал этап 47 (ТЗ §30: состояние
 * живёт в базе, а не в экземпляре) — заводить его обратно ради готовой
 * библиотеки было бы странно. Redis у проекта нет и не появится ради
 * этого; Postgres уже есть.
 *
 * ## Как считается
 *
 * Фиксированные окна: ключ `маршрут|IP`, окно — начало текущей минуты
 * (или другого шага). Один запрос к базе на проверку:
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING count` — либо заводит
 * строку, либо прибавляет единицу, либо начинает новое окно, если старое
 * закончилось. Атомарно для всех экземпляров сразу, как `alert_states`.
 * Фиксированное окно пропускает до 2×лимита на стыке минут — для брейка
 * от перебора это приемлемо, для тарификации было бы нет; здесь первое.
 *
 * ## Где стоит
 *
 * Не на всём API — лишний запрос к базе на каждом вызове стоил бы дороже
 * защиты, а на дорогих маршрутах (генерация, разбор) уже стоят свои
 * барьеры: атомарные замки этапа 47 и суточные потолки §26.4. Ставится
 * там, где вызов дешёвый для нас, но неограниченный для чужого: создание
 * сессии (строка в базе с каждого запроса) и входы через Telegram (там
 * перебирают подписи).
 *
 * ## Два окна на одном маршруте (ассистент на лендинге, ТЗ §7.1)
 *
 * `@RateLimit()` принимает и одно правило (как раньше — все существующие
 * маршруты не меняются), и массив правил на случай, когда узкое окно
 * (10/мин — не дать одному человеку залить чат вопросами) недостаточно
 * само по себе (10 запросов в минуту весь час подряд — тоже слишком
 * много для бесплатного анонимного чата). Гвард проверяет ВСЕ правила по
 * очереди одним и тем же ключом `${name}|${ip}` (имя правила своё у
 * каждого — окна не складываются друг с другом); первое сработавшее
 * останавливает запрос 429-м.
 *
 * ## Почему отказ базы ПРОПУСКАЕТ запрос
 *
 * Ограничитель — тормоз от злоупотребления, а не дверь. Если база не
 * отвечает, то не работает и всё остальное; закрыть вход из-за того, что
 * не удалось посчитать, значило бы превратить сбой базы в отказ входа
 * без выигрыша в безопасности. Пишем warn и пропускаем.
 */

import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

export interface RateLimitRule {
  /** Сколько запросов на один ключ за окно. */
  limit: number;
  /** Длина окна в секундах. */
  windowSec: number;
  /** Имя маршрута в ключе — чтобы лимиты разных маршрутов не складывались. */
  name: string;
  /**
   * По чему считать: по адресу (умолчание) или по вошедшему человеку
   * (аудит этапа 148).
   *
   * Адрес — верный ключ там, где человека ещё нет: регистрация,
   * публичные формы. Но в мини-аппе за одним адресом сидит целый
   * оператор сотовой связи, и лимит на платное действие, посчитанный по
   * адресу, мешает не тому: соседи по NAT выбирают чужое окно, а один
   * настойчивый меняет адрес и обходит.
   *
   * `user` считает по `telegramUserId`. Анонимный запрос откатывается к
   * адресу — иначе все безымянные сложились бы в одно окно, и первый же
   * гость закрыл бы вход остальным.
   */
  by?: 'ip' | 'user';
}

export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Правило (или несколько) для маршрута; применяется вместе с
 * `@UseGuards(RateLimitGuard)`. Один объект — как везде до сих пор;
 * массив — второе, более широкое окно на том же маршруте (§7.1 ТЗ
 * ассистента на лендинге).
 */
export const RateLimit = (rule: RateLimitRule | RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_KEY, rule);

export const RATE_LIMIT_MESSAGE =
  'Слишком много запросов с вашего адреса. Подождите минуту и попробуйте снова.';

/** Строки старше этого — мусор: любое окно давно закрылось. */
const STATE_MAX_AGE_MS = 60 * 60 * 1000;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.get<
      RateLimitRule | RateLimitRule[] | undefined
    >(RATE_LIMIT_KEY, context.getHandler());
    if (!metadata) return true;
    const rules = Array.isArray(metadata) ? metadata : [metadata];

    const req = context
      .switchToHttp()
      .getRequest<Request & { telegramUserId?: string }>();
    const ip = clientIp(req);
    const now = new Date();

    // Все правила проверяются, а не только первое сработавшее окно —
    // иначе снятие узкого лимита само по себе ведёт лишний INSERT ради
    // окна, которое всё равно не решает.
    for (const rule of rules) {
      const who =
        rule.by === 'user' && req.telegramUserId
          ? `u:${req.telegramUserId}`
          : ip;
      const verdict = await this.hit(`${rule.name}|${who}`, rule, now);
      if (verdict.count > rule.limit) {
        const res = context.switchToHttp().getResponse<Response>();
        res.setHeader('Retry-After', String(verdict.retryAfterSec));
        this.logger.warn(
          `${rule.name}: ${verdict.count} запросов за окно от ${who} при лимите ${rule.limit}`,
        );
        throw new HttpException(
          RATE_LIMIT_MESSAGE,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    return true;
  }

  /** Один запрос: завести, прибавить или начать новое окно. */
  private hit(
    key: string,
    rule: RateLimitRule,
    now: Date,
  ): Promise<{ count: number; retryAfterSec: number }> {
    return hitRateLimit(this.prisma, key, rule.windowSec, now, this.logger);
  }
}

/**
 * Счёт одного обращения в окне — тот же, что у гварда (этап 157).
 *
 * Вынесено из гварда, потому что появился путь БЕЗ HTTP-контекста:
 * входящее бота (`docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.2). Вход
 * в бота — по сути незалогиненный: там нет ни запроса, ни ответа, в
 * который можно положить `Retry-After`, ни 429, который клиент поймёт.
 * Но счётчик нужен тот же самый — второй, свой, разошёлся бы с этим
 * молча, а окна и уборка (`pruneRateLimits`) у них общие.
 *
 * Возвращает `count: 0`, когда счётчик недоступен: база легла — это не
 * повод отказывать человеку, у отказа из-за неработающей проверки цена
 * выше, чем у пропущенного лишнего сообщения.
 */
export async function hitRateLimit(
  prisma: PrismaService,
  key: string,
  windowSec: number,
  now: Date = new Date(),
  logger?: Logger,
): Promise<{ count: number; retryAfterSec: number }> {
  const windowMs = windowSec * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const retryAfterSec = Math.max(
    1,
    Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
  );
  try {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO "rate_limits" ("key", "windowStart", "count")
      VALUES (${key}, ${windowStart}, 1)
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN "rate_limits"."windowStart" = ${windowStart} THEN "rate_limits"."count" + 1
          ELSE 1 END,
        "windowStart" = ${windowStart}
      RETURNING "count"
    `;
    return { count: Number(rows[0]?.count ?? 1), retryAfterSec };
  } catch (error) {
    logger?.warn(
      `счётчик частоты недоступен, запрос пропущен: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { count: 0, retryAfterSec };
  }
}

/** Уборка для крона: строки, чьё окно закрылось час назад и раньше. */
export async function pruneRateLimits(
  prisma: PrismaService,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STATE_MAX_AGE_MS);
  return prisma.$executeRaw`
    DELETE FROM "rate_limits" WHERE "windowStart" < ${cutoff}
  `;
}

/**
 * Адрес клиента за прокси Vercel: первый элемент `x-forwarded-for`
 * выставляет сама платформа, подделать его снаружи нельзя — свой заголовок
 * клиента Vercel затирает. Локально и в Docker заголовка нет — берём
 * адрес сокета.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidate = first?.split(',')[0]?.trim();
  return candidate || req.ip || req.socket?.remoteAddress || 'unknown';
}
