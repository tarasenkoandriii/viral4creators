/**
 * «Отчёт для разработчика» по одноразовой ссылке (заход 9, Р-З9-9) —
 * гашение токена и выдача среза отчёта. Ссылку выдаёт кабинет
 * (`VoiceControlSettingsService.devLink`): строка `assist_site_voice_tests`
 * вида `dev_report` (хеш токена, срок, срез отчёта без ПД — `devReportOf`),
 * без миграции. Запрос страницы ссылки приходит без кабинета — чтение
 * системное, только по хешу токена; гашение — тем же условным UPDATE
 * (`usedAt IS NULL`, срок не вышел): два параллельных открытия — одно.
 * В лог — только id строки.
 */
import { Injectable, Logger } from '@nestjs/common';
import { SitesDb } from '../../../prisma/sites-db.service';
import { sha256Hex } from '../public/voice-test-store';
import { DEV_REPORT_KIND, type DevReport } from './dev-report';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

@Injectable()
export class VoiceDevReportService {
  private readonly logger = new Logger(VoiceDevReportService.name);
  now: () => Date = () => new Date();

  constructor(private readonly sitesDb: SitesDb) {}

  private sys() {
    return this.sitesDb.system(
      'отчёт мастера для разработчика: строка по хешу одноразового токена (кабинета в запросе нет)',
    );
  }

  /** Язык страницы ссылки без гашения (GET); нет/истёк/открыт — null. */
  async peekLang(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const row = await this.sys().assistSiteVoiceTest.findFirst({
      where: {
        tokenHash: sha256Hex(token),
        kind: DEV_REPORT_KIND,
        usedAt: null,
        tokenExpiresAt: { gt: this.now() },
      },
      select: { report: true },
    });
    const r = row?.report as { lang?: unknown } | null | undefined;
    return typeof r?.lang === 'string' ? r.lang : null;
  }

  /** Погасить токен и отдать срез; недействителен/истёк/открыт — null. */
  async consume(token: unknown): Promise<DevReport | null> {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const now = this.now();
    const sys = this.sys();
    const row = await sys.assistSiteVoiceTest.findFirst({
      where: {
        tokenHash: sha256Hex(token),
        kind: DEV_REPORT_KIND,
        usedAt: null,
        tokenExpiresAt: { gt: now },
      },
      select: { id: true, report: true },
    });
    if (!row?.report) return null;
    const used = await sys.assistSiteVoiceTest.updateMany({
      where: { id: row.id, usedAt: null, tokenExpiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) return null;
    this.logger.log(`voice dev-report opened row=${row.id}`);
    return row.report as unknown as DevReport;
  }
}
