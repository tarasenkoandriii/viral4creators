/**
 * Общий лимит частоты по IP на серверные маршруты `/assist/v1/sites/*`
 * (Ш5 (11), аудит безопасности Ш5): API знаний (`assist-site-knowledge-api`)
 * и вебхук целей (`assist-analytics/goal-webhook`). Оба маршрута
 * @PublicRoute — подлинность только HMAC-подписью, и КАЖДЫЙ запрос, даже
 * без подписи или с чужой, до ответа 401 читает из базы и расшифровывает
 * секрет сайта. Лимиты сайта (60 / 120 в минуту) стоят ПОСЛЕ подписи и
 * перебор чужих id не держат — держит этот, ДО подписи:
 *
 *  1. `assist-v1-ip-min` — все запросы с адреса в минуту (`IP_PER_MINUTE`
 *     с запасом выше суммы лимитов одного сайта: честный бэкенд одного
 *     сайта в него не упирается);
 *  2. `assist-v1-ip-unsigned-min` — запросы с адреса, не прошедшие подпись
 *     (ответ 401: нет подписи, старая, чужая, нет сайта), в минуту. Выбран
 *     — до конца окна адрес получает 429 без чтения секрета.
 *
 * Адрес — `clientIp` (первый `x-forwarded-for`, как у остальных публичных
 * маршрутов sites-backend: за Vercel заголовок ставит платформа), ключ —
 * `ipLimitKey` (IPv6 — /64, mapped IPv4 — как IPv4), в базе — только хеш с
 * суточной солью (сырой IP нигде не хранится). Окна — строки
 * `assist_rate_buckets` (уборка — chat-retention по `expiresAt`), счёт —
 * одним условным `INSERT … ON CONFLICT DO UPDATE … WHERE count < limit`.
 * Сбой базы на лимитере не роняет маршрут в 500 — пропускает (подпись и
 * лимиты сайта остаются), как прочие счётчики «мягкой» защиты.
 */
import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, Observable, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { widgetIpSecret } from '../config/widget-env';
import { PrismaService } from '../prisma/prisma.service';
import { hashIpWithDailySalt } from '../shared/assist-chat-core';
import { ipLimitKey } from '../modules/assist-sandbox/sandbox-limits';
import { clientIp } from '../modules/telegram-auth/web/web-request';

export const ASSIST_V1_IP_LIMITS = {
  /** Все запросы `/assist/v1/sites/*` с адреса в минуту. */
  perMinute: 300,
  /** Из них — не прошедших подпись (401) в минуту. */
  unsignedPerMinute: 30,
  windowMs: 60_000,
} as const;

export type AssistV1Scope = 'assist-v1-ip-min' | 'assist-v1-ip-unsigned-min';

const LABEL = 'assist-v1';

/** Ключ адреса для счётчиков: хеш ключа лимита с суточной солью. */
export function assistV1IpKey(
  ip: string,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const secret = widgetIpSecret(env) ?? 'no-secret';
  return hashIpWithDailySalt(ipLimitKey(ip), `${secret}:${LABEL}`, now);
}

export function assistV1Window(
  now: Date,
  windowMs: number = ASSIST_V1_IP_LIMITS.windowMs,
): { bucket: string; endsAt: Date } {
  const start = Math.floor(now.getTime() / windowMs) * windowMs;
  return {
    bucket: new Date(start).toISOString(),
    endsAt: new Date(start + windowMs),
  };
}

export function assistV1RateLimited(retryAfterMs: number): HttpException {
  return new HttpException(
    {
      error: 'RATE_LIMITED',
      code: 'RATE_LIMITED',
      message: 'Слишком много запросов с этого адреса — повторите через минуту',
      retryAfterMs,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function statusOf(e: unknown): number | null {
  return e instanceof HttpException ? e.getStatus() : null;
}

@Injectable()
export class AssistV1IpLimit implements NestInterceptor {
  private readonly logger = new Logger(AssistV1IpLimit.name);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();
  limits: { perMinute: number; unsignedPerMinute: number; windowMs: number } = {
    ...ASSIST_V1_IP_LIMITS,
  };

  constructor(private readonly prisma: PrismaService) {}

  /** Счёт окна: true — уложились (счётчик увеличен). */
  private async hit(
    scope: AssistV1Scope,
    key: string,
    limit: number,
    now: Date,
  ): Promise<boolean> {
    const { bucket, endsAt } = assistV1Window(now, this.limits.windowMs);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT ("scope", "key", "bucket") DO UPDATE
         SET "count" = "sites"."assist_rate_buckets"."count" + 1
         WHERE "sites"."assist_rate_buckets"."count" < $5
       RETURNING "count"`,
      scope,
      key,
      bucket,
      endsAt,
      limit,
    );
    return rows.length === 1;
  }

  private async unsignedCount(key: string, now: Date): Promise<number> {
    const { bucket } = assistV1Window(now, this.limits.windowMs);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT "count" FROM "sites"."assist_rate_buckets"
        WHERE "scope" = 'assist-v1-ip-unsigned-min' AND "key" = $1 AND "bucket" = $2`,
      key,
      bucket,
    );
    return rows[0]?.count ?? 0;
  }

  /**
   * До подписи: адрес не выбрал ни окно неподписанных, ни общее. Бросает
   * 429; сбой базы — пропуск (лог).
   */
  async before(key: string, now: Date): Promise<void> {
    let ok = true;
    try {
      ok =
        (await this.unsignedCount(key, now)) < this.limits.unsignedPerMinute &&
        (await this.hit('assist-v1-ip-min', key, this.limits.perMinute, now));
    } catch (e) {
      this.logger.warn(`лимит по IP: сбой счётчика (${(e as Error).name})`);
      return;
    }
    if (!ok) {
      const { endsAt } = assistV1Window(now, this.limits.windowMs);
      throw assistV1RateLimited(Math.max(0, endsAt.getTime() - now.getTime()));
    }
  }

  /** Запрос не прошёл подпись — в окно неподписанных (без потолка: счёт). */
  async failed(key: string, now: Date): Promise<void> {
    const { bucket, endsAt } = assistV1Window(now, this.limits.windowMs);
    await this.prisma
      .$executeRawUnsafe(
        `INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
         VALUES ('assist-v1-ip-unsigned-min', $1, $2, 1, $3)
         ON CONFLICT ("scope", "key", "bucket") DO UPDATE
           SET "count" = "sites"."assist_rate_buckets"."count" + 1`,
        key,
        bucket,
        endsAt,
      )
      .catch((e: Error) =>
        this.logger.warn(`лимит по IP: сбой счёта отказа (${e.name})`),
      );
  }

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    const req = http.getRequest<Request>();
    const now = this.now();
    const key = assistV1IpKey(clientIp(req), now, this.env);
    try {
      await this.before(key, now);
    } catch (e) {
      const res = http.getResponse<Response | undefined>();
      const ms = (
        (e as HttpException).getResponse?.() as { retryAfterMs?: number }
      )?.retryAfterMs;
      if (res?.setHeader && typeof ms === 'number') {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
      }
      throw e;
    }
    return next
      .handle()
      .pipe(
        catchError((e: unknown) =>
          statusOf(e) === HttpStatus.UNAUTHORIZED
            ? from(this.failed(key, now)).pipe(
                mergeMap(() => throwError(() => e)),
              )
            : throwError(() => e),
        ),
      );
  }
}
