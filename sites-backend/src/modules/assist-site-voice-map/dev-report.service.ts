/**
 * «Отчёт для разработчика» голосовой карты — выдача ссылки в TMA и чтение
 * по ссылке без входа (Э6-тер (9), заход 9; ТЗ §5-кватер.4, §5-кватер.13).
 *
 *  - выдать (`POST …/voice-map/site/dev-report`, владелец/менеджер): снимок
 *    отчёта по ЧЕРНОВИКУ карты (`buildDevReport`) пишется в строку, токен
 *    — 24 случайных байта, в базе только SHA-256; срок 7 дней; прежние
 *    ссылки сайта гаснут (одна живая ссылка на сайт), истёкшие/отозванные
 *    строки сверх 20 удаляются здесь же (без крона);
 *  - отозвать (`DELETE …/dev-report`) — сразу; статус (`GET …/dev-report`);
 *  - прочитать (`GET …/dev-report/:token`, публичный маршрут): строка по
 *    хешу — системным чтением (кабинета в запросе нет), сайт пути должен
 *    совпасть со строкой; неизвестный/чужой/истёкший/отозванный токен —
 *    ОДИН ответ 404 (не оракул). Содержимое — только снятый снимок: живой
 *    черновик по ссылке не читается.
 */
import { randomBytes } from 'crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../prisma/sites-db.service';
import { loadAssistSite } from '../assist-site-setup/widget-settings.service';
import { parseVoiceMapContent } from '../assist-ui-core/voice-map';
import type { AccountMembership } from '../site-core/account/roles';
import {
  buildDevReport,
  DEV_REPORT_LIMITS,
  type DevReportContent,
} from './dev-report';
import { voiceMapError } from './voice-map-errors';
import { sha256Hex, VoiceMapService } from './voice-map.service';

export interface DevReportLinkView {
  /** Токен показывается ОДИН раз (в базе — только хеш). */
  token: string;
  /** Путь отчёта от корня публичного API (TMA добавляет origin). */
  path: string;
  expiresAt: string;
  counts: DevReportContent['counts'];
}

export interface DevReportStatusView {
  active: {
    createdAt: string;
    expiresAt: string;
    views: number;
    lastViewedAt: string | null;
  } | null;
}

/** Боты превью ссылок в мессенджерах и поисковики — не «просмотр». */
export const PREVIEW_BOT_RE =
  /TelegramBot|Slackbot|facebookexternalhit|Facebot|Twitterbot|LinkedInBot|WhatsApp|Discordbot|SkypeUriPreview|vkShare|Viber|redditbot|Googlebot|bingbot|Applebot|Embedly|Iframely|Pinterest|YandexBot|Google-InspectionTool/i;

export function devReportPath(siteId: string, token: string): string {
  return `/assist/sites/${encodeURIComponent(siteId)}/voice-map/site/dev-report/${token}`;
}

@Injectable()
export class DevReportService {
  private readonly logger = new Logger(DevReportService.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly sitesDb: SitesDb,
    private readonly maps: VoiceMapService,
  ) {}

