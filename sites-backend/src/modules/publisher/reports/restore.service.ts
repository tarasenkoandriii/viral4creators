/**
 * AI Publisher — восстановление копии в НОВЫЙ продукт `kind=restored`
 * (P-E, проектный документ §15.4, §8 «Восстановление не повторяет внешние
 * действия»; Р-PUB-10, Р-PUB-24; AT-CORE-20; контракт P-A0 §8.2).
 *
 * Порядок (контракт P-A0: «pub_restores running до переноса», «сначала
 * решения, потом головы»):
 *  1. `start` (короткая транзакция в `runOperation`): продукт `restored`,
 *     `mode=closed`, `restoredFromBackupId` на ТЕСТОВОМ сайте того же
 *     кабинета без продукта; строка `pub_restores` `running` с
 *     `targetProductId` — она открывает обход проверок «текущего
 *     состояния» для вставок `createdBy='restore:<id>'` (`pub_restoring`).
 *  2. `transfer` (одна длинная транзакция): все строки копии в порядке FK
 *     (`exportOrder`; `pub_parameters` — после `pub_parameter_decisions`;
 *     строки с самоссылками — топологически), новые id по карте
 *     old→new, шифротексты контактов и заметок перешифрованы под новый AAD,
 *     `matchHash` — с новым `productId`, `publicRef` заявок — новые
 *     (уникальны глобально); обратные ссылки циклов — вторым проходом;
 *     применяются ТЕКУЩИЕ списки `pub_erasures` и `pub_source_revocations`
 *     исходного продукта (удалённый контакт и отозванный источник не
 *     возвращаются); `pub_lead_outbox` и `pub_notifications` не создаются
 *     (их нет в копии); публикации, оплаты и расходы — история с
 *     `createdBy=restore:<id>`; счётчики бюджета сверяются с записями
 *     (расхождение — пересчёт и запись в отчёт); сверка связей и сумм.
 *     Затем `pub_restores.status='done'` + отчёт — обход закрыт.
 *  3. Ошибка переноса — откат всего переноса, `pub_restores=failed` с
 *     отчётом, целевой продукт → `archived`.
 *
 * Кроны продукты `kind=restored` не обрабатывают; гейты у него закрыты;
 * в публичных представлениях его нет (P-A0).
 *
 * Производительность (замер P-A0 ~0,2 мс/строка на DEFINER-гвардах):
 * вставка пакетами `jsonb_populate_recordset` по `RESTORE_CHUNK` строк —
 * один оператор на пакет; измерение — `reports/restore.db.spec.ts`, отчёт
 * пакета P-E.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt } from 'crypto';
import { SitesDb } from '../../../prisma/sites-db.service';
import type { DerivedKeys } from '../../../common/secrets-keyring';
import type { RestoreView } from '../contracts/reports-api';
import type { ContactMethod } from '../contracts/states';
import {
  contactMatchHash,
  openContact,
  openText,
  publisherKeys,
  sealContact,
  sealText,
} from '../core/contact-crypto';
import { AuditService } from '../core/audit';
import { PubError, validationError } from '../core/errors';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { newPublicKey } from '../core/product.service';
import {
  DEFERRED_REFS,
  ENCRYPTED_COLUMNS,
  exportOrder,
  fkColumnsOf,
  type DmmfModel,
  type PubTableInfo,
} from '../core/table-registry';
import type { BackupDocument, BackupRow } from './backup-format';
import { tableCountsOf } from './backup-format';
import { newRowId } from './experiments.service';
import { erasedRequestHash, leadEraseEffect } from '../leads/erase-effect';
import { redditOnSourceRevoked } from '../reddit/cascade';

/** Основание отзыва ролей восстановленного продукта (аудит P-E S1-5). */
export const RESTORE_GRANT_REVOKE_REASON =
  'Відновлення копії: ролі відновленого продукту власник видає заново.';

type RestoreRow = Prisma.PubRestoreGetPayload<object>;
type BackupDbRow = Prisma.PubBackupGetPayload<object>;

/** Аудит каскадов внутри переноса (сервис без состояния). */
const RESTORE_AUDIT = new AuditService();

/** Пакет вставки (один оператор INSERT … SELECT FROM jsonb_populate_recordset). */
export const RESTORE_CHUNK = 1000;
/** Длинная транзакция переноса (Supabase pooler держит; Vercel maxDuration 60 с — см. отчёт). */
export const RESTORE_TX_TIMEOUT_MS = 120_000;
/** `running` старше — зависшее (процесс оборван): следующий запуск помечает `failed`. */
export const RESTORE_STALE_MS = 15 * 60_000;

