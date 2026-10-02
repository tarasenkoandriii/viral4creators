/**
 * Приём передачи человеку от посетителя — H (ТЗ §3.7 п.1–2, п.5–6).
 * ПУБЛИЧНЫЙ код (папка public/ — правило графа `public-db`): только
 * AssistPublicDb, по siteId/visitorId из ПРОВЕРЕННОГО токена (W). Кому
 * слать карточку, решает системный код: после записи — `dispatcher.dispatch(id)`
 * по id (как лид Э2 → LeadDelivery), ожидание ≤ HANDOFF_DISPATCH_WAIT_MS,
 * дальше — крон `assist-handoff-tick`.
 *
 * Порядок `request`:
 *  1. диалог — только свой (siteId + visitorId), иначе `no_conversation`;
 *  2. availability: включено, рабочие часы (пояс сайта), есть хотя бы один
 *     участник `owner|assist:manager|operator` с ботом (Start, не 403) —
 *     иначе `{ mode: 'lead', reason }` (сразу форма заявки, §3.7 п.2);
 *  3. условный UPDATE диалога `handoffState` → waiting + createMany передачи
 *     (частичный уникальный индекс: вторая открытая на диалог — 23505 →
 *     вернуть уже открытую, не ошибка);
 *  4. identify — шифром (lead-crypto), только здесь (К-3);
 *  5. dispatch по id.
 * В лог — только id и коды (§6.6).
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { questionLang } from '../../assist-knowledge-core/answer/prompt';
import type {
  WidgetIdentity,
  WidgetSiteContext,
  WidgetVisitor,
} from '../../assist-site-chat/chat-types';
import { leadKey } from '../../assist-site-chat/lead-crypto';
import { LearningSignals } from '../../assist-site-learning/public/learning-signals';
import type { EscalationKind, HandoffState } from '../api-types';
import { detectEscalation } from '../escalation';
import { HandoffDispatcher } from '../system/handoff-dispatcher.service';
import { effectiveHandoffConfig, isWithinHours } from './handoff-config';
import { encryptIdentity, hasIdentity } from './identity-crypto';

/** Сколько ждать рассылки карточек в запросе посетителя (остальное — крон). */
export const HANDOFF_DISPATCH_WAIT_MS = 5_000;

export type HandoffUnavailableReason =
  'disabled' | 'off_hours' | 'no_operators' | 'no_conversation';

export interface HandoffAvailability {
  available: boolean;
  reason: Exclude<HandoffUnavailableReason, 'no_conversation'> | null;
  /** Медиана (assist_sites.handoffEtaMinutes) или null — тогда etaText. */
  etaMinutes: number | null;
  etaText: Partial<Record<'uk' | 'ru' | 'en', string>>;
}

export interface HandoffRequestInput {
  site: WidgetSiteContext;
  visitor: WidgetVisitor;
  conversationId: string | null;
  reason: 'visitor' | 'scenario' | 'escalation';
  escalation?: EscalationKind | null;
  uiLang: 'uk' | 'ru' | 'en' | null;
  pageUrl: string | null;
  identity: WidgetIdentity | null;
  now?: Date;
}

/** Видимое посетителю состояние передачи (WidgetStateView.handoff, W). */
export interface VisitorHandoffView {
  id: string;
  state: HandoffState;
  requestedAt: string;
  takenAt: string | null;
  /** Когда посетитель увидит форму заявки, если никто не взял. */
  timeoutAt: string;
}

export type HandoffRequestResult =
  | {
      mode: 'human';
      handoff: VisitorHandoffView;
      etaMinutes: number | null;
      /** Передача уже была открыта (повторное нажатие) — та же. */
      existing: boolean;
    }
  | { mode: 'lead'; reason: HandoffUnavailableReason };

const LANGS = new Set(['uk', 'ru', 'en']);
/** Видимость закрытой/пропущенной передачи посетителю (§3.7 п.5). */
const VISITOR_VIEW_MS = 24 * 60 * 60 * 1000;

/** Страница — без query и фрагмента, только http(s) (§6.6). */
function bareUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return null;
  }
}

function isUniqueViolation(e: unknown): boolean {
  const o = e as { code?: string; message?: string; meta?: unknown } | null;
  return (
    o?.code === 'P2002' ||
    /23505|unique constraint/i.test(String(o?.message ?? '')) ||
    /23505/.test(JSON.stringify(o?.meta ?? null))
  );
}

