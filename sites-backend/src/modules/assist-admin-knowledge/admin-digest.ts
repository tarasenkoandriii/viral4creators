/**
 * Факты «Админки» для утренней сводки и отчёта недели — A (Э3; ТЗ §4.15
 * assist-digest «удержанные версии базы», §5-тер.7 «Раздел „Админка“ — только
 * assistAdmin: owner», У-8, У-27). Единственный файл A в модуле «Админки»:
 * читает только assist_admin_* (правило графа admin↛site), отдаёт числа без
 * текстов. Собирает отчёт нейтральный модуль assist-digest (правило графа
 * `digest-leaf`), раздел уходит только участникам с assistAdmin: owner.
 * Заход 9: мемо АМ-N «требует проверки» (§5-бис.17 п.8 — «строка в
 * дайджесте») и голова цепочки журнала действий (Р-З9-20, внешний якорь).
 */
import { Injectable } from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';

/** Мемо АМ-N в `needs_review` (§5-бис.17 п.8): номер и код причины. */
export interface AdminDigestMemo {
  number: number;
  /** pin_mismatch | failures | goal_low (admin-memo-review.ts) — или null. */
  code: string | null;
  /** Шаг с 1 (сбои/pin); null — по цели. */
  step: number | null;
}

/**
 * Голова цепочки журнала действий (Р-З9-20, аудит Э8 (3)): внешний якорь —
 * владелец получает её раз в неделю в отчёте и может сверить с экспортом
 * CSV; переписанную задним числом цепочку выдаст несовпадение хеша.
 */
export interface AdminChainHead {
  hash: string;
  id: string;
  at: string;
}

export interface AdminDigestFacts {
  /** Удержанные (held) версии знаний «Админки» — ждут решения владельца. */
  heldVersions: number;
  /** Всплеск карантина «Админки» за сутки. */
  quarantined: number;
  /** Мемо «требует проверки» (не больше ADMIN_DIGEST_MEMOS_MAX, по номеру). */
  memosNeedReview?: AdminDigestMemo[];
  /** Всего мемо в `needs_review` (строк в списке может быть меньше). */
  memosNeedReviewTotal?: number;
  /** Голова цепочки журнала; null — журнал пуст. */
  chainHead?: AdminChainHead | null;
}

/** Мемо «требует проверки» в одном сообщении (остальные — «и ещё N»). */
export const ADMIN_DIGEST_MEMOS_MAX = 10;

function memoOf(r: { number: number; reviewReason: unknown }): AdminDigestMemo {
  const why =
    r.reviewReason && typeof r.reviewReason === 'object'
      ? (r.reviewReason as { code?: unknown; step?: unknown })
      : {};
  return {
    number: r.number,
    code:
      typeof why.code === 'string' && /^[a-z_]{1,32}$/.test(why.code)
        ? why.code
        : null,
    step:
      typeof why.step === 'number' && Number.isInteger(why.step)
        ? why.step
        : null,
  };
}

@Injectable()
export class AdminDigestSource {
  constructor(private readonly sitesDb: SitesDb) {}

  /**
   * Числа и коды: удержанные версии (сейчас), карантин с `since`, мемо АМ-N
   * в `needs_review` (номер и код причины, без текстов шагов) и голова
   * цепочки журнала (хеш, id, время — без данных строки).
   */
  async facts(p: {
    accountId: string;
    siteId: string;
    since: Date;
  }): Promise<AdminDigestFacts> {
    const db = this.sitesDb.forAccount(p.accountId);
    const [heldVersions, quarantined, memos, memosTotal, head] =
      await Promise.all([
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
        db.assistAdminMemo.findMany({
          where: { siteId: p.siteId, status: 'needs_review' },
          select: { number: true, reviewReason: true },
          orderBy: { number: 'asc' },
          take: ADMIN_DIGEST_MEMOS_MAX,
        }),
        db.assistAdminMemo.count({
          where: { siteId: p.siteId, status: 'needs_review' },
        }),
        db.assistAdminActionLog.findFirst({
          where: { siteId: p.siteId },
          orderBy: [{ at: 'desc' }, { id: 'desc' }],
          select: { id: true, hash: true, at: true },
        }),
      ]);
    return {
      heldVersions,
      quarantined,
      memosNeedReview: memos.map(memoOf),
      memosNeedReviewTotal: memosTotal,
      chainHead: head
        ? { hash: head.hash, id: head.id, at: head.at.toISOString() }
        : null,
    };
  }
}
