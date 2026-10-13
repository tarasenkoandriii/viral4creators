/**
 * AI Publisher — проспекты и история идентификации заявок (P-D, проектный
 * документ §6.5 `pub_prospects`, `pub_lead_prospect_links`; ТЗ §9 Lead,
 * §10; Р-PUB-15).
 *
 *  - Автоматически — только ТОЧНОЕ совпадение нормализованного контакта
 *    (`matchHash` с `productId`): заявка присоединяется к проспекту
 *    прежней заявки (`intake_exact_match`), иначе — новый (`new`). Всё
 *    прочее — подсказка (`possibleDuplicates`) и решение менеджера.
 *  - История — append-only `pub_lead_prospect_links`: текущий проспект
 *    заявки = последняя строка; снимок отчёта берёт строку на `snapshotAt`
 *    (пересчёт с прежней идентификацией воспроизводим, ТЗ §10).
 *  - Слияние: `mergedIntoId` + новые строки связей для заявок источника
 *    (`manual_merge`); разделение — новый проспект и строка `manual_split`.
 *  - Заметка проспекта — только шифр (`noteEnc`, AAD = id проспекта,
 *    метка `publisher-lead-notes-v1`, аудит P2-8).
 */
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { ProspectView } from '../contracts/leads-api';
import { PRIOR_EXTERNAL_PAYMENT } from '../contracts/states';
import { publisherKeys, sealNote } from '../core/contact-crypto';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
} from '../contracts/common';
import { PubError, validationError } from '../core/errors';
import type { AuditInput, ProductRef, PubTx } from '../core/ports';
import { casUpdate, parseExpectedRevision } from '../core/revision';

export const NOTE_MAX = 2000;
export const PROSPECT_LINK_REASONS_MANUAL = [
  'manual_merge',
  'manual_split',
  'manual_assign',
] as const;

/** id строки (для AAD шифра нужен до вставки). */
export const newId = (prefix: string): string =>
  `${prefix}${randomBytes(12).toString('hex')}`;

type ProspectRow = {
  id: string;
  code: string;
  isExternal: boolean;
  isTeamOrPartner: boolean;
  priorExternalPayment: string;
  mergedIntoId: string | null;
  noteEnc: string | null;
  createdAt: Date;
  revision: number;
};

/** Шифр заметки текущим ключом (`leadNotes`); нет ключа — 503. */
export function sealLeadNote(
  text: string,
  rowId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const keys = publisherKeys('leadNotes', env);
  if (!keys) throw new PubError('PUB_CONTACT_KEY_MISSING');
  return sealNote(text, rowId, keys).enc;
}

/** Текст заметки: строка ≤ 2000 (после обрезки), пустая — null. */
export function noteOf(v: unknown, field = 'note'): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw validationError([{ field, code: 'type' }]);
  const t = v.trim();
  if (!t) return null;
  if ([...t].length > NOTE_MAX)
    throw validationError([{ field, code: 'length' }]);
  return t;
}

