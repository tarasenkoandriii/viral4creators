/**
 * AI Publisher — уведомления менеджеру о заявках (P-D, проектный документ
 * §6.5 `pub_notifications`, §15.1 `notifications-deliver`,
 * `contact-overdue`, §15.2; ТЗ §6, §20; AT-CORE-05).
 *
 *  - Канал — бот помощника (`ASSIST_BOT_TOKEN`, Р-PUB-22) через
 *    `assist-knowledge-core/notify`; текст — номер обращения и ссылка в
 *    кабинет `#/sites/:siteId/publisher/leads/:id`, БЕЗ контактов и текста
 *    задачи; язык получателя — `recipientsWithLang`.
 *  - Доставка: аренда `leaseUntil`, экспоненциальная пауза (1 мин × 2^n,
 *    потолок 6 ч), после 8 попыток — `dead` (видно в очереди);
 *    `kind≠working` — `suppressed` (реальным людям не уходит).
 *  - Сбой уведомления НЕ трогает заявку: она уже сохранена и видна в
 *    очереди; повтор (`POST …/notifications/:id/retry`) возвращает строку в
 *    `pending`, второй заявки не создаёт. Ежедневная проверка очереди
 *    (`pub_queue_checks`) от уведомлений не зависит (ТЗ §20).
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  recipientsWithLang,
  sendToMembers,
  type NotifyLang,
} from '../../assist-knowledge-core/notify';
import type { NotificationView, OutboxView } from '../contracts/leads-api';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  type ListPage,
} from '../contracts/common';
import { NOTIFICATION_STATUSES, OUTBOX_STATUSES } from '../contracts/states';
import { PubContribution } from '../core/contributions';
import { PubError, validationError } from '../core/errors';
import { OPERATION_TX_OPTIONS } from '../core/operation';
import type {
  AuditInput,
  CronJob,
  CronResult,
  ProductRef,
  PubCronContext,
  PubTx,
} from '../core/ports';
import { errorCodeOf } from './lead-enrich.job';
import { isLeadRecipient, leadRecipientIds } from './recipients';

/** Код строки уведомления: адресат утратил роль (dead, перераздача). */
export const RECIPIENT_REVOKED = 'recipient_revoked';

export const NOTIFY_MAX_ATTEMPTS = 8;
const LEASE_MS = 2 * 60 * 1000;
const BATCH = 50;
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

/** Пауза перед попыткой n+1 (n — уже сделанных попыток). */
export function backoffMs(attempts: number): number {
  return Math.min(
    BACKOFF_CAP_MS,
    BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1),
  );
}

/** Сообщение получателю: только номер и ссылка (без контактов). */
export interface NotifyMessage {
  chatId: bigint;
  text: string;
  button: { text: string; hashPath: string };
}

export type NotifyOutcome = 'sent' | 'not_configured' | 'failed';

/** Транспорт уведомлений (подменяется в тестах: «бот недоступен»). */
export interface NotifyTransport {
  send(m: NotifyMessage): Promise<NotifyOutcome>;
}
export const PUB_NOTIFY_TRANSPORT = 'PUB_NOTIFY_TRANSPORT';

/** Бот помощника (`ASSIST_BOT_TOKEN`, `ASSIST_TMA_URL`). */
export class BotNotifyTransport implements NotifyTransport {
  async send(m: NotifyMessage): Promise<NotifyOutcome> {
    if (
      !process.env.ASSIST_BOT_TOKEN?.trim() ||
      !process.env.ASSIST_TMA_URL?.trim()
    ) {
      return 'not_configured';
    }
    const n = await sendToMembers({
      chatIds: [m.chatId],
      text: m.text,
      button: m.button,
    });
    return n === 1 ? 'sent' : 'failed';
  }
}

const TEXTS: Record<
  NotifyLang,
  Record<
    'new_lead' | 'retention_review' | 'contact_overdue',
    (ref: string, product: string) => string
  > & { button: string }
