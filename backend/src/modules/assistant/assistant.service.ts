/**
 * AssistantService — ИИ-консультант на лендинге
 * (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md), ядро §4.4.
 *
 * Стримит ответ Gemini как последовательность событий (`AssistantStreamEvent`);
 * контроллер сам решает, отдавать их как `text/event-stream` или собрать в
 * один JSON-ответ (§4.3 — запасной вариант без SSE). Логика ОДНА для обоих
 * путей — расхождение между «что стримится» и «что приходит без стрима»
 * было бы отдельным источником багов.
 *
 * Буферизация разделителя `<<<actions>>>` (§5.4): держим неотправленным
 * хвост длиной до `ACTIONS_DELIMITER_MAX_PREFIX - 1` символов, пока не
 * станет ясно, что это не начало разделителя — стандартный приём для
 * потокового поиска подстроки на границе чанков.
 */
import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { normalizeLocale, SupportedLocale } from '../../common/locale';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TelegramNotifyService } from '../notify/telegram-notify.service';
import { AssistantSettingsService } from './assistant-settings.service';
import { buildSystemInstruction } from './assistant-prompt';
import {
  ACTIONS_DELIMITER,
  ACTIONS_DELIMITER_MAX_PREFIX,
  parseActions,
  splitActionsBlock,
} from './actions';
import { containsForbiddenPromise, maskSensitiveEcho } from './post-filter';
import { estimateCost } from '../../common/ai-pricing';
import { hashVisitorIp } from './ip-hash';
import { ASSISTANT_KNOWLEDGE, ASSISTANT_STEPS } from './knowledge/generated';
import {
  AssistantAction,
  AssistantChatMessage,
  AssistantChatRequest,
  AssistantErrorCode,
} from './assistant.types';

/** Ответ Gemini SDK в части `usageMetadata` (та же форма, что в `AiUsageService`). */
interface GeminiUsageMeta {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
}

export type AssistantStreamEvent =
  | { type: 'token'; t: string }
  | { type: 'actions'; items: AssistantAction[] }
  | { type: 'done'; usage: { in: number; out: number; cached: number } }
  | { type: 'error'; code: AssistantErrorCode; message: string };

/** Таймауты Gemini (ТЗ §4.4): 30 с до первого токена, 90 с на весь ответ. */
const FIRST_TOKEN_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 90_000;

/** §6.5/§4.3 — локализованные тексты кодов ошибки для JSON/SSE `event: error`. */
const ERROR_MESSAGES: Record<
  AssistantErrorCode,
  Record<SupportedLocale, string>
> = {
  disabled: {
    ru: 'Консультант сейчас недоступен.',
    uk: 'Консультант зараз недоступний.',
    en: 'The consultant is unavailable right now.',
    de: 'Der Berater ist gerade nicht verfügbar.',
    es: 'El consultor no está disponible ahora mismo.',
  },
  budget_exhausted: {
    ru: 'Консультант отдыхает до завтра — загляните в обучалку и FAQ.',
    uk: 'Консультант відпочиває до завтра — погляньте в навчалку і FAQ.',
    en: 'The consultant is resting until tomorrow — check the tutorial and FAQ.',
    de: 'Der Berater pausiert bis morgen — schauen Sie in die Anleitung und die FAQ.',
    es: 'El consultor descansa hasta mañana — revisa el tutorial y las preguntas frecuentes.',
  },
  rate_limited: {
    ru: 'Слишком много вопросов подряд, подождите минуту.',
    uk: 'Забагато запитань поспіль, зачекайте хвилину.',
    en: 'Too many questions in a row, please wait a minute.',
    de: 'Zu viele Fragen hintereinander, bitte warten Sie eine Minute.',
    es: 'Demasiadas preguntas seguidas, espera un minuto.',
  },
  upstream: {
    ru: 'Не получилось получить ответ. Попробуйте ещё раз.',
    uk: 'Не вдалося отримати відповідь. Спробуйте ще раз.',
    en: "Couldn't get a response. Please try again.",
    de: 'Antwort konnte nicht abgerufen werden. Bitte versuchen Sie es erneut.',
    es: 'No se pudo obtener respuesta. Inténtalo de nuevo.',
  },
};

