/**
 * Хранение окружения тестировщика (этап 156,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §3.4).
 *
 * ## Почему окружение приходит заранее, а не вместе с тикетом
 *
 * Тикет приходит ИЗ БОТА (этап 3 того же ТЗ) — это сообщение в личке,
 * у которого нет ни экрана, ни `User-Agent`, ни платформы мини-аппа.
 * Спросить окружение в момент тикета не у кого: человек уже вышел из
 * приложения. Значит его нужно снять там, где оно есть, — в мини-аппе,
 * и до того, как понадобится.
 *
 * Отсюда же и невозможность досняться задним числом: тестировщик
 * поменяет телефон, обновит Telegram, и то окружение, в котором баг
 * воспроизводился, исчезнет вместе с ним.
 *
 * ## Почему только тестовым аккаунтам
 *
 * Запись идёт в строку `users` — самую крупную таблицу проекта. Писать
 * туда на каждом запуске у каждого пользователя значит менять самую
 * горячую таблицу ради данных, которые никто никогда не прочитает:
 * окружение читает вкладка тикетов, а тикеты бывают только у
 * тестировщиков.
 *
 * Отказ при этом НЕ ошибка: обычный пользователь ничего неправильного
 * не сделал, и красная ошибка в консоли на каждом запуске — это шум,
 * который потом мешает читать настоящие. Отвечаем `{ stored: false }`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeEnvironment } from '../../common/environment';

@Injectable()
export class EnvironmentService {
  private readonly logger = new Logger(EnvironmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(
    telegramUserId: string,
    payload: unknown,
  ): Promise<{ stored: boolean }> {
    const environment = normalizeEnvironment(payload);
    if (!environment) {
      // Аудит этапа 156: без этой строки негодное тело неотличимо от
      // «не тестировщик» — оба тихо отвечают `stored: false`. А это
      // ровно тот отказ, который случится сам собой, когда старая
      // сборка мини-аппа встретит новый сервер: окружения не будет ни
      // у кого, и никто об этом не узнает. Шов в `check-docs` ловит
      // расхождение на сборке, эта строка — в работе.
      this.logger.warn(
        `environment rejected for ${telegramUserId}: не разобрано ` +
          `(нет поверхности или вида устройства); поля тела: ${fields(payload)}`,
      );
      return { stored: false };
    }

    // Один запрос вместо «прочитать, решить, записать». Условие доступа
    // выражается в WHERE целиком, поэтому решение и запись происходят
    // атомарно: между чтением и записью нельзя успеть отозвать доступ.
    // На serverless это ещё и вдвое меньше обращений к базе за вызов,
    // а вызов — на каждый запуск мини-аппа.
    const { count } = await this.prisma.user.updateMany({
      where: {
        telegramId: telegramUserId,
        isTestUser: true,
        // Истёкший доступ — не тестировщик. Иначе запись шла бы мимо
        // всех остальных проверок тестового доступа и однажды
        // разошлась бы с ними.
        OR: [
          { testAccessUntil: null },
          { testAccessUntil: { gt: new Date() } },
        ],
      },
      data: {
        lastEnvironment: environment as unknown as object,
        lastEnvironmentAt: new Date(),
      },
    });
    if (count === 0) return { stored: false };

    this.logger.log(
      `environment: ${environment.surface}/${environment.deviceKind}/` +
        `${environment.osFamily} тема=${environment.theme ?? '—'} ` +
        `build=${environment.appBuild}`,
    );
    return { stored: true };
  }
}

/** Имена полей тела — чтобы отказ было с чем сличить, без содержимого. */
function fields(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return typeof payload;
  const keys = Object.keys(payload as Record<string, unknown>);
  return keys.length ? keys.slice(0, 20).join(', ') : 'пусто';
}
