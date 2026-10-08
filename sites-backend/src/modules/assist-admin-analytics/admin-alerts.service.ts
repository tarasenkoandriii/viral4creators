/**
 * Push владельцу по тревоге компенсаций «Админки» (заход 10, Р-З10-13; ТЗ
 * §5-бис.15 п.12; было Р-З9-43 «пока только в статистике»).
 *
 *  - без нового крона: из существующего assist-admin-embed-run, в части с
 *    троттлингом (не чаще раза в 10 мин — `AdminAnalyticsRunner`);
 *  - расчёт тревоги — тот же, что на экране (`compensationWindow`: успешность
 *    < 80% на ≥ 10 попытках за 24 ч), по сайтам, где за 48 ч были
 *    исполнения компенсаций (дешёвый отбор системным чтением);
 *  - дедуп сайт × UTC-сутки — условный UPDATE `compensationAlertDay`: два
 *    тика и два инстанса не пришлют push дважды;
 *  - получатели — владелец кабинета и `assistAdmin: owner` (К-9: менеджер
 *    «Сайта» о данных «Админки» не узнаёт), каждому на его языке
 *    (`recipientsWithLang` + `sendToMembersByLang`, Р-З9-7). Без деградации:
 *    только сигнал.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import {
  COMPENSATION_ALERT,
  compensationWindow,
} from '../assist-admin-mode/admin-stats.service';
import {
  type FetchLike,
  recipientsWithLang,
  sendToMembersByLang,
} from '../assist-knowledge-core/notify';
import { ADMIN_REPORT_LANGS, compensationAlertText } from './admin-report-text';
import { adminOwner } from './admin-weekly.service';

export interface AdminAlertTickResult {
  checked: number;
  alerts: number;
  sent: number;
}

@Injectable()
export class AdminCompensationAlerts {
  env: NodeJS.ProcessEnv = process.env;
  /** Подмена отправки — только тестами (никогда из env). */
  fetchImpl: FetchLike | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
  ) {}

  async tick(p: {
    now: Date;
    deadline: number;
    siteIds?: string[] | null;
  }): Promise<AdminAlertTickResult> {
    const out: AdminAlertTickResult = { checked: 0, alerts: 0, sent: 0 };
    const since = new Date(p.now.getTime() - 2 * COMPENSATION_ALERT.windowMs);
    const day = p.now.toISOString().slice(0, 10);
    const sites = await this.prisma.$queryRawUnsafe<
      Array<{ accountId: string; siteId: string }>
    >(
      `SELECT DISTINCT x."accountId", x."siteId"
         FROM "sites"."assist_admin_action_proposals" x
         JOIN "sites"."assist_admin_settings" s
           ON s."siteId" = x."siteId" AND s."accountId" = x."accountId"
        WHERE x."compensationOf" IS NOT NULL AND x."createdAt" >= $1
          AND s."adminModeEnabled"
          AND (s."compensationAlertDay" IS NULL OR s."compensationAlertDay" <> $2)
          AND ($3::text[] IS NULL OR x."siteId" = ANY($3::text[]))
        LIMIT 200`,
      since,
      day,
      p.siteIds ?? null,
    );
    for (const s of sites) {
      if (Date.now() >= p.deadline) break;
      out.checked++;
      const db = this.sitesDb.forAccount(s.accountId);
      const rows = await db.assistAdminActionProposal.findMany({
        where: {
          siteId: s.siteId,
          compensationOf: { not: null },
          createdAt: { gte: since },
        },
        select: {
          status: true,
          attempts: true,
          compensationOf: true,
          createdAt: true,
          executedAt: true,
        },
        take: 5_000,
      });
      const w = compensationWindow(rows, p.now);
      if (!w.alert) continue;
      out.alerts++;
      // Дедуп сайт × сутки: условный UPDATE — push уходит ровно один раз.
      const claimed = await db.assistAdminSettings.updateMany({
        where: {
          siteId: s.siteId,
          OR: [
            { compensationAlertDay: null },
            { compensationAlertDay: { not: day } },
          ],
        },
        data: { compensationAlertDay: day },
      });
      if (claimed.count !== 1) continue;
      const site = await db.site.findFirst({
        where: { id: s.siteId },
        select: { name: true },
      });
      const texts = Object.fromEntries(
        ADMIN_REPORT_LANGS.map((lang) => [
          lang,
          compensationAlertText(lang, {
            siteName: site?.name ?? s.siteId,
            attempts: w.attempts,
            ok: w.ok,
          }),
        ]),
      ) as Parameters<typeof sendToMembersByLang>[0]['texts'];
      out.sent += await sendToMembersByLang({
        recipients: await recipientsWithLang(
          this.sitesDb,
          s.accountId,
          adminOwner,
        ),
        texts,
        hashPath: `/sites/${s.siteId}/admin-mode/stats`,
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
    }
    return out;
  }
}
