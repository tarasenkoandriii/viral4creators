/**
 * Действия оператора — H (ТЗ §3.7 п.3–4; приёмка Э3 «два оператора жмут
 * „Взять“ одновременно — диалог получает один»). Общие для бота (callback,
 * реплай) и TMA (маршруты cabinet/). Основная роль.
 *
 *  - take: ОДИН условный UPDATE `state='waiting' → 'active', assigned…`
 *    (`WHERE id AND state='waiting'`), count = 1 — взял; иначе
 *    `already_taken`. Остальным карточкам — правка «Взял(а) …» (без имени
 *    посетителя). Права: owner | assist: manager | operator кабинета сайта.
 *  - reply: только взявший (или manager/owner — «перехват» с записью
 *    assignedMemberId); перевод на язык посетителя (№12, оригинал — в
 *    translation), сообщение role=operator в assist_site_messages,
 *    `stateVersion + 1` диалога (посетитель видит опросом ≤ 3 с — W),
 *    firstReplyAt; в бот — кнопка «Предложить как проверенный ответ» (L).
 *  - close / regenerateDraft.
 *
 * Уточнения H:
 *  - «Взять» работает и для `missed` (оператор увидел карточку позже —
 *    посетитель прочтёт ответ при возвращении, §3.7 п.5): тот же условный
 *    UPDATE с `state IN ('waiting','missed')`;
 *  - ответ в waiting/missed сначала берёт передачу (реплай на карточку без
 *    «Взять» — обычное поведение операторов);
 *  - кнопку «Предложить как проверенный» шлёт бот (AssistBotUpdates) после
 *    ответа реплаем; из TMA кандидат предлагается экраном очереди (L).
 */
import { HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { HANDOFF_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  parseAccountRole,
  OWNER_PRODUCT_ROLES,
  parseProductRoles,
  type AccountMembership,
} from '../../site-core/account/roles';
import type {
  HandoffDraft,
  OperatorReplyRequest,
  OperatorReplyResult,
  TakeResult,
} from '../api-types';
import { effectiveHandoffConfig } from '../public/handoff-config';
import {
  HANDOFF_ROW_SELECT,
  canOperate,
  handoffError,
  handoffNotFound,
  isAssistManager,
  toHandoffView,
  type HandoffRow,
} from './handoff-common';
import { HandoffAi } from './handoff-ai';
import { HandoffDispatcher } from './handoff-dispatcher.service';

/** Кто действует: участник из TMA (гвард) или из бота (по telegramId → участник кабинета сайта). */
export type OperatorActor =
  | { via: 'tma'; membership: AccountMembership }
  | { via: 'bot'; telegramId: bigint };

@Injectable()
export class HandoffOperatorActions {
  private readonly logger = new Logger(HandoffOperatorActions.name);
  now: () => Date = () => new Date();

  constructor(
    readonly prisma: PrismaService,
    @Optional() readonly ai?: HandoffAi,
    @Optional() readonly dispatcher?: HandoffDispatcher,
  ) {}

  /** Участник кабинета передачи с правом на передачи; иначе 404/403. */
  async resolve(
    actor: OperatorActor,
    handoffId: string,
  ): Promise<{ h: HandoffRow; m: AccountMembership }> {
    const h = await this.prisma.assistSiteHandoff.findUnique({
      where: { id: handoffId },
      select: HANDOFF_ROW_SELECT,
    });
    if (!h) throw handoffNotFound();
    let m: AccountMembership | null = null;
    if (actor.via === 'tma') {
      // Чужой кабинет — «не найдено», а не «нет прав» (не оракул чужих id).
      if (actor.membership.accountId !== h.accountId) throw handoffNotFound();
      m = actor.membership;
    } else {
      const row = await this.prisma.siteAccountMember.findFirst({
        where: { accountId: h.accountId, telegramId: actor.telegramId },
        select: { id: true, telegramId: true, role: true, productRoles: true },
      });
      const role = row ? parseAccountRole(row.role) : null;
      if (!row || !role) throw handoffNotFound();
      m = {
        accountId: h.accountId,
        memberId: row.id,
        telegramId: row.telegramId,
        role,
        productRoles:
          role === 'owner'
            ? { ...OWNER_PRODUCT_ROLES }
            : parseProductRoles(row.productRoles),
      };
    }
    if (!canOperate(m)) {
      throw handoffError(
        'FORBIDDEN',
        'Нет прав отвечать посетителям этого сайта',
        HttpStatus.FORBIDDEN,
      );
    }
    return { h, m };
  }

  async take(actor: OperatorActor, handoffId: string): Promise<TakeResult> {
    const { m } = await this.resolve(actor, handoffId);
    const now = this.now();
    const won = await this.prisma.assistSiteHandoff
      .updateMany({
        where: { id: handoffId, state: { in: ['waiting', 'missed'] } },
        data: {
          state: 'active',
          assignedMemberId: m.memberId,
          assignedTelegramId: m.telegramId,
          takenAt: now,
          lockedUntil: null,
        },
      })
      .catch((e: unknown) => {
        // Пропущенную взять нельзя, если посетитель уже позвал человека
        // снова (одна открытая передача на диалог — 23505): это «не ждёт»,
        // а не сбой «попробуйте ещё раз».
        if ((e as { code?: string } | null)?.code === 'P2002') {
          return { count: 0 };
        }
        throw e;
      });
    const h = (await this.prisma.assistSiteHandoff.findUnique({
      where: { id: handoffId },
      select: HANDOFF_ROW_SELECT,
    })) as HandoffRow;
    if (won.count === 1) {
      await this.prisma.assistSiteConversation.update({
        where: { id: h.conversationId },
        data: { handoffState: 'active', stateVersion: { increment: 1 } },
        select: { id: true },
      });
      this.logger.log(`передача ${handoffId}: взята`);
      await this.dispatcher?.refreshCards(handoffId).catch(() => undefined);
      return { result: 'taken', handoff: toHandoffView(h, m) };
    }
    if (h.state === 'active') {
      return {
        result: h.assignedMemberId === m.memberId ? 'taken' : 'already_taken',
        handoff: toHandoffView(h, m),
      };
    }
    return { result: 'not_waiting', handoff: toHandoffView(h, m) };
  }

  async reply(
    actor: OperatorActor,
    handoffId: string,
    body: OperatorReplyRequest,
  ): Promise<OperatorReplyResult> {
    const original = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!original || original.length > HANDOFF_DEFAULTS.replyMaxChars) {
      throw handoffError(
        'REPLY_INVALID',
        `Ответ — от 1 до ${HANDOFF_DEFAULTS.replyMaxChars} символов`,
        HttpStatus.BAD_REQUEST,
      );
    }
    const r0 = await this.resolve(actor, handoffId);
    const m = r0.m;
    let h = r0.h;
    if (h.state === 'closed' || h.state === 'cancelled') {
      throw handoffError(
        'HANDOFF_CLOSED',
        'Передача закрыта — посетитель больше не ждёт ответа здесь',
        HttpStatus.CONFLICT,
      );
    }
    if (h.state === 'waiting' || h.state === 'missed') {
      await this.take(actor, handoffId);
      h = (await this.prisma.assistSiteHandoff.findUnique({
        where: { id: handoffId },
        select: HANDOFF_ROW_SELECT,
      })) as HandoffRow;
    }
    if (h.state !== 'active') {
      throw handoffError(
        'HANDOFF_CLOSED',
        'Передача закрыта',
        HttpStatus.CONFLICT,
      );
    }
    if (h.assignedMemberId !== m.memberId) {
      if (!isAssistManager(m)) {
        throw handoffError(
          'HANDOFF_NOT_ASSIGNED',
          'Диалог взял другой оператор',
          HttpStatus.FORBIDDEN,
        );
      }
      // Перехват менеджером/владельцем — условно, чтобы не затереть закрытие.
      const took = await this.prisma.assistSiteHandoff.updateMany({
        where: { id: handoffId, state: 'active' },
        data: {
          assignedMemberId: m.memberId,
          assignedTelegramId: m.telegramId,
        },
      });
      if (took.count !== 1) {
        throw handoffError(
          'HANDOFF_CLOSED',
          'Передача закрыта',
          HttpStatus.CONFLICT,
        );
      }
      await this.dispatcher?.refreshCards(handoffId).catch(() => undefined);
    }

    const site = await this.prisma.assistSite.findUnique({
      where: { siteId: h.siteId },
      select: { handoffConfig: true },
    });
    const config = effectiveHandoffConfig(site?.handoffConfig);
    const operatorLang = h.operatorLang ?? config.operatorLang;
    const visitorLang = h.visitorLang;
    let text = original;
    let translated = false;
    if (
      !body.noTranslate &&
      config.translate &&
      visitorLang &&
      visitorLang !== operatorLang &&
      this.ai
    ) {
      const tr = await this.ai
        .translate({
          accountId: h.accountId,
          siteId: h.siteId,
          text: original,
          from: operatorLang,
          to: visitorLang,
        })
        .catch(() => ({ text: original, translated: false }));
      text = tr.text;
      translated = tr.translated;
    }
    const now = this.now();
    const id = randomUUID();
    // Голос бизнеса — как написан (телефон магазина не маскируется, О-5).
    await this.prisma.assistSiteMessage.create({
      data: {
        id,
        accountId: h.accountId,
        siteId: h.siteId,
        conversationId: h.conversationId,
        role: 'operator',
        text,
        lang: translated ? visitorLang : (visitorLang ?? operatorLang),
        translation: translated
          ? ({ lang: operatorLang, text: original } as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        authorMemberId: m.memberId,
        streamState: 'complete',
        streamOffset: text.length,
        flags: [],
        createdAt: now,
      },
      select: { id: true },
    });
    await this.prisma.assistSiteHandoff.update({
      where: { id: handoffId },
      data: {
        firstReplyAt: h.firstReplyAt ?? now,
        lastOperatorAt: now,
      },
      select: { id: true },
    });
    await this.prisma.assistSiteConversation.update({
      where: { id: h.conversationId },
      data: { stateVersion: { increment: 1 }, lastMessageAt: now },
      select: { id: true },
    });
    this.logger.log(`передача ${handoffId}: ответ оператора ${id}`);
    return { messageId: id, sentText: text, translated };
  }

  async close(actor: OperatorActor, handoffId: string): Promise<void> {
    const { h, m } = await this.resolve(actor, handoffId);
    // Чужую взятую передачу закрывает только manager/owner.
    if (
      h.state === 'active' &&
      h.assignedMemberId !== m.memberId &&
      !isAssistManager(m)
    ) {
      throw handoffError(
        'HANDOFF_NOT_ASSIGNED',
        'Диалог взял другой оператор',
        HttpStatus.FORBIDDEN,
      );
    }
    const u = await this.prisma.assistSiteHandoff.updateMany({
      where: { id: handoffId, state: { in: ['waiting', 'active', 'missed'] } },
      data: {
        state: 'closed',
        closedAt: this.now(),
        closedBy: 'operator',
        lockedUntil: null,
      },
    });
    if (u.count !== 1) return;
    await this.prisma.assistSiteConversation.update({
      where: { id: h.conversationId },
      data: { handoffState: 'closed', stateVersion: { increment: 1 } },
      select: { id: true },
    });
    this.logger.log(`передача ${handoffId}: закрыта оператором`);
    if (this.dispatcher) {
      await this.dispatcher.refreshCards(handoffId).catch(() => undefined);
      await this.dispatcher.afterClose(handoffId);
    }
  }

  async regenerateDraft(
    actor: OperatorActor,
    handoffId: string,
  ): Promise<HandoffDraft | null> {
    const { h } = await this.resolve(actor, handoffId);
    if (h.state === 'closed' || h.state === 'cancelled') {
      throw handoffError(
        'HANDOFF_CLOSED',
        'Передача закрыта',
        HttpStatus.CONFLICT,
      );
    }
    const draft = this.ai
      ? await this.ai.draft(handoffId).catch(() => null)
      : null;
    await this.prisma.assistSiteHandoff.update({
      where: { id: handoffId },
      data: {
        draft: draft
          ? (draft as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
      select: { id: true },
    });
    return draft;
  }
}