@Injectable()
export class ProspectsService {
  /** Следующий код `P-0001` (под блокировкой продукта по кодам). */
  async nextCode(tx: PubTx, productId: string): Promise<string> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pub-prospect-code:${productId}`}, 0))::text AS l`;
    const rows = await tx.$queryRaw<Array<{ n: number | null }>>`
      SELECT max(substr("code", 3)::int) AS "n"
        FROM "sites"."pub_prospects" WHERE "productId" = ${productId}`;
    const n = Number(rows[0]?.n ?? 0) + 1;
    return `P-${String(n).padStart(4, '0')}`;
  }

  async create(
    tx: PubTx,
    product: ProductRef,
    input: {
      isExternal?: boolean;
      isTeamOrPartner?: boolean;
      priorExternalPayment?: string;
      note?: string | null;
    },
    actor: string,
  ): Promise<{ id: string; code: string }> {
    const prior = input.priorExternalPayment ?? 'unknown';
    if (!(PRIOR_EXTERNAL_PAYMENT as readonly string[]).includes(prior)) {
      throw validationError([{ field: 'priorExternalPayment', code: 'enum' }]);
    }
    const id = newId('pr_');
    const code = await this.nextCode(tx, product.id);
    await tx.pubProspect.create({
      data: {
        id,
        accountId: product.accountId,
        productId: product.id,
        code,
        isExternal: input.isExternal ?? true,
        isTeamOrPartner: input.isTeamOrPartner ?? false,
        priorExternalPayment: prior,
        noteEnc: input.note ? sealLeadNote(input.note, id) : null,
        createdBy: actor,
      },
    });
    return { id, code };
  }

  async get(tx: PubTx, productId: string, id: string): Promise<ProspectRow> {
    const p = await tx.pubProspect.findFirst({
      where: { id, productId },
      select: {
        id: true,
        code: true,
        isExternal: true,
        isTeamOrPartner: true,
        priorExternalPayment: true,
        mergedIntoId: true,
        noteEnc: true,
        createdAt: true,
        revision: true,
      },
    });
    if (!p) throw new PubError('PUB_NOT_FOUND', { object: 'prospect' });
    return p;
  }

  /** Корень цепочки слияний (`mergedIntoId`), не глубже 20. */
  async rootOf(tx: PubTx, productId: string, id: string): Promise<ProspectRow> {
    let p = await this.get(tx, productId, id);
    for (let i = 0; i < 20 && p.mergedIntoId; i++) {
      p = await this.get(tx, productId, p.mergedIntoId);
    }
    return p;
  }

  /** Новая строка истории + кэш текущего проспекта на заявке. */
  async link(
    tx: PubTx,
    product: ProductRef,
    leadId: string,
    prospectId: string,
    reason:
      | 'intake_exact_match'
      | 'new'
      | 'manual_merge'
      | 'manual_split'
      | 'manual_assign',
    actor: string,
    at: Date,
  ): Promise<void> {
    await tx.pubLeadProspectLink.create({
      data: {
        accountId: product.accountId,
        productId: product.id,
        leadId,
        prospectId,
        validFrom: at,
        reason,
        decidedBy: actor,
        createdBy: actor,
      },
    });
    await tx.pubLead.update({
      where: { id: leadId },
      data: { prospectId },
    });
  }

  /**
   * Проспект для новой заявки: точное совпадение `matchHash` с заявкой того
   * же продукта, у которой проспект уже есть, — её проспект (корень слияния);
   * иначе новый. Возвращает id и причину связи.
   *
   * Гонка (аудит P-D S1-1): две заявки одного человека обогащаются
   * параллельно (крон, открытие карточки, переход в `qualified`) — без
   * сериализации обе не видят незакоммиченный проспект друг друга и создают
   * два. Поэтому поиск и создание идут под `pg_advisory_xact_lock` по
   * `productId + matchHash`; поиск выполняется ПОСЛЕ взятия блокировки
   * (READ COMMITTED: новый оператор видит проспект, закоммиченный
   * предыдущим владельцем блокировки).
   */
  async resolveForIntake(
    tx: PubTx,
    product: ProductRef,
    leadId: string,
    actor: string,
  ): Promise<{ prospectId: string; reason: 'intake_exact_match' | 'new' }> {
    const own = await tx.pubLeadContact.findFirst({
      where: { leadId, productId: product.id },
      select: { matchHash: true },
    });
    if (own?.matchHash) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pub-prospect-match:${product.id}:${own.matchHash}`}, 0))::text AS l`;
      const match = await tx.pubLead.findFirst({
        where: {
          productId: product.id,
          id: { not: leadId },
          prospectId: { not: null },
          leadContactLeadOf: { some: { matchHash: own.matchHash } },
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        select: { prospectId: true },
      });
      if (match?.prospectId) {
        const root = await this.rootOf(tx, product.id, match.prospectId);
        return { prospectId: root.id, reason: 'intake_exact_match' };
      }
    }
    const created = await this.create(tx, product, {}, actor);
    return { prospectId: created.id, reason: 'new' };
  }

  async view(tx: PubTx, productId: string, id: string): Promise<ProspectView> {
    const p = await this.get(tx, productId, id);
    const leads = await tx.pubLead.findMany({
      where: { productId, prospectId: id },
      select: { id: true },
      orderBy: { receivedAt: 'asc' },
    });
    return {
      id: p.id,
      code: p.code,
      isExternal: p.isExternal,
      isTeamOrPartner: p.isTeamOrPartner,
      priorExternalPayment:
        p.priorExternalPayment as ProspectView['priorExternalPayment'],
      mergedIntoId: p.mergedIntoId,
      hasNote: p.noteEnc !== null,
      leadIds: leads.map((l) => l.id),
      createdAt: p.createdAt.toISOString(),
      revision: p.revision,
    };
  }

  async list(
    tx: PubTx,
    productId: string,
    q: { before?: unknown; limit?: unknown },
  ): Promise<ListPage<ProspectView>> {
    const limit = Math.min(
      Math.max(Number(q.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const rows = await tx.pubProspect.findMany({
      where: {
        productId,
        ...(typeof q.before === 'string' && q.before
          ? { code: { lt: (await this.get(tx, productId, q.before)).code } }
          : {}),
      },
      orderBy: { code: 'desc' },
      take: limit + 1,
      select: { id: true },
    });
    const page = rows.slice(0, limit);
    const items: ProspectView[] = [];
    for (const r of page) items.push(await this.view(tx, productId, r.id));
    return {
      items,
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Признаки проспекта и заметка (шифр); CAS по ревизии. */
  async update(
    tx: PubTx,
    product: ProductRef,
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ audit: AuditInput[] }> {
    const expected = parseExpectedRevision(body.expectedRevision);
    const p = await this.get(tx, product.id, id);
    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    for (const k of ['isExternal', 'isTeamOrPartner'] as const) {
      if (body[k] === undefined) continue;
      if (typeof body[k] !== 'boolean')
        throw validationError([{ field: k, code: 'type' }]);
      if (body[k] !== p[k]) {
        data[k] = body[k];
        changed.push(k);
      }
    }
    if (body.priorExternalPayment !== undefined) {
      if (
        !(PRIOR_EXTERNAL_PAYMENT as readonly unknown[]).includes(
          body.priorExternalPayment,
        )
      ) {
        throw validationError([
          { field: 'priorExternalPayment', code: 'enum' },
        ]);
      }
      if (body.priorExternalPayment !== p.priorExternalPayment) {
        data.priorExternalPayment = body.priorExternalPayment;
        changed.push('priorExternalPayment');
      }
    }
    if (body.note !== undefined) {
      const note = noteOf(body.note);
      data.noteEnc = note ? sealLeadNote(note, id) : null;
      changed.push('note');
    }
    if (!changed.length)
      throw validationError([{ field: '$', code: 'unchanged' }]);
    await casUpdate(tx.pubProspect, id, expected, data);
    return {
      audit: [
        {
          objectType: 'prospect',
          objectId: id,
          action: 'update',
          meta: { fields: changed },
        },
      ],
    };
  }

  /**
   * Слияние: `from` → `into` (корни), заявки источника получают новые
   * строки связей `manual_merge`; история прежних связей остаётся.
   */
  async merge(
    tx: PubTx,
    product: ProductRef,
    body: Record<string, unknown>,
    actor: string,
    now: Date,
    reason: string,
  ): Promise<{ intoId: string; moved: number; audit: AuditInput[] }> {
    if (typeof body.fromId !== 'string' || typeof body.intoId !== 'string') {
      throw validationError([
        {
          field: typeof body.fromId !== 'string' ? 'fromId' : 'intoId',
          code: 'required',
        },
      ]);
    }
    const from = await this.get(tx, product.id, body.fromId);
    const into = await this.rootOf(tx, product.id, body.intoId);
    if (from.mergedIntoId)
      throw validationError([{ field: 'fromId', code: 'already_merged' }]);
    if (from.id === into.id)
      throw validationError([{ field: 'intoId', code: 'self' }]);
    await casUpdate(tx.pubProspect, from.id, from.revision, {
      mergedIntoId: into.id,
    });
    const leads = await tx.pubLead.findMany({
      where: { productId: product.id, prospectId: from.id },
      select: { id: true },
    });
    for (const l of leads) {
      await this.link(tx, product, l.id, into.id, 'manual_merge', actor, now);
    }
    return {
      intoId: into.id,
      moved: leads.length,
      audit: [
        {
          objectType: 'prospect',
          objectId: from.id,
          action: 'merge',
          reason,
          meta: { intoId: into.id, movedLeads: leads.length },
        },
      ],
    };
  }
}
