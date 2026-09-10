/**
 * MarketingBroadcastService — крон-воркер рассылки подборки удачных
 * роликов (ТЗ §42, этап 63). Вызывается `GET /api/cron/marketing-
 * broadcast` раз в сутки (`backend/vercel.json`).
 *
 * Один прогон (`runDaily`) делает два независимых по данным шага в одном
 * маршруте — тот же приём экономии крон-слота, что у `/cron/blog` (этап
 * 57): Vercel Hobby считает кроны поштучно, и лишний маршрут — лишний
 * (непроверенный) риск упереться в лимит плана.
 *
 * 1. **Сборка выпуска** — не чаще раза в `marketing.frequencyDays` дней:
 *    если пора, берёт до `marketing.pageCount` ещё не показанных
 *    PUBLISHED-страниц (SharedVideoPage), создаёт `MarketingBroadcast` со
 *    снимком их id и заводит по одной `MarketingDelivery(PENDING)` на
 *    каждого подписчика с активным согласием.
 * 2. **Доставка партии** — до `marketing.cronBatch` строк
 *    `MarketingDelivery`, готовых к попытке (PENDING или FAILED с
 *    истёкшим nextAttemptAt), по одной, с паузой между отправками против
 *    лимита Telegram (~30 msg/sec). Бэкофф — та же формула
 *    `2^attempts` минут, что у `PublishWorkerService.recordFailure`
 *    (этап 61): один битый получатель не блокирует остальных и не
 *    рассылается бесконечно.
 *
 *    Ответ Telegram "бот заблокирован пользователем" — не ошибка
 *    доставки, а сигнал отписки: TODO §III.4 требует, чтобы блокировка
 *    бота снимала согласие в базе, а не рассылалась молча "в пустоту
 *    годами". Реактивная проверка (на попытке отправки), а не отдельный
 *    вебхук `my_chat_member` — сознательное решение этапа, см. SPEC §42
 *    (единственный вебхук бота уже занят платежами, этап 62).
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';

/** Потолок ожидания ответа Telegram на одну отправку. */
const SEND_TIMEOUT_MS = 5000;
/** Пауза между отправками — под лимит Telegram (~30 сообщений/сек),
 * с большим запасом (незачем гнаться за скоростью суточного воркера). */
const SEND_PAUSE_MS = 40;

interface FeaturedPage {
  id: string;
  title: string;
  productName: string;
}

interface DeliverableRow {
  id: string;
  userId: string;
  attempts: number;
  broadcast: { sharedVideoPageIds: string[] };
}

export interface MarketingBroadcastResult {
  composed: boolean;
  featured: number;
  recipients: number;
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  stillPending: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class MarketingBroadcastService {
  private readonly logger = new Logger(MarketingBroadcastService.name);

  constructor(private readonly prisma: PrismaService) {}

  private cfg() {
    return loadConfiguration().marketing;
  }

  private get botToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  }

  async runDaily(): Promise<MarketingBroadcastResult> {
    const composition = await this.composeIfDue();
    const delivery = await this.deliverBatch();
    const result: MarketingBroadcastResult = {
      composed: composition.composed,
      featured: composition.featured,
      recipients: composition.recipients,
      ...delivery,
    };
    if (composition.composed || delivery.processed > 0) {
      this.logger.log(
        `Крон рассылки: выпуск ${composition.composed ? `собран (${composition.featured} карточек, ${composition.recipients} получателей)` : 'не собирался'}, ` +
          `доставка: обработано ${delivery.processed}, отправлено ${delivery.sent}, ` +
          `пропущено ${delivery.skipped}, ошибок ${delivery.failed}, в очереди ${delivery.stillPending}`,
      );
    }
    return result;
  }

  // ── Шаг 1: сборка выпуска ───────────────────────────────────────────

  private async composeIfDue(): Promise<{
    composed: boolean;
    featured: number;
    recipients: number;
  }> {
    const last = await this.prisma.marketingBroadcast.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last) {
      const dueAt =
        last.createdAt.getTime() + this.cfg().frequencyDays * 86_400_000;
      if (Date.now() < dueAt) {
        return { composed: false, featured: 0, recipients: 0 };
      }
    }

    const pages: FeaturedPage[] = await this.prisma.sharedVideoPage.findMany({
      where: { status: 'PUBLISHED', featuredInBroadcastAt: null },
      orderBy: { createdAt: 'desc' },
      take: this.cfg().pageCount,
      select: { id: true, title: true, productName: true },
    });
    if (pages.length === 0) {
      // Нечего показать — пустой выпуск хуже отсутствия выпуска, ждём
      // следующего тика. Не трогаем last.createdAt: следующая попытка
      // собрать выпуск будет уже завтра, а не через ещё N дней.
      return { composed: false, featured: 0, recipients: 0 };
    }

    const broadcast = await this.prisma.marketingBroadcast.create({
      data: { sharedVideoPageIds: pages.map((p) => p.id) },
      select: { id: true },
    });
    await this.prisma.sharedVideoPage.updateMany({
      where: { id: { in: pages.map((p) => p.id) } },
      data: { featuredInBroadcastAt: new Date() },
    });

