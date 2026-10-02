/**
 * Журнал доступа к учётным данным (Э-С Ш2, П-Т12; аудит слияния §3.2
 * «Аудит доступа»): кто, когда, зачем, какой результат — БЕЗ секретов, без
 * URL-путей и без содержимого.
 *
 * Строки только дописываются (триггер БД запрещает UPDATE, DELETE — кроме
 * чистки по сроку кроном), каждая несёт `hash = SHA-256(prevHash + поля)`:
 * удалённая или переписанная строка в середине видна `verifyAuditChain`.
 * Порядок цепочки держит `pg_advisory_xact_lock` — две параллельные записи
 * не возьмут один `prevHash`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { SitesDb } from '../../prisma/sites-db.service';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'put-secret'
  | 'forget-secrets'
  | 'lease'
  | 'redeem'
  | 'read'
  | 'expire'
  | 'rotate';

export interface AuditEntry {
  actor: string;
  action: AuditAction;
  scope: 'A' | 'B';
  accountId?: string | null;
  subjectId?: string | null;
  ownerRef?: string | null;
  product?: string | null;
  hostId?: string | null;
  runRef?: string | null;
  purpose?: string | null;
  /** `ok` | `denied:<причина>` */
  result: string;
}

export interface AuditRow extends AuditEntry {
  at: Date;
  prevHash: string | null;
  hash: string;
}

const LOCK_KEY = 'site-credential-audit';

/** Канонические поля строки — порядок фиксирован, пустое — пустая строка. */
export function auditHash(
  prevHash: string | null,
  e: AuditEntry,
  at: Date,
): string {
  const fields = [
    prevHash ?? '',
    at.toISOString(),
    e.actor,
    e.action,
    e.scope,
    e.accountId ?? '',
    e.subjectId ?? '',
    e.ownerRef ?? '',
    e.product ?? '',
    e.hostId ?? '',
    e.runRef ?? '',
    e.purpose ?? '',
    e.result,
  ];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Проверка цепочки: каждая строка ссылается на хеш предыдущей и сама
 * хешируется верно. `firstBroken` — индекс первой нарушенной строки.
 */
export function verifyAuditChain(rows: AuditRow[]): {
  ok: boolean;
  firstBroken: number | null;
} {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i > 0 && r.prevHash !== rows[i - 1].hash) {
      return { ok: false, firstBroken: i };
    }
    if (auditHash(r.prevHash, r, r.at) !== r.hash) {
      return { ok: false, firstBroken: i };
    }
  }
  return { ok: true, firstBroken: null };
}

@Injectable()
export class CredentialAuditService {
  private readonly logger = new Logger(CredentialAuditService.name);

  constructor(private readonly db: SitesDb) {}

  async append(entry: AuditEntry, now = new Date()): Promise<void> {
    const prisma = this.db.system(
      'журнал доступа к учётным данным: обе зоны (кабинет и личные записи)',
    );
    // Миллисекунды — как хранит TIMESTAMP(3): иначе хеш, посчитанный по
    // микросекундам JS, не совпал бы с перечитанной строкой.
    const at = new Date(Math.floor(now.getTime()));
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      const last = await tx.siteCredentialAudit.findFirst({
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });
      const prevHash = last?.hash ?? null;
      await tx.siteCredentialAudit.create({
        data: {
          actor: entry.actor,
          action: entry.action,
          scope: entry.scope,
          accountId: entry.accountId ?? null,
          subjectId: entry.subjectId ?? null,
          ownerRef: entry.ownerRef ?? null,
          product: entry.product ?? null,
          hostId: entry.hostId ?? null,
          runRef: entry.runRef ?? null,
          purpose: entry.purpose ?? null,
          result: entry.result,
          at,
          prevHash,
          hash: auditHash(prevHash, entry, at),
        },
      });
    });
  }

  /** Как `append`, но сбой журнала не роняет вызывающего (только отказы). */
  async appendQuietly(entry: AuditEntry, now = new Date()): Promise<void> {
    try {
      await this.append(entry, now);
    } catch (e) {
      this.logger.error(
        `журнал учётных данных не записан (${entry.action}/${entry.result}): ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }

  /** Последние строки по учётке/записи — для экрана «кто и когда брал». */
  async recent(
    where: { accountId: string; subjectId: string } | { ownerRef: string },
    take = 20,
  ): Promise<AuditRow[]> {
    const rows = await this.db
      .system('журнал доступа к учётным данным: чтение строк одной учётки')
      .siteCredentialAudit.findMany({
        where,
        orderBy: { seq: 'desc' },
        take,
      });
    return rows.map((r) => ({
      ...r,
      action: r.action as AuditAction,
      scope: r.scope as 'A' | 'B',
    }));
  }
}
