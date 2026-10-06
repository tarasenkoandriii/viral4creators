/**
 * Журнал использованных id подписанных запросов воркера (Э-С Ш3) — та же
 * таблица и тот же приём, что у канала генератора
 * (`internal-sites/request-ledger.ts`: `INSERT … ON CONFLICT DO NOTHING`,
 * сутки хранения), вызывающий — `browser-worker`. Свой класс, потому что
 * `internal-sites` — лист графа и его не импортирует никто.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { WORKER_CALLER } from '../browser-jobs/protocol';

export const WORKER_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class WorkerRequestLedger {
  private readonly logger = new Logger(WorkerRequestLedger.name);
  /** Чистка не чаще раза в минуту: воркер шлёт heartbeat часто. */
  private lastSweep = 0;

  constructor(private readonly db: SitesDb) {}

  async claim(
    requestId: string,
    route: string,
    now = new Date(),
  ): Promise<boolean> {
    const db = this.db.system(
      'канал браузерного воркера: id подписанного запроса (защита от повтора)',
    );
    const { count } = await db.siteInternalRequest.createMany({
      data: [{ requestId, caller: WORKER_CALLER, route, createdAt: now }],
      skipDuplicates: true,
    });
    if (now.getTime() - this.lastSweep > 60_000) {
      this.lastSweep = now.getTime();
      await db.siteInternalRequest
        .deleteMany({
          where: {
            caller: WORKER_CALLER,
            createdAt: { lt: new Date(now.getTime() - WORKER_LEDGER_TTL_MS) },
          },
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `чистка site_internal_requests: ${e instanceof Error ? e.name : 'error'}`,
          ),
        );
    }
    return count === 1;
  }
}
