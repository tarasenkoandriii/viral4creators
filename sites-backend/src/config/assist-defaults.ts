/**
 * Умолчания помощника для Э1 (знания, обход, песочница) — ОДНО место.
 *
 * С Э4 лимиты тарифа (единицы диалогов, страницы знаний, бюджеты
 * обучения, суточный потолок сайта) живут в `ASSIST_PLANS`
 * (modules/assist-billing/plans.ts) и читаются по тарифу кабинета; здесь —
 * технические умолчания обхода, знаний, виджета и песочниц (лендинг-ТЗ §6.3).
 *
 * Деньги — в микродолларах (как site_ai_usage.costMicroUsd).
 */

export const MICRO_USD = 1_000_000;

/** Обход (ТЗ §3.4, §4.14, §4-тер.2). */
export const CRAWL_DEFAULTS = {
  /** Лимит страниц сайта за переобход (Trial/Start; Э4 — по тарифу). */
  maxPages: 500,
  /** SPA через Chromium на Vercel — до воркера QA (§4.14). Э1: не делаем. */
  maxSpaPages: 30,
  /** «≤ 2 запроса/с на хост» (§3.4) — пауза между запросами к одному хосту. */
  minDelayMsPerHost: 500,
  /** Тело страницы — не больше (HTML). */
  maxHtmlBytes: 3 * 1024 * 1024,
  /** robots.txt / sitemap — не больше. */
  maxRobotsBytes: 512 * 1024,
  maxSitemapBytes: 10 * 1024 * 1024,
  /** Сколько sitemap (индекс + дочерние) читаем за прогон. */
  maxSitemaps: 20,
  /** Таймаут одного запроса. */
  requestTimeoutMs: 10_000,
  /** Редиректов на запрос (в пределах того же хоста). */
  maxRedirects: 5,
  /** Глубина обхода по ссылкам, если sitemap нет. */
  maxLinkDepth: 4,
  /** Кэш robots.txt по origin. */
  robotsTtlMs: 24 * 60 * 60 * 1000,
  /** Бюджет одного тика крона (функция Vercel — с запасом до maxDuration). */
  tickBudgetMs: 45_000,
  /** Страниц за тик (ТЗ §4.14: «батчами по 20 страниц за вызов»). */
  pagesPerTick: 20,
  /** Lease строки очереди/прогона. */
  leaseMs: 2 * 60 * 1000,
  /** Попыток на URL, потом — failed. */
  maxAttempts: 3,
  /** «Горячие страницы» — не больше (§4-тер.2). */
  maxHotPages: 10,
} as const;

/** Индексация и версии (ТЗ §4.3, §4-тер.2). */
export const KNOWLEDGE_DEFAULTS = {
  embedModel: 'gemini-embedding-001',
  embedDimensions: 768,
  /** Фрагмент 300–500 токенов, перекрытие 50 (§4.3). */
  chunkMinTokens: 300,
  chunkMaxTokens: 500,
  chunkOverlapTokens: 50,
  /** Эмбеддингов за один вызов провайдера. */
  embedBatchSize: 100,
  /** Окно отката: 7 дней и не больше 5 последних публикаций. */
  rollbackWindowDays: 7,
  rollbackMaxPublished: 5,
  /** Ушедшая со страницы (gone) — физически удаляется через 7 дней. */
  goneRetentionDays: 7,
  /** Пороги ворот аномалий (§4-тер.2). */
  gates: {
    goneOrErrorShare: 0.3,
    identicalChangedShare: 0.5,
    identicalChangedMin: 10,
    langShiftPoints: 40,
    quarantineHoldShare: 0.1,
    /** Удержание по «сломанным» страницам — не меньше стольких страниц. */
    goneOrErrorMinPages: 2,
    /** «Всплеск» карантина — не меньше стольких фрагментов. */
    quarantineHoldMin: 3,
  },
  /** Источников одного режима на сайт. */
  maxSourcesPerSite: 50,
  /** Адресов в одном url-источнике. */
  maxUrlsPerSource: 20,
  /** Текст документа длиннее — обрезается с флагом truncated (бюджет обучения). */
  maxDocumentTextChars: 1_000_000,
  /** Lease разбора файла кроном и попыток до failed. */
  processLeaseMs: 5 * 60 * 1000,
  processMaxAttempts: 3,
  /** Поиск (§4.3): top-20 + top-20 → RRF → top-6. */
  search: { vectorTopK: 20, textTopK: 20, resultTopK: 6, rrfK: 60 },
  /** Файл-документ — не больше (§3.4). */
  maxDocumentBytes: 20 * 1024 * 1024,
  /** Типы документов (§3.4). */
  documentMimeTypes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv',
  ],
} as const;

