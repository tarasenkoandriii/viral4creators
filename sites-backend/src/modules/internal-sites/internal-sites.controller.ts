/**
 * Внутренний API для обучалки генератора (Э-С Ш1, П-С3). Зовёт ТОЛЬКО
 * backend/ (`modules/sites-internal`), подпись — tutorial-hmac.guard.ts.
 *
 *   POST /internal/sites/tutorial/host-status    { telegramId, url } → режим A/B, статус хоста (только чтение)
 *   POST /internal/sites/tutorial/register-host  { telegramId, url } → завести хост (pending) в кабинете человека
 *
 * Всё — POST с JSON-телом: подписывается тело, а не query (query-строку
 * прокси и логи переписывают и пишут чаще).
 */
import {
  BadRequestException,
  Controller,
  HttpCode,
  Post,
  UseGuards,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import { PublicRoute } from '../telegram-auth/allow-apps.decorator';
import {
  InternalSitesService,
  parseTelegramId,
} from './internal-sites.service';
import { InternalRequest, TutorialHmacGuard } from './tutorial-hmac.guard';

/** Тело после проверки подписи (гвард разобрал JSON). */
const InternalBody = createParamDecorator(
  (_d: unknown, ctx: ExecutionContext): unknown =>
    ctx.switchToHttp().getRequest<InternalRequest>().internalBody,
);

function payload(b: unknown): { telegramId: bigint; url: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    throw new BadRequestException({
      error: 'INTERNAL_BAD_BODY',
      code: 'INTERNAL_BAD_BODY',
      message: 'Ожидается { telegramId, url }',
    });
  }
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'telegramId' && k !== 'url') {
      throw new BadRequestException({
        error: 'INTERNAL_BAD_BODY',
        code: 'INTERNAL_BAD_BODY',
        message: `Лишнее поле «${k}»`,
      });
    }
  }
  if (typeof o.url !== 'string' || o.url.length > 2048) {
    throw new BadRequestException({
      error: 'INTERNAL_BAD_BODY',
      code: 'INTERNAL_BAD_BODY',
      message: 'url — строка до 2048 символов',
    });
  }
  return { telegramId: parseTelegramId(o.telegramId), url: o.url };
}

@Controller('internal/sites/tutorial')
@PublicRoute(
  'внутренний API обучалки генератора: HMAC с меткой времени и id (SITES_TUTORIAL_HMAC_SECRET)',
)
@UseGuards(TutorialHmacGuard)
export class InternalSitesController {
  constructor(private readonly svc: InternalSitesService) {}

  @Post('host-status')
  @HttpCode(200)
  hostStatus(@InternalBody() b: unknown) {
    const p = payload(b);
    return this.svc.hostStatus(p.telegramId, p.url);
  }

  @Post('register-host')
  @HttpCode(200)
  registerHost(@InternalBody() b: unknown) {
    const p = payload(b);
    return this.svc.registerHost(p.telegramId, p.url);
  }
}
