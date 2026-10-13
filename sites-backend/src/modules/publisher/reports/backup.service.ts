/**
 * AI Publisher — экспорт резервной копии продукта (P-E, проектный документ
 * §15.4; Р-PUB-10/11; AT-CORE-20).
 *
 *  - Снимок данных — одна транзакция REPEATABLE READ (согласованный срез
 *    всех таблиц), без сети; затем шифрование и запись в Blob — ВНЕ
 *    транзакции (§8.1: сеть внутри транзакции запрещена); затем строка
 *    `pub_backups` (sha256, размер, счётчики, версия ключа, `rotationUntil`
 *    = +`retention_policy.backupRotationDays` дней Kyiv, путь —
 *    шифротекстом).
 *  - Таблицы — `core/table-registry.exportOrder()` (всё, кроме служебных
 *    очередей и окон лимита); строки — `to_jsonb` с `bigint`/`Decimal`
 *    текстом.
 *  - Копии — только продуктов `working|test` (eval-конфигурации AI живут в
 *    eval-продукте, `restored` — уже копия).
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { publisherBackupDisabled } from '../../../config/publisher-env';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { BackupView } from '../contracts/reports-api';
import {
  openBackupPath,
  publisherKeys,
  sealBackupPath,
} from '../core/contact-crypto';
import { PubError } from '../core/errors';
import { addKyivCalendarDays } from '../core/kyiv-time';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { exportOrder, type PubTableInfo } from '../core/table-registry';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  openBackup,
  sealBackup,
  sha256Of,
  tableCountsOf,
  type BackupDocument,
  type BackupRow,
} from './backup-format';
import { PUB_BACKUP_STORAGE, type BackupStorage } from './backup-storage';
import { newRowId } from './experiments.service';

type BackupDbRow = Prisma.PubBackupGetPayload<object>;
export type BackupKind = 'weekly' | 'post_purchase' | 'manual';

const DEFAULT_ROTATION_DAYS = 90;

/** Колонки `bigint`/`Decimal` модели — в копию текстом (точность). */
function numericColumns(model: string): string[] {
  const m = (
    Prisma.dmmf.datamodel.models as unknown as Array<{
      name: string;
      fields: Array<{ name: string; kind: string; type: string }>;
    }>
  ).find((x) => x.name === model);
  return (m?.fields ?? [])
    .filter(
      (f) =>
        f.kind === 'scalar' && (f.type === 'BigInt' || f.type === 'Decimal'),
    )
    .map((f) => f.name);
}

/** SELECT строк таблицы продукта как jsonb (порядок — createdAt, id). */
export function exportSql(t: PubTableInfo): string {
  const nums = numericColumns(t.model);
  const fix = nums.length
    ? ` || jsonb_build_object(${nums.map((c) => `'${c}', t."${c}"::text`).join(', ')})`
    : '';
  const where =
    t.table === 'pub_products'
      ? `t."id" = $1 AND t."accountId" = $2`
      : `t."productId" = $1 AND t."accountId" = $2`;
  return `SELECT (to_jsonb(t)${fix})::text AS r FROM "sites"."${t.table}" t WHERE ${where} ORDER BY t."createdAt", t."id"`;
}

export function backupView(r: BackupDbRow): BackupView {
  return {
    id: r.id,
    kind: r.kind as BackupView['kind'],
    status: r.status as BackupView['status'],
    sha256: r.sha256,
    sizeBytes: r.sizeBytes.toString(),
    tableCounts: r.tableCounts as Record<string, number>,
    keyVersion: r.keyVersion,
    rotationUntil: r.rotationUntil.toISOString(),
    createdAt: r.createdAt.toISOString(),
    createdBy: r.createdBy,
  };
}

@Injectable()
export class BackupService {
  private readonly log = new Logger('PublisherBackup');

  constructor(
    private readonly db: SitesDb,
    @Inject(PUB_BACKUP_STORAGE) private readonly storage: BackupStorage,
  ) {}

  disabled(): boolean {
    return publisherBackupDisabled();
  }

