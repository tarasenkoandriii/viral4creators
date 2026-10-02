/**
 * Внутренний API Э6 для обучалки генератора: привязка черновика к сайту
 * помощника, ролики сайта и карта интерфейса из раундов обучалки (ТЗ
 * помощника §4.11, §4.12; аудит слияния §3.2 — `site_ui_maps`, Ш4).
 *
 * Направление то же, что у Ш1: генератор → sites-backend, HMAC с меткой
 * времени и id запроса (tutorial-hmac.guard.ts), свой секрет. Генератор не
 * получает DSN схемы `sites`; sites-backend не ходит в генератор.
 *
 * Кто вправе: человек (telegramId) — владелец кабинета сайта или менеджер
 * помощника в нём (`productRoles.assist = manager`; оператор — нет: он
 * отвечает в чате, а не решает, что показывать посетителям от имени
 * сайта). Без этого любой привязал бы свой ролик к чужому сайту (§4.11).
 * Чужой сайт и несуществующий отвечают ОДНИМ кодом — не оракул.
 *
 *  - `link` — проверка перед привязкой черновика (генератор пишет
 *    `clientSiteId` только после неё);
 *  - `syncVideos` — ПОЛНЫЙ набор одобренных оператором роликов сайта
 *    (замена): у каждого — свой хозяин, членство проверяется ПО КАЖДОМУ
 *    (черновик бывшего менеджера, которого убрали из кабинета, выпадает);
 *    `requiresLogin` — закрытый отказ: признак генератора ИЛИ шаг на хосте,
 *    который не подтверждён у этого сайта, ИЛИ хостов шагов нет вовсе;
 *    признак у существующего ролика только ставится и не снимается
 *    (выключен навсегда); адрес ролика не из ASSIST_VIDEO_HOSTS — ролик не
 *    принимается; включение владельца у существующих сохраняется, новые —
 *    выключены; набор старше последнего принятого (`asOf`, аудит Э6 —
 *    гонка двух синхронизаций в обратном порядке вернула бы отвязанный
 *    ролик) — `stale: true`, без изменений (отметка и замена — в ОДНОЙ
 *    транзакции: строка сайта блокируется условным UPDATE);
 *  - `uiMap` — элементы страницы из раунда обучалки (источник `tutorial`):
 *    только страница на подтверждённом хосте этого сайта.
 */
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isAllowedVideoUrl } from '../../config/media-env';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountService } from '../site-core/account/account.service';
import { siteCoreError } from '../site-core/site-core.constants';
import {
  cleanUiElements,
  uiElementsHash,
  uiMapHost,
  uiMapKey,
} from '../site-core/ui-map/ui-map';

/** Тот же потолок, что MEDIA_DEFAULTS.syncVideosMax (тело ≤ 8 КБ). */
export const SYNC_VIDEOS_MAX = 15;
const TITLE_MAX = 120;

export interface SyncVideoInput {
  externalId: string;
  draftId: string;
  ownerTelegramId: bigint;
  title: string;
  locale: string;
  durationMs: number | null;
  url: string;
  requiresLogin: boolean;
  stepHosts: string[];
}

export interface SiteLinkResult {
  siteId: string;
  siteName: string;
  /** Подтверждённые хосты сайта — генератор показывает, к чему привязал. */
  hosts: string[];
}

export interface SyncVideosResult {
  siteId: string;
  accepted: number;
  removed: number;
  rejected: Array<{ externalId: string; reason: 'owner' | 'url' }>;
  /** Набор старше уже принятого (`asOf`) — ничего не изменено. */
  stale?: true;
}

const linkDenied = () =>
  new ForbiddenException({
    error: 'SITE_LINK_FORBIDDEN',
    code: 'SITE_LINK_FORBIDDEN',
    message:
      'Сайт помощника не найден среди ваших (нужна роль владельца или менеджера помощника)',
  });

@Injectable()
export class InternalSiteMediaService {
  private readonly logger = new Logger(InternalSiteMediaService.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly db: SitesDb,
    private readonly accounts: AccountService,
  ) {}

  private system(why: string) {
    return this.db.system(`внутренний API обучалки (Э6): ${why}`);
  }

  /** Кабинеты, где человек вправе решать за помощника. */
  private async managedAccounts(telegramId: bigint): Promise<Set<string>> {
    const all = await this.accounts.memberships(telegramId);
    return new Set(
      all
        .filter(
          (m) => m.role === 'owner' || m.productRoles.assist === 'manager',
        )
        .map((m) => m.accountId),
    );
  }

  private async siteRow(siteId: string) {
    return this.system('сайт по id').site.findUnique({
      where: { id: siteId },
      select: { id: true, accountId: true, name: true },
    });
  }

  private async verifiedHosts(
    siteId: string,
  ): Promise<Array<{ id: string; host: string }>> {
    return this.system('подтверждённые хосты сайта').siteHost.findMany({
      where: { siteId, status: 'verified', revokedAt: null },
      select: { id: true, host: true },
    });
  }

  async link(telegramId: bigint, siteId: string): Promise<SiteLinkResult> {
    const site = await this.siteRow(siteId);
    if (!site || !(await this.managedAccounts(telegramId)).has(site.accountId))
      throw linkDenied();
    const hosts = await this.verifiedHosts(siteId);
    return {
      siteId,
      siteName: site.name,
      hosts: hosts.map((h) => h.host),
    };
  }

