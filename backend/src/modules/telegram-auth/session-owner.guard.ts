/**
 * SessionOwnerGuard — сессия с владельцем принадлежит только ему (Б-3.4).
 *
 * ## Что было
 *
 * Модель «UUID сессии — предъявитель» описана в ТЗ §7.8 и сама по себе
 * законна: анонимный сценарий обязан работать без аккаунта, и другого
 * ключа, кроме идентификатора, у него нет. Но по этому же
 * идентификатору доставались вещи, к сессии не относящиеся:
 *
 *   - `GET /api/sessions/:id` — вся сессия целиком, включая внутренний
 *     `userId` владельца;
 *   - `GET /api/library/recommend?sessionId=…` — приватные записи
 *     библиотеки владельца сессии;
 *   - `POST /api/sessions/:id/{analysis,prompt,generate,audit,relevance}`
 *     — платные вызовы за счёт ЧУЖОГО дневного бюджета (у Premium это до
 *     $100 в сутки);
 *   - `POST /api/sessions/:id/video/upload-url` — сброс кастинга и
 *     выбора сцен чужой сессии плюс presigned PUT в чужой префикс.
 *
 * Механизм проверки в проекте уже был и применялся ровно в одном месте
 * (`publication.service.ts` — «сессия принадлежит вошедшему»), но не
 * стоял на самих сессионных маршрутах.
 *
 * ## Правило
 *
 * Одно, и оно целиком здесь: **если у сессии есть владелец, запрос
 * обязан прийти от него**. Анонимная сессия (`userId === null`)
 * работает как раньше — иначе половина продукта, работающая без
 * аккаунта, перестала бы существовать. С этапа 49 первый же опознанный
 * запрос к ничьей сессии делает её своей (В-3.4) — см. ниже.
 *
 * Гвард глобальный, потому что маршрутов с `:sessionId` тринадцать в
 * одиннадцати контроллерах, и правило, размазанное по ним, разъедется
 * на первом же новом маршруте. Ничего не делает, когда в запросе нет
 * `sessionId` — в том числе на всех `/admin/*`, где параметр называется
 * `id` и авторизацию делает `AdminSessionGuard`.
 *
 * Цена — один запрос по первичному ключу (`select: { userId }`) на
 * сессионный маршрут. Это меньше, чем любой из вызовов, которые он
 * защищает.
 *
 * Несуществующая сессия пропускается: 404 отдаёт сам обработчик, и это
 * честнее, чем 403 на то, чего нет.
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramIdentifiedRequest } from './telegram-identity.middleware';

export const FOREIGN_SESSION_MESSAGE =
  'Эта сессия принадлежит другому аккаунту. Войдите под ним, чтобы продолжить.';

type RequestWithParams = Partial<
  Pick<TelegramIdentifiedRequest, 'telegramUserId'>
> & {
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
};

/** `sessionId` из пути или из строки запроса; иначе `null`. */
export function sessionIdFromRequest(req: {
  params?: Record<string, string | undefined>;
  query?: Record<string, unknown>;
}): string | null {
  const fromPath = req.params?.sessionId;
  if (typeof fromPath === 'string' && fromPath) return fromPath;
  const fromQuery = req.query?.sessionId;
  // `?sessionId=a&sessionId=b` приходит массивом — такому запросу
  // доверять нельзя, и разбирать его незачем.
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  return null;
}

@Injectable()
export class SessionOwnerGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<RequestWithParams>();
    const sessionId = sessionIdFromRequest(req);
    if (!sessionId) return true;

    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { userId: true },
    });
    if (!row) return true;
    const me = req.telegramUserId ?? null;

    if (row.userId === null) {
      // Ничья сессия и опознанный запрос — привязываем (этап 49, В-3.4).
      //
      // Сессия заводится при открытии приложения, до входа; кнопка входа
      // её не пересоздаёт. Раньше владелец записывался ровно один раз,
      // при создании, и человек, вошедший посреди работы, до конца
      // сессии оставался для сервера анонимом: этот гвард её не защищал
      // (единственный ключ — UUID), платил он из общего гостевого котла
      // на всех, а права получал LITE, хотя за Premium и входил.
      //
      // Привязка — условный UPDATE: если параллельный запрос успел
      // первым, перечитываем и судим по факту, а не по своему намерению.
      if (!me) return true;
      const affected = await this.prisma.$executeRaw`
        UPDATE "sessions" SET "userId" = ${me}
        WHERE "id" = ${sessionId} AND "userId" IS NULL
      `;
      if (affected > 0) return true;
      const again = await this.prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true },
      });
      if (!again || again.userId === null || again.userId === me) return true;
      throw new ForbiddenException(FOREIGN_SESSION_MESSAGE);
    }

    if (row.userId === me) return true;
    throw new ForbiddenException(FOREIGN_SESSION_MESSAGE);
  }
}
