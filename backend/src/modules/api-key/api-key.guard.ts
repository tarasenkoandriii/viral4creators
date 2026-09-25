/**
 * ApiKeyGuard — вход во внешнее API (этап 144,
 * docs-tz/TZ-Vneshnee-API.md).
 *
 * Устроен по образцу `AdminSessionGuard`: аутентификация в гварде,
 * права — в обработчике. Три отличия, и все вынужденные.
 *
 * **Кладёт на запрос `telegramUserId`** — то же поле, что и у входа из
 * мини-аппа. Иначе каждый сервис за гвардом пришлось бы учить второму
 * понятию «кто это», а их в продукте уже два (оператор и
 * пользователь); третье означало бы, что любая проверка прав,
 * написанная для мини-аппа, молча не сработает для API.
 *
 * **Режим и блокировка проверяются ЗДЕСЬ, а не в обработчике.** У
 * админского гварда наоборот (`assertOperator` первой строкой
 * обработчика) — и это правильно там, где часть маршрутов операторские,
 * а часть нет. Здесь же весь `/v1` целиком для Premium, и проверка,
 * которую надо не забыть написать в каждом новом обработчике, рано или
 * поздно окажется не написана.
 *
 * **Суточный потолок расхода здесь НЕ проверяется.** Он относится к
 * платному вызову, а не ко входу: `GET /v1/me` должен работать и у
 * того, кто сегодня уже выбрал лимит, — иначе интегратор, разбираясь
 * «почему не работает», получит 403 на проверке ключа и решит, что
 * ключ отозван.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import {
  apiKeyFromHeader,
  hashApiKey,
  shouldTouchLastUsed,
} from '../../common/api-key';
import { PlanService } from '../plan/plan.service';
import { planAllows } from '../../common/plans';

export type ApiKeyRequest = Request & {
  telegramUserId: string;
  /** Ключ, которым вошли: пригодится журналам и будущим лимитам. */
  apiKeyId: string;
};

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const secret = apiKeyFromHeader(request.headers.authorization);
    if (!secret) {
      throw new UnauthorizedException(
        'Нужен заголовок Authorization: Bearer <ключ API>',
      );
    }

    const key = await this.prisma.apiKey.findUnique({
      where: { keyHash: hashApiKey(secret) },
    });
    // Отозванный ключ отвечает тем же, что и несуществующий: знать, что
    // ключ когда-то был верным, тому, кто его предъявил, незачем.
    if (!key || key.revokedAt) {
      throw new UnauthorizedException('Ключ API не найден или отозван');
    }

    const access = await this.plans.accessOf(key.userId);
    this.plans.assertNotBlocked(access);
    if (!planAllows(access.plan, 'externalApi')) {
      throw new ForbiddenException(
        'Внешнее API доступно в режиме Premium — ключ выдан, но режим ниже',
      );
    }

    const now = new Date();
    if (shouldTouchLastUsed(key.lastUsedAt, now)) {
      // Лучшая попытка: отметка «ключом ещё пользуются» не стоит того,
      // чтобы из-за неё отказать в вызове.
      await this.prisma.apiKey
        .update({ where: { id: key.id }, data: { lastUsedAt: now } })
        .catch(() => undefined);
    }

    request.telegramUserId = key.userId;
    request.apiKeyId = key.id;
    return true;
  }
}
