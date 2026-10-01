/**
 * Адаптер режима «Сайт» для общего кода маршрутов знаний (K3): делегаты
 * ТОЛЬКО таблиц assist_site_* (+ assist_sites). Имён «Админки» здесь нет и
 * быть не может (правило графа site-names↛admin) — поэтому маршрут «Сайта»
 * физически не пишет в знания сотрудников.
 */
import { SitesDb } from '../../prisma/sites-db.service';
import type { ModeAdapter } from '../assist-knowledge-core/documents/mode-knowledge.core';
import type {
  ChunkRow,
  DocumentRow,
  ExclusionRow,
  FaqRow,
  ModeRows,
  RowDelegate,
  SourceRow,
  VersionRow,
} from '../assist-knowledge-core/documents/rows';
import type { KnowledgeCtx } from '../assist-knowledge-core/types';
import { SiteKnowledgeService } from './site-knowledge.service';

export function siteModeAdapter(
  db: SitesDb,
  api: SiteKnowledgeService,
): ModeAdapter {
  return {
    mode: 'site',
    api,
    urlPurpose: 'assist-crawl',
    requirePublicConfirm: true,
    fileCreateExtra: (now) => ({ publicConfirmedAt: now }),
    rows(accountId: string): ModeRows {
      const t = db.forAccount(accountId);
      return {
        source: t.assistSiteSource as unknown as RowDelegate<SourceRow>,
        document: t.assistSiteDocument as unknown as RowDelegate<DocumentRow>,
        chunk: t.assistSiteChunk as unknown as RowDelegate<ChunkRow>,
        version:
          t.assistSiteKnowledgeVersion as unknown as RowDelegate<VersionRow>,
        faq: t.assistSiteFaq as unknown as RowDelegate<FaqRow>,
        exclusion:
          t.assistSiteExclusion as unknown as RowDelegate<ExclusionRow>,
      };
    },
    systemSources(): RowDelegate<SourceRow> {
      return db.system(
        'крон разбора документов «Сайта»: источники всех кабинетов',
      ).assistSiteSource as unknown as RowDelegate<SourceRow>;
    },
    async publishedVersion(ctx: KnowledgeCtx): Promise<number> {
      const row = await db.forAccount(ctx.accountId).assistSite.findFirst({
        where: { siteId: ctx.siteId },
        select: { knowledgeVersion: true },
      });
      return row?.knowledgeVersion ?? 0;
    },
    /**
     * Строка assist_sites нужна K2 (счётчик версий) до первого документа —
     * создаётся выключенной: включение помощника — отдельное действие (enable).
     */
    async ensureSettings(ctx: KnowledgeCtx): Promise<void> {
      await db.forAccount(ctx.accountId).assistSite.createMany({
        data: [
          { accountId: ctx.accountId, siteId: ctx.siteId, enabled: false },
        ],
        skipDuplicates: true,
      });
    },
  };
}
