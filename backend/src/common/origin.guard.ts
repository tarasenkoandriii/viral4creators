/**
 * OriginGuard — проверка `Origin` на маршрутах, которые СТАВЯТ или
 * СНИМАЮТ cookie (этап 49, В-3.2, В-3.6).
 *
 * ## Почему это отдельный гвард, а не middleware
 *
 * Общий барьер `isOriginAllowed` стоит в двух местах: в
 * `TelegramIdentityMiddleware` — но только когда cookie УЖЕ разобралась,
 * и в `AdminSessionGuard` — на маршрутах ПОСЛЕ входа. Маршруты входа под
 * оба условия не попадают: у нового посетителя cookie ещё нет, а гварда
 * админки на самом входе быть не может. Именно поэтому вход был открыт
 * для CSRF наоборот — «login CSRF».
 *
 * ## Как это эксплуатировалось
 *
 * Злоумышленник входит сам и снимает свой валидный payload Telegram Login
 * Widget (годен 24 часа). Кладёт его в автоотправляемую форму на своём
 * сайте. Браузер жертвы делает top-level POST на наш `/callback`, подпись
 * сходится, и жертва получает `Set-Cookie` с сессией злоумышленника.
 * Дальше всё, что она заводит — проекты, манифесты, фото, ролики, — ложится
 * в аккаунт злоумышленника, и он это читает у себя. Уже вошедшая жертва
 * защищена middleware; уязвим именно новый посетитель — самый частый
 * случай. Тем же приёмом `logout` выкидывает оператора с чужого сайта.
 *
 * Политика та же, что у `isOriginAllowed`: safe-методы и запросы без
 * `Origin` (не-браузерные клиенты) проходят; браузерная форма с чужого
 * сайта `Origin` несёт всегда — и получает 403.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { CSRF_REJECTED_MESSAGE, isOriginAllowed } from './csrf';

@Injectable()
export class OriginGuard implements CanActivate {
  private readonly logger = new Logger(OriginGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin as string | undefined;
    if (
      !isOriginAllowed(req.method ?? 'GET', origin, process.env.CORS_ORIGIN)
    ) {
      this.logger.warn(
        `CSRF: ${req.method} ${req.originalUrl} с Origin «${origin ?? '—'}» отклонён на маршруте входа/выхода`,
      );
      throw new ForbiddenException(CSRF_REJECTED_MESSAGE);
    }
    return true;
  }
}
