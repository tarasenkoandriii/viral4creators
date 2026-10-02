/**
 * Внутренний API для админки платформы (вкладка «Помощник», ТЗ §8) —
 * генератор (`backend/`, admin-panel) ходит сюда сервер-сервер, без DSN к
 * схеме `sites` (аудит слияния §3.0 п.2). Секрет — заголовок
 * `X-Sites-Internal-Secret` (= env `SITES_INTERNAL_SECRET` с обеих сторон,
 * по образцу `X-Relay-Secret`), сравнение постоянного времени; нет секрета —
 * маршруты ЗАКРЫТЫ (503), а не открыты. Кто из операторов действует —
 * `X-Admin-Actor` (id пользователя админки генератора) → журнал доступа.
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

function header(req: Request, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

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

@Injectable()
export class InternalSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    assertInternalSecret(header(req, INTERNAL_SECRET_HEADER));
    const actor = header(req, ADMIN_ACTOR_HEADER);
    if (!actor || !/^[A-Za-z0-9_:-]{1,64}$/.test(actor)) {
      throw new UnauthorizedException('Нет X-Admin-Actor');
    }
    return true;
  }
}

/** id оператора админки (после InternalSecretGuard). */
export const AdminActor = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): string =>
    header(ctx.switchToHttp().getRequest<Request>(), ADMIN_ACTOR_HEADER) ?? '',
);
