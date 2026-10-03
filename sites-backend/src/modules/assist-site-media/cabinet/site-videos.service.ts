/**
 * Кабинет: экран «Видео» TMA помощника (Э6, ТЗ §4.11: «список роликов
 * сайта, переключатель „показывать в виджете“, кнопка „снять новое
 * обучение“»). Основная роль (SitesDb.forAccount — тенант кабинета).
 *
 *  - GET — ролики, которые генератор прислал для сайта (только одобренные
 *    оператором и привязанные хозяином черновика — internal-sites), их
 *    включение, deep-link в визард обучалки и сводка карты интерфейса;
 *  - PATCH — включить/выключить показ. Включить можно только ролик НЕ за
 *    логином (закрытый отказ §4.3-бис, У-7) и только на тарифе с видео;
 *    выключить — всегда.
 *  - Э-С Ш4: GET …/ui-map — сводка общей карты интерфейса (страницы,
 *    источники, вид вёрстки, устаревшие ЭЛЕМЕНТЫ — по порогу промахов, а не
 *    «страница после первого промаха»); та же сводка — кратко в «Видео».
 */
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { generatorTutorialLink } from '../../../config/media-env';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import { readState } from '../../assist-billing/public/entitlements';
import type { AccountMembership } from '../../site-core/account/roles';
import { uiMapSummary } from '../../site-core/ui-map/ui-map-store';
import { UI_STALE_RECRAWL } from '../../assist-site-knowledge/ui-stale-recrawl-config';
import type {
  MediaCabinetErrorCode,
  SiteUiMapView,
  SiteVideoView,
  SiteVideosView,
} from '../api-types';
import { videoAllowedByPlan } from '../public/site-videos';

export function mediaCabinetError(
  status: HttpStatus,
  code: MediaCabinetErrorCode,
  message: string,
): HttpException {
  return new HttpException({ error: code, code, message }, status);
}

interface VideoRow {
  id: string;
  title: string;
  locale: string;
  durationMs: number | null;
  requiresLogin: boolean;
  enabled: boolean;
  syncedAt: Date;
}

const VIDEO_SELECT = {
  id: true,
  title: true,
  locale: true,
  durationMs: true,
  requiresLogin: true,
  enabled: true,
  syncedAt: true,
} as const;

function view(r: VideoRow): SiteVideoView {
  return {
    id: r.id,
    title: r.title,
    locale: r.locale,
    durationMs: r.durationMs,
    requiresLogin: r.requiresLogin,
    enabled: r.enabled,
    syncedAt: r.syncedAt.toISOString(),
  };
}

@Injectable()
export class SiteVideosService {
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly prisma: PrismaService,
  ) {}

  private async site(m: AccountMembership, siteId: string) {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) {
      throw mediaCabinetError(
        HttpStatus.NOT_FOUND,
        'SITE_NOT_FOUND',
        'Сайт не найден',
      );
    }
    return db;
  }

  async list(m: AccountMembership, siteId: string): Promise<SiteVideosView> {
    const db = await this.site(m, siteId);
    const [rows, map, state] = await Promise.all([
      db.assistSiteVideo.findMany({
        where: { siteId },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        select: VIDEO_SELECT,
      }),
      uiMapSummary(db, siteId),
      readState(this.prisma, m.accountId, this.now()),
    ]);
    return {
      siteId,
      planAllowsVideo: videoAllowedByPlan(state.planId),
      videos: (rows as VideoRow[]).map(view),
      tutorialLink: generatorTutorialLink(siteId, this.env),
      uiMap: {
        pages: map.pages,
        // Ш4: страницы с устаревшими ЭЛЕМЕНТАМИ (порог промахов по виду).
        stalePages: map.stalePages,
        staleElements: map.staleElements,
        lastCapturedAt: map.lastCapturedAt,
      },
    };
  }

  /**
   * Э-С Ш4: сводка общей карты интерфейса сайта (экран «Карта інтерфейсу»);
   * Э6-бис (г): + точечный переобход устаревших страниц (решение п.4).
   */
  async uiMap(m: AccountMembership, siteId: string): Promise<SiteUiMapView> {
    const db = await this.site(m, siteId);
    const now = this.now();
    const [summary, state, today, recent] = await Promise.all([
      uiMapSummary(db, siteId),
      readState(this.prisma, m.accountId, now),
      db.assistSiteUiRecrawl.count({
        where: {
          siteId,
          status: 'requested',
          createdAt: {
            gte: new Date(now.getTime() - UI_STALE_RECRAWL.perPageEveryMs),
          },
        },
      }),
      db.assistSiteUiRecrawl.findMany({
        where: { siteId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          host: true,
          path: true,
          status: true,
          staleElements: true,
          createdAt: true,
        },
      }),
    ]);
    return {
      ...summary,
      recrawl: {
        perDay: state.planId
          ? UI_STALE_RECRAWL.pagesPerDayByPlan[state.planId]
          : 0,
        today,
        recent: recent.map((r) => ({
          host: r.host,
          path: r.path,
          status: r.status === 'budget' ? 'budget' : 'requested',
          staleElements: r.staleElements,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    };
  }

  async patch(
    m: AccountMembership,
    siteId: string,
    videoId: string,
    body: unknown,
  ): Promise<SiteVideoView> {
    const db = await this.site(m, siteId);
    const enabled =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).enabled
        : undefined;
    if (
      typeof enabled !== 'boolean' ||
      Object.keys(body as object).some((k) => k !== 'enabled')
    ) {
      throw mediaCabinetError(
        HttpStatus.BAD_REQUEST,
        'VIDEO_PATCH_INVALID',
        'Ожидается { enabled: true|false }',
      );
    }
    const row = (await db.assistSiteVideo.findFirst({
      where: { id: videoId, siteId },
      select: VIDEO_SELECT,
    })) as VideoRow | null;
    if (!row) {
      throw mediaCabinetError(
        HttpStatus.NOT_FOUND,
        'VIDEO_NOT_FOUND',
        'Ролик не найден',
      );
    }
    if (enabled && row.requiresLogin) {
      throw mediaCabinetError(
        HttpStatus.CONFLICT,
        'VIDEO_REQUIRES_LOGIN',
        'Ролик снят за логином или не на подтверждённом адресе сайта — посетителям его показывать нельзя',
      );
    }
    if (enabled) {
      const state = await readState(this.prisma, m.accountId, this.now());
      if (!videoAllowedByPlan(state.planId)) {
        throw mediaCabinetError(
          HttpStatus.PAYMENT_REQUIRED,
          'VIDEO_PLAN_REQUIRED',
          'Видео в ответах доступно на тарифе Business и выше',
        );
      }
    }
    // Условно по requiresLogin: синхронизация генератора могла пометить
    // ролик «за логином» между чтением и записью.
    const res = await db.assistSiteVideo.updateMany({
      where: {
        id: videoId,
        siteId,
        ...(enabled ? { requiresLogin: false } : {}),
      },
      data: { enabled },
    });
    if (res.count === 0) {
      throw mediaCabinetError(
        HttpStatus.CONFLICT,
        'VIDEO_REQUIRES_LOGIN',
        'Ролик изменился — обновите экран',
      );
    }
    return view({ ...row, enabled });
  }
}
