/**
 * Configuration Module
 *
 * Loads and validates environment variables for the application.
 * Provides type-safe access to configuration values.
 */

export interface Configuration {
  // Server
  port: number;
  nodeEnv: string;

  // Google Gemini
  gemini: {
    apiKey: string;
    model: string;
  };

  // GPT-5 text generation via laozhang.ai (still active — see
  // prompt.service.ts). Video generation no longer goes through this
  // client at all: it moved to Google Veo 3.1 via @google/genai, see
  // GenerationService.VEO_MODELS. There used to be a `soraModel` field
  // here for the old Sora-2-via-laozhang video flow; removed as dead
  // config once nothing read it anymore (doc/VERCEL-READINESS-AUDIT.md,
  // finding #8).
  openai: {
    apiKey: string;
    baseUrl: string;
    gptModel: string;
    /**
     * Доп. запрос владельца продукта: узкий, точный шаг переписывания
     * промпта под конвенцию Grok reference-to-video (ТЗ
     * VEO-MODEL-VERSION-CHOICE-SPEC.md §8.5 п.2, §15.3) — не творческая
     * задача вроде написания сцены, поэтому дешевле/быстрее
     * `OPENAI_GPT_MODEL`. Имя модели на момент подготовки — ПРОВЕРИТЬ
     * на `console.x.ai`/OpenAI-совместимой панели laozhang.ai перед
     * первым реальным вызовом, тот же принцип, что уже применяется к
     * остальным моделям в этом файле.
     */
    fastModel: string;
  };

  // CORS
  cors: {
    // Parsed from CORS_ORIGIN (comma-separated). Each entry is either an
    // exact origin ("https://app.example.com") or a wildcard suffix
    // ("*.vercel.app") matched against the request's Origin header — see
    // main.ts's enableCors call for how this list is actually used.
    origins: string[];
  };

  // Product/Project workflow (doc/PRODUCT-PROJECT-SPEC.md). Stage 1 of
  // doc/PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md — config only; nothing
  // reads these yet, the consuming modules land in later stages. None of
  // them is validated as required: a stand without these keys must keep
  // starting, the corresponding endpoint simply refuses at call time
  // (same policy as LAOZHANG_API_KEY / BLOB_* — see .env.docker.example).
  serpApi: {
    /** SerpApi Google Lens — photo → market analogs (spec §6.1). */
    apiKey: string;
    /**
     * Per-user daily cap on SerpApi calls (spec §7.5, decided). A setting,
     * not a hard-coded number, so the real threshold can be tuned from
     * env/admin without a redeploy once actual spend is observed.
     */
    dailyLimitPerUser: number;
  };
  youtube: {
    /** YouTube Data API v3 — reference-video search (spec §6.4). */
    apiKey: string;
    /**
     * Per-user daily cap on search.list calls. The Google quota is per
     * Cloud project (10 000 units ≈ 100 searches/day for EVERYONE), so
     * without this one user could exhaust it for all. Default 20.
     */
    searchDailyLimitPerUser: number;
  };
  videoAudit: {
    /**
     * Soft cap on automatic audit → prompt-fix → regenerate iterations per
     * generated video (spec §11.1, decided: 3). Past it the UI warns
     * instead of silently running another paid Veo pass.
     */
    autoIterationsLimit: number;
  };
  project: {
    /**
     * Max ProductItems in one LINE project (spec §7.3, decided: 500 —
     * raised on stage 68 from the original 20: the whole point of §47's
     * feed import is a seller with 300+ SKUs, unreachable at the old
     * default). A setting rather than a DB constraint — bounds UI
     * clutter and the worst-case SerpApi spend per project, and can be
     * tuned without a release. Enforced in ProjectService.addItem.
     */
    lineItemLimit: number;
  };

