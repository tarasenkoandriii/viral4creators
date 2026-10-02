/**
 * Системная часть передачи человеку — H (ТЗ §3.7 п.3–6). Основная роль
 * (папка system/): получатели — участники кабинета (owner и
 * `assist: manager|operator`) с ботом (assist_bot_users.startedAt, без
 * blockedAt) — их telegramId роли виджета не видны.
 *
 *  - dispatch(id): сводка (№14; модель — SiteBudget сайта+платформы,
 *    операция `assist-handoff`; нет денег/сбой — `fallback` без модели),
 *    черновик (№11, если включён и есть источники), карточка каждому:
 *    страница (без query), язык, сводка (МАСКИРОВАННАЯ — §3.7 «что
 *    пересылается»), кнопки «Взять» / «Черновик» / «Шаблон» / «Открыть в
 *    TMA» (`#/sites/:id/dialogs/:cid`); каждое отправленное сообщение — в
 *    assist_bot_messages (реплай и кнопки находят передачу по нему).
 *    Захват строки — lockedUntil (условный UPDATE), повтор — кроном.
 *  - relayVisitorMessage(id): вопрос посетителя во время передачи → взявшему
 *    (или всем, пока waiting), с переводом (№12) — оригинал рядом.
 *  - tick(now): waiting после timeoutAt → missed (+ посетителю форма заявки
 *    через state, + «пропущено» в утреннюю сводку A); напоминание взявшему
 *    без ответа через remindAfterMinutes (≤ maxReminders); active без
 *    активности idleCloseHours → closed; медиана «~N минут» за 7 дней →
 *    assist_sites.handoffEtaMinutes; уборка assist_bot_messages по expiresAt;
 *    operator_fix-сигнал (L) по закрытой передаче, где оператор ответил после
 *    ответа модели.
 * В лог — только id и коды; текст сообщений и telegramId — никогда (§6.6).
 *
 * Уточнения H:
 *  - напоминание и для waiting: через remindAfterMinutes без «Взять» —
 *    всем получателям карточки (ответом на карточку), не больше maxReminders;
 *  - сообщение посетителя, написанное после запроса передачи и не
 *    пересланное (карточек ещё не было, сбой отправки), — повтор кроном
 *    после доставки карточек (в сводку оно могло не попасть);
 *  - relayedAt ставится ДО отправки (захват: конвейер и крон не пошлют
 *    дважды), полный сбой отправки — снимается.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { HANDOFF_DEFAULTS } from '../../../config/assist-defaults';
import type { CronScope } from '../../../common/cron-scope';
import { PrismaService } from '../../../prisma/prisma.service';
import type { FetchLike } from '../../assist-knowledge-core/notify';
import { IntegrationsService } from '../../assist-analytics/integrations.service';
import { leadKey } from '../../assist-site-chat/lead-crypto';
import { LearningCandidates } from '../../assist-site-learning/learning-queue.service';
import {
  createTelegramBotClient,
  type BotButton,
  type TelegramBotClient,
} from '../bot/telegram-bot-client';
import {
  effectiveHandoffConfig,
  type HandoffConfig,
} from '../public/handoff-config';
import { decryptIdentity } from '../public/identity-crypto';
import {
  HANDOFF_ROW_SELECT,
  botRecipients,
  cardText,
  parseCards,
  parseSummary,
  relayText,
  type CardRef,
  type HandoffRow,
} from './handoff-common';
import { HandoffAi } from './handoff-ai';

export interface HandoffTickResult {
  missed: number;
  reminded: number;
  closed: number;
  redelivered: number;
  etaUpdated: number;
  botMessagesPurged: number;
  /** Хвост forget (L, LearnRollup.processForgetJobs) — зовёт контроллер крона. */
  forgetJobs?: number;
}

/** Пауза перед повтором рассылки: 1, 2, 4 мин… */
export function dispatchBackoffMs(attempt: number): number {
  return Math.min(30, 2 ** Math.max(0, attempt - 1)) * 60_000;
}