export function assistantErrorMessage(
  code: AssistantErrorCode,
  locale: string,
): string {
  const loc = normalizeLocale(locale);
  return ERROR_MESSAGES[code][loc];
}

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly settings: AssistantSettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly prisma: PrismaService,
    private readonly notify: TelegramNotifyService,
  ) {
    // Как в остальных сервисах, зовущих Gemini «мягко» (§7.4: нет ключа —
    // консультант отвечает `disabled`, а не падает 500 на каждый запрос).
    try {
      this.genai = createGeminiClient();
    } catch {
      this.genai = null;
    }
  }

  /**
   * Основной поток (§4.4). Всегда завершается событием `done` ИЛИ ровно
   * одним `error` — никогда не бросает исключение наружу (контроллер не
   * должен ловить ничего, кроме как для 5xx на уровне транспорта).
   */
  async *streamChat(
    request: AssistantChatRequest,
    clientIpAddr: string,
    // Найдено доп. аудитом (HIGH) — сигнал разрыва соединения от
    // AssistantController (`req`/`res` `close`), объединяемый ниже с
    // собственным AbortController этого метода (тем же, что уже дёргают
    // таймауты FIRST_TOKEN_TIMEOUT_MS/TOTAL_TIMEOUT_MS): без него
    // закрытая клиентом вкладка не останавливала стрим Gemini раньше
    // штатных 30/90 секунд.
    externalSignal?: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    if (externalSignal?.aborted) return; // клиент ушёл ещё до первого токена
    const locale = normalizeLocale(request.locale);
    const startedAt = Date.now();

    const settings = await this.settings.get();
    if (!settings.enabled || !this.genai) {
      yield {
        type: 'error',
        code: 'disabled',
        message: assistantErrorMessage('disabled', locale),
      };
      return;
    }

    // Известная гонка (найдено доп. аудитом, MEDIUM, сознательно не
    // чинится в этом заходе): читаем «сколько уже потрачено» и решаем
    // ДО платного вызова, а не резервируем слот атомарно, как
    // `SerpApiUsageService.reserve()`/`release()` для дневного лимита
    // аналогов (см. её доккомментарий про тот же класс TOCTOU-гонки,
    // однажды уже случившейся в проде). Несколько параллельных вопросов
    // от разных посетителей могут все пройти эту проверку одновременно и
    // все зайти в Gemini, пока строка `AssistantExchange`/`AiUsage`
    // предыдущего ещё не записана — бюджет может быть превышен на
    // ширину этой гонки. Не резервируем слот здесь по тем же причинам,
    // по которым `SerpApiUsageService` резервирует: перенос той же
    // атомарной схемы (резерв → вызов → списание/возврат) на бюджет в
    // деньгах, а не в счётчике запросов, требует отдельного story —
    // здесь только дневной SOFT-лимит расходов (§7.2), не защита от
    // злоупотребления (та — отдельный RateLimitGuard на IP, 10/мин,
    // 60/час), и цена ошибки — не критична (небольшой перерасход
    // бюджета в редкий момент пиковой одновременности, не потеря
    // данных). Не мой объём аудита — если гонка станет заметна на
    // практике, чинить по образцу SerpApiUsageService.
    const spentToday = await this.aiUsage.spentTodayForOperation('assistant');
    if (spentToday >= settings.dailyBudgetMicroUsd) {
      yield {
        type: 'error',
        code: 'budget_exhausted',
        message: assistantErrorMessage('budget_exhausted', locale),
      };
      // §7.2: уведомление оператору при исчерпании. Дедупликация — 10-
      // минутное окно `TelegramNotifyService` (см. его доккомментарий);
      // это не строго «раз в сутки», но не даёт заливать канал так же,
      // как и остальные тревоги в проекте — тот же приём, что и везде.
      void this.notify.alert(
        'assistant-budget-exhausted',
        `ИИ-консультант на лендинге: дневной бюджет исчерпан ($${(
          settings.dailyBudgetMicroUsd / 1_000_000
        ).toFixed(2)}).`,
      );
      // §10 — доля budget_exhausted в агрегатах админки: без строки
      // здесь считать было бы не из чего (в отличие от rate_limited,
      // который ТЗ просит в той же сводке, но который отсекается гвардом
      // ДО контроллера — трогать общий RateLimitGuard ради одной этой
      // метрики не стали, известное упрощение, см. итоговое резюме).
      void this.prisma.assistantEvent
        .create({ data: { kind: 'server_error', detail: 'budget_exhausted' } })
        .catch(() => undefined);
      return;
    }

    const knowledgeMd = ASSISTANT_KNOWLEDGE[locale] ?? '';
    // Этап 92: обучалка выросла до 10 шагов (десятый — «Постпродакшн»).
    const step =
      request.stepId && request.stepId >= 1 && request.stepId <= 10
        ? ASSISTANT_STEPS[locale]?.[request.stepId - 1]
        : undefined;
    const systemInstruction = buildSystemInstruction(locale, knowledgeMd, step);
    const contents = request.messages.map((m) => toGeminiContent(m));

    const controller = new AbortController();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else {
        externalSignal.addEventListener('abort', () => controller.abort(), {
          once: true,
        });
      }
    }
    const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);
    let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => controller.abort(),
      FIRST_TOKEN_TIMEOUT_MS,
    );

    let fullText = '';
    let emittedLength = 0;
    let delimiterFound = false;
    let usageMeta: GeminiUsageMeta | null = null;

    try {
      const stream = await this.genai.models.generateContentStream({
        model: settings.model,
        contents,
        config: {
          systemInstruction,
          abortSignal: controller.signal,
          // Найдено доп. аудитом (HIGH): без явного потолка не было
          // ничего, что остановило бы аномально длинный ответ раньше
          // TOTAL_TIMEOUT_MS — 90 с стрима на неограниченный по
          // токенам вывод, оплаченные как обычный запрос. Спек (§3.2/
          // §6.2 doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md) целится в
          // 300–600 токенов и 2–6 предложений на ответ; 2000 — щедрый
          // запас поверх этого (под `<<<actions>>>`-блок и длинные
          // ответы на составные вопросы), а не жёсткая обрезка нормального
          // ответа.
          maxOutputTokens: 2000,
        },
      });

      for await (const chunk of stream) {
        if (firstTokenTimer) {
          clearTimeout(firstTokenTimer);
          firstTokenTimer = null;
        }
        const chunkUsage = (chunk as { usageMetadata?: GeminiUsageMeta })
          .usageMetadata;
        if (chunkUsage) usageMeta = chunkUsage;

        const piece = chunk.text ?? '';
        if (!piece) continue;
        fullText += piece;

        if (!delimiterFound) {
          const idx = fullText.indexOf(ACTIONS_DELIMITER);
          if (idx !== -1) {
            delimiterFound = true;
            if (idx > emittedLength) {
              yield { type: 'token', t: fullText.slice(emittedLength, idx) };
              emittedLength = idx;
            }
          } else {
            const safeLen = Math.max(
              emittedLength,
              fullText.length - (ACTIONS_DELIMITER_MAX_PREFIX - 1),
            );
            if (safeLen > emittedLength) {
              yield {
                type: 'token',
                t: fullText.slice(emittedLength, safeLen),
              };
              emittedLength = safeLen;
            }
          }
        }
      }
    } catch (error) {
      clearTimeout(totalTimer);
      if (firstTokenTimer) clearTimeout(firstTokenTimer);
      this.logger.warn(
        `ассистент: сбой стрима Gemini — ${error instanceof Error ? error.message : String(error)}`,
      );
      yield {
        type: 'error',
        code: 'upstream',
        message: assistantErrorMessage('upstream', locale),
      };
      // Что успело накопиться — тоже записываем (§4.4 п.7: «клиент
      // показывает то, что успело прийти»), деньги за неполный ответ уже
      // потрачены независимо от того, как оборвался стрим.
      if (fullText.trim()) {
        await this.recordExchange(
          request,
          locale,
          fullText,
          usageMeta,
          clientIpAddr,
          Date.now() - startedAt,
          settings.model,
        );
      }
      return;
    }
    clearTimeout(totalTimer);
    if (firstTokenTimer) clearTimeout(firstTokenTimer);

    // Хвост, который не попал ни под один чанк-эмит выше (обычная
    // концовка без разделителя, либо остаток внутри буфера ≤ 13 симв.).
    if (!delimiterFound && fullText.length > emittedLength) {
      yield { type: 'token', t: fullText.slice(emittedLength) };
    }

    const { rawActionsJson } = splitActionsBlock(fullText);
    const actions = parseActions(rawActionsJson);
    if (actions.length > 0) {
      yield { type: 'actions', items: actions };
    }

    const usage = {
      in: usageMeta?.promptTokenCount ?? 0,
      out:
        (usageMeta?.candidatesTokenCount ?? 0) +
        (usageMeta?.thoughtsTokenCount ?? 0),
      cached: usageMeta?.cachedContentTokenCount ?? 0,
    };
    yield { type: 'done', usage };

    await this.recordExchange(
      request,
      locale,
      fullText,
      usageMeta,
      clientIpAddr,
      Date.now() - startedAt,
      settings.model,
    );
  }

  /** §10 — запись обмена для аналитики/ревью; учёт расхода — §7.2/26. */
  private async recordExchange(
    request: AssistantChatRequest,
    locale: SupportedLocale,
    fullText: string,
    usageMeta: GeminiUsageMeta | null,
    clientIpAddr: string,
    latencyMs: number,
    model: string,
  ): Promise<void> {
    const { text, rawActionsJson } = splitActionsBlock(fullText);
    const actions = parseActions(rawActionsJson);
    const visibleText = text.trim();
    const maskedAnswer = maskSensitiveEcho(visibleText).slice(0, 4000);
    const flagged = containsForbiddenPromise(visibleText);

    const inTokens = usageMeta?.promptTokenCount ?? 0;
    const outTokens =
      (usageMeta?.candidatesTokenCount ?? 0) +
      (usageMeta?.thoughtsTokenCount ?? 0);
    const cachedTokens = usageMeta?.cachedContentTokenCount ?? 0;
    // Своя оценка тем же прайсом, что и AiUsageService.record ниже —
    // строка AssistantExchange.costMicroUsd нужна для ленты/агрегатов
    // §10 независимо от AiUsage (разные таблицы, разное назначение), но
    // считать она обязана ОДИНАКОВО, а не третьим отдельным числом.
    const costMicroUsd = estimateCost(model, {
      inputTokens: inTokens,
      cachedInputTokens: cachedTokens,
      outputTokens: outTokens,
    }).costMicroUsd;

    // Деньги — та же таблица AiUsage, что и весь остальной продукт
    // (`operation: 'assistant'`), НЕ привязана к пользователю/сессии —
    // консультант не знает, кто перед ним (§8).
    await this.aiUsage.recordGemini(
      { usageMetadata: usageMeta ?? undefined },
      { operation: 'assistant', model, userId: null, sessionId: null },
    );

    const lastUserMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user');

    try {
      await this.prisma.assistantExchange.create({
        data: {
          locale,
          page: request.page,
          stepId: request.stepId ?? null,
          question: (lastUserMessage?.content ?? '').slice(0, 600),
          answer: maskedAnswer,
          actions: actions.length ? (actions as unknown as object) : undefined,
          inTokens,
          outTokens,
          cachedTokens,
          costMicroUsd,
          latencyMs,
          flagged,
          ipHash: hashVisitorIp(clientIpAddr),
          triggeredBy: request.triggeredBy ?? 'user',
        },
      });
    } catch (error) {
      // Аналитика не должна ронять уже отданный ответ — тот же принцип,
      // что у AiUsageService.record (см. его доккомментарий).
      this.logger.warn(
        `не удалось записать AssistantExchange: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function toGeminiContent(m: AssistantChatMessage): {
  role: string;
  parts: { text: string }[];
} {
  // Gemini использует роль 'model' для ответа модели, не 'assistant'
  // (наш собственный контракт §4.3) — перевод один раз, здесь.
  return {
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }],
  };
}
