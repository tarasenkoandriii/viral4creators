/**
 * Сигналы очереди обучения из ПУБЛИЧНОГО кода — L (ТЗ §4-тер.3 «Типы
 * сигналов»). Зовут: конвейер ответа (H: no_answer, empty_search, flag:*,
 * repeat, handoff_after_answer) и 👎 (W: WidgetStateService.feedback).
 * Только AssistPublicDb: INSERT … ON CONFLICT DO NOTHING без RETURNING (у
 * роли нет SELECT на очередь). Именно БЕЗ цели конфликта: `ON CONFLICT
 * ("messageId", "kind")` Postgres пускает только с SELECT на колонки цели
 * (42501 под ролью — проверено); без цели арбитр — любой уникальный индекс
 * таблицы, а их два: id (наш randomUUID) и (messageId, kind) — то же самое.
 * Вектор вопроса — тот, что
 * уже посчитан для поиска (`$n::"extensions"."vector"`), нет — без него
 * (кластеризация досчитает кроном из бюджета обучения).
 * Тексты — УЖЕ маскированные (maskForJournal) — проверка на входе: строка с
 * телефоном/e-mail отвергается (не пишется), а не «чистится» здесь.
 * Ошибка записи сигнала не роняет ответ посетителю (лог — id и код).
 *
 * Колонки INSERT — ровно GRANT миграции Э3 (без кандидата и решения):
 * id, accountId, siteId, kind, conversationId, messageId, visitorId,
 * suspicious, signal, questionMasked, answerMasked, lang,
 * questionEmbedding, status, createdAt, updatedAt.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import { maskForJournal } from '../../assist-site-chat/answer-checks';
import { toVectorLiteral } from '../../site-ai/embedder';
import type { LearningKind, LearningSignalSource } from '../api-types';

export interface LearningSignal {
  accountId: string;
  siteId: string;
  kind: Exclude<LearningKind, 'voice_miss'>;
  signal: LearningSignalSource;
  conversationId: string | null;
  /** Сообщение, к которому сигнал (ответ модели или вопрос) — дедуп (messageId, kind). */
  messageId: string | null;
  visitorId: string | null;
  suspicious: boolean;
  questionMasked: string;
  answerMasked: string | null;
  lang: string | null;
  /** Вектор вопроса 768 (уже посчитан поиском) или null. */
  embedding: number[] | null;
}

/** Длины в очереди: вопрос — как у виджета с запасом, ответ — обрезка. */
export const SIGNAL_LIMITS = {
  question: 2000,
  answer: 4000,
  id: 64,
  signal: 48,
} as const;

const KINDS = new Set(['unknown', 'wrong', 'unhappy', 'operator_fix']);
const SIGNALS = new Set([
  'no_answer',
  'empty_search',
  'thumbs_down',
  'repeat',
  'handoff_after_answer',
  'operator',
  // Э3-бис: сигнал ИИ-разметки (крон, основная роль) — kind 'wrong'.
  'label',
]);

/** Почему сигнал не записан (код для лога) или null — годен. */
export function rejectSignal(s: LearningSignal): string | null {
  const id = (v: unknown, nullable: boolean) =>
    (nullable && v === null) ||
    (typeof v === 'string' && v.length > 0 && v.length <= SIGNAL_LIMITS.id);
  if (!id(s.accountId, false) || !id(s.siteId, false)) return 'site';
  if (!KINDS.has(s.kind)) return 'kind';
  if (
    typeof s.signal !== 'string' ||
    s.signal.length > SIGNAL_LIMITS.signal ||
    !(SIGNALS.has(s.signal) || /^flag:[a-z0-9_]{1,40}$/.test(s.signal))
  ) {
    return 'signal';
  }
  if (!id(s.conversationId, true) || !id(s.messageId, true)) return 'ids';
  if (!id(s.visitorId, true)) return 'visitor';
  if (typeof s.questionMasked !== 'string' || !s.questionMasked.trim()) {
    return 'question';
  }
  // Маска идемпотентна: уже маскированный текст она не меняет. Изменила —
  // значит, в тексте живой контакт: такой строке в очереди не место.
  if (maskForJournal(s.questionMasked) !== s.questionMasked) {
    return 'question_contact';
  }
  if (s.answerMasked !== null) {
    if (typeof s.answerMasked !== 'string') return 'answer';
    if (maskForJournal(s.answerMasked) !== s.answerMasked) {
      return 'answer_contact';
    }
  }
  if (s.lang !== null && !(typeof s.lang === 'string' && s.lang.length <= 8)) {
    return 'lang';
  }
  return null;
}

/** Вектор поиска годится в колонку vector(768), иначе null. */
export function signalVector(v: number[] | null): string | null {
  if (!Array.isArray(v) || v.length !== KNOWLEDGE_DEFAULTS.embedDimensions) {
    return null;
  }
  try {
    return toVectorLiteral(v);
  } catch {
    return null;
  }
}

@Injectable()
export class LearningSignals {
  private readonly logger = new Logger(LearningSignals.name);

  constructor(readonly db: AssistPublicDb) {}

  async record(signal: LearningSignal): Promise<void> {
    const reason = rejectSignal(signal);
    if (reason) {
      // Только код и id сайта — текст вопроса в лог не попадает (§6.6).
      this.logger.warn(
        `сигнал обучения отвергнут (site ${typeof signal?.siteId === 'string' ? signal.siteId.slice(0, 64) : '?'}): ${reason}`,
      );
      return;
    }
    const vector = signalVector(signal.embedding);
    try {
      await this.db.$executeRawUnsafe(
        `INSERT INTO "sites"."assist_site_learning_items"
           ("id", "accountId", "siteId", "kind", "conversationId", "messageId",
            "visitorId", "suspicious", "signal", "questionMasked", "answerMasked",
            "lang", "questionEmbedding", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::"extensions"."vector", 'new', now(), now())
         ON CONFLICT DO NOTHING`,
        randomUUID(),
        signal.accountId,
        signal.siteId,
        signal.kind,
        signal.conversationId,
        signal.messageId,
        signal.visitorId,
        signal.suspicious === true,
        signal.signal,
        Array.from(signal.questionMasked.trim())
          .slice(0, SIGNAL_LIMITS.question)
          .join(''),
        signal.answerMasked === null
          ? null
          : Array.from(signal.answerMasked)
              .slice(0, SIGNAL_LIMITS.answer)
              .join(''),
        signal.lang,
        vector,
      );
    } catch (e) {
      // Код Postgres (42501, 23503…) — да; сообщение (в нём бывают значения) — нет.
      const code = (e as { code?: unknown; meta?: { code?: unknown } } | null)
        ?.meta?.code;
      this.logger.warn(
        `сигнал обучения не записан (site ${signal.siteId}): ${(e as Error | null)?.name ?? 'Error'}${typeof code === 'string' ? ` ${code}` : ''}`,
      );
    }
  }
}
