// AdminSessionGuard — параллельный TelegramIdentityMiddleware, НЕ
// связанный с ним: разный источник токена (httpOnly cookie vs заголовок
// X-Telegram-Init-Data), разная модель сессии (held session с TTL на
// сервере vs stateless-проверка подписи на каждый запрос).
//
// Перенесено из Devil's Advocate (apps/api/src/admin-auth/admin-session.guard.ts),
// включая CSRF-защиту (см. isOriginAllowed) — отдельный, специально
// найденный в том проекте баг-класс: cookie ставится с SameSite=None
// (админка и API — разные домены в проде), и браузер отправляет
// cross-site form-POST с cookie без preflight; CORS сам по себе только
// запрещает ЧИТАТЬ ответ, не отправку. Проверка Origin для не-safe
// методов — единственное, что реально блокирует такой запрос: браузер
// выставляет Origin почти на каждый non-GET запрос и подделать его со
// страницы нельзя.
//
// Fail-политика описана в `common/csrf.ts` — там же живёт сама проверка,
// общая теперь с пользовательскими маршрутами (Б-3.1). Здесь остаётся
// только её вызов. Одно изменение по существу (Б-3.2): незаданный
// CORS_ORIGIN в проде больше не выключает барьер молча.

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { parseCookieHeader, ADMIN_SESSION_COOKIE_NAME } from './cookie.util';
import { CSRF_REJECTED_MESSAGE, isOriginAllowed } from '../../common/csrf';

// Реэкспорт: `isOriginAllowed` живёт в общем модуле, но исторически
// импортируется отсюда (тесты, документация).
export { isOriginAllowed };

export interface AdminAuthenticatedRequest extends Request {
  userId: string;
}

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AdminAuthenticatedRequest>();

    if (
      !isOriginAllowed(
        request.method ?? 'GET',
        request.headers.origin as string | undefined,
        process.env.CORS_ORIGIN,
      )
    ) {
      throw new ForbiddenException(CSRF_REJECTED_MESSAGE);
    }

    const cookies = parseCookieHeader(request.headers.cookie);
    const token = cookies[ADMIN_SESSION_COOKIE_NAME];
    if (!token) {
      throw new UnauthorizedException('Admin session cookie is required');
    }

    const session = await this.prisma.adminSession.findUnique({
      where: { token },
    });
    if (!session) {
      throw new UnauthorizedException('Invalid admin session');
    }
    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Admin session expired');
    }

    request.userId = session.userId;
    return true;
  }
}
