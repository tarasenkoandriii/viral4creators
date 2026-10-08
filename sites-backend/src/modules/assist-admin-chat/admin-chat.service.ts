/**
 * Диалоги сотрудников «Админки» (ТЗ §5, §4-бис.8, §4-тер.6) — общие для
 * двух входов:
 *  - 7a, TMA: участник кабинета с `assistAdmin: owner|employee`
 *    (`employeeRef = tg:<telegramId>`); владелец — все включённые операции,
 *    сотрудник — роль `tmaEmployeeRole` (или только знания);
 *  - 7b, встраивание: сессия по employee-JWT (`employeeRef = jwt:<sub>`),
 *    роль — по карте ролей; неизвестная роль — только знания (§5.1).
 *
 * Состояние — по паре (сайт, сотрудник): последний диалог ≤ 8 ч находится
 * по `employeeRef` (§4-бис.8). Сообщения другого сотрудника этим путём не
 * достать: все выборки — с `employeeRef` текущего (приёмка §4-бис.10 п.8).
 *
 * Очередь обучения (контур (г), §4-тер.6): 👎 и «правильно так: …»,
 * отказы «не знаю», ошибки параметров и сбои инструментов — кандидаты в
 * assist_admin_learning_items; в знания их переносит только
 * `assistAdmin: owner` (экран «Обучение (сотрудники)»). Текст ответа,
 * построенного по данным API, в очередь не попадает (результаты
 * инструментов не становятся знаниями никогда).
 */
import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { maskSensitiveEcho } from '../../shared/assist-chat-core';
import { claimUnits, readState } from '../assist-billing/public/entitlements';
import { ASSIST_PLANS, siteDailyCapFromPlan } from '../assist-billing/plans';
import { DIALOG_BASE_UNITS, DIALOG_IDLE_MS } from '../assist-billing/units';
import {
  type AdminTurnReservation,
  adminBudgetRowMicroUsd,
  adminSpentToday,
  adminTurnEstimateMicroUsd,
  reserveAdminTurn,
  settleAdminTurn,
} from '../assist-admin-mode/admin-budget';
import {
  effectivePlatformCapMicroUsd,
  readWidgetPlatformSettings,
} from '../../common/platform-settings';
import { widgetPlatformDailyCapMicroUsd } from '../../config/widget-env';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import type { CallerCtx } from '../assist-admin-mode/connectors.service';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { questionLang } from '../assist-knowledge-core/answer/prompt';
import { AdminMemoService } from '../assist-admin-actions/admin-memo.service';
import {
  type ActorCtx,
  ProposalsService,
  type ProposalView,
} from '../assist-admin-actions/proposals.service';
import type { ActionLang } from '../assist-admin-actions/action-core';
import { AdminAnswerService, type TurnResult } from './admin-answer.service';
import { adminHistory } from './admin-prompt';

/** Диалог сотрудника продолжается, если последняя активность не старше 8 ч (§4-бис.8). */
export const ADMIN_CONVERSATION_IDLE_MS = 8 * 60 * 60 * 1000;
const HISTORY_TURNS = 6;

export interface EmployeeCtx {
  accountId: string;
  siteId: string;
  channel: 'embed' | 'tma';
  employeeRef: string;
  /** Внешний id для `X-V4C-Actor` (sub или telegramId). */
  actorExternal: string;
  /** Роль у заказчика (JWT) или роль кабинета (TMA) — для журнала и статистики. */
  customerRole: string | null;
  name: string | null;
  /** Роль помощника: `*` — все операции, null — только знания. */
  role: string | null;
}

export interface AdminMessageView {
  id: string;
  role: 'employee' | 'assistant';
  text: string;
  sources: Array<{ n: number; url: string | null; title: string | null }>;
  tools: Array<{
    operation: string;
    outcome: string;
    httpStatus: number | null;
  }>;
  answerPath: string | null;
  rating: number | null;
  createdAt: string;
  /** Э8: id карточки подтверждения при этом сообщении. */
  proposalId: string | null;
  /** Э8: сама карточка — в ответе `chat` (в `state` — массив `proposals`). */
  proposal?: ProposalView | null;
}

