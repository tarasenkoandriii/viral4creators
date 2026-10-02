/**
 * Факты «Админки» для утренней сводки и отчёта недели — A (Э3; ТЗ §4.15
 * assist-digest «удержанные версии базы», §5-тер.7 «Раздел „Админка“ — только
 * assistAdmin: owner», У-8, У-27). Единственный файл A в модуле «Админки»:
 * читает только assist_admin_* (правило графа admin↛site), отдаёт числа без
 * текстов. Собирает отчёт нейтральный модуль assist-digest (правило графа
 * `digest-leaf`), раздел уходит только участникам с assistAdmin: owner.
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';

export interface AdminDigestFacts {
  /** Удержанные (held) версии знаний «Админки» — ждут решения владельца. */
  heldVersions: number;
  /** Всплеск карантина «Админки» за сутки. */
  quarantined: number;
}

@Injectable()
export class AdminDigestSource {
  constructor(private readonly sitesDb: SitesDb) {}

  /** Только числа: удержанные версии (сейчас) и карантин с `since`. */
  async facts(p: {
    accountId: string;
    siteId: string;
    since: Date;
  }): Promise<AdminDigestFacts> {
    const db = this.sitesDb.forAccount(p.accountId);
    const [heldVersions, quarantined] = await Promise.all([
      db.assistAdminKnowledgeVersion.count({
        where: { siteId: p.siteId, status: 'held' },
      }),
      db.assistAdminChunk.count({
        where: {
          siteId: p.siteId,
          quarantined: true,
          createdAt: { gte: p.since },
        },
      }),
    ]);
    return { heldVersions, quarantined };
  }
}