/** Строк за проход крона на каждый шаг (с запасом по времени функции). */
export const TICK_BATCH = 100;
/** Сообщение посетителя «свежее» — его пересылает сам конвейер, не крон. */
const RELAY_GRACE_MS = 30_000;
const RECIPIENTS_CACHE_MS = 30_000;

type CardState =
  'waiting' | 'taken_by_me' | 'taken_by_other' | 'closed' | 'missed';

@Injectable()
export class HandoffDispatcher {
  private readonly logger = new Logger(HandoffDispatcher.name);
  /** Часы — параметром (тесты «через 24 ч», таймауты). */
  now: () => Date = () => new Date();
  /** env и fetch бота — тесты подменяют (подменённый fetch, §8). */
  env: NodeJS.ProcessEnv = process.env;
  fetchImpl: FetchLike | undefined;
  private readonly recipientsCache = new Map<
    string,
    { at: number; value: boolean }
  >();

  constructor(
    readonly prisma: PrismaService,
    @Optional() readonly ai?: HandoffAi,
    @Optional() readonly integrations?: IntegrationsService,
    @Optional() readonly candidates?: LearningCandidates,
  ) {}

  bot(): TelegramBotClient {
    return createTelegramBotClient({
      env: this.env,
      fetchImpl: this.fetchImpl,
    });
  }

  /** Есть ли кому слать карточки (публичный приём спрашивает по accountId). */
  async hasRecipients(accountId: string): Promise<boolean> {
    const hit = this.recipientsCache.get(accountId);
    const t = Date.now();
    if (hit && t - hit.at < RECIPIENTS_CACHE_MS) return hit.value;
    const value = (await botRecipients(this.prisma, accountId)).length > 0;
    this.recipientsCache.set(accountId, { at: t, value });
    return value;
  }

  /** Сброс кэша (Start/блок бота, смена ролей) — следующий запрос увидит сразу. */
  forgetRecipients(accountId?: string): void {
    if (accountId) this.recipientsCache.delete(accountId);
    else this.recipientsCache.clear();
  }

  // ── Рассылка карточек ──────────────────────────────────────────────────

