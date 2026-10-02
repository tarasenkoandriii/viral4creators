/**
 * Доставка лида в бот Помощника — W3 (ТЗ §3.6 п.6, §3.7; приёмка Э2 п.7).
 * СИСТЕМНЫЙ код под основной ролью (папка system/ — правило графа
 * `chat-public-db`): получатели — участники кабинета (owner и
 * productRoles.assist ∈ manager|operator), их telegramId роли assist_public
 * не видны. Сообщение: сайт, страница (без query), поля лида (расшифровка
 * здесь, в памяти), ТЕКСТ СОГЛАСИЯ и время, кнопка «Открыть в TMA».
 * Отправка — notify.ts (Э1) ботом ASSIST_BOT_TOKEN. Захват строки —
 * условным UPDATE (lockedUntil), попытки до leadDeliveryMaxAttempts → failed.
 * В лог — только id лида и код, никогда поля (§6.6).
 *
 * Уточнения W3: отправка — по одному получателю (sendToMembers с одним
 * chatId), чтобы `deliveredTo` перечислял, кому дошло; лид «доставлен»,
 * если дошёл хоть одному (остальные, скорее всего, не нажимали Start у бота
 * — О-9). Без ASSIST_BOT_TOKEN/ASSIST_TMA_URL sendToMembers не зовётся
 * вовсе: его запасная ветка пишет текст сообщения в лог, а здесь в тексте —
 * поля лида.
 *
 * Э3 (A): identify посетителя (`identityEnc`) — строка «Покупатель на
 * сайте: …» с пометкой «проверен» (userHash сошёлся с секретом
 * идентичности сайта — IntegrationsService.verifyUserHash) или «заявлено
 * сайтом, не проверено» (секрета нет / подпись не та / без userHash);
 * итог — в `identityVerified` (null — identify не было).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { WIDGET_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { SitesDb } from '../../../prisma/sites-db.service';
import {
  recipients,
  sendToMembers,
  type BotNotifyEnv,
  type FetchLike,
} from '../../assist-knowledge-core/notify';
import { IntegrationsService } from '../../assist-analytics/integrations.service';
import {
  decryptIdentity,
  identityKey,
} from '../../assist-analytics/public/identity-crypto';
import type { WidgetIdentity } from '../chat-types';
import { decryptLeadFields, leadKey, type LeadFields } from '../lead-crypto';

/** Lease захвата строки: дольше одной отправки на всех получателей. */
export const LEAD_LEASE_MS = 60_000;
/** Пауза перед следующей попыткой: 1, 2, 4, 8 мин… */
export function leadBackoffMs(attempt: number): number {
  return Math.min(60, 2 ** Math.max(0, attempt - 1)) * 60_000;
}

interface LeadRow {
  id: string;
  accountId: string;
  siteId: string;
  conversationId: string | null;
  fieldsEnc: string;
  consentText: string;
  consentAt: Date;
  pageUrl: string | null;
  attempts: number;
  identityEnc: string | null;
}

const FIELD_LABEL: Record<keyof LeadFields, string> = {
  name: 'Имя',
  phone: 'Телефон',
  email: 'E-mail',
  comment: 'Комментарий',
};

/** Текст сообщения в бот (кабинет — по-русски, как уведомления Э1). Чистая. */
export function leadMessageText(p: {
  siteName: string;
  pageUrl: string | null;
  fields: LeadFields;
  consentText: string;
  consentAt: Date;
  /** Э3: identify посетителя и итог сверки userHash. */
  identity?: WidgetIdentity | null;
  identityVerified?: boolean | null;
}): string {
  const lines = [`Новая заявка с сайта «${p.siteName}»`];
  if (p.pageUrl) lines.push(`Страница: ${p.pageUrl}`);
  for (const k of ['name', 'phone', 'email', 'comment'] as const) {
    const v = p.fields[k];
    if (v) lines.push(`${FIELD_LABEL[k]}: ${v}`);
  }
  if (p.identity) {
    const who = [
      p.identity.name,
      p.identity.email,
      p.identity.externalId ? `id ${p.identity.externalId}` : null,
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `Покупатель на сайте: ${who} — ${
        p.identityVerified
          ? 'проверен (подпись сайта сошлась)'
          : 'заявлено сайтом, не проверено'
      }`,
    );
  }
  lines.push(
    '',
    `Согласие посетителя (${p.consentAt.toISOString().replace('T', ' ').slice(0, 16)} UTC):`,
    `«${p.consentText}»`,
  );
  return lines.join('\n').slice(0, 4000);
}