/*
 * Бюджет обучения — месячный потолок ПОДПИСКИ (Р-58: Trial/Start $0.5,
 * Business $3, Pro $8). С Э4 — из тарифа кабинета:
 * `ASSIST_PLANS[…].learningBudgetMicroUsd` (modules/assist-billing/plans.ts),
 * читает site-ai/learning-budget.ts.
 */

/** Песочница в TMA (§3.1) и анонимная с лендинга (лендинг-ТЗ §6.3). */
export const SANDBOX_LIMITS = {
  cabinet: {
    pages: 10,
    questions: 20,
    ttlMs: 7 * 24 * 60 * 60 * 1000,
    /** Песочниц кабинета в сутки (деньги платформы, онбординг). */
    perAccountPerDay: 10,
  },
  public: {
    pages: 8,
    questions: 10,
    ttlMs: 24 * 60 * 60 * 1000,
    /** Новых песочниц в сутки на IPv4 / IPv6 /64. */
    perIpPerDay: 3,
    /** Новых обходов одного eTLD+1 в сутки со всех IP; дальше — кэш. */
    newCrawlsPerDomainPerDay: 3,
    /** Повторная песочница по тому же домену в течение — из кэша. */
    domainCacheMs: 24 * 60 * 60 * 1000,
    /** «≤ 1 запрос/с на хост» (лендинг-ТЗ §6.3). */
    minDelayMsPerHost: 1000,
    /** Суточный денежный потолок всех публичных песочниц — ВКЛЮЧЁН. */
    dailyCapMicroUsdDefault: 5 * MICRO_USD,
  },
  /** Длина вопроса в песочнице. */
  maxQuestionChars: 500,
  /** Работа одного опроса статуса (функция Vercel — с запасом). */
  pollBudgetMs: 8_000,
  /** Страниц за опрос: публичная — 1 запрос/с на хост → ~3 с. */
  pagesPerPoll: 3,
  /** Вес UGC в слиянии выдач (§6.5: мнение посетителя, не факт). */
  ugcPenalty: 0.005,
} as const;

/**
 * Э2: виджет режима «Сайт» (ТЗ §4.5, §4.13, §4-бис, §3-бис, §6.3, §7.1;
 * лендинг-ТЗ §5.3, §10.1). Квота диалогов и суточный потолок сайта с Э4 —
 * из тарифа кабинета (modules/assist-billing).
 */
