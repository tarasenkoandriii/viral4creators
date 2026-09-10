/**
 * TelegramIdentityGuard
 *
 * The one place in the app that REQUIRES an identity. TelegramIdentityMiddleware
 * (same module) never blocks — it only sets `req.telegramUserId` when it
 * can (initData / dev-bypass / login cookie) — because the core
 * Session-based generation flow must keep working anonymously
 * (doc/TELEGRAM-ADMIN.md). Some routes, however, only make sense with an
 * owner: a Project / Brand Manifest is a persistent catalog that gets
 * listed and edited later (doc/PRODUCT-PROJECT-SPEC.md §7.8, §12) — with
 * no user there is nothing to list it under, and letting anyone who
 * guesses an id read or edit saved product/price data isn't acceptable.
 *
 * Put `@UseGuards(TelegramIdentityGuard)` on those controllers; everything
 * else stays untouched. 401 (not 403): the caller isn't forbidden, they
 * simply haven't identified themselves — inside Telegram this can't
 * happen (initData is always there), in a plain browser it means "log in
 * with the Telegram button first" (modules/telegram-login) or, on the dev
 * stand, "ALLOW_DEV_AUTH + X-Dev-User-Id".
 */

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramIdentifiedRequest } from './telegram-identity.middleware';

@Injectable()
export class TelegramIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<TelegramIdentifiedRequest>();
    if (!req.telegramUserId) {
      throw new UnauthorizedException(
        'This endpoint requires a Telegram identity (open inside Telegram, log in with the Telegram button, or use the dev bypass on a local stand).',
      );
    }
    return true;
  }
}

/**
 * Narrow the request type after the guard has run — lets controller code
 * use `req.telegramUserId` as a plain `string` without a per-handler
 * non-null assertion. Only valid on routes protected by the guard.
 */
export type IdentifiedRequest = TelegramIdentifiedRequest & {
  telegramUserId: string;
};
