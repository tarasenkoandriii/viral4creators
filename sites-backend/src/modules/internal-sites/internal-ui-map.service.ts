/**
 * Внутренний API карты интерфейса для Flow-QA (Э-С Ш4; QA-ТЗ §3.5:
 * «само-лечение селекторов — как находка „селектор изменился“, не
 * молчаливо»). Чтение и запись карты по сайту от имени человека QA.
 *
 * Кто вправе (QA-ТЗ §2, L2): владелец кабинета сайта или `productRoles.qa`
 * — `admin` (запись и чтение) / `viewer` (только чтение). Чужой и
 * несуществующий сайт — один код 403 `UI_MAP_FORBIDDEN` (не оракул).
 * Запись — только страница на ПОДТВЕРЖДЁННОМ хосте этого сайта
 * (`HOST_NOT_VERIFIED`), источник `qa`, приём — общей дверью
 * `ingestUiSnapshot` (версии, история, слияние с обходом и обучалкой).
 */
import { ForbiddenException, Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountService } from '../site-core/account/account.service';
import { siteCoreError } from '../site-core/site-core.constants';
import { uiMapHost, uiMapKey } from '../site-core/ui-map/ui-map';
import type { UiMapViewport } from '../site-core/ui-map/ui-map-model';
import {
  UiMapLimitError,
  ingestUiSnapshot,
  uiMapPageForQa,
  uiMapPagesForQa,
} from '../site-core/ui-map/ui-map-store';

const forbidden = () =>
  new ForbiddenException({
    error: 'UI_MAP_FORBIDDEN',
    code: 'UI_MAP_FORBIDDEN',
    message: 'Сайт не найден среди ваших (нужна роль владельца или QA)',
  });

@Injectable()
export class InternalUiMapService {
  constructor(
    private readonly db: SitesDb,
    private readonly accounts: AccountService,
  ) {}

  /** Кабинет сайта, если человек вправе (`write` — только admin/владелец). */
  private async access(
    telegramId: bigint,
    siteId: string,
    write: boolean,
  ): Promise<string> {
    const site = await this.db
      .system('внутренний API QA (Ш4): сайт по id')
      .site.findUnique({ where: { id: siteId }, select: { accountId: true } });
    if (!site) throw forbidden();
    const m = (await this.accounts.memberships(telegramId)).find(
      (x) => x.accountId === site.accountId,
    );
    const ok =
      !!m &&
      (m.role === 'owner' ||
        m.productRoles.qa === 'admin' ||
        (!write && m.productRoles.qa === 'viewer'));
    if (!ok) throw forbidden();
    return site.accountId;
  }

  async read(
    telegramId: bigint,
    siteId: string,
    url: string | null,
    viewport: UiMapViewport | null,
  ) {
    const accountId = await this.access(telegramId, siteId, false);
    const db = this.db.forAccount(accountId);
    if (!url) return uiMapPagesForQa(db, siteId);
    const key = uiMapKey(url);
    if (!key) {
      throw siteCoreError(
        ForbiddenException,
        'HOST_NOT_VERIFIED',
        'Адрес страницы не годится',
      );
    }
    return {
      siteId,
      ...(await uiMapPageForQa(db, siteId, key.host, key.path, viewport)),
    };
  }

  async write(
    telegramId: bigint,
    siteId: string,
    url: string,
    viewport: UiMapViewport,
    elements: unknown,
    now = new Date(),
  ) {
    const accountId = await this.access(telegramId, siteId, true);
    const key = uiMapKey(url);
    const host = key
      ? (
          await this.db.forAccount(accountId).siteHost.findMany({
            where: { siteId, status: 'verified', revokedAt: null },
            select: { id: true, host: true },
          })
        ).find((h) => uiMapHost(h.host) === key.host)
      : undefined;
    if (!key || !host) {
      throw siteCoreError(
        ForbiddenException,
        'HOST_NOT_VERIFIED',
        'Страница не на подтверждённом адресе этого сайта',
      );
    }
    try {
      const r = await ingestUiSnapshot(this.db.forAccount(accountId), {
        accountId,
        siteId,
        hostId: host.id,
        host: key.host,
        path: key.path,
        source: 'qa',
        viewport,
        elements,
        now,
      });
      return { siteId, ...r };
    } catch (e) {
      if (e instanceof UiMapLimitError) {
        throw new ForbiddenException({
          error: e.code,
          code: e.code,
          message: e.message,
        });
      }
      throw e;
    }
  }
}
