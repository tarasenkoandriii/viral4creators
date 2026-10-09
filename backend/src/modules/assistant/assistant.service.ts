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
 * Буферизация разделителя `<<<actions>>>` (§5.4), таймауты и сам
 * генератор событий вынесены в общее ядро `common/assist-chat-core`
 * (ТЗ помощника §4.2) — Помощник использует ту же механику. Здесь —
 * специфика лендинга: настройки, бюджет, промпт, видео, журнал.
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
import { parseActions, splitActionsBlock } from './actions';
import { containsForbiddenPromise } from './post-filter';
import { maskForJournal } from './journal-mask';
import { estimateCost } from '../../common/ai-pricing';
import { hashVisitorIp } from './ip-hash';
import {
  AssistantReserveResult,
  commitAssistantReserve,
  estimateAssistantReserve,
  releaseAssistantBudget,
  reserveAssistantBudget,
} from './assistant-budget';
import {
  ASSISTANT_KNOWLEDGE,
  ASSISTANT_STEPS,
} from '../../common/tutorial-knowledge/generated';
import {
  ChatStreamEvent,
  chatUsageFromMeta,
  DEFAULT_CHAT_TIMEOUTS,
  GeminiUsageMeta,
  runChatStream,
  toGeminiContent,
} from '../../common/assist-chat-core';
import {
  AssistantAction,
  AssistantChatRequest,
  AssistantErrorCode,
} from './assistant.types';
import {
  isSiteTutorialDemoFamilyKey,
  NOT_SITE_TUTORIAL_DEMO_WHERE,
} from '../tutorial-help/site-tutorial-demo';

export type AssistantStreamEvent = ChatStreamEvent<
  AssistantAction,
  AssistantErrorCode
>;

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

/**
 * Потолок ответа модели (см. комментарий у `maxOutputTokens`); он же —
 * худший случай выхода в оценке резерва бюджета (П-Г5).
 */
export const ASSISTANT_MAX_OUTPUT_TOKENS = 2000;

/**
 * Текст тревоги оператору при отказе по бюджету (аудит захода 10, P3-1):
 * «потрачено» (строки `AiUsage`) и «занято» (резервы вопросов в полёте и
 * оборванных после первого токена) — разные вещи: второе освобождается само
 * через минуты, и оператору не нужно поднимать потолок из-за пика.
 */