  /** Разослать карточки новой передачи (идемпотентно: повтор не шлёт дважды тому же). */
  async dispatch(handoffId: string): Promise<void> {
    const now = this.now();
    const claimed = await this.prisma.assistSiteHandoff.updateMany({
      where: {
        id: handoffId,
        state: 'waiting',
        deliveredAt: null,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        lockedUntil: new Date(now.getTime() + HANDOFF_DEFAULTS.leaseMs),
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return;
    let h = await this.row(handoffId);
    if (!h) return;
    const site = await this.siteOf(h.siteId);
    const config = effectiveHandoffConfig(site?.handoffConfig);
    try {
      const patch: Prisma.AssistSiteHandoffUpdateInput = {};
      if (!h.operatorLang) patch.operatorLang = config.operatorLang;
      if (!h.summary && this.ai) {
        patch.summary = (await this.ai
          .summarize(handoffId)
          .catch(() => null)) as unknown as Prisma.InputJsonValue;
      }
      if (config.draft && !h.draft && this.ai) {
        const d = await this.ai.draft(handoffId).catch(() => null);
        if (d) patch.draft = d as unknown as Prisma.InputJsonValue;
      }
      if (h.identityEnc && h.identityVerified === null) {
        patch.identityVerified = await this.verifyIdentity(h);
      }
      if (Object.keys(patch).length) {
        await this.prisma.assistSiteHandoff.update({
          where: { id: handoffId },
          data: patch,
          select: { id: true },
        });
        h = (await this.row(handoffId)) ?? h;
      }
      const cards = parseCards(h.cards);
      const sentTo = new Set(cards.map((c) => c.memberId));
      const recipients = await botRecipients(this.prisma, h.accountId);
      const bot = this.bot();
      const text = this.card(h, site?.name ?? '', 'waiting');
      for (const r of recipients) {
        if (sentTo.has(r.memberId)) continue;
        const res = await bot.send({
          chatId: r.telegramId,
          text,
          buttons: this.cardButtons(h, config, 'waiting'),
        });
        if (res.code === 'blocked') await this.markBlocked(r.telegramId);
        if (!res.ok) continue;
        if (res.messageId !== null) {
          cards.push({
            memberId: r.memberId,
            chatId: r.telegramId.toString(),
            messageId: res.messageId,
          });
          await this.remember(
            r.telegramId,
            res.messageId,
            h,
            'handoff_card',
            r.memberId,
          );
        }
        sentTo.add(r.memberId);
      }
      const delivered = sentTo.size > 0;
      await this.prisma.assistSiteHandoff.update({
        where: { id: handoffId },
        data: {
          cards: cards as unknown as Prisma.InputJsonValue,
          deliveredAt: delivered ? (h.deliveredAt ?? this.now()) : null,
          lockedUntil: delivered
            ? null
            : new Date(this.now().getTime() + dispatchBackoffMs(h.attempts)),
        },
        select: { id: true },
      });
      this.logger.log(
        `передача ${handoffId}: карточки ${delivered ? `разосланы (${sentTo.size})` : 'не доставлены'}`,
      );
    } catch (e) {
      // lockedUntil истечёт — крон повторит.
      this.logger.warn(
        `передача ${handoffId}: сбой рассылки (${(e as Error | null)?.name ?? 'Error'})`,
      );
    }
  }

  // ── Пересылка сообщения посетителя ────────────────────────────────────

  /** Переслать сообщение посетителя оператору(ам) во время передачи. */
  async relayVisitorMessage(messageId: string): Promise<void> {
    const msg = await this.prisma.assistSiteMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        accountId: true,
        siteId: true,
        conversationId: true,
        role: true,
        text: true,
        lang: true,
        relayedAt: true,
        createdAt: true,
      },
    });
    if (!msg || msg.role !== 'visitor' || msg.relayedAt) return;
    const h = await this.prisma.assistSiteHandoff.findFirst({
      where: {
        conversationId: msg.conversationId,
        state: { in: ['waiting', 'active'] },
      },
      select: HANDOFF_ROW_SELECT,
    });
    if (!h) return;
    const cards = parseCards(h.cards);
    const targets =
      h.state === 'active' && h.assignedMemberId
        ? cards.filter((c) => c.memberId === h.assignedMemberId)
        : cards;
    // Взявший оператор без карточки (взял из TMA) — пишем ему напрямую.
    const direct =
      h.state === 'active' && h.assignedTelegramId && !targets.length
        ? [
            {
              memberId: h.assignedMemberId ?? '',
              chatId: h.assignedTelegramId.toString(),
              messageId: 0,
            },
          ]
        : [];
    const all = await this.stillEligible(h.accountId, [...targets, ...direct]);
    if (!all.length) return;
    const claim = await this.prisma.assistSiteMessage.updateMany({
      where: { id: messageId, relayedAt: null },
      data: { relayedAt: this.now() },
    });
    if (claim.count !== 1) return;
    // Язык посетителя — язык его последних сообщений (О-6): ответ оператора
    // переводится на него.
    if (msg.lang && msg.lang !== h.visitorLang) {
      await this.prisma.assistSiteHandoff.update({
        where: { id: h.id },
        data: { visitorLang: msg.lang },
        select: { id: true },
      });
    }
    const site = await this.siteOf(h.siteId);
    const config = effectiveHandoffConfig(site?.handoffConfig);
    const operatorLang = h.operatorLang ?? config.operatorLang;
    let translation: { lang: string; text: string } | null = null;
    let untranslated = false;
    if (config.translate && msg.lang && msg.lang !== operatorLang && this.ai) {
      const tr = await this.ai
        .translate({
          accountId: msg.accountId,
          siteId: msg.siteId,
          text: msg.text,
          from: msg.lang,
          to: operatorLang,
        })
        .catch(() => ({ text: msg.text, translated: false }));
      if (tr.translated) {
        translation = { lang: operatorLang, text: tr.text };
        await this.prisma.assistSiteMessage.update({
          where: { id: msg.id },
          data: {
            translation: translation as unknown as Prisma.InputJsonValue,
          },
          select: { id: true },
        });
      } else {
        untranslated = true;
      }
    }
    const bot = this.bot();
    const text = relayText({ text: msg.text, translation, untranslated });
    let sent = 0;
    for (const c of all) {
      const chatId = BigInt(c.chatId);
      const res = await bot.send({
        chatId,
        text,
        replyToMessageId: c.messageId || undefined,
      });
      if (res.code === 'blocked') await this.markBlocked(chatId);
      if (!res.ok) continue;
      sent++;
      if (res.messageId !== null) {
        await this.remember(
          chatId,
          res.messageId,
          h,
          'relay',
          c.memberId || null,
        );
      }
    }
    if (!sent) {
      await this.prisma.assistSiteMessage.updateMany({
        where: { id: messageId },
        data: { relayedAt: null },
      });
      this.logger.warn(`сообщение ${messageId}: не переслано оператору`);
    }
  }