> = {
  uk: {
    new_lead: (r, p) =>
      `Нове звернення ${r} у продукті «${p}». Зв'яжіться не пізніше наступного робочого дня.`,
    contact_overdue: (r, p) =>
      `Звернення ${r} у продукті «${p}»: строк першого контакту минув.`,
    retention_review: (r, p) =>
      `Звернення ${r} у продукті «${p}»: настав строк перегляду зберігання контакту.`,
    button: 'Відкрити звернення',
  },
  ru: {
    new_lead: (r, p) =>
      `Новое обращение ${r} в продукте «${p}». Свяжитесь не позднее следующего рабочего дня.`,
    contact_overdue: (r, p) =>
      `Обращение ${r} в продукте «${p}»: срок первого контакта прошёл.`,
    retention_review: (r, p) =>
      `Обращение ${r} в продукте «${p}»: наступил срок пересмотра хранения контакта.`,
    button: 'Открыть обращение',
  },
  en: {
    new_lead: (r, p) =>
      `New enquiry ${r} in “${p}”. Please respond by the end of the next business day.`,
    contact_overdue: (r, p) =>
      `Enquiry ${r} in “${p}”: first-contact deadline has passed.`,
    retention_review: (r, p) =>
      `Enquiry ${r} in “${p}”: contact retention review is due.`,
    button: 'Open enquiry',
  },
};

export function notificationText(
  lang: NotifyLang,
  kind: 'new_lead' | 'retention_review' | 'contact_overdue',
  leadRef: string,
  productName: string,
): { text: string; button: string } {
  const t = TEXTS[lang] ?? TEXTS.uk;
  return { text: t[kind](leadRef, productName), button: t.button };
}

export const leadHashPath = (siteId: string, leadId: string): string =>
  `/sites/${siteId}/publisher/leads/${leadId}`;

