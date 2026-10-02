/**
 * Журнал использованных id подписанных запросов генератора (Э-С Ш1,
 * П-С3) — вторая половина защиты от повтора. Первая — окно метки времени
 * ±5 мин (`shared/sites-internal-signature.ts`): за окном подпись не
 * принимается вовсе, а ВНУТРИ окна один и тот же id проходит один раз.
 *
 * Запись — `createMany({ skipDuplicates })` = `INSERT … ON CONFLICT DO
 * NOTHING`: два параллельных повтора не пройдут оба, решает первичный
 * ключ, а не «прочитал → решил». Строки живут сутки (окно — 10 минут,
 * остальное — короткий журнал «кто какой маршрут звал»), чистятся здесь
 * же, без отдельного крона: таблица растёт со скоростью вызовов
 * генератора, индекс по `createdAt` делает чистку дешёвой.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';

export const REQUEST_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class InternalRequestLedger {
  private readonly logger = new Logger(InternalRequestLedger.name);

  constructor(private readonly db: SitesDb) {}

  /** `true` — id новый и занят; `false` — повтор. */
  async claim(
    requestId: string,
    caller: string,
    route: string,
    now = new Date(),
  ): Promise<boolean> {
    const db = this.db.system(
      'внутренний API генератора: id подписанного запроса (защита от повтора)',
    );
    const { count } = await db.siteInternalRequest.createMany({
      data: [{ requestId, caller, route, createdAt: now }],
      skipDuplicates: true,
    });
    // Чистка — после записи и молча: её сбой не повод отказать в запросе.
    await db.siteInternalRequest
      .deleteMany({
        where: {
          createdAt: { lt: new Date(now.getTime() - REQUEST_LEDGER_TTL_MS) },
        },
      })
      .catch((e: unknown) =>
        this.logger.warn(
          `чистка site_internal_requests: ${e instanceof Error ? e.name : 'error'}`,
        ),
      );
    return count === 1;
  }
}