  // xAI Grok Batch API — фоновый перевод статей блога (ТЗ §35.1, решение
  // от прямого запроса пользователя «использовать Grok AI как в solar
  // shop batch mode для перевода статей»; отменяет более раннее решение
  // этапа 55 использовать синхронные Gemini/GPT-5 под крон-бюджетом).
  // Как и serpApi/youtube выше — конфиг заведён ДО потребителя: сам
  // клиент (GrokBatchService) уже есть, а ArticleTranslation, которая
  // будет его вызывать, — этап 57. Без ключа GrokBatchService честно
  // отвечает `{ error: 'GROK_API_KEY не задан' }`, вместо того чтобы
  // мешать стенду запускаться.
  grok: {
    apiKey: string;
    /**
     * Модель для перевода статей блога (spec §35.1, этап 57). Значение по
     * умолчанию НЕ сверено с актуальным списком моделей xAI на дату
     * добавления — как и у Veo/GPT-5 в `common/ai-pricing.ts`, проверьте
     * его на `console.x.ai` перед первым реальным запуском перевода.
     */
    model: string;
    /**
     * Доп. запрос владельца продукта: Grok как провайдер видео-генерации
     * (§10–11 ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md). Официальное имя на
     * момент подготовки ТЗ — `grok-imagine-video-1.5` (GA, не preview,
     * docs.x.ai) — ПРОВЕРИТЬ на `console.x.ai` перед первым реальным
     * запуском: то же самое предупреждение, что уже есть у остальных
     * моделей в этом файле и в `common/ai-pricing.ts`.
     */
    videoModel: string;
  };

  // Блог (doc/TODO.md §II.3–II.4, ТЗ §36, этап 57). Конфиг заведён вместе
  // с потребителем в этом же этапе (в отличие от serpApi/youtube/grok
  // выше, которые ждали своего этапа) — здесь модуль и конфиг рождаются
  // одновременно.
  blog: {
    /**
     * Ниши для суточного поиска трендовых роликов (TODO §II.3: "в заданных
     * категориях") — поисковые запросы-затравки для YoutubeSearchService,
     * через запятую. Пусто — крон честно ничего не делает и пишет об этом
     * в лог, а не выдумывает категории по умолчанию.
     */
    categories: string[];
    /**
     * Суточный потолок вызовов YouTube Data API суточным кроном блога —
     * СВОЙ, отдельный от `youtube.searchDailyLimitPerUser` (TODO §II.3:
     * "должен иметь свой потолок, отдельный от пользовательского"): один
     * runaway-прогон генератора не обязан делить квоту с реальными
     * пользователями поиска референсов.
     */
    youtubeSearchDailyLimit: number;
    /**
     * Сколько новых черновиков заводить максимум за один прогон крона —
     * защита от одного раздутого прогона, не суточная квота (та — выше).
     */
    draftsPerRunLimit: number;
    /**
     * Порог оценки Gemini (0–100) для превращения кандидата в черновик
     * (TODO §II.4: "порог — переменная окружения... 'высокая оценка' на
     * старте будет означать не то же, что через месяц"). Ниже порога —
     * ролик пропускается молча, черновик не заводится вовсе: копить в
     * очереди то, что оператор гарантированно отклонит, — не польза, а
     * шум в модерации.
     */
    minScoreToDraft: number;
    /**
     * Сколько ожидающих переводов включать в одну пачку xAI за прогон
     * крона — потолок объёма одного вызова submitBatch, не суточный лимит.
     */
    translateBatchLimit: number;
  };