  /** Документ копии: согласованный срез всех таблиц продукта. */
  async exportDocument(
    product: ProductRef,
    now: Date,
  ): Promise<BackupDocument> {
    return this.db.forAccount(product.accountId).$transaction(
      async (tx) => {
        const p = await tx.pubProduct.findFirst({
          where: { id: product.id },
          select: {
            id: true,
            accountId: true,
            siteId: true,
            kind: true,
            status: true,
          },
        });
        if (!p) throw new PubError('PUB_NOT_FOUND');
        if (p.kind !== 'working' && p.kind !== 'test') {
          throw new PubError('PUB_TRANSITION_INVALID', {
            reason: `backup_kind_${p.kind}`,
            allowed: [],
          });
        }
        const tables: Record<string, BackupRow[]> = {};
        for (const t of exportOrder()) {
          const rows = await tx.$queryRawUnsafe<Array<{ r: string }>>(
            exportSql(t),
            product.id,
            product.accountId,
          );
          tables[t.table] = rows.map((x) => JSON.parse(x.r) as BackupRow);
        }
        return {
          format: BACKUP_FORMAT,
          formatVersion: BACKUP_FORMAT_VERSION,
          exportedAt: now.toISOString(),
          source: {
            productId: p.id,
            accountId: p.accountId,
            siteId: p.siteId,
            kind: p.kind,
          },
          tables,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5000,
        timeout: 60_000,
      },
    );
  }

  /**
   * Экспорт + запись в хранилище (вне транзакции). Возвращает данные строки
   * `pub_backups` для вставки вызывающим (в его транзакции, с аудитом).
   */
  async prepare(
    product: ProductRef,
    now: Date,
  ): Promise<{
    id: string;
    blobPathEnc: string;
    sha256: string;
    sizeBytes: bigint;
    tableCounts: Record<string, number>;
    keyVersion: string;
    status: 'ok' | 'failed';
    storedPath: string | null;
  }> {
    const keys = publisherKeys('backup');
    if (!keys)
      throw new PubError('PUB_CONTACT_KEY_MISSING', { purpose: 'backup' });
    const doc = await this.exportDocument(product, now);
    const id = newRowId('bk');
    const sealed = sealBackup(doc, id, keys);
    const sha = sha256Of(sealed.bytes);
    let stored: string | null = null;
    try {
      stored = await this.storage.put(
        `publisher/${product.accountId}/${product.id}/backups/${id}.bin`,
        sealed.bytes,
      );
    } catch (e) {
      // Без текста ошибки хранилища в журнал данных (там может быть путь/токен).
      this.log.warn(
        `backup ${id}: запись в хранилище не удалась (${(e as Error)?.name ?? 'Error'})`,
      );
    }
    return {
      id,
      blobPathEnc: sealBackupPath(stored ?? `failed/${id}`, id, keys).enc,
      sha256: sha,
      sizeBytes: BigInt(sealed.bytes.length),
      tableCounts: tableCountsOf(doc),
      keyVersion: sealed.keyVersion,
      status: stored ? 'ok' : 'failed',
      storedPath: stored,
    };
  }

  async rotationUntil(tx: PubTx, productId: string, now: Date): Promise<Date> {
    const p = await tx.pubParameter.findFirst({
      where: { productId, key: 'retention_policy' },
      select: { value: true },
    });
    const days = (p?.value as { backupRotationDays?: unknown } | null)
      ?.backupRotationDays;
    return addKyivCalendarDays(
      now,
      typeof days === 'number' && Number.isInteger(days) && days >= 1
        ? days
        : DEFAULT_ROTATION_DAYS,
    );
  }

  /** Строка копии (в транзакции вызывающего). */
  async insertRow(
    tx: PubTx,
    product: ProductRef,
    prepared: Awaited<ReturnType<BackupService['prepare']>>,
    kind: BackupKind,
    actor: string,
    now: Date,
  ): Promise<{ row: BackupDbRow; audit: AuditInput[] }> {
    const row = await tx.pubBackup.create({
      data: {
        id: prepared.id,
        accountId: product.accountId,
        productId: product.id,
        kind,
        blobPathEnc: prepared.blobPathEnc,
        sha256: prepared.sha256,
        sizeBytes: prepared.sizeBytes,
        tableCounts: prepared.tableCounts,
        keyVersion: prepared.keyVersion,
        rotationUntil: await this.rotationUntil(tx, product.id, now),
        status: prepared.status,
        createdBy: actor,
      },
    });
    return {
      row,
      audit: [
        {
          objectType: 'backup',
          objectId: row.id,
          action: 'backup',
          toStatus: row.status,
          meta: {
            kind,
            sizeBytes: Number(prepared.sizeBytes),
            tables: Object.keys(prepared.tableCounts).length,
          },
        },
      ],
    };
  }

  /** Удалить записанный blob (повтор операции с тем же opKey — сирота). */
  async discard(prepared: { storedPath: string | null }): Promise<void> {
    if (prepared.storedPath)
      await this.storage.remove(prepared.storedPath).catch(() => undefined);
  }

  /**
   * Скачать, проверить sha256 и расшифровать копию. Несовпадение hash —
   * `PUB_RESTORE_CONFLICT` (копия повреждена или подменена).
   */
  async load(row: BackupDbRow): Promise<BackupDocument> {
    if (row.status !== 'ok')
      throw new PubError('PUB_RESTORE_CONFLICT', {
        reason: `backup_${row.status}`,
      });
    const keys = publisherKeys('backup');
    if (!keys)
      throw new PubError('PUB_CONTACT_KEY_MISSING', { purpose: 'backup' });
    const path = openBackupPath(row.blobPathEnc, row.id, keys);
    if (!path)
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'key_unavailable' });
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(path.value);
    } catch {
      throw new PubError('PUB_RESTORE_CONFLICT', {
        reason: 'blob_unavailable',
      });
    }
    if (sha256Of(bytes) !== row.sha256)
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'sha256_mismatch' });
    const doc = openBackup(bytes, row.id, keys);
    if (!doc)
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'decrypt_failed' });
    if (
      doc.source.productId !== row.productId ||
      doc.source.accountId !== row.accountId
    ) {
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'source_mismatch' });
    }
    return doc;
  }

  /** Ротация: blob удаляется, строка → `expired_deleted` (история копий остаётся). */
  async expire(row: BackupDbRow): Promise<boolean> {
    const keys = publisherKeys('backup');
    const path = keys ? openBackupPath(row.blobPathEnc, row.id, keys) : null;
    // Путь не открыть (нет ключа его версии) — blob не удалить: строку не трогаем.
    if (!path) return false;
    if (!path.value.startsWith('failed/'))
      await this.storage.remove(path.value);
    const n = await this.db.forAccount(row.accountId).pubBackup.updateMany({
      where: { id: row.id, status: 'ok' },
      data: { status: 'expired_deleted' },
    });
    return n.count === 1;
  }
}