  // ── Карточки после «Взять»/«Закрыть» ──────────────────────────────────

  /** Правка разосланных карточек по текущему состоянию передачи (без имён). */
  async refreshCards(handoffId: string): Promise<void> {
    const h = await this.row(handoffId);
    if (!h) return;
    const site = await this.siteOf(h.siteId);
    const config = effectiveHandoffConfig(site?.handoffConfig);
    const bot = this.bot();
    for (const c of parseCards(h.cards)) {
      const state: CardState =
        h.state === 'active'
          ? c.memberId === h.assignedMemberId
            ? 'taken_by_me'
            : 'taken_by_other'
          : h.state === 'missed'
            ? 'missed'
            : h.state === 'waiting'
              ? 'waiting'
              : 'closed';
      const res = await bot.edit({
        chatId: BigInt(c.chatId),
        messageId: c.messageId,
        text: this.card(h, site?.name ?? '', state),
        buttons: this.cardButtons(h, config, state),
      });
      if (res.code === 'blocked') await this.markBlocked(BigInt(c.chatId));
    }
  }

  /**
   * После закрытия (оператором или кроном): оператор ответил ПОСЛЕ ответа
   * модели — сигнал operator_fix (L, без модели-сравнителя — решение 7).
   */
  async afterClose(handoffId: string): Promise<void> {
    const h = await this.prisma.assistSiteHandoff.findUnique({
      where: { id: handoffId },
      select: {
        accountId: true,
        siteId: true,
        conversationId: true,
        requestedAt: true,
      },
    });
    if (!h || !this.candidates) return;
    const model = await this.prisma.assistSiteMessage.findFirst({
      where: {
        conversationId: h.conversationId,
        role: 'assistant',
        answerPath: { in: ['model', 'faq', 'cache'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!model) return;
    const op = await this.prisma.assistSiteMessage.findFirst({
      where: {
        conversationId: h.conversationId,
        role: 'operator',
        createdAt: { gt: model.createdAt },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!op) return;
    await this.candidates
      .recordOperatorFix({
        accountId: h.accountId,
        siteId: h.siteId,
        conversationId: h.conversationId,
        operatorMessageId: op.id,
      })
      .catch((e: unknown) =>
        this.logger.warn(
          `передача ${handoffId}: operator_fix не записан (${(e as Error | null)?.name ?? 'Error'})`,
        ),
      );
  }

  // ── Крон ──────────────────────────────────────────────────────────────

  /**
   * `scope` — только для тестов на общей базе (контракт Э3 §9 п.6): крон
   * идёт по всем сайтам, тест — только по своим, иначе он трогает строки
   * параллельных наборов.
   */
  async tick(now: Date, scope?: CronScope): Promise<HandoffTickResult> {
    const saved = this.now;
    this.now = () => now;
    try {
      const where = scope ? { siteId: { in: scope.siteIds } } : {};
      const r: HandoffTickResult = {
        missed: await this.tickMissed(now, where),
        reminded: 0,
        closed: 0,
        redelivered: 0,
        etaUpdated: 0,
        botMessagesPurged: 0,
      };
      r.redelivered = await this.tickRedeliver(now, where);
      r.reminded = await this.tickRemind(now, where);
      r.closed = await this.tickIdleClose(now, where);
      r.etaUpdated = await this.tickEta(now, scope);
      r.botMessagesPurged = (
        await this.prisma.assistBotMessage.deleteMany({
          where: { ...where, expiresAt: { lt: now } },
        })
      ).count;
      return r;
    } finally {
      this.now = saved;
    }
  }

  private async tickMissed(
    now: Date,
    where: Prisma.AssistSiteHandoffWhereInput,
  ): Promise<number> {
    const due = await this.prisma.assistSiteHandoff.findMany({
      where: { ...where, state: 'waiting', timeoutAt: { lte: now } },
      orderBy: { timeoutAt: 'asc' },
      take: TICK_BATCH,
      select: { id: true, conversationId: true },
    });
    let n = 0;
    for (const d of due) {
      const u = await this.prisma.assistSiteHandoff.updateMany({
        where: { id: d.id, state: 'waiting' },
        data: { state: 'missed', missedAt: now, lockedUntil: null },
      });
      if (u.count !== 1) continue;
      n++;
      await this.prisma.assistSiteConversation.update({
        where: { id: d.conversationId },
        data: { handoffState: 'missed', stateVersion: { increment: 1 } },
        select: { id: true },
      });
      await this.refreshCards(d.id).catch(() => undefined);
      this.logger.log(`передача ${d.id}: пропущена (missed)`);
    }
    return n;
  }

  private async tickRedeliver(
    now: Date,
    where: Prisma.AssistSiteHandoffWhereInput,
  ): Promise<number> {
    let n = 0;
    const due = await this.prisma.assistSiteHandoff.findMany({
      where: {
        ...where,
        state: 'waiting',
        deliveredAt: null,
        attempts: { lt: HANDOFF_DEFAULTS.maxDispatchAttempts },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      orderBy: { requestedAt: 'asc' },
      take: TICK_BATCH,
      select: { id: true },
    });
    for (const d of due) {
      await this.dispatch(d.id);
      const after = await this.prisma.assistSiteHandoff.findUnique({
        where: { id: d.id },
        select: { deliveredAt: true },
      });
      if (after?.deliveredAt) n++;
    }
    // Сообщения посетителя, которые конвейер не успел переслать. Граница —
    // запрос передачи, а не доставка карточек: сводка считается в начале
    // рассылки, и вопрос, написанный, пока карточки ещё не дошли (рассылка
    // идёт, Telegram недоступен — повтор через минуты), не попал бы ни в
    // сводку, ни оператору. Лучше повтор того, что уже есть в сводке.
    const open = await this.prisma.assistSiteHandoff.findMany({
      where: {
        ...where,
        state: { in: ['waiting', 'active'] },
        deliveredAt: { not: null },
      },
      take: TICK_BATCH,
      select: { conversationId: true, requestedAt: true },
    });
    for (const o of open) {
      const msgs = await this.prisma.assistSiteMessage.findMany({
        where: {
          conversationId: o.conversationId,
          role: 'visitor',
          relayedAt: null,
          createdAt: {
            gte: o.requestedAt,
            lt: new Date(now.getTime() - RELAY_GRACE_MS),
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 20,
        select: { id: true },
      });
      for (const m of msgs) {
        await this.relayVisitorMessage(m.id);
        const after = await this.prisma.assistSiteMessage.findUnique({
          where: { id: m.id },
          select: { relayedAt: true },
        });
        if (after?.relayedAt) n++;
      }
    }
    return n;
  }

  private async tickRemind(
    now: Date,
    where: Prisma.AssistSiteHandoffWhereInput,
  ): Promise<number> {
    const rows = await this.prisma.assistSiteHandoff.findMany({
      where: {
        ...where,
        state: { in: ['waiting', 'active'] },
        deliveredAt: { not: null },
      },
      orderBy: { requestedAt: 'asc' },
      take: TICK_BATCH,
      select: HANDOFF_ROW_SELECT,
    });
    const configs = await this.configs(rows.map((r) => r.siteId));
    let n = 0;
    for (const h of rows) {
      const cfg = configs.get(h.siteId) ?? effectiveHandoffConfig(null);
      if (h.reminders >= cfg.maxReminders) continue;
      // Ждёт ли посетитель: не взяли, или после взятия/последнего ответа
      // посетитель написал, а оператор — нет.
      const waitingSince =
        h.state === 'waiting'
          ? h.requestedAt
          : !h.firstReplyAt
            ? (h.takenAt ?? h.requestedAt)
            : h.lastVisitorAt &&
                (!h.lastOperatorAt || h.lastVisitorAt > h.lastOperatorAt)
              ? h.lastVisitorAt
              : null;
      if (!waitingSince) continue;
      const base =
        h.remindedAt && h.remindedAt > waitingSince
          ? h.remindedAt
          : waitingSince;
      if (now.getTime() - base.getTime() < cfg.remindAfterMinutes * 60_000) {
        continue;
      }
      const u = await this.prisma.assistSiteHandoff.updateMany({
        where: { id: h.id, reminders: h.reminders },
        data: { reminders: { increment: 1 }, remindedAt: now },
      });
      if (u.count !== 1) continue;
      const cards = parseCards(h.cards);
      const targets =
        h.state === 'active'
          ? cards.filter((c) => c.memberId === h.assignedMemberId)
          : cards;
      const direct =
        h.state === 'active' && !targets.length && h.assignedTelegramId
          ? [
              {
                memberId: h.assignedMemberId ?? '',
                chatId: h.assignedTelegramId.toString(),
                messageId: 0,
              },
            ]
          : [];
      const bot = this.bot();
      const text =
        h.state === 'waiting'
          ? '⏰ Посетитель всё ещё ждёт оператора. Нажмите «Взять» в карточке выше.'
          : '⏰ Посетитель ждёт ответа. Ответьте реплаем на это сообщение.';
      for (const c of await this.stillEligible(h.accountId, [
        ...targets,
        ...direct,
      ])) {
        const chatId = BigInt(c.chatId);
        const res = await bot.send({
          chatId,
          text,
          replyToMessageId: c.messageId || undefined,
        });
        if (res.code === 'blocked') await this.markBlocked(chatId);
        if (res.ok && res.messageId !== null) {
          await this.remember(
            chatId,
            res.messageId,
            h,
            'reminder',
            c.memberId || null,
          );
        }
      }
      n++;
    }
    return n;
  }

  private async tickIdleClose(
    now: Date,
    where: Prisma.AssistSiteHandoffWhereInput,
  ): Promise<number> {
    const rows = await this.prisma.assistSiteHandoff.findMany({
      where: { ...where, state: 'active' },
      orderBy: { updatedAt: 'asc' },
      take: TICK_BATCH,
      select: {
        id: true,
        siteId: true,
        conversationId: true,
        takenAt: true,
        requestedAt: true,
        lastOperatorAt: true,
        lastVisitorAt: true,
      },
    });
    const configs = await this.configs(rows.map((r) => r.siteId));
    let n = 0;
    for (const h of rows) {
      const cfg = configs.get(h.siteId) ?? effectiveHandoffConfig(null);
      const last = Math.max(
        ...[h.requestedAt, h.takenAt, h.lastOperatorAt, h.lastVisitorAt]
          .filter((d): d is Date => !!d)
          .map((d) => d.getTime()),
      );
      if (now.getTime() - last < cfg.idleCloseHours * 3_600_000) continue;
      const u = await this.prisma.assistSiteHandoff.updateMany({
        where: { id: h.id, state: 'active' },
        data: { state: 'closed', closedAt: now, closedBy: 'timeout' },
      });
      if (u.count !== 1) continue;
      n++;
      await this.prisma.assistSiteConversation.update({
        where: { id: h.conversationId },
        data: { handoffState: 'closed', stateVersion: { increment: 1 } },
        select: { id: true },
      });
      await this.refreshCards(h.id).catch(() => undefined);
      await this.afterClose(h.id);
    }
    return n;
  }

  /** Медиана «запрос → первый ответ оператора» за 7 дней (≥ etaMinSamples). */
  private async tickEta(now: Date, scope?: CronScope): Promise<number> {
    const since = new Date(now.getTime() - HANDOFF_DEFAULTS.etaWindowMs);
    const scoped = scope ? `AND s."siteId" = ANY($3::text[])` : '';
    const params: unknown[] = [since, HANDOFF_DEFAULTS.etaMinSamples];
    if (scope) params.push(scope.siteIds);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ siteId: string; eta: number | null; cur: number | null }>
    >(
      `SELECT s."siteId",
              s."handoffEtaMinutes" AS cur,
              CASE WHEN count(h."id") >= $2
                   THEN GREATEST(1, ceil(percentile_cont(0.5) WITHIN GROUP (
                          ORDER BY extract(epoch FROM h."firstReplyAt" - h."requestedAt")) / 60))::int
              END AS eta
         FROM "sites"."assist_sites" s
         LEFT JOIN "sites"."assist_site_handoffs" h
           ON h."siteId" = s."siteId" AND h."firstReplyAt" IS NOT NULL AND h."requestedAt" >= $1
        WHERE (s."handoffEtaMinutes" IS NOT NULL OR h."id" IS NOT NULL) ${scoped}
        GROUP BY s."siteId", s."handoffEtaMinutes"`,
      ...params,
    );
    let n = 0;
    for (const r of rows) {
      const eta = r.eta === null ? null : Number(r.eta);
      if (eta === (r.cur === null ? null : Number(r.cur))) continue;
      await this.prisma.assistSite.update({
        where: { siteId: r.siteId },
        data: { handoffEtaMinutes: eta },
        select: { id: true },
      });
      n++;
    }
    return n;
  }

  // ── внутреннее ────────────────────────────────────────────────────────

  /**
   * Карточки/взявший — только те, кто ВСЁ ЕЩЁ вправе работать с передачами
   * кабинета: удалённому участнику или оператору, у которого сняли права,
   * сообщения посетителя и напоминания больше не уходят (карточка в его
   * Telegram осталась, но новых реплик он видеть не должен).
   */
  private async stillEligible(
    accountId: string,
    refs: CardRef[],
  ): Promise<CardRef[]> {
    if (!refs.length) return refs;
    const ok = new Set(
      (await botRecipients(this.prisma, accountId)).map((r) => r.memberId),
    );
    return refs.filter((c) => ok.has(c.memberId));
  }

  async markBlocked(telegramId: bigint): Promise<void> {
    await this.prisma.assistBotUser
      .updateMany({ where: { telegramId }, data: { blockedAt: this.now() } })
      .catch(() => undefined);
    this.forgetRecipients();
  }

  async remember(
    chatId: bigint,
    messageId: number,
    h: Pick<HandoffRow, 'id' | 'accountId' | 'siteId' | 'conversationId'>,
    kind: string,
    memberId: string | null,
  ): Promise<void> {
    await this.prisma.assistBotMessage
      .upsert({
        where: { chatId_messageId: { chatId, messageId } },
        create: {
          chatId,
          messageId,
          accountId: h.accountId,
          siteId: h.siteId,
          kind,
          handoffId: h.id,
          conversationId: h.conversationId,
          memberId,
          expiresAt: new Date(
            this.now().getTime() + HANDOFF_DEFAULTS.botMessageTtlMs,
          ),
        },
        update: {},
      })
      .catch(() => undefined);
  }

  async row(id: string): Promise<HandoffRow | null> {
    return this.prisma.assistSiteHandoff.findUnique({
      where: { id },
      select: HANDOFF_ROW_SELECT,
    });
  }

  async siteOf(siteId: string): Promise<{
    name: string;
    handoffConfig: Prisma.JsonValue | null;
    timezone: string;
  } | null> {
    const [site, assist] = await Promise.all([
      this.prisma.site.findUnique({
        where: { id: siteId },
        select: { name: true },
      }),
      this.prisma.assistSite.findUnique({
        where: { siteId },
        select: { handoffConfig: true, timezone: true },
      }),
    ]);
    if (!site) return null;
    return {
      name: site.name,
      handoffConfig: assist?.handoffConfig ?? null,
      timezone: assist?.timezone ?? 'Europe/Kyiv',
    };
  }

  private async configs(
    siteIds: string[],
  ): Promise<Map<string, HandoffConfig>> {
    const ids = [...new Set(siteIds)];
    if (!ids.length) return new Map();
    const rows = await this.prisma.assistSite.findMany({
      where: { siteId: { in: ids } },
      select: { siteId: true, handoffConfig: true },
    });
    return new Map(
      rows.map((r) => [r.siteId, effectiveHandoffConfig(r.handoffConfig)]),
    );
  }

  private async verifyIdentity(h: HandoffRow): Promise<boolean | null> {
    const key = leadKey(this.env);
    if (!key || !h.identityEnc || !this.integrations) return null;
    const id = decryptIdentity(h.identityEnc, h.id, key);
    if (!id?.externalId || !id.userHash) return null;
    return this.integrations
      .verifyUserHash(h.siteId, id.externalId, id.userHash)
      .catch(() => null);
  }

  card(h: HandoffRow, siteName: string, state: CardState): string {
    return cardText({
      siteName,
      pageUrl: h.pageUrl,
      visitorLang: h.visitorLang,
      reason: h.reason,
      escalation: h.escalation,
      identity: h.identityEnc
        ? h.identityVerified
          ? 'verified'
          : 'claimed'
        : null,
      summary: parseSummary(h.summary),
      state,
    });
  }

  cardButtons(
    h: Pick<HandoffRow, 'id' | 'siteId' | 'conversationId'>,
    config: HandoffConfig,
    state: CardState,
  ): BotButton[][] {
    const open: BotButton[] = [
      {
        text: 'Открыть в TMA',
        webAppHashPath: `/sites/${h.siteId}/dialogs/${h.conversationId}`,
      },
    ];
    const tools: BotButton[] = [];
    if (config.draft)
      tools.push({ text: 'Черновик', callback: `h:draft:${h.id}` });
    if (config.templates.length) {
      tools.push({ text: 'Шаблон', callback: `h:tpl:${h.id}:l` });
    }
    if (state === 'waiting' || state === 'missed') {
      return [
        [{ text: 'Взять', callback: `h:take:${h.id}` }],
        ...(tools.length ? [tools] : []),
        open,
      ];
    }
    if (state === 'taken_by_me') {
      return [
        ...(tools.length ? [tools] : []),
        [{ text: 'Закрыть', callback: `h:close:${h.id}` }],
        open,
      ];
    }
    return [open];
  }
}
