/**
 * Промахи Т-4 по целям голосовой карты за 7 дней — «Обучение → Голос»
 * в TMA (Э6-тер (12), заход 9; ТЗ §5-кватер.10 «Т-4 мониторинг», §4-тер.5):
 *   GET /assist/sites/:id/voice-map/site/misses
 * По журналу шагов (`assist_site_ui_action_log`, поле `mapKey`) на цель:
 *  - «нажмите сами» — шаг цели закончился `manual`/`failed` (не «нет цели»);
 *  - «цель не найдена» — шаг цели `manual`/`failed` с причиной `no_target`;
 *  - «не туда» — стоп человеком (кнопка, Esc, голос, свой клик) ≤ 5 с после
 *    исполненного шага этой цели (то же окно, что монитор Т-4);
 *  - «выполнено» — для доли.
 *  - «промах карты» — команда назвала цель, а в снимке её не было
 *    (`mapMiss` с ключом названной цели — его пишет план, аудит B);
 * плюс страницы таких промахов (и старых строк без ключа). Кнопка
 * «Открыть в редакторе» в TMA — ссылка редактора с `focus=<ключ>` на
 * странице последнего промаха. Т-3 (находки воркера) — когда будет воркер.
 * Только чтение журнала основной ролью с тенантом; подписей и значений нет.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import type { AccountMembership } from '../site-core/account/roles';
import {
  MAP_MISSES_LIMITS,
  mapMissStats,
  mapMissWrongs,
  type MapMissRow,
  type MapMissesView,
} from '../assist-ui-core/map-misses-core';

// Заход 13 (Р-З13-А1): свёртка — общее чистое ядро двух контуров.
export {
  MAP_MISSES_LIMITS,
  mapMissStats,
  mapMissWrongs,
  type MapMissItem,
  type MapMissRow,
  type MapMissesView,
} from '../assist-ui-core/map-misses-core';

@Injectable()
export class MapMissesService {
  now: () => Date = () => new Date();

  constructor(private readonly sitesDb: SitesDb) {}

  async misses(m: AccountMembership, siteId: string): Promise<MapMissesView> {
    await loadAssistSite(
      this.sitesDb.forAccount(m.accountId),
      m.accountId,
      siteId,
    );
    return this.statsFor(m.accountId, siteId);
  }

  /**
   * Свёртка за 7 дней без проверки права — для вызывающих, кто его уже
   * проверил (сессия редактора `we.`, режим «Промахи», №113, заход 10).
   */
  async statsFor(accountId: string, siteId: string): Promise<MapMissesView> {
    return mapMissStats(await this.rowsFor(accountId, siteId));
  }

  /**
   * №113 (заход 11) — для панели редактора: свёртка по ВСЕМ целям с шагами
   * (тепловые значки: сколько раз просили) и планы «не туда» по целям
   * («перепривязать»). Право проверено вызывающим (сессия редактора).
   */
  async detailFor(
    accountId: string,
    siteId: string,
  ): Promise<{
    view: MapMissesView;
    wrongs: Array<{ key: string; planId: string; multi: boolean }>;
  }> {
    const rows = await this.rowsFor(accountId, siteId);
    return {
      view: mapMissStats(rows, { all: true }),
      wrongs: mapMissWrongs(rows),
    };
  }

  /** Строки журнала за 7 дней: планы с целью карты — целиком (стоп человеком). */
  private async rowsFor(
    accountId: string,
    siteId: string,
  ): Promise<MapMissRow[]> {
    const db = this.sitesDb.forAccount(accountId);
    const since = new Date(this.now().getTime() - MAP_MISSES_LIMITS.windowMs);
    const keyed = await db.assistSiteUiActionLog.findMany({
      where: {
        siteId,
        createdAt: { gte: since },
        OR: [{ mapKey: { not: null } }, { mapMiss: true }],
      },
      select: { planId: true },
      orderBy: { createdAt: 'desc' },
      take: MAP_MISSES_LIMITS.rows,
    });
    const planIds = [...new Set(keyed.map((r) => r.planId))].slice(0, 2000);
    if (!planIds.length) return [];
    // Стоп человеком — строка плана без `mapKey`: берём планы целиком.
    return db.assistSiteUiActionLog.findMany({
      where: { siteId, planId: { in: planIds } },
      select: {
        planId: true,
        action: true,
        result: true,
        reason: true,
        mapKey: true,
        mapMiss: true,
        url: true,
        createdAt: true,
      },
      take: MAP_MISSES_LIMITS.rows,
    });
  }
}