  async syncVideos(
    siteId: string,
    videos: SyncVideoInput[],
    asOf: number,
    now = new Date(),
  ): Promise<SyncVideosResult> {
    const site = await this.siteRow(siteId);
    if (!site) throw linkDenied();
    const verified = new Set(
      (await this.verifiedHosts(siteId)).map((h) => uiMapHost(h.host)),
    );
    const owners = new Map<string, boolean>();
    const rejected: SyncVideosResult['rejected'] = [];
    const keep: SyncVideoInput[] = [];
    for (const v of videos.slice(0, SYNC_VIDEOS_MAX)) {
      const k = v.ownerTelegramId.toString();
      if (!owners.has(k)) {
        owners.set(
          k,
          (await this.managedAccounts(v.ownerTelegramId)).has(site.accountId),
        );
      }
      if (!owners.get(k)) {
        rejected.push({ externalId: v.externalId, reason: 'owner' });
        continue;
      }
      if (!isAllowedVideoUrl(v.url, this.env)) {
        rejected.push({ externalId: v.externalId, reason: 'url' });
        continue;
      }
      keep.push(v);
    }
    let removed = 0;
    let stale = false;
    await this.system('замена роликов сайта').$transaction(async (tx) => {
      // Отметка — ПЕРВОЙ записью транзакции: условный UPDATE берёт блокировку
      // строки сайта, параллельная синхронизация ждёт и перепроверяет условие
      // уже по зафиксированной отметке. Равная отметка принимается (повтор
      // того же набора после таймаута).
      const mark = await tx.site.updateMany({
        where: {
          id: siteId,
          accountId: site.accountId,
          OR: [
            { assistVideosAsOf: null },
            { assistVideosAsOf: { lte: BigInt(asOf) } },
          ],
        },
        data: { assistVideosAsOf: BigInt(asOf) },
      });
      if (mark.count === 0) {
        stale = true;
        return;
      }
      const del = await tx.assistSiteVideo.deleteMany({
        where: {
          siteId,
          accountId: site.accountId,
          externalId: { notIn: keep.map((v) => v.externalId) },
        },
      });
      removed = del.count;
      for (const v of keep) {
        const requiresLogin =
          v.requiresLogin ||
          v.stepHosts.length === 0 ||
          v.stepHosts.some((h) => !verified.has(uiMapHost(h)));
        const data = {
          draftId: v.draftId,
          ownerTelegramId: v.ownerTelegramId,
          title: v.title.slice(0, TITLE_MAX),
          locale: v.locale,
          durationMs: v.durationMs,
          url: v.url,
          syncedAt: now,
          // Стал «за логином» — признак и выключение сразу (закрытый отказ).
          ...(requiresLogin ? { requiresLogin: true, enabled: false } : {}),
        };
        // «За логином» — НАВСЕГДА (§4.3-бис, У-7): признак у существующего
        // ролика только ставится, но не снимается. Признаки генератора не
        // все липкие (данные входа стирает крон/«одноразово»/перенос Ш2,
        // хост могут подтвердить позже), а кадры за логином в ролике
        // остаются — следующая синхронизация не должна открыть его владельцу.
        await tx.assistSiteVideo.upsert({
          where: { siteId_externalId: { siteId, externalId: v.externalId } },
          create: {
            ...data,
            requiresLogin,
            accountId: site.accountId,
            siteId,
            externalId: v.externalId,
          },
          update: data,
        });
      }
    });
    if (stale) {
      this.logger.log(
        `ролики сайта ${siteId}: набор устарел (asOf ${asOf}) — не принят`,
      );
      return { siteId, accepted: 0, removed: 0, rejected: [], stale: true };
    }
    if (rejected.length) {
      this.logger.warn(
        `ролики сайта ${siteId}: не приняты ${rejected.map((r) => `${r.externalId}:${r.reason}`).join(', ')}`,
      );
    }
    return { siteId, accepted: keep.length, removed, rejected };
  }

  async uiMap(
    telegramId: bigint,
    siteId: string,
    url: string,
    rawElements: unknown,
    now = new Date(),
  ): Promise<{ siteId: string; path: string; elements: number }> {
    const site = await this.siteRow(siteId);
    if (!site || !(await this.managedAccounts(telegramId)).has(site.accountId))
      throw linkDenied();
    const key = uiMapKey(url);
    const host = key
      ? (await this.verifiedHosts(siteId)).find(
          (h) => uiMapHost(h.host) === key.host,
        )
      : undefined;
    if (!key || !host) {
      throw siteCoreError(
        ForbiddenException,
        'HOST_NOT_VERIFIED',
        'Страница не на подтверждённом адресе этого сайта',
      );
    }
    const elements = cleanUiElements(rawElements);
    const where = {
      siteId,
      host: key.host,
      path: key.path,
      source: 'tutorial',
    };
    const db = this.db.forAccount(site.accountId);
    if (!elements.length) {
      await db.siteUiMap.deleteMany({ where });
      return { siteId, path: key.path, elements: 0 };
    }
    const elementsHash = uiElementsHash(elements);
    const existing = await db.siteUiMap.findFirst({
      where,
      select: { id: true, elementsHash: true },
    });
    const data = {
      hostId: host.id,
      elements: elements as unknown as Prisma.InputJsonValue,
      elementsHash,
      capturedAt: now,
      ...(existing?.elementsHash !== elementsHash
        ? { staleSignals: 0, lastStaleAt: null }
        : {}),
    };
    if (existing) {
      await db.siteUiMap.update({ where: { id: existing.id }, data });
    } else {
      await db.siteUiMap.create({
        data: { ...data, ...where, accountId: site.accountId },
      });
    }
    return { siteId, path: key.path, elements: elements.length };
  }
}