interface HandoffPublicRow {
  id: string;
  state: string;
  requestedAt: Date;
  takenAt: Date | null;
  timeoutAt: Date;
  missedAt: Date | null;
  closedAt: Date | null;
}

const PUBLIC_SELECT = {
  id: true,
  state: true,
  requestedAt: true,
  takenAt: true,
  timeoutAt: true,
  missedAt: true,
  closedAt: true,
} as const;

function toVisitorView(h: HandoffPublicRow): VisitorHandoffView {
  return {
    id: h.id,
    state: h.state as HandoffState,
    requestedAt: h.requestedAt.toISOString(),
    takenAt: h.takenAt?.toISOString() ?? null,
    timeoutAt: h.timeoutAt.toISOString(),
  };
}

@Injectable()
export class HandoffIntake {
  private readonly logger = new Logger(HandoffIntake.name);
  /** env — ключ шифра identify (тесты подменяют). */
  env: NodeJS.ProcessEnv = process.env;
  /** Ожидание рассылки в запросе посетителя (тесты укорачивают). */
  dispatchWaitMs = HANDOFF_DISPATCH_WAIT_MS;

  constructor(
    readonly db: AssistPublicDb,
    readonly dispatcher: HandoffDispatcher,
    @Optional() readonly signals?: LearningSignals,
  ) {}

  private async siteRow(siteId: string) {
    return this.db.assistSite.findUnique({
      where: { siteId },
      select: {
        enabled: true,
        handoffConfig: true,
        handoffEtaMinutes: true,
        timezone: true,
      },
    });
  }

  /** Доступна ли передача сайту сейчас (без записи). */
  async availability(
    site: WidgetSiteContext,
    now: Date = new Date(),
  ): Promise<HandoffAvailability> {
    const row = await this.siteRow(site.siteId);
    const config = effectiveHandoffConfig(row?.handoffConfig);
    const base = {
      etaMinutes: row?.handoffEtaMinutes ?? null,
      etaText: config.etaText,
    };
    if (!row || !config.enabled) {
      return { available: false, reason: 'disabled', ...base };
    }
    if (!isWithinHours(config, row.timezone, now)) {
      return { available: false, reason: 'off_hours', ...base };
    }
    // Кому писать — решает системный код по id кабинета (telegramId роли не видны).
    if (!(await this.dispatcher.hasRecipients(site.accountId))) {
      return { available: false, reason: 'no_operators', ...base };
    }
    return { available: true, reason: null, ...base };
  }

