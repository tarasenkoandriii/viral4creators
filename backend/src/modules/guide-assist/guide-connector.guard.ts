/**
 * Гвард API фактов (Э-С Ш6): вызывать может только коннектор «Админки»
 * платформы помощника, и только от имени того пользователя TMA, чей
 * employee-JWT мы сами подписали.
 *
 *  1. API выключен (нет ключа коннектора или секрета JWT) — 404, как будто
 *     маршрута нет;
 *  2. `Authorization: Bearer <WIZARD_GUIDE_ASSIST_CONNECTOR_KEY>` — сравнение
 *     за постоянное время по SHA-256 обеих строк (длина не утекает);
 *  3. `X-V4C-Actor` — псевдоним `g1.<userId>.<mac>` с НАШЕЙ подписью
 *     (`guide-assist-jwt.ts`) и существующий пользователь; его id — и
 *     ключ лимита частоты (`by: 'user'`, гвард лимита идёт ПОСЛЕ этого).
 *
 * Подписи запроса (`X-V4C-Signature`, Э8) у чтения нет: платформа
 * подписывает только изменяющие вызовы. Поэтому `X-V4C-Actor` не
 * одноразовый — повтор возможен лишь у того, у кого уже есть ключ
 * коннектора (TLS, только платформа), а сам псевдоним бессрочен до
 * ротации секрета JWT (решение Р-Ш6-4, аудит Ш6).
 *
 * Отказы различаются ровно настолько, насколько это нужно платформе
 * (аудит Н-3): неверный ключ коннектора — 401 с
 * `WWW-Authenticate: Bearer error="invalid_token"` (платформа ставит
 * коннектор на паузу ТОЛЬКО по 401 — договорённость с sites-backend);
 * любая беда с актором (нет, чужая подпись, мусор, пользователя нет) —
 * 403 `ACTOR_INVALID`: ключ верный, коннектор исправен, отказ касается
 * одного человека. Какая именно беда с актором — не сообщается (не
 * оракул), а 403 получает только тот, у кого уже есть ключ коннектора.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { GuideAssistService } from './guide-assist.service';

export type ConnectorRequest = Request & {
  guideUserId?: string;
  /**
   * Тот же id, что `guideUserId`: по нему `RateLimitGuard` (`by: 'user'`)
   * считает окно на человека, а не на адрес платформы — все вызовы
   * коннектора приходят с её адресов, и общий лимит по IP один
   * разговорчивый сотрудник выбирал бы за всех (аудит Ш6).
   */
  telegramUserId?: string;
};

/** Сравнение секретов за постоянное время, без утечки длины. */
export function sameSecret(got: string, expected: string): boolean {
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearerOf(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header.trim());
  return m ? m[1] : null;
}

/** Машинный код отказа «ключ верный, актор — нет» (`error.code` конверта). */
export const ACTOR_INVALID = 'ACTOR_INVALID';

/** Значение `WWW-Authenticate` при неверном ключе коннектора (RFC 6750 §3). */
export const CONNECTOR_KEY_CHALLENGE = 'Bearer error="invalid_token"';

@Injectable()
export class GuideConnectorGuard implements CanActivate {
  constructor(private readonly guide: GuideAssistService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<ConnectorRequest>();
    const cfg = this.guide.factsConfig();
    if (!cfg) throw new NotFoundException();
    const token = bearerOf(req.headers.authorization);
    if (!token || !sameSecret(token, cfg.connectorKey)) {
      http
        .getResponse<Response>()
        .setHeader('WWW-Authenticate', CONNECTOR_KEY_CHALLENGE);
      throw new UnauthorizedException();
    }
    const actor = req.headers['x-v4c-actor'];
    const userId = await this.guide.userOfActor(
      typeof actor === 'string' ? actor : undefined,
    );
    if (!userId) {
      throw new ForbiddenException({
        error: ACTOR_INVALID,
        code: ACTOR_INVALID,
        message: 'X-V4C-Actor не распознан',
      });
    }
    req.guideUserId = userId;
    req.telegramUserId = userId;
    return true;
  }
}
