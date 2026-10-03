/**
 * Обслуживание общей карты интерфейса (Э-С Ш4) — крон
 * `GET /cron/site-ui-map-maintenance` (sites-backend/vercel.json):
 * ретенция истории версий (UI_MAP_SHARED: 10 версий, 90 дней, текущая —
 * всегда), журнала промахов (окно устаревания), срок отметки «устарел»
 * без нового подтверждения, достройка слитых элементов для снимков, принятых
 * до Ш4. Логика — ui-map-store.ts; здесь только клиенты базы.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  runUiMapMaintenance,
  type UiMapMaintenanceResult,
} from './ui-map-store';

@Injectable()
export class UiMapMaintenanceService {
  private readonly logger = new Logger(UiMapMaintenanceService.name);
  now: () => Date = () => new Date();

  constructor(private readonly db: SitesDb) {}

  async run(): Promise<UiMapMaintenanceResult> {
    const r = await runUiMapMaintenance(
      this.db.system('крон карты интерфейса: ретенция по всем кабинетам'),
      (accountId) => this.db.forAccount(accountId),
      this.now(),
    );
    this.logger.log(
      `карта интерфейса: версий −${r.versionsDeleted}, промахов −${r.missesDeleted}, «устарел» снято ${r.staleExpired}, достроено страниц ${r.pagesRebuilt}`,
    );
    return r;
  }
}