  /** «Позвать человека» (кнопка, сценарий, правило эскалации). */
  async request(input: HandoffRequestInput): Promise<HandoffRequestResult> {
    const now = input.now ?? new Date();
    const { site, visitor } = input;
    // Предпросмотр конфигуратора — не к живым операторам (владелец видит форму).
    if (site.preview) return { mode: 'lead', reason: 'disabled' };
    if (!input.conversationId) {
      return { mode: 'lead', reason: 'no_conversation' };
    }
    const conv = await this.db.assistSiteConversation.findFirst({
      where: {
        id: input.conversationId,
        siteId: site.siteId,
        visitorId: visitor.visitorId,
      },
      select: { id: true, suspicious: true },
    });
    if (!conv) return { mode: 'lead', reason: 'no_conversation' };
    const open = await this.openRow(site.siteId, conv.id);
    if (open) {
      return {
        mode: 'human',
        handoff: toVisitorView(open),
        etaMinutes:
          (await this.siteRow(site.siteId))?.handoffEtaMinutes ?? null,
        existing: true,
      };
    }
    const avail = await this.availability(site, now);
    if (!avail.available) {
      return { mode: 'lead', reason: avail.reason ?? 'disabled' };
    }
    const config = effectiveHandoffConfig(
      (await this.siteRow(site.siteId))?.handoffConfig,
    );
    const id = randomUUID();
    const visitorLang = await this.visitorLang(conv.id, input.uiLang);
    const key = leadKey(this.env);
    const identityEnc =
      key && hasIdentity(input.identity)
        ? encryptIdentity(input.identity as WidgetIdentity, id, key)
        : null;
    const timeoutAt = new Date(now.getTime() + config.waitMinutes * 60_000);
    try {
      await this.db.assistSiteHandoff.createMany({
        data: [
          {
            id,
            accountId: site.accountId,
            siteId: site.siteId,
            conversationId: conv.id,
            state: 'waiting',
            reason: input.reason,
            escalation: input.escalation ?? null,
            visitorLang,
            pageUrl: bareUrl(input.pageUrl),
            identityEnc,
            requestedAt: now,
            timeoutAt,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
    } catch (e) {
      // Вторая открытая передача на диалог (частичный уникальный индекс) — та же.
      if (isUniqueViolation(e)) {
        const again = await this.openRow(site.siteId, conv.id);
        if (again) {
          return {
            mode: 'human',
            handoff: toVisitorView(again),
            etaMinutes: avail.etaMinutes,
            existing: true,
          };
        }
      }
      throw e;
    }
    await this.db.assistSiteConversation.update({
      where: { id: conv.id },
      data: {
        handoffState: 'waiting',
        outcome: 'handoff',
        stateVersion: { increment: 1 },
      },
      select: { id: true },
    });
    this.logger.log(
      `передача ${id}: запрошена (${input.reason}, site ${site.siteId})`,
    );
    await this.afterAnswerSignal(site, visitor, conv.id, conv.suspicious);
    await this.waitDispatch(this.dispatcher.dispatch(id));
    return {
      mode: 'human',
      handoff: {
        id,
        state: 'waiting',
        requestedAt: now.toISOString(),
        takenAt: null,
        timeoutAt: timeoutAt.toISOString(),
      },
      etaMinutes: avail.etaMinutes,
      existing: false,
    };
  }

  /** Посетитель передумал: waiting → cancelled (active не отменяется — оператор уже пишет). */
  async cancel(
    site: WidgetSiteContext,
    visitor: WidgetVisitor,
    conversationId: string,
    now?: Date,
  ): Promise<boolean> {
    const conv = await this.db.assistSiteConversation.findFirst({
      where: {
        id: conversationId,
        siteId: site.siteId,
        visitorId: visitor.visitorId,
      },
      select: { id: true },
    });
    if (!conv) return false;
    const at = now ?? new Date();
    const u = await this.db.assistSiteHandoff.updateMany({
      where: { siteId: site.siteId, conversationId: conv.id, state: 'waiting' },
      data: {
        state: 'cancelled',
        closedAt: at,
        closedBy: 'visitor',
        updatedAt: at,
      },
    });
    if (u.count !== 1) return false;
    await this.db.assistSiteConversation.update({
      where: { id: conv.id },
      data: { handoffState: 'cancelled', stateVersion: { increment: 1 } },
      select: { id: true },
    });
    return true;
  }

  /** Последняя передача диалога (открытая или закрытая < 24 ч) — для `GET state` (W). */
  async visitorView(
    site: WidgetSiteContext,
    visitor: WidgetVisitor,
    conversationId: string,
  ): Promise<VisitorHandoffView | null> {
    const conv = await this.db.assistSiteConversation.findFirst({
      where: {
        id: conversationId,
        siteId: site.siteId,
        visitorId: visitor.visitorId,
      },
      select: { id: true },
    });
    if (!conv) return null;
    const h = await this.db.assistSiteHandoff.findFirst({
      where: { siteId: site.siteId, conversationId: conv.id },
      orderBy: { requestedAt: 'desc' },
      select: PUBLIC_SELECT,
    });
    if (!h) return null;
    if (h.state === 'waiting' || h.state === 'active') return toVisitorView(h);
    const ended = h.closedAt ?? h.missedAt ?? h.requestedAt;
    return Date.now() - ended.getTime() < VISITOR_VIEW_MS
      ? toVisitorView(h)
      : null;
  }

  /**
   * Сообщение посетителя во время передачи сохранено (конвейер, H) —
   * переслать оператору: `dispatcher.relayVisitorMessage(id)` с ожиданием
   * ≤ HANDOFF_DISPATCH_WAIT_MS (дальше — крон). Конвейер зовёт ЭТОТ метод,
   * а не system/ чужого модуля (правило графа `public-zone-e3`).
   */
  async relay(messageId: string): Promise<void> {
    await this.waitDispatch(this.dispatcher.relayVisitorMessage(messageId));
  }

  /**
   * Для конвейера ответа (H, site-chat.service): открытая передача диалога —
   * вопрос посетителя уходит оператору, а не модели (событие `handoff`).
   */
  async openFor(
    siteId: string,
    conversationId: string,
  ): Promise<{ id: string; state: 'waiting' | 'active' } | null> {
    const h = await this.openRow(siteId, conversationId);
    return h ? { id: h.id, state: h.state as 'waiting' | 'active' } : null;
  }

  /** Посетитель написал в открытую передачу (колоночный UPDATE роли). */
  async touchVisitor(handoffId: string, at: Date): Promise<void> {
    await this.db.assistSiteHandoff.updateMany({
      where: { id: handoffId, state: { in: ['waiting', 'active'] } },
      data: { lastVisitorAt: at, updatedAt: at },
    });
  }

  /**
   * Ранняя эскалация (№13) для конвейера: правила — из настроек передачи
   * сайта (колонка открыта роли виджета). Чистый детектор — escalation.ts.
   */
  async escalationFor(
    siteId: string,
    question: string,
  ): Promise<EscalationKind | null> {
    const row = await this.siteRow(siteId);
    const config = effectiveHandoffConfig(row?.handoffConfig);
    return detectEscalation(question, config.escalation);
  }

  // ── внутреннее ────────────────────────────────────────────────────────

  private async openRow(
    siteId: string,
    conversationId: string,
  ): Promise<HandoffPublicRow | null> {
    return this.db.assistSiteHandoff.findFirst({
      where: { siteId, conversationId, state: { in: ['waiting', 'active'] } },
      select: PUBLIC_SELECT,
    });
  }

  private async visitorLang(
    conversationId: string,
    uiLang: string | null,
  ): Promise<string | null> {
    const last = await this.db.assistSiteMessage.findFirst({
      where: { conversationId, role: 'visitor', text: { not: '' } },
      orderBy: { createdAt: 'desc' },
      select: { text: true, lang: true },
    });
    if (last?.lang) return last.lang;
    if (last?.text) return questionLang(last.text, uiLang?.slice(0, 2) ?? null);
    const ui = uiLang?.slice(0, 2).toLowerCase() ?? null;
    return ui && LANGS.has(ui) ? ui : null;
  }

  /**
   * Просьба человека ПОСЛЕ ответа модели — сигнал `unhappy` очереди (L,
   * §4-тер.3): элемент — к последнему ответу модели в диалоге. Зовёт
   * request() и конвейер (фраза «позовите человека», когда передача
   * недоступна и посетитель получает форму заявки).
   */
  async afterAnswerSignal(
    site: WidgetSiteContext,
    visitor: WidgetVisitor,
    conversationId: string,
    suspicious: boolean,
  ): Promise<void> {
    if (!this.signals) return;
    try {
      const answer = await this.db.assistSiteMessage.findFirst({
        where: {
          conversationId,
          role: 'assistant',
          answerPath: 'model',
          streamState: 'complete',
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, text: true, createdAt: true },
      });
      if (!answer) return;
      const question = await this.db.assistSiteMessage.findFirst({
        where: {
          conversationId,
          role: 'visitor',
          createdAt: { lt: answer.createdAt },
        },
        orderBy: { createdAt: 'desc' },
        select: { text: true, lang: true },
      });
      if (!question?.text) return;
      await this.signals.record({
        accountId: site.accountId,
        siteId: site.siteId,
        kind: 'unhappy',
        signal: 'handoff_after_answer',
        conversationId,
        messageId: answer.id,
        visitorId: visitor.visitorId,
        suspicious,
        questionMasked: question.text,
        answerMasked: answer.text,
        lang: question.lang,
        embedding: null,
      });
    } catch (e) {
      this.logger.warn(
        `сигнал handoff_after_answer не записан (диалог ${conversationId}): ${(e as Error | null)?.name ?? 'Error'}`,
      );
    }
  }

  /** Ждать системную часть не дольше dispatchWaitMs (дальше — крон). */
  private async waitDispatch(p: Promise<void>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const guarded = p.catch((e: unknown) =>
      this.logger.warn(
        `рассылка передачи: сбой (${(e as Error | null)?.name ?? 'Error'})`,
      ),
    );
    await Promise.race([
      guarded,
      new Promise<void>((r) => {
        timer = setTimeout(r, this.dispatchWaitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}