  // Выгрузка одобренных заявок в YouTube/TikTok (ТЗ §14, этап 61). Как
  // и serpApi/youtube/grok выше — все поля опциональны на уровне
  // validateConfiguration: без ключей кнопки подключения канала скрыты,
  // а крон-воркер просто не находит ни одного канала для выгрузки.
  publishing: {
    /** OAuth-клиент Google (Cloud-проект с включённым YouTube Data API v3). */
    googleClientId: string;
    googleClientSecret: string;
    /** Приложение TikTok for Developers (Login Kit + Content Posting API). */
    tiktokClientKey: string;
    tiktokClientSecret: string;
    /** Ключ шифрования OAuth-токенов в БД — см. common/token-crypto.ts. */
    channelTokenKey: string;
    /** Сколько заявок берёт один тик крона (§14.5). */
    cronBatch: number;
    /** Потолок попыток выгрузки одной заявки до FAILED (§14.5). */
    maxAttempts: number;
    /** Публичный адрес backend — для redirect_uri OAuth-колбэков. */
    apiPublicUrl: string;
    /**
     * Публичный адрес TMA (frontend) — куда OAuth-callback возвращает
     * браузер после подключения канала. Тот же URL, что у landing в
     * NEXT_PUBLIC_TMA_URL, но нужен и backend'у отдельно: callback дёргает
     * сам Google/TikTok напрямую на backend, у него нет доступа к env
     * фронтенда. Пусто → страница результата даёт только ссылку на «/».
     */
    tmaUrl: string;
  };

  // Оплата — Telegram Stars и WayForPay, подписки и пакеты кредитов
  // (ТЗ §41, этап 62). Тот же принцип, что у publishing выше: все поля
  // опциональны на уровне validateConfiguration — без ключей кнопки
  // покупки скрыты, вебхуки отвечают понятной ошибкой конфигурации, а не
  // валят старт приложения.
  billing: {
    /** Секрет, который Telegram эхом шлёт в X-Telegram-Bot-Api-Secret-Token
     * на каждый вызов вебхука (setWebhook secret_token) — первая входящая
     * точка от Telegram в проекте, сверяется тем же приёмом, что CRON_SECRET. */
    telegramWebhookSecret: string;
    wayforpayMerchantAccount: string;
    wayforpayMerchantSecret: string;
    /** Домен мерчанта, как он зарегистрирован у WayForPay — участвует в
     * подписи формы покупки. */
    wayforpayDomain: string;
    /** Ключ шифрования recToken (регулярный платёж WayForPay) — отдельный
     * от CHANNEL_TOKEN_KEY, см. common/token-crypto.ts. */
    paymentTokenKey: string;
    /** Сколько подписок с истёкшим currentPeriodEnd берёт один тик крона
     * продления. */
    cronBatch: number;
  };

  // Рекламный канал — рассылка подборки удачных роликов через Telegram-
  // бота (ТЗ §42, этап 63). Все поля со значениями по умолчанию — в
  // отличие от publishing/billing выше, здесь не нужен ни один новый
  // обязательный ключ (бот уже есть, TELEGRAM_BOT_TOKEN настроен ради
  // остального): рассылка работает "из коробки", просто с дефолтными
  // темпом и размером выпуска.
  marketing: {
    /** Не чаще одного выпуска раз в столько дней (TODO §III.4 — "потолок
     * частоты"). */
    frequencyDays: number;
    /** Сколько опубликованных страниц (SharedVideoPage) попадает в один
     * выпуск. */
    pageCount: number;
    /** Сколько строк MarketingDelivery берёт один тик крона. */
    cronBatch: number;
    /** Потолок попыток доставки одному подписчику до FAILED. */
    maxAttempts: number;
    /** Публичный адрес landing — для ссылок на карточки в тексте
     * рассылки. Пусто → сообщение уходит без ссылок, а не падает. */
    landingUrl: string;
  };

  // Пакетная генерация по каталогу (ТЗ §44, этап 65, TODO §III.5): один
  // уже одобренный ролик переносится на все остальные товары линейки за
  // один заход. Обязательных ключей нет — партия работает поверх уже
  // существующих Gemini/GPT-5/Veo и не требует своего API-ключа.
  catalogBatch: {
    /** Сколько строк CatalogBatchItem берёт один тик крона. */
    cronBatch: number;
    /** Потолок попыток обработки одного товара до FAILED. */
    maxAttempts: number;
  };

  // A/B-варианты одного ролика (TODO §III.6, этап 66): из одного уже
  // одобренного ролика собираются 3 дубля, отличающихся хуком и CTA.
  // Обязательных ключей нет — своего API-ключа не требует, работает
  // поверх уже существующих GPT-5/Veo.
  abTest: {
    /** Сколько строк AbTestVariant берёт один тик крона. */
    cronBatch: number;
    /** Потолок попыток обработки одного варианта до FAILED. */
    maxAttempts: number;
  };

  // Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68, §47):
  // разовый снимок каталога из YML/CSV-ссылки. Обязательных ключей нет —
  // своего API-ключа не требует, работает поверх уже существующих
  // ProjectService.addItem/Blob.
  productFeedImport: {
    /** Сколько строк ProductFeedImportItem берёт один тик крона. */
    cronBatch: number;
    /** Потолок попыток обработки запуска/строки до FAILED. */
    maxAttempts: number;
    /**
     * Предел размера тела фида в байтах — иначе продавец с фидом на
     * сотни мегабайт кладёт serverless-функцию по времени/памяти.
     */
    maxFeedBytes: number;
  };
}

/**
 * Parse a positive-integer env var, falling back to `fallback` when the
 * var is unset OR not a positive integer — a typo like "abc" or "-5"
 * must never turn into NaN/negative and silently disable a limit
 * (NaN > count is always false, which would make the cap never trigger).
 */
const positiveIntFromEnv = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * Load configuration from environment variables
 */
export const loadConfiguration = (): Configuration => {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    gemini: {
      apiKey:
        process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || '',
      // Не используется нигде в коде на 2026-09-13 (единственный реальный
      // источник — GEMINI_MODEL в common/gemini-model.ts) — не убираю,
      // раз это не мой объём аудита, но держу значение по умолчанию тем же,
      // что и там, чтобы не вводить в заблуждение, если это когда-то
      // подключат.
      model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    },

    openai: {
      apiKey: process.env.LAOZHANG_API_KEY || process.env.OPENAI_API_KEY || '',
      baseUrl:
        process.env.LAOZHANG_API_BASE_URL ||
        process.env.OPENAI_API_BASE_URL ||
        'https://api.laozhang.ai/v1',
      gptModel: process.env.OPENAI_GPT_MODEL || 'gpt-5',
      fastModel: process.env.OPENAI_FAST_MODEL || 'gpt-5-mini',
    },

    cors: {
      origins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    },

    serpApi: {
      apiKey: process.env.SERPAPI_API_KEY || '',
      dailyLimitPerUser: positiveIntFromEnv(
        process.env.SERPAPI_DAILY_LIMIT_PER_USER,
        50,
      ),
    },
    youtube: {
      apiKey: process.env.YOUTUBE_API_KEY || '',
      searchDailyLimitPerUser: positiveIntFromEnv(
        process.env.YOUTUBE_SEARCH_DAILY_LIMIT_PER_USER,
        20,
      ),
    },
    videoAudit: {
      autoIterationsLimit: positiveIntFromEnv(
        process.env.AUDIT_AUTO_ITERATIONS_LIMIT,
        3,
      ),
    },
    project: {
      lineItemLimit: positiveIntFromEnv(
        process.env.PROJECT_LINE_ITEM_LIMIT,
        500,
      ),
    },

    grok: {
      apiKey: process.env.GROK_API_KEY || '',
      model: process.env.GROK_MODEL || 'grok-4-fast',
      videoModel: process.env.GROK_VIDEO_MODEL || 'grok-imagine-video-1.5',
    },

    blog: {
      categories: (process.env.BLOG_CATEGORIES || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      youtubeSearchDailyLimit: positiveIntFromEnv(
        process.env.BLOG_YOUTUBE_SEARCH_DAILY_LIMIT,
        10,
      ),
      draftsPerRunLimit: positiveIntFromEnv(
        process.env.BLOG_DRAFTS_PER_RUN_LIMIT,
        5,
      ),
      minScoreToDraft: positiveIntFromEnv(
        process.env.BLOG_MIN_SCORE_TO_DRAFT,
        60,
      ),
      translateBatchLimit: positiveIntFromEnv(
        process.env.BLOG_TRANSLATE_BATCH_LIMIT,
        50,
      ),
    },

    publishing: {
      googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      googleClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      tiktokClientKey: process.env.TIKTOK_CLIENT_KEY || '',
      tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
      channelTokenKey: process.env.CHANNEL_TOKEN_KEY || '',
      cronBatch: positiveIntFromEnv(process.env.PUBLISH_CRON_BATCH, 3),
      maxAttempts: positiveIntFromEnv(process.env.PUBLISH_MAX_ATTEMPTS, 5),
      apiPublicUrl: process.env.API_PUBLIC_URL || '',
      tmaUrl: process.env.TMA_PUBLIC_URL || '',
    },
    billing: {
      telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      wayforpayMerchantAccount: process.env.WAYFORPAY_MERCHANT_ACCOUNT || '',
      wayforpayMerchantSecret: process.env.WAYFORPAY_MERCHANT_SECRET || '',
      wayforpayDomain: process.env.WAYFORPAY_DOMAIN || '',
      paymentTokenKey: process.env.PAYMENT_TOKEN_KEY || '',
      cronBatch: positiveIntFromEnv(process.env.BILLING_CRON_BATCH, 20),
    },
    marketing: {
      frequencyDays: positiveIntFromEnv(
        process.env.MARKETING_BROADCAST_FREQUENCY_DAYS,
        7,
      ),
      pageCount: positiveIntFromEnv(
        process.env.MARKETING_BROADCAST_PAGE_COUNT,
        5,
      ),
      cronBatch: positiveIntFromEnv(process.env.MARKETING_CRON_BATCH, 200),
      maxAttempts: positiveIntFromEnv(process.env.MARKETING_MAX_ATTEMPTS, 5),
      landingUrl: process.env.LANDING_PUBLIC_URL || '',
    },
    catalogBatch: {
      cronBatch: positiveIntFromEnv(process.env.CATALOG_BATCH_CRON_BATCH, 10),
      maxAttempts: positiveIntFromEnv(
        process.env.CATALOG_BATCH_MAX_ATTEMPTS,
        5,
      ),
    },
    abTest: {
      cronBatch: positiveIntFromEnv(process.env.AB_TEST_CRON_BATCH, 10),
      maxAttempts: positiveIntFromEnv(process.env.AB_TEST_MAX_ATTEMPTS, 5),
    },
    productFeedImport: {
      cronBatch: positiveIntFromEnv(
        process.env.PRODUCT_FEED_IMPORT_CRON_BATCH,
        50,
      ),
      maxAttempts: positiveIntFromEnv(
        process.env.PRODUCT_FEED_IMPORT_MAX_ATTEMPTS,
        5,
      ),
      maxFeedBytes: positiveIntFromEnv(
        process.env.PRODUCT_FEED_IMPORT_MAX_BYTES,
        8 * 1024 * 1024,
      ),
    },
  };
};

/**
 * Validate that required configuration values are present.
 * Storage (Vercel Blob) isn't checked here — it authenticates via
 * BLOB_READ_WRITE_TOKEN or Vercel's own OIDC, read directly by the
 * @vercel/blob SDK, not through this Configuration object (see
 * BlobService's doc comment).
 * @throws Error if required values are missing
 */
export const validateConfiguration = (config: Configuration): void => {
  const requiredFields = [
    {
      key: 'GEMINI_API_KEY or GOOGLE_GEMINI_API_KEY',
      value: config.gemini.apiKey,
    },
    // Ключ OpenAI/Laozhang здесь НЕ обязателен сознательно: сборка промпта
    // (GPT-5) — обязательный шаг сценария с этапа 10, но без ключа
    // PromptService отказывает на своём маршруте понятной ошибкой, а
    // стенд для проверки разбора и админки поднимается. До этапа 53
    // комментарий обещал «needed in later phases» (В-6.22).
  ];

  const missingFields = requiredFields
    .filter((field) => !field.value)
    .map((field) => field.key);

  if (missingFields.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingFields.join(', ')}`,
    );
  }
};
