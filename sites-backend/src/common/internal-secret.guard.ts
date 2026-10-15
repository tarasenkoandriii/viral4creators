/**
 * Внутренний API для админки платформы — генератор (`backend/`,
 * admin-panel) ходит сюда сервер-сервер, без DSN к схеме `sites` (аудит
 * слияния §3.0 п.2). Секрет — заголовок `X-Sites-Internal-Secret`
 * (= env `SITES_INTERNAL_SECRET` с обеих сторон, по образцу `X-Relay-Secret`),
 * сравнение постоянного времени; нет секрета — маршруты ЗАКРЫТЫ (503), а не
 * открыты. Кто из операторов действует — `X-Admin-Actor` (id пользователя
 * админки генератора) → журнал доступа / актор журналов.
 *
 * Общий для двух потребителей (P-R-ADM, Р-RD-ADM-6): вкладка «Помощник»
 * (`platform-admin`, `InternalSecretGuard` — поведение прежнее: нет актора
 * → 401) и вкладка «Reddit» (`publisher/reddit/admin`, свой гвард поверх
 * `assertInternalSecret`: нет актора → 400). Вынесен из
 * `modules/platform-admin/`, чтобы Publisher не импортировал чужой модуль
 * (правило графа `publisher-scope`).
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'crypto';

export const INTERNAL_SECRET_HEADER = 'x-sites-internal-secret';
export const ADMIN_ACTOR_HEADER = 'x-admin-actor';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Значение заголовка (первое, если их несколько). */
export function headerOf(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Секрет внутреннего API: env не задан (< 16) — 503; секрета нет или он
 * неверный — 401 ОДИНАКОВО (тот же текст и код).
 */
export function assertInternalSecret(
  presented: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const secret = env.SITES_INTERNAL_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new ServiceUnavailableException(
      'SITES_INTERNAL_SECRET не задан (≥ 16 символов) — внутренний API закрыт',
    );
  }
  if (!presented || !safeEqual(presented.trim(), secret)) {
    throw new UnauthorizedException('Неверный внутренний секрет');
  }
}

/** Вкладка «Помощник»: секрет + `X-Admin-Actor` (нет — 401, как было). */
@Injectable()
export class InternalSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    assertInternalSecret(headerOf(req, INTERNAL_SECRET_HEADER));
    const actor = headerOf(req, ADMIN_ACTOR_HEADER);
    if (!actor || !/^[A-Za-z0-9_:-]{1,64}$/.test(actor)) {
      throw new UnauthorizedException('Нет X-Admin-Actor');
    }
    return true;
  }
}

/** id оператора админки (после гварда внутреннего API). */
export const AdminActor = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string =>
    headerOf(ctx.switchToHttp().getRequest<Request>(), ADMIN_ACTOR_HEADER) ??
    '',
);