  async create(
    m: AccountMembership,
    siteId: string,
  ): Promise<DevReportLinkView> {
    const db = this.sitesDb.forAccount(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const now = this.now();
    const row = await this.maps.loadMap(db, m.accountId, siteId);
    const hosts = this.maps.hostNames(
      await this.maps.siteHosts(db, siteId, now),
    );
    const content = buildDevReport(parseVoiceMapContent(row.draft), {
      host: hosts[0] ?? null,
      platform: row.platformTemplate,
      draftRevision: row.draftRevision,
      publishedVersion: row.publishedVersion,
      now,
    });
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + DEV_REPORT_LIMITS.ttlMs);
    await db.$transaction(async (tx) => {
      // Аудит P3: две выдачи разом — по очереди (замок сайта), иначе обе
      // погасили бы «прежние» до вставки друг друга и живых стало бы две.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`voice-map-dev-report:${siteId}`}))`;
      // Одна живая ссылка на сайт: прежние гаснут сразу.
      await tx.assistSiteVoiceMapDevReport.updateMany({
        where: { siteId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.assistSiteVoiceMapDevReport.create({
        data: {
          accountId: m.accountId,
          siteId,
          tokenHash: sha256Hex(token),
          content: content as unknown as Prisma.InputJsonValue,
          createdBy: m.memberId,
          expiresAt,
        },
      });
      // Уборка без крона: старые погасшие строки сверх 20 на сайт.
      const old = await tx.assistSiteVoiceMapDevReport.findMany({
        where: { siteId },
        orderBy: { createdAt: 'desc' },
        skip: DEV_REPORT_LIMITS.keepRows,
        select: { id: true },
      });
      const gone = await tx.assistSiteVoiceMapDevReport.findMany({
        where: {
          siteId,
          OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
          createdAt: { lte: new Date(now.getTime() - DEV_REPORT_LIMITS.ttlMs) },
        },
        select: { id: true },
      });
      const ids = [...new Set([...old, ...gone].map((x) => x.id))];
      if (ids.length)
        await tx.assistSiteVoiceMapDevReport.deleteMany({
          where: { id: { in: ids } },
        });
    });
    await db.assistSiteVoiceMapChange.create({
      data: {
        accountId: m.accountId,
        siteId,
        revision: row.draftRevision,
        actor: m.memberId,
        source: 'tma',
        op: { op: 'dev-report', targets: content.counts.targets },
      },
    });
    this.logger.log(
      `voice-map dev-report site=${siteId} targets=${content.counts.targets}`,
    );
    return {
      token,
      path: devReportPath(siteId, token),
      expiresAt: expiresAt.toISOString(),
      counts: content.counts,
    };
  }

  async status(
    m: AccountMembership,
    siteId: string,
  ): Promise<DevReportStatusView> {
    const db = this.sitesDb.forAccount(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const now = this.now();
    const r = await db.assistSiteVoiceMapDevReport.findFirst({
      where: { siteId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        views: true,
        lastViewedAt: true,
      },
    });
    return {
      active: r
        ? {
            createdAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            views: r.views,
            lastViewedAt: r.lastViewedAt ? r.lastViewedAt.toISOString() : null,
          }
        : null,
    };
  }

  async revoke(
    m: AccountMembership,
    siteId: string,
  ): Promise<{ revoked: number }> {
    const db = this.sitesDb.forAccount(m.accountId);
    await loadAssistSite(db, m.accountId, siteId);
    const u = await db.assistSiteVoiceMapDevReport.updateMany({
      where: { siteId, revokedAt: null },
      data: { revokedAt: this.now() },
    });
    return { revoked: u.count };
  }

  /**
   * Чтение по ссылке (публичный маршрут): снимок отчёта или 404 — один код
   * на все отказы (нет строки, чужой сайт в пути, истекла, отозвана).
   */
  async read(
    siteId: unknown,
    token: unknown,
    opts: { count?: boolean } = {},
  ): Promise<DevReportContent> {
    const notFound = () =>
      voiceMapError(
        HttpStatus.NOT_FOUND,
        'VOICE_MAP_DEV_REPORT_NOT_FOUND',
        'Ссылка недействительна, устарела или отозвана',
      );
    if (
      typeof token !== 'string' ||
      !DEV_REPORT_LIMITS.tokenRe.test(token) ||
      typeof siteId !== 'string'
    )
      throw notFound();
    const now = this.now();
    const row = await this.sitesDb
      .system(
        'отчёт для разработчика: строка по хешу токена — кабинета в запросе нет',
      )
      .assistSiteVoiceMapDevReport.findFirst({
        where: { tokenHash: sha256Hex(token) },
      });
    if (
      !row ||
      row.siteId !== siteId ||
      row.revokedAt ||
      row.expiresAt.getTime() <= now.getTime()
    )
      throw notFound();
    // Просмотр — только человеком (не HEAD и не бот превью ссылки).
    if (opts.count !== false)
      await this.sitesDb
        .forAccount(row.accountId)
        .assistSiteVoiceMapDevReport.updateMany({
          where: { id: row.id, revokedAt: null },
          data: { views: { increment: 1 }, lastViewedAt: now },
        });
    return row.content as unknown as DevReportContent;
  }
}
