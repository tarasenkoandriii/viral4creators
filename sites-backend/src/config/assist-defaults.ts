/**
 * Умолчания помощника для Э1 (знания, обход, песочница) — ОДНО место.
 *
 * До Э4 тарифов нет (`ASSIST_PLANS`), а лимиты нужны уже сейчас: обход
 * ограничен числом страниц, бюджет обучения — потолком подписки (Р-58),
 * песочницы — лимитами лендинга. Здесь — значения тарифа Trial/Start из
 * ТЗ помощника §7.1/§4-тер.11 и лендинг-ТЗ §6.3. Э4 заменит чтение этих
 * констант на тариф кабинета; места чтения — только через функции ниже.
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

/**
 * Бюджет обучения — месячный потолок ПОДПИСКИ (Р-58: Trial/Start $0.5,
 * Business $3, Pro $8). До Э4 подписок нет → потолок кабинета = Trial/Start.
 */
export const LEARNING_BUDGET_DEFAULT_MICRO_USD = 0.5 * MICRO_USD;

/**
 * Потолок кабинета на текущий период. Э4: из тарифа подписки кабинета.
 * `accountId` в сигнатуре — чтобы Э4 не менял вызывающих.
 */
export function learningBudgetCapMicroUsd(_accountId: string): number {
  return LEARNING_BUDGET_DEFAULT_MICRO_USD;
}

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