export interface AdminStateView {
  conversationId: string | null;
  version: number;
  messages: AdminMessageView[];
  employee: { name: string | null; role: string | null; tools: boolean };
  statsPerEmployee: boolean;
  /**
   * Э8: карточки этого сотрудника за 8 ч — незавершённые восстанавливаются
   * после перезагрузки с тем же сроком (§4-бис.5), исполненные — с итогом.
   */
  proposals: ProposalView[];
}

/** `?lang=` маршрута: uk/ru/en или null (тогда — по последнему вопросу). */
export function langParam(v: unknown): ActionLang | null {
  return v === 'uk' || v === 'ru' || v === 'en' ? v : null;
}

/** Сотрудник «Админки» → действующее лицо предложений (язык — по вопросу). */
export function actorOf(
  ctx: EmployeeCtx,
  conversationId: string | null,
  lang: ActionLang = 'uk',
): ActorCtx {
  return {
    accountId: ctx.accountId,
    siteId: ctx.siteId,
    actor: ctx.employeeRef,
    actorRole: ctx.customerRole,
    actorExternal: ctx.actorExternal,
    channel: ctx.channel,
    conversationId,
    assistRole: ctx.role,
    lang,
  };
}

/** Нормализованный вопрос → ключ кластера очереди (те же слова — один кластер). */
export function clusterKeyOf(question: string): string {
  const norm = question
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function view(r: {
  id: string;
  role: string;
  text: string;
  sources: Prisma.JsonValue;
  tools: Prisma.JsonValue;
  answerPath: string | null;
  rating: number | null;
  createdAt: Date;
  proposalId?: string | null;
}): AdminMessageView {
  return {
    id: r.id,
    role: r.role === 'employee' ? 'employee' : 'assistant',
    text: r.text,
    sources: Array.isArray(r.sources)
      ? (r.sources as AdminMessageView['sources'])
      : [],
    tools: Array.isArray(r.tools) ? (r.tools as AdminMessageView['tools']) : [],
    answerPath: r.answerPath,
    rating: r.rating,
    createdAt: r.createdAt.toISOString(),
    proposalId: r.proposalId ?? null,
  };
}

@Injectable()
export class AdminChatService {
  /** Тесты подменяют env (потолок платформы). */
  env: NodeJS.ProcessEnv = process.env;
  /** Оценка хода сверху (Р-З9-15); тесты — свою. */
  turnEstimateMicroUsd = adminTurnEstimateMicroUsd();

  constructor(
    private readonly db: SitesDb,
    private readonly prisma: PrismaService,
    private readonly mode: AdminModeService,
    private readonly answers: AdminAnswerService,
    private readonly proposals: ProposalsService,
    private readonly memos: AdminMemoService,
  ) {}

  /** 7a/7b общее: режим включён, тариф даёт «Админку», у сайта есть verified-хост. */
  async assertUsable(ctx: EmployeeCtx, now = new Date()) {
    const s = await this.mode.ensureSettings(ctx.accountId, ctx.siteId);
    const okAccess =
      ctx.channel === 'tma'
        ? s.adminAccess === 'tma' || s.adminAccess === 'both'
        : s.adminAccess === 'script' || s.adminAccess === 'both';
    if (!s.adminModeEnabled || !okAccess) {
      throw adminError(
        403,
        'ADMIN_MODE_OFF',
        'Помощник сотрудника на этом сайте выключен',
      );
    }
    if (!(await this.mode.planAllows(ctx.accountId, now))) {
      throw adminError(
        402,
        'ADMIN_PLAN_REQUIRED',
        '«Админка: чтение» — в тарифах Business и Pro',
      );
    }
    const hosts = await this.db
      .forAccount(ctx.accountId)
      .siteHost.findMany({ where: { siteId: ctx.siteId } });
    if (!hosts.some((h) => evaluateHostAccess(h, 'assist-admin', now).ok)) {
      throw adminError(
        409,
        'ADMIN_SITE_NOT_VERIFIED',
        'Нужен хотя бы один подтверждённый хост сайта',
      );
    }
    return s;
  }

  private async currentConversation(ctx: EmployeeCtx, now: Date) {
    return this.db.forAccount(ctx.accountId).assistAdminConversation.findFirst({
      where: {
        siteId: ctx.siteId,
        employeeRef: ctx.employeeRef,
        lastActivityAt: {
          gte: new Date(now.getTime() - ADMIN_CONVERSATION_IDLE_MS),
        },
      },
      orderBy: { lastActivityAt: 'desc' },
    });
  }

  async state(
    ctx: EmployeeCtx,
    now = new Date(),
    lang: ActionLang | null = null,
  ): Promise<AdminStateView> {
    const s = await this.assertUsable(ctx, now);
    const conv = await this.currentConversation(ctx, now);
    const msgs = conv
      ? await this.db.forAccount(ctx.accountId).assistAdminMessage.findMany({
          where: { conversationId: conv.id },
          orderBy: { createdAt: 'asc' },
          take: 200,
        })
      : [];
    // Аудит Э8 (5): язык подсказок карточек — явный `?lang=` или язык
    // последнего вопроса сотрудника (как у ответа хода), иначе uk.
    const lastQ = [...msgs].reverse().find((m) => m.role === 'employee');
    const cardLang: ActionLang =
      lang ?? (lastQ ? (questionLang(lastQ.text) as ActionLang) : 'uk');
    return {
      conversationId: conv?.id ?? null,
      version: conv?.stateVersion ?? 0,
      messages: msgs.slice(-50).map(view),
      employee: {
        name: ctx.name,
        role: ctx.customerRole,
        tools: ctx.role !== null,
      },
      statsPerEmployee: s.statsPerEmployee,
      proposals: await this.proposals.forState(
        ctx.accountId,
        ctx.siteId,
        ctx.employeeRef,
        now,
        cardLang,
      ),
    };
  }

  /**
   * Диалог тарифа (§7.1: 30 минут тишины — новый диалог) = единицы с весом
   * «Админки». Отказ — 402 до вызова модели.
   */
  private async claimDialog(ctx: EmployeeCtx, now: Date) {
    const st = await readState(this.prisma, ctx.accountId, now);
    if (!st.planId || !ASSIST_PLANS[st.planId].adminRead) {
      throw adminError(
        402,
        'ADMIN_PLAN_REQUIRED',
        '«Админка: чтение» — в тарифах Business и Pro',
      );
    }
    const ok = await claimUnits(this.prisma, {
      accountId: ctx.accountId,
      state: st,
      units: DIALOG_BASE_UNITS.admin,
      dialogs: 1,
    });
    if (!ok) {
      throw adminError(
        402,
        'ADMIN_LIMIT',
        'Лимит диалогов тарифа исчерпан — пополните пакет в TMA',
      );
    }
  }

  /**
   * Суточный денежный потолок «Админки» сайта (аудит Э7). Единица тарифа —
   * ДИАЛОГ (30 мин тишины), а вопросов в нём — до лимита частоты на `sub`
   * (120/ч); `sub` выдаёт бэкенд заказчика, так что сотрудник (или утёкший
   * секрет подписи) мог бы жечь модель без денежной границы. Потолок — тот
   * же, что у ответов «Сайта» по умолчанию (§7.3: себестоимость месячного
   * лимита тарифа / 10), но СВОЙ счётчик: сумма `costMicroUsd` ответов
   * сотрудников сайта за UTC-сутки плюс строка дня `admin/<siteId>`
   * (резервы ходов в полёте и оценки сорвавшихся ходов). Здесь — быстрая
   * проверка без резерва (голосовое управление, F); ход чата резервирует
   * (`reserveAdminTurn`, Р-З9-15).
   */
  async assertDailyBudget(ctx: EmployeeCtx, now: Date): Promise<void> {
    const st = await readState(this.prisma, ctx.accountId, now);
    const cap = siteDailyCapFromPlan(st.planId);
    // Э6-бис (б): голосовое управление «Админкой» — распознавание и планы
    // платят тот же суточный потолок (операции assist-admin-stt|ui-plan);
    // аудит Э6-бис (е): и lite-выбор мемо АМ-N (assist-admin-memo).
    const spent =
      (await adminSpentToday(
        this.db.forAccount(ctx.accountId),
        ctx.siteId,
        now,
      )) + (await adminBudgetRowMicroUsd(this.prisma, ctx.siteId, now));
    if (spent >= cap) {
      throw adminError(
        429,
        'ADMIN_DAILY_BUDGET',
        'Суточный лимит помощника сотрудников исчерпан — продолжим завтра',
      );
    }
  }

  /**
   * Э6-бис (б): ход голосового управления — тот же диалог сотрудника и те
   * же единицы тарифа (30 мин тишины — новый диалог), суточный потолок
   * денег «Админки» — до вызова модели.
   */
  async openTurn(ctx: EmployeeCtx, now = new Date()): Promise<string> {
    await this.assertUsable(ctx, now);
    await this.assertDailyBudget(ctx, now);
    let conv = await this.currentConversation(ctx, now);
    if (
      conv &&
      now.getTime() - conv.lastActivityAt.getTime() > DIALOG_IDLE_MS
    ) {
      await this.claimDialog(ctx, now);
    }
    conv ??= await this.openConversation(ctx, now);
    return conv.id;
  }

  /**
   * Э6-бис (б): команда сотрудника и итог плана — сообщения его диалога
   * (видны после перезагрузки; деньги плана — в `costMicroUsd` ответа не
   * пишутся: они в site_ai_usage и в потолке выше).
   */
  async recordTurn(
    ctx: EmployeeCtx,
    conversationId: string,
    question: string,
    answer: string,
    opts: { proposalId?: string | null; flags?: string[]; now?: Date } = {},
  ): Promise<void> {
    const now = opts.now ?? new Date();
    const db = this.db.forAccount(ctx.accountId);
    if (question)
      await db.assistAdminMessage.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          conversationId,
          role: 'employee',
          text: maskSensitiveEcho(question).slice(0, 4000),
          flags: ['voice-control'],
          createdAt: now,
        },
      });
    if (answer)
      await db.assistAdminMessage.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          conversationId,
          role: 'assistant',
          text: answer.slice(0, 4000),
          flags: opts.flags ?? ['voice-control'],
          answerPath: opts.proposalId ? 'action' : 'tool',
          proposalId: opts.proposalId ?? null,
          createdAt: new Date(now.getTime() + 1),
        },
      });
    await db.assistAdminConversation.update({
      where: { id: conversationId },
      data: { lastActivityAt: now, stateVersion: { increment: 1 } },
      select: { id: true },
    });
  }

  private async openConversation(ctx: EmployeeCtx, now: Date) {
    await this.claimDialog(ctx, now);
    return this.db.forAccount(ctx.accountId).assistAdminConversation.create({
      data: {
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        employeeRef: ctx.employeeRef,
        channel: ctx.channel,
        employeeRole: ctx.customerRole,
        employeeName: ctx.name,
        lastActivityAt: now,
      },
    });
  }

  async ask(
    ctx: EmployeeCtx,
    question: string,
    clientRequestId: string | null,
    now = new Date(),
  ): Promise<{
    question: AdminMessageView;
    answer: AdminMessageView;
    version: number;
  }> {
    const s = await this.assertUsable(ctx, now);
    const q = question
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .trim();
    if (!q) throw adminError(400, 'MESSAGE_NOT_FOUND', 'Пустой вопрос');
    const db = this.db.forAccount(ctx.accountId);
    let conv = await this.currentConversation(ctx, now);

    // Повтор того же вопроса (перезагрузка, сеть) — тот же ответ, без модели.
    if (conv && clientRequestId) {
      const prev = await db.assistAdminMessage.findFirst({
        where: { conversationId: conv.id, clientRequestId },
      });
      if (prev) {
        const ans = await db.assistAdminMessage.findFirst({
          where: {
            conversationId: conv.id,
            role: 'assistant',
            createdAt: { gte: prev.createdAt },
          },
          orderBy: { createdAt: 'asc' },
        });
        if (ans)
          return {
            question: view(prev),
            answer: view(ans),
            version: conv.stateVersion,
          };
      }
    }
    // Р-З9-15: резерв хода «сайт + платформа» ДО модели (одна транзакция);
    // снимается после записи ответа (finally ниже), сбой — держится.
    const reservation = await this.reserveTurn(ctx, now);
    let actual: number | null = null;
    let modelStarted = false;
    try {
      if (
        conv &&
        now.getTime() - conv.lastActivityAt.getTime() > DIALOG_IDLE_MS
      ) {
        await this.claimDialog(ctx, now);
      }
      conv ??= await this.openConversation(ctx, now);
      // Р-З9-19: роли с инструментами/действиями — без ответов по данным API.
      const history = adminHistory(
        (
          await db.assistAdminMessage.findMany({
            where: { conversationId: conv.id },
            orderBy: { createdAt: 'desc' },
            take: HISTORY_TURNS,
            select: { role: true, text: true, answerPath: true },
          })
        ).reverse(),
        ctx.role !== null,
      );
      const qRow = await db.assistAdminMessage.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          conversationId: conv.id,
          role: 'employee',
          text: q.slice(0, 4000),
          flags: [],
          clientRequestId,
          createdAt: now,
        },
      });
      const site = await db.site.findFirst({
        where: { id: ctx.siteId },
        select: { name: true },
      });
      const caller: CallerCtx = {
        accountId: ctx.accountId,
        siteId: ctx.siteId,
        actor: ctx.employeeRef,
        actorRole: ctx.customerRole,
        actorExternal: ctx.actorExternal,
        channel: ctx.channel,
        conversationId: conv.id,
      };
      // Э8: мемо АМ-N (по номеру или фразе) — прямой путь без модели (§5-бис.17
      // п.10, Р-68); права сотрудника — на каждую операцию мемо.
      const lang = questionLang(q) as ActionLang;
      const actor = actorOf(ctx, conv.id, lang);
      modelStarted = true;
      const memo = ctx.role !== null ? await this.memos.match(actor, q) : null;
      let turn: TurnResult;
      if (memo) {
        const r =
          memo.kind === 'memo'
            ? await this.memos.start(actor, memo, now)
            : {
                text: this.memos.unknownText(lang, memo.number),
                proposal: null,
              };
        turn = {
          text: r.text,
          sources: [],
          tools: [],
          answerPath: r.proposal ? 'action' : 'tool',
          flags: [memo.kind === 'memo' ? 'memo' : 'memo_missing'],
          model: null,
          inTokens: 0,
          outTokens: 0,
          costMicroUsd: 0,
          learning: null,
          proposal: r.proposal,
        };
      } else {
        turn = await this.answers.turn({
          ctx: caller,
          role: ctx.role,
          question: q,
          history,
          siteName: site?.name ?? null,
          instructions: s.instructions,
        });
      }
      const aRow = await db.assistAdminMessage.create({
        data: {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          conversationId: conv.id,
          role: 'assistant',
          text: turn.text,
          sources: turn.sources as unknown as Prisma.InputJsonValue,
          tools: turn.tools as unknown as Prisma.InputJsonValue,
          flags: turn.flags,
          answerPath: turn.answerPath,
          model: turn.model,
          inTokens: turn.inTokens,
          outTokens: turn.outTokens,
          costMicroUsd: turn.costMicroUsd,
          proposalId: turn.proposal?.id ?? null,
          createdAt: new Date(now.getTime() + 1),
        },
      });
      const updated = await db.assistAdminConversation.update({
        where: { id: conv.id },
        data: { lastActivityAt: now, stateVersion: { increment: 1 } },
        select: { stateVersion: true },
      });
      if (turn.learning) {
        await this.enqueue(ctx, {
          kind: turn.learning,
          conversationId: conv.id,
          messageId: aRow.id,
          question: q,
          answer: turn.answerPath === 'tool' ? null : turn.text,
        });
      }
      actual = turn.costMicroUsd;
      return {
        question: view(qRow),
        answer: { ...view(aRow), proposal: turn.proposal },
        version: updated.stateVersion,
      };
    } finally {
      // Резерв снимается всегда (аудит пакета C): ход записан — факт из
      // costMicroUsd ответа; отказ до модели (402 тарифа и т. п.) — 0; сбой
      // ПОСЛЕ начала хода — оценка переносится в spent (деньги, вероятно,
      // потрачены, а в ответ не записаны).
      await settleAdminTurn(
        this.prisma,
        reservation,
        actual !== null ? actual : modelStarted ? null : 0,
      ).catch(() => undefined);
    }
  }

  /**
   * Резерв хода (Р-З9-15): потолок сайта — `siteDailyCapFromPlan`, факт дня
   * читается ВНУТРИ транзакции резерва под блокировкой строки дня
   * (`reserveAdminTurn`), потолок платформы — тот же, что у «Сайта» (env +
   * настройка админки платформы). Отказ — 429 `ADMIN_DAILY_BUDGET` до модели.
   */
  private async reserveTurn(
    ctx: EmployeeCtx,
    now: Date,
  ): Promise<AdminTurnReservation> {
    const st = await readState(this.prisma, ctx.accountId, now);
    const r = await reserveAdminTurn(this.prisma, {
      siteId: ctx.siteId,
      siteCapMicroUsd: siteDailyCapFromPlan(st.planId),
      platformCapMicroUsd: effectivePlatformCapMicroUsd(
        widgetPlatformDailyCapMicroUsd(this.env),
        await readWidgetPlatformSettings(this.prisma),
      ),
      estMicroUsd: this.turnEstimateMicroUsd,
      now,
    });
    if (!r.ok) {
      throw adminError(
        429,
        'ADMIN_DAILY_BUDGET',
        'Суточный лимит помощника сотрудников исчерпан — продолжим завтра',
      );
    }
    return r.reservation;
  }

  private async enqueue(
    ctx: EmployeeCtx,
    p: {
      kind: string;
      conversationId: string;
      messageId: string;
      question: string;
      answer: string | null;
      proposed?: string | null;
    },
  ) {
    await this.db.forAccount(ctx.accountId).assistAdminLearningItem.createMany({
      data: [
        {
          accountId: ctx.accountId,
          siteId: ctx.siteId,
          conversationId: p.conversationId,
          messageId: p.messageId,
          kind: p.kind,
          employeeRef: ctx.employeeRef,
          questionMasked: maskSensitiveEcho(p.question).slice(0, 2000),
          answerMasked: p.answer
            ? maskSensitiveEcho(p.answer).slice(0, 2000)
            : null,
          proposedAnswer: p.proposed ? p.proposed.slice(0, 2000) : null,
          clusterKey: clusterKeyOf(p.question),
        },
      ],
      skipDuplicates: true,
    });
  }

  /**
   * 👍/👎 и «правильно так: …» сотрудника (§4-тер.6): кандидат в очередь
   * «Админки», не знание. Сообщение — только из СВОЕГО диалога.
   */
  async feedback(
    ctx: EmployeeCtx,
    messageId: string,
    rating: 1 | -1,
    correction: string | null,
    now = new Date(),
  ): Promise<{ ok: true }> {
    await this.assertUsable(ctx, now);
    const db = this.db.forAccount(ctx.accountId);
    const msg = await db.assistAdminMessage.findFirst({
      where: {
        id: messageId,
        siteId: ctx.siteId,
        role: 'assistant',
        conversation: { employeeRef: ctx.employeeRef },
      },
    });
    if (!msg)
      throw adminError(404, 'MESSAGE_NOT_FOUND', 'Сообщение не найдено');
    await db.assistAdminMessage.updateMany({
      where: { id: msg.id },
      data: { rating },
    });
    if (rating === 1 && !correction) return { ok: true };
    const q = await db.assistAdminMessage.findFirst({
      where: {
        conversationId: msg.conversationId,
        role: 'employee',
        createdAt: { lte: msg.createdAt },
      },
      orderBy: { createdAt: 'desc' },
    });
    const question = q?.text ?? '';
    const answer = msg.answerPath === 'tool' ? null : msg.text;
    if (rating === -1) {
      await this.enqueue(ctx, {
        kind: 'thumbs_down',
        conversationId: msg.conversationId,
        messageId: msg.id,
        question,
        answer,
      });
    }
    const fix = correction?.trim();
    if (fix) {
      await this.enqueue(ctx, {
        kind: 'employee_fix',
        conversationId: msg.conversationId,
        messageId: msg.id,
        question,
        answer,
        proposed: fix,
      });
    }
    return { ok: true };
  }
}