    const subscribers = await this.prisma.user.findMany({
      where: {
        marketingConsentAt: { not: null },
        marketingConsentRevokedAt: null,
      },
      select: { id: true },
    });
    if (subscribers.length > 0) {
      await this.prisma.marketingDelivery.createMany({
        data: subscribers.map((u: { id: string }) => ({
          broadcastId: broadcast.id,
          userId: u.id,
        })),
        skipDuplicates: true,
      });
    }
    return {
      composed: true,
      featured: pages.length,
      recipients: subscribers.length,
    };
  }

  // ── Шаг 2: доставка партии ──────────────────────────────────────────

  private async deliverBatch(): Promise<{
    processed: number;
    sent: number;
    skipped: number;
    failed: number;
    stillPending: number;
  }> {
    if (!this.botToken) {
      // Тот же принцип, что у остальных крон-воркеров: без ключа
      // бессмысленно искать работу — честные нули, а не 500.
      return { processed: 0, sent: 0, skipped: 0, failed: 0, stillPending: 0 };
    }
    const rows: DeliverableRow[] = await this.prisma.marketingDelivery.findMany(
      {
        where: {
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', nextAttemptAt: { lte: new Date() } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: this.cfg().cronBatch,
        select: {
          id: true,
          userId: true,
          attempts: true,
          broadcast: { select: { sharedVideoPageIds: true } },
        },
      },
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const outcome = await this.processOne(row);
        if (outcome === 'sent') sent += 1;
        else if (outcome === 'skipped') skipped += 1;
      } catch (error) {
        failed += 1;
        await this.recordFailure(row, error);
      }
      await sleep(SEND_PAUSE_MS);
    }
    return {
      processed: rows.length,
      sent,
      skipped,
      failed,
      stillPending: rows.length - sent - skipped - failed,
    };
  }

  private async processOne(row: DeliverableRow): Promise<'sent' | 'skipped'> {
    const user = await this.prisma.user.findUnique({
      where: { id: row.userId },
      select: { telegramId: true, marketingConsentRevokedAt: true },
    });
    if (!user || user.marketingConsentRevokedAt) {
      // Отписался (сам или уже из-за 403 на другой доставке того же
      // пользователя) между сборкой выпуска и этим тиком — не шлём.
      await this.prisma.marketingDelivery.update({
        where: { id: row.id },
        data: { status: 'SKIPPED' },
      });
      return 'skipped';
    }

    const pages = await this.prisma.sharedVideoPage.findMany({
      where: { id: { in: row.broadcast.sharedVideoPageIds } },
      select: { id: true, title: true, productName: true },
    });
    const text = buildMessage(pages, this.cfg().landingUrl);

    const res = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: user.telegramId,
          text,
          disable_web_page_preview: false,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    if (res.ok) {
      await this.prisma.marketingDelivery.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      return 'sent';
    }

    const body = await res.json().catch(() => null as unknown);
    const description =
      body && typeof body === 'object' && 'description' in body
        ? String((body as { description: unknown }).description)
        : '';
    if (res.status === 403 || /blocked by the user/i.test(description)) {
      // Требование TODO §III.4: отписка обязана работать по факту, а не
      // после того, как о ней кто-то заявит вручную. Помечаем эту и все
      // будущие попытки (следующая сборка выпуска уже не заведёт для
      // него новых MarketingDelivery — условие "активное согласие" не
      // совпадёт).
      await this.prisma.$transaction([
        this.prisma.marketingDelivery.update({
          where: { id: row.id },
          data: { status: 'SKIPPED', error: description.slice(0, 500) },
        }),
        this.prisma.user.update({
          where: { id: row.userId },
          data: { marketingConsentRevokedAt: new Date() },
        }),
      ]);
      return 'skipped';
    }
    throw new Error(
      `Telegram ответил ${res.status}${description ? `: ${description}` : ''}`,
    );
  }

  /** Бэкофф — буквально та же формула, что
   * PublishWorkerService.recordFailure (этап 61): attempts++,
   * nextAttemptAt = now + 2^attempts мин, FAILED-терминал после
   * maxAttempts. */
  private async recordFailure(
    row: DeliverableRow,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = row.attempts + 1;
    const maxAttempts = this.cfg().maxAttempts;
    const exhausted = attempts >= maxAttempts;
    await this.prisma.marketingDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        error: message.slice(0, 2000),
        status: 'FAILED',
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + 2 ** attempts * 60_000),
      },
    });
    this.logger.warn(
      `Доставка ${row.id}: попытка ${attempts}/${maxAttempts} не удалась — ${message}` +
        (exhausted ? ', попытки исчерпаны → FAILED' : ''),
    );
  }
}

/** Pure — экспортирован для теста. */
export function buildMessage(
  pages: Array<{ id: string; title: string; productName: string }>,
  landingUrl: string,
): string {
  const lines = pages.map((p) => {
    const link = landingUrl ? `${landingUrl}/video/${p.id}` : null;
    const label = `${p.title} (${p.productName})`;
    return link ? `• ${label}\n  ${link}` : `• ${label}`;
  });
  return [
    '🎬 Подборка удачных рекламных роликов недели:',
    '',
    ...lines,
    '',
    'Отписаться можно в любой момент в приложении.',
  ].join('\n');
}