export const WIDGET_DEFAULTS = {
  /** Посетитель (§4.5): сообщений за сессию / за сутки. */
  visitorMessagesPerSession: 30,
  visitorMessagesPerDay: 60,
  /** Частота (§4.13 п.2–3). */
  sessionsPerIpPerMinute: 5,
  messagesPerVisitorPerMinute: 10,
  messagesPerVisitorPerHour: 60,
  messagesPerIpSitePerMinute: 30,
  /** Прогрессивное замедление: после N сообщений за сессию — пауза (§4.13 п.3). */
  slowdownAfterMessages: 20,
  slowdownMinMs: 2_000,
  slowdownMaxMs: 5_000,
  /** «Токен выдан < 1 с назад и сразу сообщение» — признак бота (§4.13 п.5). */
  botTokenAgeMs: 1_000,
  /** Вопрос (§4.13 п.4) и история из СВОЕЙ базы (последние реплики, §4.6 п.7). */
  maxQuestionChars: 600,
  historyTurns: 10,
  /** `V4CAssist('context')` и заголовок страницы — данные, усечение (§3-бис.2, §4.6 п.5). */
  maxContextChars: 500,
  maxPageTitleChars: 200,
  /** Ответ (§4.5): токенов вывода, потолок генерации (как у лендинга, 90 с). */
  maxOutputTokens: 800,
  answerTimeoutMs: 90_000,
  /** Сброс накопленного текста стрима в базу (§4-бис.4). */
  streamFlushMs: 500,
  /** Резерв бюджета живёт дольше полного таймаута ответа (§4.5 уточнение 2). */
  reservationTtlMs: 3 * 60 * 1000,
  /** Не больше 3 кнопок-действий, одно видео (§4.9). */
  maxActions: 3,
  /** Прямой ответ проверенным ответом — порог сходства (§4.5 п.1). */
  faqDirectSimilarity: 0.92,
  /** Семантический кэш (§4.5, §4-тер.7). */
  semanticCacheTtlMs: 24 * 60 * 60 * 1000,
  semanticCacheMaxQuestionChars: 200,
  // Э4: правила счёта диалогов (30 мин тишины, ×2 после 30 ответов, веса)
  // — modules/assist-billing/units.ts; лимит единиц и суточный потолок сайта
  // («месячная себестоимость лимита / 10») — из тарифа кабинета
  // (modules/assist-billing/plans.ts, public/entitlements.ts).
  /** Потолок платформы (все сайты, сутки) — env ASSIST_WIDGET_PLATFORM_DAILY_CAP_USD. */
  platformDailyCapMicroUsdDefault: 20 * MICRO_USD,
  /** Сессия посетителя (§4.13 п.2), указатель (§4-бис.3), «продолжить» (§4-бис.1). */
  visitorTokenTtlMs: 24 * 60 * 60 * 1000,
  resumeTtlMs: 30 * 24 * 60 * 60 * 1000,
  resumeDialogMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  /** Конфиг и HTML iframe кэшируются ≤ 5 мин (§3-бис.1, §4.12). */
  configCacheSeconds: 300,
  frameCacheSeconds: 300,
  /** Предпросмотр (§3-бис.4): токен 30 мин, одноразовый; сессия — до закрытия вкладки, но ≤ 2 ч. */
  previewTokenTtlMs: 30 * 60 * 1000,
  previewSessionTtlMs: 2 * 60 * 60 * 1000,
  /** Версий вида/персоны в истории (§3-бис.4: «последних 20 публикаций»). */
  configHistoryKeep: 20,
  /** Лид (§3.6 п.6): длины полей. */
  leadFieldMaxChars: 200,
  leadCommentMaxChars: 1_000,
  leadDeliveryMaxAttempts: 5,
  /** Лидов в час на посетителя (контракт §5: `widget-lead-visitor-hour`). */
  leadsPerVisitorPerHour: 5,
  /** Сроки хранения по умолчанию (§6.3) — колонки assist_sites. */
  conversationRetentionDays: 90,
  leadRetentionDays: 180,
  /** z-index кнопки (§3-бис.3): ниже максимума на 647 — баннеры сайта выше. */
  zIndexDefault: 2147483000,
  /** Пинг загрузчика свежий (проверка установки, §3-бис.2). */
  installPingFreshMs: 7 * 24 * 60 * 60 * 1000,
  /** Тело публичных запросов виджета (кроме чата) — не больше. */
  maxPublicBodyBytes: 4 * 1024,
} as const;

/** Мастер «Научите помощника» (§4-тер.9, §4-тер.11): платит платформа. */
export const WIZARD_DEFAULTS = {
  topics: 10,
  /** Первый прогон черновиков + не больше 3 повторов. */
  maxDraftRuns: 4,
  /** Потолок одного прогона (≈ $0.1 по §4-тер.11 — с запасом). */
  runCapMicroUsd: 0.15 * MICRO_USD,
} as const;

/** Лендинг (лендинг-ТЗ §5.3, §10.1): черновики вида и события. */
export const LANDING_DEFAULTS = {
  widgetDraftMaxBytes: 2 * 1024,
  widgetDraftTtlMs: 7 * 24 * 60 * 60 * 1000,
  widgetDraftsPerIpPerDay: 10,
  eventsPerBatch: 20,
  eventBodyMaxBytes: 4 * 1024,
  /** Батчей событий в минуту с одного ipHash (sendBeacon при каждом скрытии вкладки). */
  eventBatchesPerMinute: 30,
  eventsRetentionDays: 90,
} as const;