export function assistantBudgetAlert(
  budgetMicroUsd: number,
  spentMicroUsd: number,
  inFlightMicroUsd: number,
): string {
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;
  if (spentMicroUsd >= budgetMicroUsd) {
    return `ИИ-консультант на лендинге: дневной бюджет исчерпан — потрачено ${usd(
      spentMicroUsd,
    )} из ${usd(budgetMicroUsd)}.`;
  }
  return `ИИ-консультант на лендинге: новый вопрос не помещается в дневной бюджет ${usd(
    budgetMicroUsd,
  )} — потрачено ${usd(spentMicroUsd)}, ещё ${usd(
    inFlightMicroUsd,
  )} занято вопросами в полёте и оборванными (резерв).`;
}

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
    // таймауты 30/90 с, `DEFAULT_CHAT_TIMEOUTS` ядра): без него
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

    const knowledgeMd = ASSISTANT_KNOWLEDGE[locale] ?? '';
    // Этап 92: обучалка выросла до 10 шагов (десятый — «Постпродакшн»).
    const step =
      request.stepId && request.stepId >= 1 && request.stepId <= 10
        ? ASSISTANT_STEPS[locale]?.[request.stepId - 1]
        : undefined;
    // Этап 99 (§4.8) — в отличие от знаний/шагов выше, список видео не
    // статический: он зависит от того, что уже отснято И одобрено в
    // админке (`TutorialVideoAsset.reviewed`), поэтому запрашивается
    // заново на КАЖДЫЙ чат-запрос, а не кешируется рядом с
    // ASSISTANT_KNOWLEDGE/ASSISTANT_STEPS (принятая цена — лишний round-
    // trip в Postgres на запрос, см. doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md).
    const videoSubjectKeys = await this.availableVideoSubjectKeys(locale);
    const systemInstruction = buildSystemInstruction(
      locale,
      knowledgeMd,
      step,
      videoSubjectKeys,
    );
    const contents = request.messages.map((m) => toGeminiContent(m));

    // П-Г5 (Р-З10-5): атомарный резерв дневного бюджета ДО платного
    // вызова — `assistant-budget.ts`. До захода 10 здесь было «прочитал
    // потрачено → решил»: параллельные вопросы все проходили проверку и
    // все уходили в Gemini, пока строка `AiUsage` первого не записана.
    // Теперь резервы сериализованы одним advisory-lock'ом консультанта
    // (заход 11, Р-З11-Г6: не на сутки — резервы по обе стороны полуночи
    // видят друг друга), оценка (худший случай по выходу) учитывает и
    // чужие вопросы «в полёте» любых суток и обрывы этих суток, а
    // снимается резерв только после записи `AiUsage` (или при сбое) — в
    // `finally` ниже, в том числе когда клиент ушёл посреди стрима.
    const estimateMicroUsd = estimateAssistantReserve(
      settings.model,
      systemInstruction.length +
        request.messages.reduce((n, m) => n + m.content.length, 0),
      ASSISTANT_MAX_OUTPUT_TOKENS,
    );
    let reserve: AssistantReserveResult;
    try {
      reserve = await reserveAssistantBudget(this.prisma, {
        budgetMicroUsd: settings.dailyBudgetMicroUsd,
        estimateMicroUsd,
      });
    } catch (error) {
      // База недоступна — бюджет не проверить; модель не зовём (деньги),
      // посетитель получает обычное «попробуйте ещё раз».
      this.logger.warn(
        `ассистент: резерв бюджета не удался — ${error instanceof Error ? error.message : String(error)}`,
      );
      yield {
        type: 'error',
        code: 'upstream',
        message: assistantErrorMessage('upstream', locale),
      };
      return;
    }
    if (!reserve.ok) {
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
        assistantBudgetAlert(
          settings.dailyBudgetMicroUsd,
          reserve.spentMicroUsd,
          reserve.inFlightMicroUsd,
        ),
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
    const reserveKey = reserve.key;
    // Резерв — по итогу обмена (аудит захода 10, P2-1):
    //  - `AiUsage` записан с настоящим расходом модели → снять;
    //  - модель не прислала ни одного токена (сбой, обрыв до ответа) → снять;
    //  - токены были, а расхода в `AiUsage` нет (клиент бросил стрим до
    //    `done` — `break` в контроллере, сбой посреди ответа без
    //    `usageMetadata`) → оценка остаётся расходом до конца суток.
    let sawToken = false;
    let usageRecorded = false;
    let innerDone = false;
    const inner = this.streamReserved(
      request,
      locale,
      settings.model,
      systemInstruction,
      contents,
      clientIpAddr,
      startedAt,
      externalSignal,
    );
    try {
      for (;;) {
        let step: IteratorResult<AssistantStreamEvent, boolean>;
        try {
          step = await inner.next();
        } catch (error) {
          innerDone = true;
          throw error;
        }
        if (step.done) {
          innerDone = true;
          usageRecorded = step.value;
          break;
        }
        if (step.value.type === 'token') sawToken = true;
        yield step.value;
      }
    } finally {
      // Потребитель бросил генератор на `yield` — закрываем и внутренний.
      if (!innerDone) await inner.return(false).catch(() => false);
      if (!usageRecorded && sawToken) {
        await commitAssistantReserve(this.prisma, reserveKey);
      } else {
        await releaseAssistantBudget(this.prisma, reserveKey);
      }
    }
  }

  /**
   * Вызов модели и запись обмена — только под резервом бюджета. Итог —
   * записан ли в `AiUsage` настоящий расход модели (`usageMetadata`).
   */
  private async *streamReserved(
    request: AssistantChatRequest,
    locale: SupportedLocale,
    model: string,
    systemInstruction: string,
    contents: ReturnType<typeof toGeminiContent>[],
    clientIpAddr: string,
    startedAt: number,
    externalSignal: AbortSignal | undefined,
  ): AsyncGenerator<AssistantStreamEvent, boolean> {
    const genai = this.genai;
    if (!genai) return false;

    // Таймауты Gemini (ТЗ §4.4): 30 с до первого токена, 90 с на весь
    // ответ (`DEFAULT_CHAT_TIMEOUTS`). Найдено доп. аудитом (HIGH) —
    // `externalSignal` объединяется с ними в ядре: без него закрытая
    // клиентом вкладка не останавливала стрим Gemini раньше 30/90 секунд.
    const outcome = yield* runChatStream<AssistantAction, AssistantErrorCode>({
      timeouts: DEFAULT_CHAT_TIMEOUTS,
      externalSignal,
      openStream: (abortSignal) =>
        genai.models.generateContentStream({
          model,
          contents,
          config: {
            systemInstruction,
            abortSignal,
            // Найдено доп. аудитом (HIGH): без явного потолка не было
            // ничего, что остановило бы аномально длинный ответ раньше
            // общего таймаута — 90 с стрима на неограниченный по
            // токенам вывод, оплаченные как обычный запрос. Спек (§3.2/
            // §6.2 doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md) целится в
            // 300–600 токенов и 2–6 предложений на ответ; 2000 — щедрый
            // запас поверх этого (под `<<<actions>>>`-блок и длинные
            // ответы на составные вопросы), а не жёсткая обрезка
            // нормального ответа.
            maxOutputTokens: ASSISTANT_MAX_OUTPUT_TOKENS,
          },
        }),
      resolveActions: (rawActionsJson) =>
        this.resolveVideoActions(parseActions(rawActionsJson), locale),
      upstreamError: (error) => {
        this.logger.warn(
          `ассистент: сбой стрима Gemini — ${error instanceof Error ? error.message : String(error)}`,
        );
        return {
          code: 'upstream',
          message: assistantErrorMessage('upstream', locale),
        };
      },
    });

    // Что успело накопиться при сбое — тоже записываем (§4.4 п.7:
    // «клиент показывает то, что успело прийти»), деньги за неполный
    // ответ уже потрачены независимо от того, как оборвался стрим.
    if (!outcome.ok && !outcome.fullText.trim()) return false;
    await this.recordExchange(
      request,
      locale,
      outcome.fullText,
      outcome.usageMeta,
      clientIpAddr,
      Date.now() - startedAt,
      model,
    );
    return outcome.usageMeta != null;
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
    const actions = await this.resolveVideoActions(
      parseActions(rawActionsJson),
      locale,
    );
    const visibleText = text.trim();
    // Ш0.7: то же правило журнала, что у вопроса ниже и у помощника
    // платформы (карты, IBAN, телефоны в свободной записи, e-mail, ключи).
    const maskedAnswer = maskForJournal(visibleText).slice(0, 4000);
    const flagged = containsForbiddenPromise(visibleText);

    const {
      in: inTokens,
      out: outTokens,
      cached: cachedTokens,
    } = chatUsageFromMeta(usageMeta);
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
          // Ш0.7 (риск В-4): вопрос посетителя — тоже ПДн, и живёт в
          // журнале 30 дней. Маскируем ДО обрезки: иначе номер карты на
          // границе 600 символов мог бы остаться наполовину открытым.
          question: maskForJournal(lastUserMessage?.content ?? '').slice(
            0,
            600,
          ),
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

  /**
   * Этап 99 (§4.8) — список `subjectKey`, доступных модели для
   * kind:"video" прямо сейчас: только `reviewed:true` (одобрено в
   * админке — доп. проверка, что видео УЖЕ собрано, `blobUrl` не пуст),
   * только для локали запроса. Возвращаются УНИКАЛЬНЫЕ ключи — если для
   * одного subjectKey накопилось несколько одобренных версий, модели
   * достаточно знать, что ключ существует; какую именно версию отдать
   * посетителю, решает `resolveVideoActions` ниже (последнюю по
   * `createdAt`).
   */
  private async availableVideoSubjectKeys(
    locale: SupportedLocale,
  ): Promise<string[]> {
    try {
      const rows = await this.prisma.tutorialVideoAsset.findMany({
        // `clientSiteDraftId: null` — третий барьер против выдачи
        // посетителю ролика по сайту ЗАКАЗЧИКА (сквозной аудит
        // 29.09.2026). Первые два стоят в админке — витрина их не
        // показывает, одобрение их отвергает, — но последнее слово
        // здесь: этот запрос решает, что модель вообще имеет право
        // предложить. Три барьера на одном пути, потому что цена
        // ошибки — чужой материал у постороннего человека.
        where: {
          locale,
          reviewed: true,
          blobUrl: { not: null },
          clientSiteDraftId: null,
          // Консультант лендинга (светлый) — только светлые ролики: с
          // заходом 3 (06.10.2026) у пары есть и тёмный ролик, а самый
          // свежий одобренный мог бы оказаться тёмным. NULL — старые
          // строки до колонки темы (светлые).
          OR: [{ theme: null }, { theme: 'light' }],
          // Демо обучающего лендинга (`site-tutorial-demo-*`) — ролики
          // витрины-полигона для одной секции одного лендинга, а не
          // обучалка продукта: консультант их не предлагает (черновик
          // демо, раздел 5.3). По префиксу — и ещё раз в коде ниже.
          ...NOT_SITE_TUTORIAL_DEMO_WHERE,
        },
        select: { subjectKey: true },
        distinct: ['subjectKey'],
      });
      return rows
        .map((r: { subjectKey: string }) => r.subjectKey)
        .filter((key: string) => !isSiteTutorialDemoFamilyKey(key));
    } catch (error) {
      // Мягкий отказ — как и весь остальной консультант (§7.4): сбой
      // этого доп. запроса не должен ронять ответ, просто модель в этот
      // раз не увидит раздел с видео и не предложит kind:"video".
      this.logger.warn(
        `ассистент: не удалось получить список видео для промпта — ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * Этап 99 (§4.8) — подставляет `url`/`title` в единственное (см.
   * `parseActions`'s ограничение «не больше одного video») действие
   * kind:"video", ЕСЛИ модель назвала `subjectKey` из списка, реально
   * одобренного в этот момент. Текст модели для URL не используется
   * никогда — только что запрошенная у базы строка `TutorialVideoAsset`
   * (см. `assistant.types.ts`'s доккомментарий у `AssistantAction`).
   * Не найдено/не одобрено (могло успеть перестать быть `reviewed` между
   * генерацией промпта и этим моментом — гонка допустима, цена ошибки
   * низкая) → действие молча выбрасывается, а не отдаётся с пустым URL.
   */
  private async resolveVideoActions(
    actions: AssistantAction[],
    locale: SupportedLocale,
  ): Promise<AssistantAction[]> {
    const videoAction = actions.find((a) => a.kind === 'video');
    if (!videoAction || !videoAction.subjectKey) return actions;
    // Ключ демо обучающего лендинга модель назвать могла (выдумала или
    // увидела в старом промпте) — такое действие выбрасывается без
    // запроса к базе, как и любое неодобренное.
    if (isSiteTutorialDemoFamilyKey(videoAction.subjectKey)) {
      return actions.filter((a) => a !== videoAction);
    }

    let asset: { blobUrl: string | null; title: string } | null = null;
    try {
      asset = await this.prisma.tutorialVideoAsset.findFirst({
        where: {
          subjectKey: videoAction.subjectKey,
          locale,
          reviewed: true,
          blobUrl: { not: null },
          clientSiteDraftId: null,
          OR: [{ theme: null }, { theme: 'light' }],
          ...NOT_SITE_TUTORIAL_DEMO_WHERE,
        },
        orderBy: { createdAt: 'desc' },
        select: { blobUrl: true, title: true },
      });
    } catch (error) {
      this.logger.warn(
        `ассистент: не удалось резолвнуть video-действие — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!asset || !asset.blobUrl) {
      return actions.filter((a) => a !== videoAction);
    }
    const resolvedUrl = asset.blobUrl;
    const resolvedTitle = asset.title;
    return actions.map((a) =>
      a === videoAction ? { ...a, url: resolvedUrl, title: resolvedTitle } : a,
    );
  }
}