/** Таблицы копии, которые НЕ переносятся в новый продукт (служебное копий самого источника). */
export const RESTORE_SKIP_TABLES = [
  'pub_products',
  'pub_backups',
  'pub_restores',
] as const;
/** Строковые «мягкие» ссылки на id (без FK) — переназначаются по карте. */
export const SOFT_REF_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pub_audit_events: ['objectId'],
  pub_review_tasks: ['objectId', 'triggerRef'],
  pub_approvals: ['objectId'],
  pub_ai_tasks: ['objectId'],
  // Запись возврата P-D `refund:<id оплаты>` — связь с оплатой (S1-3).
  pub_payments: ['paymentRef'],
};
const ID_TOKEN = /[A-Za-z0-9_-]{8,64}/g;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function restoreView(r: RestoreRow): RestoreView {
  return {
    id: r.id,
    backupId: r.backupId,
    mode: r.mode as RestoreView['mode'],
    targetProductId: r.targetProductId,
    status: r.status as RestoreView['status'],
    report: r.report,
    startedBy: r.startedBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function newPublicRef(): string {
  let s = 'L-';
  for (let i = 0; i < 10; i++) s += BASE32[randomInt(BASE32.length)];
  return s;
}

/** Самоссылки модели (`supersedesId`, `parentContentId`, …) — колонки. */
export function selfRefColumns(model: string): string[] {
  const m = (Prisma.dmmf.datamodel.models as unknown as DmmfModel[]).find(
    (x) => x.name === model,
  );
  if (!m) return [];
  const deferred = new Set(
    DEFERRED_REFS.filter(([mm]) => mm === model).map(([, c]) => c),
  );
  return m.fields
    .filter((f) => f.kind === 'object' && f.type === model)
    .flatMap((f) => fkColumnsOf(m, f).filter((c) => c !== 'accountId'))
    .filter((c) => !deferred.has(c));
}

/**
 * Порядок переноса: `exportOrder()` без служебных таблиц; `pub_parameters`
 * — сразу после `pub_parameter_decisions` (контракт P-A0: решение той же
 * версии должно существовать раньше головы).
 */
export function restoreOrder(): PubTableInfo[] {
  const list = exportOrder().filter(
    (t) => !(RESTORE_SKIP_TABLES as readonly string[]).includes(t.table),
  );
  const params = list.find((t) => t.table === 'pub_parameters');
  const out = list.filter((t) => t.table !== 'pub_parameters');
  if (params)
    out.splice(
      out.findIndex((t) => t.table === 'pub_parameter_decisions') + 1,
      0,
      params,
    );
  return out;
}

/** Строки таблицы в порядке самоссылок (цель раньше ссылающегося). */
export function orderBySelfRefs(
  rows: BackupRow[],
  cols: readonly string[],
): BackupRow[] {
  if (cols.length === 0) return rows;
  const ids = new Set(rows.map((r) => r.id as string));
  const done = new Set<string>();
  const out: BackupRow[] = [];
  let pending = rows;
  while (pending.length) {
    const next: BackupRow[] = [];
    for (const r of pending) {
      const ready = cols.every((c) => {
        const v = r[c];
        return (
          typeof v !== 'string' || !ids.has(v) || done.has(v) || v === r.id
        );
      });
      if (ready) {
        out.push(r);
        done.add(r.id as string);
      } else next.push(r);
    }
    if (next.length === pending.length)
      throw new Error('restore: цикл самоссылок в таблице');
    pending = next;
  }
  return out;
}

interface Keys {
  contact: DerivedKeys;
  match: DerivedKeys;
  notes: DerivedKeys;
}

function keysOrThrow(): Keys {
  const contact = publisherKeys('leadContact');
  const match = publisherKeys('contactMatch');
  const notes = publisherKeys('leadNotes');
  if (!contact || !match || !notes)
    throw new PubError('PUB_CONTACT_KEY_MISSING', { purpose: 'restore' });
  return { contact, match, notes };
}

export interface CurrentLists {
  erasures: Array<{
    id: string;
    leadId: string;
    erasedAt: Date;
    erasedBy: string;
    basis: string;
    scope: unknown;
    createdAt: Date;
  }>;
  revocations: Array<{
    id: string;
    sourceId: string;
    revokedAt: Date;
    revokedBy: string;
    reason: string;
    createdAt: Date;
  }>;
}

@Injectable()
export class RestoreService {
  constructor(private readonly db: SitesDb) {}

  /** ТЕКУЩИЕ списки удаления и отзыва исходного продукта (не только из копии). */
  async currentLists(tx: PubTx, source: ProductRef): Promise<CurrentLists> {
    const [erasures, revocations] = await Promise.all([
      tx.pubErasure.findMany({
        where: { productId: source.id },
        orderBy: [{ erasedAt: 'asc' }, { id: 'asc' }],
      }),
      tx.pubSourceRevocation.findMany({
        where: { productId: source.id },
        orderBy: [{ revokedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    return { erasures, revocations };
  }

  /** Проверка копии без записи данных (`dry_run`): hash и расшифровка — у `BackupService.load`. */
  async dryRunReport(
    doc: BackupDocument,
    backup: BackupDbRow,
    lists: CurrentLists,
  ): Promise<Record<string, unknown>> {
    const counts = tableCountsOf(doc);
    const expected = (backup.tableCounts ?? {}) as Record<string, number>;
    const countMismatch = Object.keys({ ...counts, ...expected }).filter(
      (t) => (counts[t] ?? 0) !== (expected[t] ?? 0),
    );
    const ids = new Map<string, string>();
    for (const [t, rows] of Object.entries(doc.tables))
      for (const r of rows) ids.set(r.id as string, t);
    const dangling: string[] = [];
    let checked = 0;
    for (const t of restoreOrder()) {
      const rows = doc.tables[t.table] ?? [];
      const cols = [
        ...t.refs.flatMap((r) => r.columns),
        ...t.deferred.map((d) => d.column),
        ...selfRefColumns(t.model),
      ];
      for (const r of rows) {
        for (const c of cols) {
          const v = r[c];
          if (typeof v !== 'string') continue;
          checked++;
          if (!ids.has(v) && v !== doc.source.productId)
            dangling.push(`${t.table}.${c}`);
        }
      }
    }
    let keys: Keys | null = null;
    try {
      keys = keysOrThrow();
    } catch {
      keys = null;
    }
    let unreadable = 0;
    for (const c of doc.tables.pub_lead_contacts ?? []) {
      if (!keys || !openContact(c.contactEnc, c.leadId as string, keys.contact))
        unreadable++;
    }
    const docLeads = new Set(
      (doc.tables.pub_leads ?? []).map((l) => l.id as string),
    );
    const docSources = new Set(
      (doc.tables.pub_sources ?? []).map((s) => s.id as string),
    );
    const contactLeads = new Set(
      (doc.tables.pub_lead_contacts ?? []).map((c) => c.leadId as string),
    );
    return {
      mode: 'dry_run',
      backupId: backup.id,
      sha256: backup.sha256,
      decrypted: true,
      counts,
      countMismatch,
      links: { checked, dangling: [...new Set(dangling)] },
      encryptedLeadData: {
        total: (doc.tables.pub_lead_contacts ?? []).length,
        unreadable,
      },
      wouldApply: {
        erasures: lists.erasures.filter((e) => docLeads.has(e.leadId)).length,
        leadRowsSuppressed: lists.erasures.filter((e) =>
          contactLeads.has(e.leadId),
        ).length,
        revocations: lists.revocations.filter((r) => docSources.has(r.sourceId))
          .length,
        roleGrantsRevoked: (doc.tables.pub_role_grants ?? []).filter(
          (g) => !g.revokedAt,
        ).length,
      },
      suppressed: {
        leadOutbox: 'not_exported',
        notifications: 'not_exported',
        publications: (doc.tables.pub_publications ?? []).length,
        payments: (doc.tables.pub_payments ?? []).length,
        expenseEntries: (doc.tables.pub_expense_entries ?? []).length,
      },
      ok:
        countMismatch.length === 0 && dangling.length === 0 && unreadable === 0,
    };
  }

  /** Восстановление `running` этого источника (зависшие старше 15 мин — `failed`). */
  private async assertNoRunning(
    tx: PubTx,
    source: ProductRef,
    now: Date,
  ): Promise<void> {
    const running = await tx.pubRestore.findMany({
      where: { productId: source.id, status: 'running' },
    });
    for (const r of running) {
      if (now.getTime() - r.updatedAt.getTime() > RESTORE_STALE_MS) {
        await tx.pubRestore.updateMany({
          where: { id: r.id, status: 'running' },
          data: {
            status: 'failed',
            report: { error: 'stale_running', markedAt: now.toISOString() },
          },
        });
        if (r.targetProductId) {
          await tx.pubProduct.updateMany({
            where: { id: r.targetProductId, kind: 'restored' },
            data: { status: 'archived' },
          });
        }
        continue;
      }
      throw new PubError('PUB_RESTORE_CONFLICT', {
        reason: 'running',
        restoreId: r.id,
      });
    }
  }

  /** Шаг 1 apply: целевой продукт и строка `running` (до переноса строк). */
  async start(
    tx: PubTx,
    source: ProductRef & { name?: string },
    backup: BackupDbRow,
    targetSiteId: unknown,
    actor: string,
    now: Date,
  ): Promise<{ restore: RestoreRow; audit: AuditInput[] }> {
    if (
      typeof targetSiteId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(targetSiteId)
    ) {
      throw validationError([
        {
          field: 'targetSiteId',
          code: targetSiteId === undefined ? 'required' : 'format',
        },
      ]);
    }
    await this.assertNoRunning(tx, source, now);
    const site = await tx.site.findFirst({
      where: { id: targetSiteId },
      select: { id: true },
    });
    if (!site) throw new PubError('PUB_NOT_FOUND');
    const busy = await tx.pubProduct.findFirst({
      where: { siteId: targetSiteId },
      select: { id: true },
    });
    if (busy) throw new PubError('PUB_PRODUCT_EXISTS', { productId: busy.id });
    const src = await tx.pubProduct.findFirst({
      where: { id: source.id },
      select: { name: true },
    });
    const name = `Відновлено: ${src?.name ?? source.id}`;
    const target = await tx.pubProduct.create({
      data: {
        accountId: source.accountId,
        siteId: targetSiteId,
        kind: 'restored',
        name: [...name].slice(0, 120).join(''),
        publicKey: newPublicKey(),
        mode: 'closed',
        status: 'active',
        restoredFromBackupId: backup.id,
        createdBy: actor,
      },
    });
    const restore = await tx.pubRestore.create({
      data: {
        accountId: source.accountId,
        productId: source.id,
        backupId: backup.id,
        mode: 'apply_new_product',
        targetProductId: target.id,
        status: 'running',
        report: { startedAt: now.toISOString() },
        startedBy: actor,
        createdBy: actor,
      },
    });
    return {
      restore,
      audit: [
        {
          objectType: 'restore',
          objectId: restore.id,
          action: 'restore',
          toStatus: 'running',
          meta: {
            backupId: backup.id,
            targetProductId: target.id,
            targetSiteId,
          },
        },
      ],
    };
  }

  /**
   * Шаг 2 apply: перенос строк одной транзакцией. Возвращает отчёт; при
   * ошибке — строка восстановления `failed`, целевой продукт `archived`.
   */
  async transfer(
    accountId: string,
    restoreId: string,
    doc: BackupDocument,
  ): Promise<RestoreRow> {
    const started = Date.now();
    const db = this.db.forAccount(accountId);
    try {
      await db.$transaction(
        async (tx) => this.transferIn(tx, accountId, restoreId, doc, started),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          maxWait: 5000,
          timeout: RESTORE_TX_TIMEOUT_MS,
        },
      );
    } catch (e) {
      const code = e instanceof PubError ? e.code : 'restore_failed';
      const message = e instanceof Error ? e.message.slice(0, 300) : 'error';
      const after = await db.$transaction(async (tx) => {
        const r = await tx.pubRestore.findFirst({ where: { id: restoreId } });
        const n = await tx.pubRestore.updateMany({
          where: { id: restoreId, status: 'running' },
          data: {
            status: 'failed',
            report: {
              error: code,
              message:
                code === 'restore_failed'
                  ? message.replace(/[^\p{L}\p{N} ._:,()/-]/gu, ' ')
                  : code,
              durationMs: Date.now() - started,
            },
          },
        });
        // Архив — только если ЭТОТ проход перевёл строку в failed: повтор
        // или параллельный перенос, проигравший уже завершённому, успешный
        // продукт не трогает (аудит P-E S3-3).
        if (n.count === 1 && r?.targetProductId) {
          await tx.pubProduct.updateMany({
            where: { id: r.targetProductId, kind: 'restored' },
            data: { status: 'archived' },
          });
        }
        return tx.pubRestore.findFirst({ where: { id: restoreId } });
      });
      if (after?.status === 'done') return after;
      if (e instanceof PubError) throw e;
      throw new PubError('PUB_RESTORE_CONFLICT', {
        reason: 'transfer_failed',
        restoreId,
      });
    }
    return (await db.pubRestore.findFirst({
      where: { id: restoreId },
    })) as RestoreRow;
  }

  private async transferIn(
    tx: PubTx,
    accountId: string,
    restoreId: string,
    doc: BackupDocument,
    started: number,
  ): Promise<Record<string, unknown>> {
    // Перенос одной строки восстановления — по одному (повтор того же
    // opKey или двойной клик ждёт и видит `done`).
    await tx.$queryRaw`SELECT "id" FROM "sites"."pub_restores" WHERE "id" = ${restoreId} FOR UPDATE`;
    const restore = await tx.pubRestore.findFirst({ where: { id: restoreId } });
    if (!restore || restore.status !== 'running' || !restore.targetProductId) {
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'not_running' });
    }
    const target = restore.targetProductId;
    const source: ProductRef = { id: restore.productId, accountId };
    if (doc.source.productId !== source.id)
      throw new PubError('PUB_RESTORE_CONFLICT', { reason: 'source_mismatch' });
    const nonEmpty = await tx.pubParameter.count({
      where: { productId: target },
    });
    if (nonEmpty > 0)
      throw new PubError('PUB_RESTORE_CONFLICT', {
        reason: 'target_not_empty',
      });
    const keys = keysOrThrow();
    const lists = await this.currentLists(tx, source);
    const actor = `restore:${restoreId}`;
    const order = restoreOrder();

    // ── Карта id ─────────────────────────────────────────────────────────
    const map = new Map<string, string>([[source.id, target]]);
    for (const t of order) {
      for (const r of doc.tables[t.table] ?? [])
        map.set(r.id as string, newRowId('rs'));
    }
    const docLeads = new Set(
      (doc.tables.pub_leads ?? []).map((l) => l.id as string),
    );
    const docSources = new Set(
      (doc.tables.pub_sources ?? []).map((s) => s.id as string),
    );
    const docErasureIds = new Set(
      (doc.tables.pub_erasures ?? []).map((e) => e.id as string),
    );
    const docRevocationIds = new Set(
      (doc.tables.pub_source_revocations ?? []).map((e) => e.id as string),
    );
    const erasedLead = new Map<string, Date>();
    for (const e of lists.erasures) {
      if (!docLeads.has(e.leadId)) continue;
      const prev = erasedLead.get(e.leadId);
      if (!prev || e.erasedAt.getTime() > prev.getTime())
        erasedLead.set(e.leadId, e.erasedAt);
    }
    // Полный эффект стирания P-D — общее правило `leads/erase-effect.ts`
    // (Р-PUB-Z2-3; аудит P-E S1-4): контакт и заметки решений — ниже;
    // `requestHash` — обезличенный нового id (`erasedRequestHash`); заметка
    // проспекта — если стирание ПОСЛЕ копии её стёрло (`scope.prospectNote`)
    // или у проспекта после применения списка не осталось неудалённых
    // заявок (`leadEraseEffect`).
    const leadRows = doc.tables.pub_leads ?? [];
    const isErased = (l: BackupRow) =>
      erasedLead.has(l.id as string) ||
      (l.erasedAt !== null && l.erasedAt !== undefined);
    const newlyErased = new Set(
      lists.erasures
        .filter((e) => docLeads.has(e.leadId) && !docErasureIds.has(e.id))
        .map((e) => e.leadId),
    );
    const effect = leadEraseEffect(
      leadRows.map((l) => ({
        id: l.id as string,
        prospectId: typeof l.prospectId === 'string' ? l.prospectId : null,
        erased: isErased(l) && !newlyErased.has(l.id as string),
      })),
      newlyErased,
    );
    const prospectNoteCleared = new Set<string>(effect.prospectNotes);
    for (const e of lists.erasures) {
      if (!newlyErased.has(e.leadId) || docErasureIds.has(e.id)) continue;
      const scope = e.scope as { prospectNote?: unknown } | null;
      const lead = leadRows.find((l) => l.id === e.leadId);
      if (scope?.prospectNote === true && typeof lead?.prospectId === 'string')
        prospectNoteCleared.add(lead.prospectId);
    }
    let prospectNotesCleared = 0;
    let grantsRevoked = 0;
    const revokeAt = new Date().toISOString();
    const revokedSource = new Map<
      string,
      CurrentLists['revocations'][number]
    >();
    for (const r of lists.revocations)
      if (docSources.has(r.sourceId)) revokedSource.set(r.sourceId, r);
    // Отзыв ПОСЛЕ копии — с тем же эффектом на claims, что у штатного
    // отзыва P-B1 (`content/revocation.service.ts`): подтверждённый claim со
    // связью с отозванным источником → `needs_review` (Р-PUB-Z2-23; найдено
    // E2E-04: иначе гвард `pub_claim_sources` роняет перенос, если источник
    // подтверждал критический claim).
    const newlyRevokedSources = new Set(
      (doc.tables.pub_sources ?? [])
        .filter(
          (x) => revokedSource.has(x.id as string) && x.usage !== 'revoked',
        )
        .map((x) => x.id as string),
    );
    const claimsToReview = new Set(
      (doc.tables.pub_claim_sources ?? [])
        .filter((l) => newlyRevokedSources.has(l.sourceId as string))
        .map((l) => l.claimId as string),
    );
    let claimsNeedsReview = 0;
    for (const e of lists.erasures)
      if (docLeads.has(e.leadId) && !docErasureIds.has(e.id))
        map.set(e.id, newRowId('rs'));
    for (const r of lists.revocations)
      if (docSources.has(r.sourceId) && !docRevocationIds.has(r.id))
        map.set(r.id, newRowId('rs'));

    const remapToken = (s: string): string => {
      const direct = map.get(s);
      if (direct) return direct;
      return s.replace(ID_TOKEN, (tok) => map.get(tok) ?? tok);
    };
    const remapJson = (v: unknown): unknown => {
      if (typeof v === 'string') return remapToken(v);
      if (Array.isArray(v)) return v.map(remapJson);
      if (v && typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v)) out[k] = remapJson(x);
        return out;
      }
      return v;
    };
    const jsonCols = (model: string) => {
      const m = (Prisma.dmmf.datamodel.models as unknown as DmmfModel[]).find(
        (x) => x.name === model,
      );
      return new Set(
        (m?.fields ?? [])
          .filter((f) => f.kind === 'scalar' && f.type === 'Json')
          .map((f) => f.name),
      );
    };

    // ── Перенос таблиц ───────────────────────────────────────────────────
    const statusRestore: Array<{ id: string; s: string }> = [];
    const deferredUpdates: Array<{
      table: string;
      column: string;
      pairs: Array<{ id: string; v: string }>;
    }> = [];
    const perTable: Record<string, { rows: number; ms: number }> = {};
    let total = 0;
    let contactsSkipped = 0;
    let notesCleared = 0;
    let publicRefs = 0;
    let revokedApplied = 0;
    const encrypted = ENCRYPTED_COLUMNS;
    for (const t of order) {
      const t0 = Date.now();
      const self = selfRefColumns(t.model);
      const json = jsonCols(t.model);
      const fkCols = new Set(t.refs.flatMap((r) => r.columns));
      const soft = new Set(SOFT_REF_COLUMNS[t.table] ?? []);
      let rows = orderBySelfRefs(doc.tables[t.table] ?? [], self);
      const extra: BackupRow[] = [];
      if (t.table === 'pub_erasures') {
        for (const e of lists.erasures) {
          if (!docLeads.has(e.leadId) || docErasureIds.has(e.id)) continue;
          extra.push({
            id: e.id,
            accountId,
            productId: source.id,
            leadId: e.leadId,
            erasedAt: e.erasedAt.toISOString(),
            erasedBy: e.erasedBy,
            basis: e.basis,
            scope: e.scope,
            createdAt: e.createdAt.toISOString(),
            createdBy: actor,
          });
        }
      }
      if (t.table === 'pub_source_revocations') {
        for (const r of lists.revocations) {
          if (!docSources.has(r.sourceId) || docRevocationIds.has(r.id))
            continue;
          extra.push({
            id: r.id,
            accountId,
            productId: source.id,
            sourceId: r.sourceId,
            revokedAt: r.revokedAt.toISOString(),
            revokedBy: r.revokedBy,
            reason: r.reason,
            createdAt: r.createdAt.toISOString(),
            createdBy: actor,
          });
        }
      }
      rows = [...rows, ...extra];
      const out: BackupRow[] = [];
      for (const src of rows) {
        const oldId = src.id as string;
        if (
          t.table === 'pub_lead_contacts' &&
          erasedLead.has(src.leadId as string)
        ) {
          contactsSkipped++;
          continue;
        }
        const r: BackupRow = {
          ...src,
          id: map.get(oldId),
          accountId,
          createdBy: actor,
        };
        if ('productId' in r) r.productId = target;
        for (const c of [...fkCols, ...self]) {
          const v = src[c];
          if (typeof v !== 'string') continue;
          const nv = map.get(v);
          if (!nv) throw new Error(`restore: ссылка ${t.table}.${c} вне копии`);
          r[c] = nv;
        }
        for (const d of t.deferred) {
          const v = src[d.column];
          if (typeof v === 'string') {
            const nv = map.get(v);
            if (!nv)
              throw new Error(
                `restore: ссылка ${t.table}.${d.column} вне копии`,
              );
            let bucket = deferredUpdates.find(
              (x) => x.table === t.table && x.column === d.column,
            );
            if (!bucket)
              deferredUpdates.push(
                (bucket = { table: t.table, column: d.column, pairs: [] }),
              );
            bucket.pairs.push({ id: r.id as string, v: nv });
          }
          r[d.column] = null;
        }
        // Предложение с решением (`accepted|rejected`) требует `decisionId`
        // (гвард), а решение ссылается на предложение: строка идёт как `open`,
        // статус возвращается после второго прохода (переход из open разрешён).
        if (
          t.table === 'pub_parameter_proposals' &&
          src.status !== 'open' &&
          typeof src.decisionId === 'string'
        ) {
          r.status = 'open';
          statusRestore.push({ id: r.id as string, s: src.status as string });
        }
        for (const c of soft)
          if (typeof src[c] === 'string') r[c] = remapToken(src[c] as string);
        for (const c of json)
          if (src[c] !== null && src[c] !== undefined) r[c] = remapJson(src[c]);
        // Шифротексты — под новый AAD (контакт: leadId; заметки: id строки).
        if (t.table === 'pub_lead_contacts') {
          const opened = openContact(
            src.contactEnc,
            src.leadId as string,
            keys.contact,
          );
          if (!opened)
            throw new PubError('PUB_RESTORE_CONFLICT', {
              reason: 'contact_unreadable',
            });
          const sealed = sealContact(
            opened.value,
            r.leadId as string,
            keys.contact,
          );
          r.contactEnc = sealed.enc;
          r.keyVersion = sealed.keyVersion;
          if (src.matchHash !== null && src.matchHash !== undefined) {
            r.matchHash = contactMatchHash(
              target,
              opened.value.contactMethod as ContactMethod,
              opened.value.contact,
              keys.match,
            );
          }
        }
        if (
          (t.table === 'pub_prospects' || t.table === 'pub_lead_decisions') &&
          typeof src.noteEnc === 'string'
        ) {
          if (
            t.table === 'pub_lead_decisions' &&
            erasedLead.has(src.leadId as string)
          ) {
            r.noteEnc = null;
            notesCleared++;
          } else if (
            t.table === 'pub_prospects' &&
            prospectNoteCleared.has(oldId)
          ) {
            r.noteEnc = null;
            prospectNotesCleared++;
          } else {
            const opened = openText(src.noteEnc, oldId, keys.notes);
            if (!opened)
              throw new PubError('PUB_RESTORE_CONFLICT', {
                reason: 'note_unreadable',
              });
            r.noteEnc = sealText(opened.value, r.id as string, keys.notes).enc;
          }
        }
        if (t.table === 'pub_leads') {
          r.publicRef = newPublicRef();
          publicRefs++;
          const er = erasedLead.get(oldId);
          if (er) r.erasedAt = er.toISOString();
          if (er || isErased(src))
            r.requestHash = erasedRequestHash(r.id as string);
        }
        // Доступы не возвращаются (аудит P-E S1-5): роли восстановленного
        // продукта создаются отозванными — владелец выдаёт их заново по
        // ТЕКУЩЕМУ составу (отозванная после копии роль не оживает).
        if (t.table === 'pub_role_grants' && !src.revokedAt) {
          r.revokedAt = revokeAt;
          r.revokedBy = actor;
          r.reason = RESTORE_GRANT_REVOKE_REASON;
          grantsRevoked++;
        }
        if (
          t.table === 'pub_claims' &&
          claimsToReview.has(oldId) &&
          src.status === 'supported'
        ) {
          r.status = 'needs_review';
          r.revision = Number(src.revision ?? 1) + 1;
          claimsNeedsReview++;
        }
        if (t.table === 'pub_sources') {
          const rev = revokedSource.get(oldId);
          if (rev && src.usage !== 'revoked') {
            r.usage = 'revoked';
            r.revokedAt = rev.revokedAt.toISOString();
            r.revokedBy = rev.revokedBy;
            r.revokeReason = rev.reason;
            revokedApplied++;
          }
        }
        for (const c of encrypted[t.table] ?? []) if (!(c in r)) r[c] = null;
        out.push(r);
      }
      for (let i = 0; i < out.length; i += RESTORE_CHUNK) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "sites"."${t.table}" SELECT * FROM jsonb_populate_recordset(NULL::"sites"."${t.table}", $1::jsonb)`,
          JSON.stringify(out.slice(i, i + RESTORE_CHUNK)),
        );
      }
      total += out.length;
      perTable[t.table] = { rows: out.length, ms: Date.now() - t0 };
    }

    // ── Второй проход: обратные ссылки циклов FK ──────────────────────────
    const t1 = Date.now();
    for (const u of deferredUpdates) {
      for (let i = 0; i < u.pairs.length; i += RESTORE_CHUNK) {
        await tx.$executeRawUnsafe(
          `UPDATE "sites"."${u.table}" AS t SET "${u.column}" = x.v
             FROM jsonb_to_recordset($1::jsonb) AS x(id text, v text)
            WHERE t."id" = x.id AND t."productId" = $2 AND t."accountId" = $3`,
          JSON.stringify(u.pairs.slice(i, i + RESTORE_CHUNK)),
          target,
          accountId,
        );
      }
    }
    if (statusRestore.length) {
      await tx.$executeRawUnsafe(
        `UPDATE "sites"."pub_parameter_proposals" AS t SET "status" = x.s
           FROM jsonb_to_recordset($1::jsonb) AS x(id text, s text)
          WHERE t."id" = x.id AND t."productId" = $2 AND t."accountId" = $3`,
        JSON.stringify(statusRestore),
        target,
        accountId,
      );
    }
    const deferredMs = Date.now() - t1;

    // ── Сверка: число строк, связи, суммы бюджета ─────────────────────────
    const mismatches: string[] = [];
    const after: Record<string, number> = {};
    for (const t of order) {
      const cols = [
        ...t.refs.flatMap((r) => r.columns),
        ...t.deferred.map((d) => d.column),
        ...selfRefColumns(t.model),
      ];
      const sel = [
        `count(*)::int AS n`,
        ...cols.map((c, i) => `count("${c}")::int AS c${i}`),
      ].join(', ');
      const got = (
        await tx.$queryRawUnsafe<Array<Record<string, number>>>(
          `SELECT ${sel} FROM "sites"."${t.table}" WHERE "productId" = $1 AND "accountId" = $2`,
          target,
          accountId,
        )
      )[0];
      after[t.table] = got.n;
      const src = doc.tables[t.table] ?? [];
      const expectedRows =
        src.length +
        (t.table === 'pub_erasures'
          ? lists.erasures.filter(
              (e) => docLeads.has(e.leadId) && !docErasureIds.has(e.id),
            ).length
          : 0) +
        (t.table === 'pub_source_revocations'
          ? lists.revocations.filter(
              (r) => docSources.has(r.sourceId) && !docRevocationIds.has(r.id),
            ).length
          : 0) -
        (t.table === 'pub_lead_contacts' ? contactsSkipped : 0);
      if (got.n !== expectedRows)
        mismatches.push(`${t.table}: строк ${got.n} ≠ ${expectedRows}`);
      if (
        t.table === 'pub_lead_contacts' ||
        t.table === 'pub_erasures' ||
        t.table === 'pub_source_revocations'
      )
        continue;
      cols.forEach((c, i) => {
        const want = src.filter((r) => typeof r[c] === 'string').length;
        if (got[`c${i}`] !== want)
          mismatches.push(`${t.table}.${c}: связей ${got[`c${i}`]} ≠ ${want}`);
      });
    }
    const budget = await this.budgetCheck(tx, doc, target, accountId);
    if (budget.sumsMismatch.length) mismatches.push(...budget.sumsMismatch);
    if (mismatches.length) {
      throw new Error(
        `restore: сверка не сошлась — ${mismatches.slice(0, 5).join('; ')}`,
      );
    }

    // ── Каскад P-R отзыва после копии (реаудит P-R N-5) ──────────────────
    // Отозван после копии первоисточник действующих правил Reddit — тот же
    // эффект, что у штатного отзыва (`revocation.service` →
    // `redditOnSourceRevoked`): гейт `block [rules_source_revoked]`,
    // возможности → `recheck_required`, запись аудита от `restore:<id>`.
    // Хранимое состояние восстановленного продукта = живому гейту. После
    // сверки: записи аудита каскада — сверх строк копии.
    const redditAudit = newlyRevokedSources.size
      ? await redditOnSourceRevoked(
          tx,
          { id: target, accountId },
          [...newlyRevokedSources].map((id) => map.get(id) ?? id),
        )
      : [];
    for (const e of redditAudit) {
      await RESTORE_AUDIT.write(tx, {
        ...e,
        accountId,
        productId: target,
        actor,
        meta: { ...(e.meta ?? {}), restoreId },
      });
    }
    const durationMs = Date.now() - started;
    const report = {
      mode: 'apply_new_product',
      backupId: restore.backupId,
      sourceProductId: source.id,
      targetProductId: target,
      counts: { before: tableCountsOf(doc), after },
      rows: total,
      applied: {
        erasures: erasedLead.size,
        leadRowsSuppressed: contactsSkipped,
        decisionNotesCleared: notesCleared,
        prospectNotesCleared,
        requestHashesErased: leadRows.filter(isErased).length,
        roleGrantsRevoked: grantsRevoked,
        revocations: revokedSource.size,
        sourcesMarkedRevoked: revokedApplied,
        claimsNeedsReview,
        redditOpportunitiesRecheck: redditAudit.length,
      },
      suppressed: { leadOutbox: 0, notifications: 0, externalActions: 'none' },
      history: {
        publications: (doc.tables.pub_publications ?? []).length,
        payments: (doc.tables.pub_payments ?? []).length,
        expenseEntries: (doc.tables.pub_expense_entries ?? []).length,
        createdBy: actor,
      },
      publicRefsReassigned: publicRefs,
      links: { mismatches: [] },
      budget: budget.report,
      timing: {
        durationMs,
        deferredMs,
        msPerRow: total ? Math.round((durationMs / total) * 1000) / 1000 : null,
        slowest: Object.entries(perTable)
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 5)
          .map(([table, v]) => ({ table, ...v })),
      },
    };
    await tx.pubRestore.updateMany({
      where: { id: restoreId, status: 'running' },
      data: {
        status: 'done',
        report: report as unknown as Prisma.InputJsonValue,
      },
    });
    return report;
  }

  /**
   * Суммы обязательств копии = суммам восстановленных; счётчики строки
   * лимита пересчитываются из обязательств (§6.4: net_paid = Σ paid −
   * refunded; open = Σ (amountTotal − paid − cancelled) открытых; used —
   * net_paid + open по категории, `other` — в `tools`). Расхождение
   * счётчиков копии с записями — пересчёт и отметка в отчёте.
   */
  private async budgetCheck(
    tx: PubTx,
    doc: BackupDocument,
    target: string,
    accountId: string,
  ): Promise<{ report: Record<string, unknown>; sumsMismatch: string[] }> {
    const big = (v: unknown) =>
      BigInt(typeof v === 'string' || typeof v === 'number' ? v : 0);
    const fields = [
      'amountTotalMinor',
      'paidMinor',
      'refundedMinor',
      'cancelledMinor',
      'deliveredMinor',
    ] as const;
    const srcSum = Object.fromEntries(
      fields.map((f) => [
        f,
        (doc.tables.pub_expenses ?? []).reduce((a, e) => a + big(e[f]), 0n),
      ]),
    );
    const rows = await tx.pubExpense.findMany({
      where: { productId: target },
      select: {
        category: true,
        status: true,
        amountTotalMinor: true,
        paidMinor: true,
        refundedMinor: true,
        cancelledMinor: true,
        deliveredMinor: true,
      },
    });
    const dstSum = Object.fromEntries(
      fields.map((f) => [f, rows.reduce((a, e) => a + e[f], 0n)]),
    );
    const sumsMismatch = fields
      .filter((f) => srcSum[f] !== dstSum[f])
      .map((f) => `pub_expenses.${f}: ${dstSum[f]} ≠ ${srcSum[f]}`);
    let netPaid = 0n;
    let open = 0n;
    const used = { placements: 0n, tools: 0n };
    for (const e of rows) {
      const paid = e.paidMinor - e.refundedMinor;
      const o =
        e.status === 'open'
          ? e.amountTotalMinor - e.paidMinor - e.cancelledMinor
          : 0n;
      netPaid += paid;
      open += o;
      used[e.category === 'placements' ? 'placements' : 'tools'] += paid + o;
    }
    const limit = await tx.pubBudgetLimit.findFirst({
      where: { productId: target },
    });
    let countersEqual: boolean | null = null;
    if (limit) {
      countersEqual =
        limit.netPaidMinor === netPaid &&
        limit.openCommitMinor === open &&
        limit.usedPlacementsMinor === used.placements &&
        limit.usedToolsMinor === used.tools;
      if (!countersEqual) {
        await tx.pubBudgetLimit.updateMany({
          where: { id: limit.id, productId: target, accountId },
          data: {
            netPaidMinor: netPaid,
            openCommitMinor: open,
            usedPlacementsMinor: used.placements,
            usedToolsMinor: used.tools,
          },
        });
      }
    }
    const s = (v: bigint) => v.toString();
    return {
      sumsMismatch,
      report: {
        expenses: Object.fromEntries(fields.map((f) => [f, s(dstSum[f])])),
        recomputed: {
          netPaidMinor: s(netPaid),
          openCommitMinor: s(open),
          usedPlacementsMinor: s(used.placements),
          usedToolsMinor: s(used.tools),
        },
        backupCounters: limit
          ? {
              netPaidMinor: s(limit.netPaidMinor),
              openCommitMinor: s(limit.openCommitMinor),
              usedPlacementsMinor: s(limit.usedPlacementsMinor),
              usedToolsMinor: s(limit.usedToolsMinor),
            }
          : null,
        countersEqual,
      },
    };
  }

  async get(tx: PubTx, source: ProductRef, id: string): Promise<RestoreRow> {
    const r = /^[A-Za-z0-9_-]{1,64}$/.test(id)
      ? await tx.pubRestore.findFirst({
          where: {
            id,
            OR: [{ productId: source.id }, { targetProductId: source.id }],
          },
        })
      : null;
    if (!r) throw new PubError('PUB_NOT_FOUND');
    return r;
  }

  /** dry-run: строка `pub_restores` сразу `done` с отчётом (данные не пишутся). */
  async recordDryRun(
    tx: PubTx,
    source: ProductRef,
    backup: BackupDbRow,
    report: Record<string, unknown>,
    actor: string,
  ): Promise<{ restore: RestoreRow; audit: AuditInput[] }> {
    const restore = await tx.pubRestore.create({
      data: {
        accountId: source.accountId,
        productId: source.id,
        backupId: backup.id,
        mode: 'dry_run',
        status: 'done',
        report: report as unknown as Prisma.InputJsonValue,
        startedBy: actor,
        createdBy: actor,
      },
    });
    return {
      restore,
      audit: [
        {
          objectType: 'restore',
          objectId: restore.id,
          action: 'restore',
          toStatus: 'done',
          meta: { mode: 'dry_run', backupId: backup.id },
        },
      ],
    };
  }
}