// ══ Э3 (контракт /tmp/k/CONTRACT-E3.md) ══════════════════════════════

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Передача человеку (§3.7). Настраиваемое владельцем — handoff-config.ts (H). */
export const HANDOFF_DEFAULTS = {
  /** Опрос iframe, пока передача waiting/active и вкладка видима (§3.7 п.4; приёмка «≤ 5 с»). */
  widgetPollMs: 3_000,
  /** Сколько ждать рассылки карточек в запросе посетителя (остальное — крон). */
  dispatchWaitMs: 5_000,
  /** Lease строки передачи при рассылке/напоминании. */
  leaseMs: 60_000,
  /** Попыток рассылки до «пропущено» без карточек. */
  maxDispatchAttempts: 5,
  /** Сообщения бота, на которые можно ответить реплаем/кнопкой. */
  botMessageTtlMs: 7 * DAY,
  /** Медиана «~N минут» — по передачам за этот срок (§3.7 п.2). */
  etaWindowMs: 7 * DAY,
  /** Медиана считается от этого числа передач с ответом. */
  etaMinSamples: 5,
  /** Ответ оператора посетителю ≤ символов (Telegram даёт 4096). */
  replyMaxChars: 2_000,
  /** «Позвать человека» — не чаще на посетителя в час. */
  requestsPerVisitorPerHour: 5,
  /** Вызов модели для сводки/черновика/перевода (оценка резерва бюджета дня). */
  aiEstimateMicroUsd: 3_000,
} as const;

/** Обучение на диалогах (§4-тер.3–4, §4-тер.8, §4-тер.11). */
export const LEARNING_DEFAULTS = {
  /** Косинус к центроиду кластера (§4-тер.3 п.2; ориентир §9.1 «сходство ≥ 0.85»). */
  clusterSimilarity: 0.85,
  /** «Повторный пробел»: unknown по решённому кластеру через ≥ N дней (§4-тер.3 п.4). */
  reopenAfterMs: 14 * DAY,
  /** Срок пересмотра проверенного ответа: 180 дней; с числами — 30 (§4-тер.4). */
  reviewAfterMs: 180 * DAY,
  reviewAfterWithNumbersMs: 30 * DAY,
  /** «Тот же вопрос повторён в течение 24 ч» (§4-тер.3 unhappy, §9.1 (г)). */
  repeatWindowMs: 24 * HOUR,
  /** Триграммное сходство маскированных вопросов для «повтора» (вектор вопросов не храним). */
  repeatTrigramSimilarity: 0.85,
  /** Примеров в карточке кластера. */
  maxExamples: 5,
  /** Плановый eval до Э4 (Trial/Start — раз в месяц, Р-36). */
  scheduledEvalEveryMs: 30 * DAY,
  /** Симуляция №31 (MVP-лайт): персонажей и вопросов каждому. */
  simulationPersonas: 10,
  simulationTurns: 3,
  /** Оценка стоимости черновика проверенного ответа (≈ $0.009, §4-тер.11). */
  draftEstimateMicroUsd: 10_000,
  forgetJobsPerTick: 50,
} as const;

/** Цели, статистика, экспорт, отчёты (§5-тер.1–2, §5-тер.7, §5-тер.10, §5-тер.15). */
export const ANALYTICS_DEFAULTS = {
  /** Прямая атрибуция: цель ≤ 30 мин после клика по действию помощника (§5-тер.2). */
  directWindowMs: 30 * MIN,
  /** Слияние page-события загрузчика с verified того же заказа (§5-тер.1 «Дедуп»). */
  mergeWindowMs: 30 * MIN,
  /** Цель без срабатываний — stale (§5-тер.1 «не срабатывала 7 дней»). */
  goalStaleAfterMs: 7 * DAY,
  goalsPerSite: 30,
  /** POST /widget/v1/event и /goal: батч и тело (§5-тер.14). */
  eventsPerBatch: 20,
  eventBodyMaxBytes: 4 * 1024,
  /** Вебхук s2s: тело, окно подписи, лимит на сайт. */
  webhookBodyMaxBytes: 4 * 1024,
  webhookSignatureWindowSec: 300,
  webhooksPerSitePerMinute: 120,
  /** Экспорт CSV (§5-тер.7): строк, срок ссылки, журнал. */
  exportMaxRows: 100_000,
  exportLinkTtlMs: 24 * HOUR,
  exportsPerTick: 3,
  /** Хранение (§5-тер.15): события целей и свёртки — 13 мес. */
  goalEventsRetentionMs: 396 * DAY,
  dailyTotalsRetentionMs: 396 * DAY,
  /** Диалог «закрыт» для свёртки и разметки — без активности (§9.1). */
  conversationIdleMs: 30 * MIN,
  /** Тревоги (№29): всплеск доли относительно среднего за 7 дней, при объёме ≥ N диалогов. */
  alertSpikeRatio: 2,
  alertMinDialogs: 20,
  /** Минуты оператора на вопрос по умолчанию (§5-тер.2 «разгрузка людей»). */
  minutesPerQuestion: 3,
} as const;