@Injectable()
export class LeadDelivery {
  private readonly logger = new Logger(LeadDelivery.name);
  env: BotNotifyEnv & NodeJS.ProcessEnv = process.env;
  fetchImpl: FetchLike | undefined;
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sitesDb: SitesDb,
    @Optional() private readonly integrations?: IntegrationsService,
  ) {}

  async deliver(leadId: string): Promise<'delivered' | 'retry' | 'failed'> {
    const now = this.now();
    const rows = await this.prisma.$queryRawUnsafe<LeadRow[]>(
      `UPDATE "sites"."assist_site_leads"
          SET "lockedUntil" = $2, "attempts" = "attempts" + 1
        WHERE "id" = $1 AND "deliveryState" = 'pending'
          AND ("lockedUntil" IS NULL OR "lockedUntil" < $3)
        RETURNING "id", "accountId", "siteId", "conversationId", "fieldsEnc",
                  "consentText", "consentAt", "pageUrl", "attempts", "identityEnc"`,
      leadId,
      new Date(now.getTime() + LEAD_LEASE_MS),
      now,
    );
    if (!rows.length) {
      // Уже доставлен/исчерпан или его сейчас везёт другой экземпляр.
      const cur = await this.prisma.assistSiteLead.findUnique({
        where: { id: leadId },
        select: { deliveryState: true },
      });
      if (cur?.deliveryState === 'delivered') return 'delivered';
      if (cur?.deliveryState === 'failed') return 'failed';
      return 'retry';
    }
    const lead = rows[0];
    const result = await this.send(lead).catch((e: unknown) => {
      this.logger.warn(
        `лид ${leadId}: сбой отправки (${(e as Error | null)?.name ?? 'Error'})`,
      );
      return { delivered: [] as bigint[], error: 'send_failed' };
    });
    if (result.delivered.length) {
      await this.prisma.assistSiteLead.update({
        where: { id: lead.id },
        data: {
          deliveryState: 'delivered',
          deliveredAt: this.now(),
          lockedUntil: null,
          lastError: null,
          deliveredTo: result.delivered.map((chatId) => ({
            channel: 'telegram',
            chatId: chatId.toString(),
            at: this.now().toISOString(),
          })),
        },
        select: { id: true },
      });
      this.logger.log(`лид ${lead.id}: доставлен (${result.delivered.length})`);
      return 'delivered';
    }
    const failed = lead.attempts >= WIDGET_DEFAULTS.leadDeliveryMaxAttempts;
    await this.prisma.assistSiteLead.update({
      where: { id: lead.id },
      data: {
        deliveryState: failed ? 'failed' : 'pending',
        lastError: result.error,
        lockedUntil: failed
          ? null
          : new Date(this.now().getTime() + leadBackoffMs(lead.attempts)),
      },
      select: { id: true },
    });
    this.logger.warn(
      `лид ${lead.id}: не доставлен (${result.error}, попытка ${lead.attempts})`,
    );
    return failed ? 'failed' : 'retry';
  }

  private async send(
    lead: LeadRow,
  ): Promise<{ delivered: bigint[]; error: string | null }> {
    if (
      !this.env.ASSIST_BOT_TOKEN?.trim() ||
      !this.env.ASSIST_TMA_URL?.trim()
    ) {
      return { delivered: [], error: 'bot_not_configured' };
    }
    const key = leadKey(this.env);
    const fields = key ? decryptLeadFields(lead.fieldsEnc, lead.id, key) : null;
    if (!fields) return { delivered: [], error: 'decrypt_failed' };
    const identity = await this.identityOf(lead);
    const site = await this.prisma.site.findUnique({
      where: { id: lead.siteId },
      select: { name: true },
    });
    const chatIds = await recipients(
      this.sitesDb,
      lead.accountId,
      (m) =>
        m.role === 'owner' ||
        m.productRoles.assist === 'manager' ||
        m.productRoles.assist === 'operator',
    );
    if (!chatIds.length) return { delivered: [], error: 'no_recipients' };
    const text = leadMessageText({
      siteName: site?.name ?? '',
      pageUrl: lead.pageUrl,
      fields,
      consentText: lead.consentText,
      consentAt: lead.consentAt,
      identity: identity?.identity ?? null,
      identityVerified: identity?.verified ?? null,
    });
    const delivered: bigint[] = [];
    for (const chatId of chatIds) {
      const n = await sendToMembers({
        chatIds: [chatId],
        text,
        button: {
          text: 'Открыть в TMA',
          hashPath: `/sites/${lead.siteId}/widget`,
        },
        env: this.env,
        fetchImpl: this.fetchImpl,
      });
      if (n > 0) delivered.push(chatId);
    }
    return { delivered, error: delivered.length ? null : 'not_delivered' };
  }

  /** identify лида: расшифровка и сверка userHash; итог — в identityVerified. */
  private async identityOf(
    lead: LeadRow,
  ): Promise<{ identity: WidgetIdentity; verified: boolean } | null> {
    if (!lead.identityEnc) return null;
    const key = identityKey(this.env);
    const identity = key
      ? decryptIdentity(lead.identityEnc, lead.id, key)
      : null;
    if (!identity) return null;
    let verified = false;
    if (identity.externalId && identity.userHash && this.integrations) {
      verified =
        (await this.integrations.verifyUserHash(
          lead.siteId,
          identity.externalId,
          identity.userHash,
        )) === true;
    }
    await this.prisma.assistSiteLead.update({
      where: { id: lead.id },
      data: { identityVerified: verified },
      select: { id: true },
    });
    return { identity, verified };
  }

  /** Крон: недоставленные с истёкшим lease. */
  async redeliverPending(limit: number): Promise<number> {
    const now = this.now();
    const due = await this.prisma.assistSiteLead.findMany({
      where: {
        deliveryState: 'pending',
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, limit),
      select: { id: true },
    });
    let delivered = 0;
    for (const l of due) {
      if ((await this.deliver(l.id)) === 'delivered') delivered++;
    }
    return delivered;
  }
}
