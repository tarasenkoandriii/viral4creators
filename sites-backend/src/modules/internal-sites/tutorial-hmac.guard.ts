/**
 * Гвард внутреннего API обучалки генератора (Э-С Ш1, П-С3).
 *
 * Секрет — `SITES_TUTORIAL_HMAC_SECRET` (≥ 32 символа), ОТДЕЛЬНЫЙ от
 * `SITES_INTERNAL_SECRET` вкладки «Помощник» админки (Э4):
 *  - разные полномочия: админка смотрит и правит тарифы кабинетов от имени
 *    оператора, обучалка действует от имени ЛЮБОГО telegramId (находит и
 *    создаёт кабинет, регистрирует хост) — утечка одного секрета не должна
 *    давать другое;
 *  - разные способы: здесь секрет по сети не ходит (HMAC тела с меткой
 *    времени и id), у админки — заголовок-токен; общий секрет сделал бы
 *    HMAC-канал не сильнее заголовочного: перехваченный заголовок админки
 *    подписывал бы и запросы обучалки;
 *  - ротация по отдельности (П-С3: «отдельный секрет на направление»).
 *
 * Нет секрета — маршруты ЗАКРЫТЫ (503), а не открыты. Подпись не сошлась,
 * метка вне окна ±5 мин, id уже был — 401 с машинным кодом (генератор
 * переводит это в режим B, а не роняет обучалку).
 *
 * Тело приходит СТРОКОЙ (`app.setup.ts`: сырой текст на `/internal/sites`):
 * подпись считается по байтам, которые прислал генератор, а JSON
 * разбирается только ПОСЛЕ проверки — `req.internalBody`.
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  SITES_CALLER_TUTORIAL,
  isUsableSitesSecret,
  verifySitesRequest,
} from '../../shared/sites-internal-signature';
import { InternalRequestLedger } from './request-ledger';

export type InternalRequest = Request & { internalBody?: unknown };

export const INTERNAL_SITES_BODY_LIMIT_BYTES = 8 * 1024;

function err(
  Ctor: new (body: Record<string, unknown>) => HttpException,
  code: string,
  message: string,
): HttpException {
  return new Ctor({ error: code, code, message });
}

@Injectable()
export class TutorialHmacGuard implements CanActivate {
  /** Тесты подменяют env и часы. */
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(private readonly ledger: InternalRequestLedger) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<InternalRequest>();
    const secret = this.env.SITES_TUTORIAL_HMAC_SECRET?.trim();
    if (!isUsableSitesSecret(secret)) {
      throw err(
        ServiceUnavailableException,
        'INTERNAL_NOT_CONFIGURED',
        'SITES_TUTORIAL_HMAC_SECRET не задан (≥ 32 символа) — внутренний API обучалки закрыт',
      );
    }
    const raw = typeof req.body === 'string' ? req.body : '';
    if (Buffer.byteLength(raw, 'utf8') > INTERNAL_SITES_BODY_LIMIT_BYTES) {
      throw err(
        BadRequestException,
        'INTERNAL_BAD_BODY',
        'Тело слишком большое',
      );
    }
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const now = this.now();
    const check = verifySitesRequest(secret, {
      method: req.method,
      path,
      body: raw,
      headers: req.headers,
      nowSeconds: Math.floor(now.getTime() / 1000),
      expectedCaller: SITES_CALLER_TUTORIAL,
    });
    if (!check.ok) {
      throw err(
        UnauthorizedException,
        `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}`,
        'Подпись внутреннего запроса не принята',
      );
    }
    if (!(await this.ledger.claim(check.requestId, check.caller, path, now))) {
      throw err(
        UnauthorizedException,
        'INTERNAL_REPLAY',
        'Этот подписанный запрос уже выполнялся',
      );
    }
    if (raw) {
      try {
        req.internalBody = JSON.parse(raw) as unknown;
      } catch {
        throw err(BadRequestException, 'INTERNAL_BAD_BODY', 'Ожидается JSON');
      }
    } else {
      req.internalBody = undefined;
    }
    return true;
  }
}