type Leased = {
  id: string;
  accountId: string;
  productId: string;
  leadId: string;
  kind: 'new_lead' | 'retention_review' | 'contact_overdue';
  recipientMemberId: string;
  attempts: number;
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('PublisherNotify');
  private readonly transport: NotifyTransport;

  constructor(
    private readonly db: SitesDb,
    @Optional() @Inject(PUB_NOTIFY_TRANSPORT) transport?: NotifyTransport,
  ) {
    this.transport = transport ?? new BotNotifyTransport();
  }

  /** Создать уведомления вида `kind` по заявке (один раз на получателя). */
  async enqueue(
    tx: PubTx,
    product: ProductRef & { kind: string },
    leadId: string,
    kind: 'new_lead' | 'retention_review' | 'contact_overdue',
    recipients: readonly string[],
    actor: string,
    now: Date,
    opts: { reopen?: boolean } = {},
  ): Promise<number> {
    let n = 0;
    const status = product.kind === 'working' ? 'pending' : 'suppressed';
    for (const memberId of recipients) {
      const created = await tx.pubNotification.createMany({
        data: [
          {
            accountId: product.accountId,
            productId: product.id,
            leadId,
            kind,
            recipientMemberId: memberId,
            status,
            nextAttemptAt: now,
            createdBy: actor,
          },
        ],
        skipDuplicates: true,
      });
      n += created.count;
      if (!created.count && opts.reopen && status === 'pending') {
        // Следующий цикл пересмотра: доставленное прежде — снова в очередь.
        const r = await tx.pubNotification.updateMany({
          where: {
            productId: product.id,
            leadId,
            kind,
            recipientMemberId: memberId,
            status: { in: ['sent', 'dead'] },
          },
          data: {
            status: 'pending',
            attempts: 0,
            nextAttemptAt: now,
            leaseUntil: null,
            lastErrorCode: null,
          },
        });
        n += r.count;
      }
    }
    return n;
  }

  /** Проход доставки (задание `notifications-deliver`). */
  async deliver(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher notifications-deliver: очередь уведомлений всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    let sent = 0;
    let failed = 0;
    let dead = 0;
    const langCache = new Map<
      string,
      Map<string, { chatId: bigint; lang: NotifyLang }>
    >();
    for (;;) {
      if (Date.now() > ctx.deadline.getTime()) break;
      const leased = await system.$queryRaw<Leased[]>`
        UPDATE "sites"."pub_notifications" n
           SET "status" = 'sending', "leaseUntil" = ${new Date(ctx.now.getTime() + LEASE_MS)},
               "attempts" = n."attempts" + 1, "updatedAt" = ${ctx.now}
         WHERE n."id" IN (
           SELECT n2."id" FROM "sites"."pub_notifications" n2
             JOIN "sites"."pub_products" p ON p."id" = n2."productId"
            WHERE p."kind" = 'working' AND p."status" = 'active' ${scope}
              AND ((n2."status" IN ('pending', 'failed') AND n2."nextAttemptAt" <= ${ctx.now})
                   OR (n2."status" = 'sending' AND n2."leaseUntil" < ${ctx.now}))
            ORDER BY n2."nextAttemptAt"
            LIMIT ${BATCH}
            FOR UPDATE OF n2 SKIP LOCKED)
        RETURNING n."id", n."accountId", n."productId", n."leadId", n."kind",
                  n."recipientMemberId", n."attempts"`;
      if (!leased.length) break;
      for (const n of leased) {
        const outcome = await this.deliverOne(n, langCache).catch(
          (e: unknown) => ({
            outcome: 'failed' as NotifyOutcome,
            code: errorCodeOf(e),
          }),
        );
        if (outcome.outcome === 'sent') {
          sent++;
          await system.pubNotification.updateMany({
            where: { id: n.id },
            data: {
              status: 'sent',
              sentAt: ctx.now,
              leaseUntil: null,
              lastErrorCode: null,
            },
          });
          continue;
        }
        const final =
          n.attempts >= NOTIFY_MAX_ATTEMPTS ||
          outcome.code === 'recipient_missing' ||
          outcome.code === RECIPIENT_REVOKED;
        if (final) dead++;
        else failed++;
        await system.pubNotification.updateMany({
          where: { id: n.id },
          data: {
            status: final ? 'dead' : 'failed',
            leaseUntil: null,
            lastErrorCode: outcome.code.slice(0, 100),
            nextAttemptAt: new Date(ctx.now.getTime() + backoffMs(n.attempts)),
          },
        });
        if (outcome.code === RECIPIENT_REVOKED) await this.reroute(n, ctx.now);
      }
      if (leased.length < BATCH) break;
    }
    return { processed: sent + failed + dead, details: { sent, failed, dead } };
  }

  /**
   * Уведомление адресата, утратившего роль, — текущим получателям заявки
   * (один раз на получателя; уже получившие не дублируются).
   */
  private async reroute(n: Leased, now: Date): Promise<void> {
    const product = {
      id: n.productId,
      accountId: n.accountId,
      kind: 'working',
    };
    await this.db.forAccount(n.accountId).$transaction(async (tx) => {
      const to = (await leadRecipientIds(tx, product)).filter(
        (id) => id !== n.recipientMemberId,
      );
      await this.enqueue(
        tx,
        product,
        n.leadId,
        n.kind,
        to,
        'system:notifications-deliver',
        now,
      );
    }, OPERATION_TX_OPTIONS);
  }

  private async deliverOne(
    n: Leased,
    langCache: Map<string, Map<string, { chatId: bigint; lang: NotifyLang }>>,
  ): Promise<{ outcome: NotifyOutcome; code: string }> {
    const db = this.db.forAccount(n.accountId);
    const [member, lead, product] = await Promise.all([
      db.siteAccountMember.findFirst({
        where: { id: n.recipientMemberId },
        select: { telegramId: true },
      }),
      db.pubLead.findFirst({
        where: { id: n.leadId, productId: n.productId },
        select: { publicRef: true },
      }),
      db.pubProduct.findFirst({
        where: { id: n.productId },
        select: { name: true, siteId: true },
      }),
    ]);
    if (!member || !lead || !product)
      return { outcome: 'failed', code: 'recipient_missing' };
    // Роль отозвана после постановки в очередь (аудит P-D S3-3): не
    // отправлять; строка — dead `recipient_revoked`, адресаты — текущие.
    if (!(await isLeadRecipient(db, n.productId, n.recipientMemberId)))
      return { outcome: 'failed', code: RECIPIENT_REVOKED };
    let langs = langCache.get(n.accountId);
    if (!langs) {
      const all = await recipientsWithLang(this.db, n.accountId, () => true);
      langs = new Map(all.map((r) => [r.chatId.toString(), r]));
      langCache.set(n.accountId, langs);
    }
    const lang = langs.get(member.telegramId.toString())?.lang ?? 'uk';
    const t = notificationText(lang, n.kind, lead.publicRef, product.name);
    const outcome = await this.transport.send({
      chatId: member.telegramId,
      text: t.text,
      button: {
        text: t.button,
        hashPath: leadHashPath(product.siteId, n.leadId),
      },
    });
    return { outcome, code: outcome === 'sent' ? '' : outcome };
  }

  // ── Кабинет: очередь уведомлений и исходящая очередь ───────────────────

  async list(
    tx: PubTx,
    productId: string,
    q: { status?: unknown; before?: unknown; limit?: unknown },
  ): Promise<ListPage<NotificationView>> {
    if (
      q.status !== undefined &&
      !(NOTIFICATION_STATUSES as readonly unknown[]).includes(q.status)
    ) {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    const limit = Math.min(
      Math.max(Number(q.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const where: Prisma.PubNotificationWhereInput = {
      productId,
      ...(q.status ? { status: q.status as string } : {}),
    };
    if (typeof q.before === 'string' && q.before) {
      const c = await tx.pubNotification.findFirst({
        where: { id: q.before, productId },
        select: { id: true, createdAt: true },
      });
      if (c)
        where.OR = [
          { createdAt: { lt: c.createdAt } },
          { createdAt: c.createdAt, id: { lt: c.id } },
        ];
    }
    const rows = await tx.pubNotification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { lead: { select: { publicRef: true } } },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => notificationView(r, r.lead.publicRef)),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Повтор доставки: `failed|dead` → `pending` (заявка не трогается). */
  async retry(
    tx: PubTx,
    productId: string,
    id: string,
    now: Date,
  ): Promise<{ view: NotificationView; audit: AuditInput[] }> {
    const r = await tx.pubNotification.findFirst({
      where: { id, productId },
      include: { lead: { select: { publicRef: true } } },
    });
    if (!r) throw new PubError('PUB_NOT_FOUND', { object: 'notification' });
    if (r.status !== 'failed' && r.status !== 'dead') {
      throw new PubError('PUB_TRANSITION_INVALID', {
        machine: 'notification',
        from: r.status,
        to: 'pending',
        allowed: [],
      });
    }
    const res = await tx.pubNotification.updateMany({
      where: { id, productId, status: r.status },
      data: {
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        leaseUntil: null,
      },
    });
    if (res.count !== 1)
      throw new PubError('PUB_CONFLICT', { reason: 'status_changed' });
    const next = await tx.pubNotification.findFirst({
      where: { id, productId },
      include: { lead: { select: { publicRef: true } } },
    });
    return {
      view: notificationView(next as typeof r, r.lead.publicRef),
      audit: [
        {
          objectType: 'notification',
          objectId: id,
          action: 'retry',
          fromStatus: r.status,
          toStatus: 'pending',
          meta: { kind: r.kind, leadId: r.leadId },
        },
      ],
    };
  }

  async outbox(
    tx: PubTx,
    productId: string,
    q: { status?: unknown; before?: unknown; limit?: unknown },
  ): Promise<ListPage<OutboxView>> {
    if (
      q.status !== undefined &&
      !(OUTBOX_STATUSES as readonly unknown[]).includes(q.status)
    ) {
      throw validationError([{ field: 'status', code: 'enum' }]);
    }
    const limit = Math.min(
      Math.max(Number(q.limit ?? LIST_LIMIT_DEFAULT) || LIST_LIMIT_DEFAULT, 1),
      LIST_LIMIT_MAX,
    );
    const where: Prisma.PubLeadOutboxWhereInput = {
      productId,
      ...(q.status ? { status: q.status as string } : {}),
    };
    if (typeof q.before === 'string' && q.before) {
      const c = await tx.pubLeadOutbox.findFirst({
        where: { id: q.before, productId },
        select: { id: true, createdAt: true },
      });
      if (c)
        where.OR = [
          { createdAt: { lt: c.createdAt } },
          { createdAt: c.createdAt, id: { lt: c.id } },
        ];
    }
    const rows = await tx.pubLeadOutbox.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { lead: { select: { publicRef: true } } },
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        leadId: r.leadId,
        leadRef: r.lead.publicRef,
        status: r.status as OutboxView['status'],
        attempts: r.attempts,
        lastErrorCode: r.lastErrorCode,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      nextBefore: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Просроченный первый контакт (задание `contact-overdue`). */
  async contactOverdue(ctx: PubCronContext): Promise<CronResult> {
    const system = this.db.system(
      'крон publisher contact-overdue: заявки без первого контакта всех кабинетов',
    );
    const scope = ctx.scope
      ? Prisma.sql`AND p."siteId" = ANY(${ctx.scope.siteIds}::text[])`
      : Prisma.empty;
    const rows = await system.$queryRaw<
      Array<{
        id: string;
        accountId: string;
        productId: string;
        kind: string;
        responsibleMemberId: string | null;
      }>
    >`
      SELECT l."id", l."accountId", l."productId", p."kind", l."responsibleMemberId"
        FROM "sites"."pub_leads" l
        JOIN "sites"."pub_products" p ON p."id" = l."productId"
       WHERE p."kind" IN ('working', 'test') AND p."status" = 'active' ${scope}
         AND l."status" = 'new' AND l."erasedAt" IS NULL
         AND l."contactDueAt" IS NOT NULL AND l."contactDueAt" < ${ctx.now}
         AND NOT EXISTS (SELECT 1 FROM "sites"."pub_notifications" n
                          WHERE n."leadId" = l."id" AND n."kind" = 'contact_overdue')
       ORDER BY l."contactDueAt"
       LIMIT 200`;
    let created = 0;
    for (const r of rows) {
      if (Date.now() > ctx.deadline.getTime()) break;
      created += await this.db
        .forAccount(r.accountId)
        .$transaction(async (tx) => {
          const product = {
            id: r.productId,
            accountId: r.accountId,
            kind: r.kind,
          };
          const to = r.responsibleMemberId
            ? [r.responsibleMemberId]
            : await leadRecipientIds(tx, product);
          return this.enqueue(
            tx,
            product,
            r.id,
            'contact_overdue',
            to,
            'system:contact-overdue',
            ctx.now,
          );
        }, OPERATION_TX_OPTIONS);
    }
    return {
      processed: rows.length,
      details: { overdueLeads: rows.length, notifications: created },
    };
  }
}

export function notificationView(
  r: {
    id: string;
    leadId: string;
    kind: string;
    recipientMemberId: string;
    status: string;
    attempts: number;
    nextAttemptAt: Date;
    lastErrorCode: string | null;
    sentAt: Date | null;
    createdAt: Date;
  },
  leadRef: string,
): NotificationView {
  return {
    id: r.id,
    leadId: r.leadId,
    leadRef,
    kind: r.kind as NotificationView['kind'],
    recipientMemberId: r.recipientMemberId,
    status: r.status as NotificationView['status'],
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt.toISOString(),
    lastErrorCode: r.lastErrorCode,
    sentAt: r.sentAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  };
}

@Injectable()
@PubContribution('cron-job')
export class NotificationsDeliverJob implements CronJob {
  readonly key = 'notifications-deliver';
  readonly schedule = 'tick' as const;
  constructor(private readonly notifications: NotificationsService) {}
  run(ctx: PubCronContext): Promise<CronResult> {
    return this.notifications.deliver(ctx);
  }
}

@Injectable()
@PubContribution('cron-job')
export class ContactOverdueJob implements CronJob {
  readonly key = 'contact-overdue';
  readonly schedule = 'tick' as const;
  constructor(private readonly notifications: NotificationsService) {}
  run(ctx: PubCronContext): Promise<CronResult> {
    return this.notifications.contactOverdue(ctx);
  }
}
