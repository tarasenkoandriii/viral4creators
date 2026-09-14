/**
 * Прайс на внешние платные вызовы (ТЗ §26, этап 31).
 *
 * Одна таблица на весь продукт: и запись расхода, и вкладка «Расходы» в
 * админке считают деньги отсюда. Ставки живут в коде, а не в базе,
 * сознательно — прайс это не пользовательские данные, у него должна быть
 * история правок в git и дата, к которой он относится. Любую ставку можно
 * переопределить переменной окружения, чтобы смена цены у провайдера не
 * требовала деплоя.
 *
 * ## Честно о цифрах
 *
 * Ставки Gemini сверены с `ai.google.dev/gemini-api/docs/pricing`
 * 2026-09-06. Ставки Veo и GPT-5 на официальных страницах на эту дату
 * не нашлись (Veo вынесен из общего прайса, GPT-5 вытеснен более новыми
 * моделями) — взяты опубликованные при запуске. **Перед тем как верить
 * колонке с деньгами, проверьте прайс и при расхождении поправьте
 * переменными окружения**; вкладка «Расходы» показывает версию прайса
 * рядом с суммой именно поэтому.
 *
 * ## Деньги в микродолларах
 *
 * Везде целые микродоллары (1 USD = 1 000 000). Сложение float-долларов
 * по десяткам тысяч строк даёт дрейф в копейках, а сумма расходов —
 * единственная цифра на этой вкладке, которой обязаны верить. В доллары
 * пересчитывает интерфейс, один раз, на готовой сумме.
 */

/** Версия прайса. Пишется в каждую строку расхода. Менять при правке ставок. */
export const PRICING_VERSION = '2026-09-06';

export type AiProvider =
  | 'GEMINI'
  | 'OPENAI'
  | 'VEO'
  | 'SERPAPI'
  | 'YOUTUBE'
  | 'FFMPEG'
  | 'ELEVENLABS'
  // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md — второй провайдер синтеза,
  // переключаемый TTS_PROVIDER (tts.module.ts), не замена ELEVENLABS.
  | 'RESEMBLE'
  | 'GROK'
  // doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md — движок пилота говорящего
  // AI-аватара (Hedra Character-3), этап 72.
  | 'HEDRA';

export const AI_PROVIDERS: readonly AiProvider[] = [
  'GEMINI',
  'OPENAI',
  'VEO',
  'SERPAPI',
  'YOUTUBE',
  'FFMPEG',
  'ELEVENLABS',
  'RESEMBLE',
  'GROK',
  'HEDRA',
];

/** Операции, за которые сервис платит. Значения попадают в БД как есть. */
export type AiOperation =
  | 'analysis'
  | 'relevance'
  | 'audit'
  | 'transcribe'
  | 'product-photo'
  | 'prompt'
  | 'generation'
  | 'analog-search'
  | 'video-search'
  | 'reframe'
  | 'voiceover'
  | 'voiceover-preview'
  // Перевод статьи блога через Grok Batch API (ТЗ §35.1, этап 57) —
  // отдельная операция, а не переиспользование 'analysis'/'prompt':
  // цена и провайдер (GROK) у неё свои, и в отчёте расходов (§26) она
  // должна быть видна отдельной строкой, не смешанной с разбором ролика.
  | 'translate'
  // Разбор трендового ролика для черновика блога (doc/TODO.md §II.3,
  // этап 57) — отдельно от 'analysis': то разбирает ЧУЖОЙ референс по
  // просьбе пользователя и стоит из его суточного потолка, это разбирает
  // ролик из суточного крона блога и ни к какому пользователю не
  // привязано — смешивать их в одной строке отчёта значило бы прятать,
  // сколько стоит контент блога, за спиной обычных пользователей.
  | 'blog-analysis'
  // Перевод уже готового разбора видео на локаль сессии (ТЗ §35.5, этап
  // 59) — отдельно от 'analysis': тот вызов — по всему видео и самый
  // дорогой в продукте, этот — дешёвый текстовый вызов поверх уже
  // готового JSON, и в отчёте расходов их нельзя путать местами.
  | 'analysis-translate'
  // A/B-варианты одного ролика (TODO §III.6, этап 66) — отдельно от
  // 'prompt': один вызов сразу пишет 3 альтернативных промпта (другой
  // профиль по токенам и стоимости), и в отчёте расходов эта строка
  // должна быть видна отдельно от обычной сборки одного промпта.
  | 'ab-variants'
  // Пилот говорящего AI-аватара (doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md
  // §4.2, этап 72) — отдельно от 'generation' (Veo): другой провайдер,
  // другая ставка, отдельная ветка пайплайна, не должна смешиваться в
  // отчёте с обычной генерацией ролика.
  | 'avatar-generation'
  // Клонирование голоса пользователем (этап 73, TODO п.32,
  // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.3) — отдельно от
  // 'voiceover'/'voiceover-preview': то платит за СИНТЕЗ речи уже
  // готовым голосом, это платит за само ОБУЧЕНИЕ нового голоса у
  // Resemble, один раз на клон, не за каждый ролик.
  | 'voice-clone'
  // Переписывание сцены под метки <IMAGE_N> для Grok reference-to-video
  // (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §15.3) — отдельно от 'prompt':
  // узкий, дешёвый шаг поверх уже готового текста сцены, не сама сборка
  // промпта, должен быть виден в отчёте расходов отдельной строкой.
  | 'grok-reference-rewrite'
  // Найдено при аудите: `extractLiteralTexts()` (§20.2 того же ТЗ)
  // изначально писался под операцию 'prompt' — но по той же самой
  // причине, что уже разделила 'grok-reference-rewrite' выше: узкий,
  // дешёвый шаг ПОСЛЕ уже готового промпта (вычленяет text-card
  // моменты из готового текста), не сама сборка. Та же логика,
  // непоследовательно применённая с первого раза — исправлено при
  // повторном проходе, не сразу.
  | 'text-extraction';

export const AI_OPERATION_LABEL: Record<AiOperation, string> = {
  analysis: 'Разбор референса',
  relevance: 'Релевантность',
  audit: 'Аудит ролика',
  transcribe: 'Расшифровка голоса',
  'product-photo': 'Распознавание фото товара',
  prompt: 'Сборка промпта',
  'ab-variants': 'A/B-варианты (хук/CTA)',
  generation: 'Генерация ролика',
  'analog-search': 'Поиск аналогов',
  'video-search': 'Поиск на YouTube',
  reframe: 'Обрезка кадра',
  voiceover: 'Озвучка',
  'voiceover-preview': 'Проба голоса',
  translate: 'Перевод статьи блога',
  'blog-analysis': 'Разбор ролика для блога',
  'analysis-translate': 'Перевод разбора видео',
  'avatar-generation': 'Аватар-видео (пилот)',
  'voice-clone': 'Клонирование голоса',
  'grok-reference-rewrite': 'Переписывание сцены для Grok-референсов',
  'text-extraction': 'Извлечение текста на экране',
};

export interface ModelRate {
  provider: AiProvider;
  /** Цена за миллион входных токенов, в микродолларах. */
  inputPerMTok?: number;
  /**
   * Цена за миллион ПОВТОРНО ИСПОЛЬЗОВАННЫХ входных токенов (кеш) — она
   * заметно ниже обычной, и провайдер отдаёт их отдельным счётчиком
   * (§26.1). Не задана — кеш считается по обычной ставке, то есть расход
   * завышается; так было до этапа 32.
   */
  cachedInputPerMTok?: number;
  /** Цена за миллион выходных токенов, в микродолларах. */
  outputPerMTok?: number;
  /** Цена за секунду сгенерированного видео, в микродолларах. */
  perSecond?: number;
  /** Цена за один вызов, в микродолларах (поштучные API). */
  perCall?: number;
  /**
   * Цена за миллион символов синтезированной речи, в микродолларах.
   * У TTS счёт идёт в символах, а не в токенах: провайдер считает именно
   * их, и подгонять это под «токены» значило бы врать в отчёте.
   */
  perMChars?: number;
  /** Откуда ставка и насколько ей верить. */
  note: string;
}

const USD = 1_000_000;

/**
 * Ключ переменной окружения для ставки: модель в верхнем регистре, всё
 * кроме букв и цифр — в подчёркивание. `gemini-2.5-flash` + `input` →
 * `AI_PRICE_GEMINI_2_5_FLASH_INPUT`. Значение — доллары (как в прайсе
 * провайдера), не микродоллары: переменную задаёт человек, глядя на
 * страницу с ценами, и заставлять его умножать на миллион — верный способ
 * получить ошибку в тысячу раз.
 */
export function priceEnvKey(
  model: string,
  kind: 'input' | 'cached' | 'output' | 'second' | 'call' | 'chars',
): string {
  return `AI_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${kind.toUpperCase()}`;
}

/** Ставки по умолчанию. Значения — в микродолларах (см. `USD`). */
export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  'gemini-2.5-flash': {
    provider: 'GEMINI',
    inputPerMTok: 0.3 * USD,
    // Кеш-чтение у Gemini дешевле обычного входа вчетверо.
    cachedInputPerMTok: 0.075 * USD,
    outputPerMTok: 2.5 * USD,
    note: 'ai.google.dev, сверено 2026-09-06; ставка кеша — четверть входной',
  },
  'gemini-2.5-pro': {
    provider: 'GEMINI',
    inputPerMTok: 1.25 * USD,
    cachedInputPerMTok: 0.3125 * USD,
    outputPerMTok: 10 * USD,
    note: 'ai.google.dev, сверено 2026-09-06 (ставка для запросов до 200k токенов); ставка кеша — четверть входной',
  },
  // Найдено при аудите (Gemini API вернул 404 на новый ключ — `gemini-2.5-flash`
  // недоступна новым пользователям, Google сам указал заменить на эту модель).
  // Официальная страница cloud.google.com/gemini-enterprise-agent-platform:
  // вводная ставка $0.75/$3.75 за 1M токенов действует ДО 31.12.2026, затем
  // вырастет до $1.50/$7.50 — если счёт разойдётся после 2027-01-01, первым
  // делом проверить именно эту дату, не искать другую причину.
  'gemini-3.6-flash': {
    provider: 'GEMINI',
    inputPerMTok: 0.75 * USD,
    // Кеш-чтение — 1/10 от входной ставки (cloud.google.com), не 1/4, как у
    // 2.5-flash/2.5-pro выше — разные модели, разная скидка на кеш.
    cachedInputPerMTok: 0.075 * USD,
    outputPerMTok: 3.75 * USD,
    note: 'cloud.google.com, сверено 2026-09-13; вводная ставка до 2026-12-31, далее $1.50/$7.50',
  },
  'veo-3.1-generate-preview': {
    provider: 'VEO',
    perSecond: 0.4 * USD,
    note: 'опубликованная при запуске ставка; на прайс-странице на 2026-09-06 не нашлась — ПРОВЕРИТЬ',
  },
  'veo-3.1-lite-generate-preview': {
    provider: 'VEO',
    perSecond: 0.15 * USD,
    note: 'опубликованная при запуске ставка; на прайс-странице на 2026-09-06 не нашлась — ПРОВЕРИТЬ',
  },
  // Доп. запрос владельца продукта: авто-выбор Veo 3.0 для сессий без
  // персонажей бренда (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §1, этап 5
  // плана §14) — ради `negativePrompt`, которого нет на 3.1.
  //
  // ОТКЛЮЧЕНО (2026-09-13): реальный сбой в проде подтвердил
  // предупреждение — `veo-3.0-generate-001` (первая догадка) дал 404
  // NOT_FOUND у Gemini API. Функция выбора выключена целиком
  // (`VEO_3_0_ENABLED` в `common/veo-model-choice.ts`) — эта строка
  // прайса сейчас ничем не используется, оставлена только на случай,
  // если Veo 3.0 включат снова после реальной проверки. Ключ обновлён
  // на вторую догадку (`-preview`, по аналогии с уже рабочей
  // `veo-3.1-generate-preview`) — тоже НЕ подтверждена реальным
  // вызовом, доверия к ней ровно на одну неудачную попытку меньше.
  'veo-3.0-generate-preview': {
    provider: 'VEO',
    perSecond: 0.4 * USD,
    note: 'ID модели и цена — не подтверждены официально, Veo 3.0 deprecated, функция отключена — ПРОВЕРИТЬ обязательно перед повторным включением',
  },
  // Доп. запрос владельца продукта: Grok как провайдер видео (ТЗ
  // VEO-MODEL-VERSION-CHOICE-SPEC.md §10–11). Одна модель xAI,
  // ТРИ ставки по разрешению (§10.2 ТЗ, официально: docs.x.ai,
  // модель `grok-imagine-video-1.5`) — `ModelRate.perSecond` держит
  // ОДНУ ставку на модель, а не запись под разрешение, поэтому три
  // отдельных ключа с суффиксом разрешения, а не правка структуры
  // `ModelRate` целиком (свободная строка — `MODEL_RATES` уже
  // `Record<string, ModelRate>`, составной ключ не требует нового
  // поля). `generation.service.ts`/`grok-video.service.ts` передают
  // сюда именно эту составную строку, не голое имя модели.
  'grok-imagine-video-1.5:480p': {
    provider: 'GROK',
    perSecond: 0.08 * USD,
    note: 'docs.x.ai, сверено при подготовке ТЗ (§10.2) — ПРОВЕРИТЬ перед стройкой',
  },
  'grok-imagine-video-1.5:720p': {
    provider: 'GROK',
    perSecond: 0.14 * USD,
    note: 'docs.x.ai, сверено при подготовке ТЗ (§10.2) — ПРОВЕРИТЬ перед стройкой',
  },
  'grok-imagine-video-1.5:1080p': {
    provider: 'GROK',
    perSecond: 0.25 * USD,
    note: 'docs.x.ai, сверено при подготовке ТЗ (§10.2) — ПРОВЕРИТЬ перед стройкой',
  },
  'gpt-5': {
    provider: 'OPENAI',
    inputPerMTok: 1.25 * USD,
    // У OpenAI кешированный вход дешевле обычного в десять раз.
    cachedInputPerMTok: 0.125 * USD,
    outputPerMTok: 10 * USD,
    note: 'ставка на момент выпуска GPT-5; в текущем прайсе OpenAI модели уже нет — ПРОВЕРИТЬ',
  },
  serpapi: {
    provider: 'SERPAPI',
    // 5000 поисков за $150 на среднем тарифе → 3 цента за поиск.
    perCall: 0.03 * USD,
    note: 'из тарифа $150 / 5000 поисков; зависит от вашего плана — ПРОВЕРИТЬ',
  },
  'ffmpeg-api': {
    provider: 'FFMPEG',
    // Обрезка восьмисекундного ролика — секунды работы. Точная ставка
    // зависит от тарифа сервиса и здесь заведомо приблизительна.
    perCall: 0.01 * USD,
    note: 'оценка за одну обрезку восьмисекундного ролика; зависит от вашего тарифа — ПРОВЕРИТЬ',
  },
  'elevenlabs-tts': {
    provider: 'ELEVENLABS',
    // Тариф Creator: $22 за 100 000 символов → $0.22 за тысячу.
    perMChars: 220 * USD,
    note: 'из тарифа Creator ($22 / 100 000 символов); зависит от вашего плана — ПРОВЕРИТЬ',
  },
  'resemble-tts': {
    provider: 'RESEMBLE',
    // Официальная resemble.ai/pricing на момент проверки (сентябрь
    // 2026) описывала другой продукт (детекция дипфейков), не
    // TTS/клонирование — doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md,
    // находка 6.3. Число ниже — оценка со вторичного источника
    // (checkthat.ai/brands/resemble-ai/pricing: $0.0005/сек синтеза,
    // Flex-план), переведённая в символы грубым допущением
    // ≈15 симв/сек живой речи, а не проверенный по счёту прайс.
    // ОБЯЗАТЕЛЬНО перепроверить из личного кабинета Resemble перед
    // реальным переключением TTS_PROVIDER=resemble в продакшн.
    perMChars: 33 * USD,
    note: 'грубая оценка от $0.0005/сек (вторичный источник, не resemble.ai/pricing напрямую) — ПРОВЕРИТЬ из личного кабинета перед продакшном',
  },
  'hedra-character-3': {
    provider: 'HEDRA',
    // doc/AVATAR-LIPSYNC-PIPELINE-SPEC.md §2/§4.2: Character-3 — 6
    // кредитов/сек, тарифы Basic $15/мес (1500 кред. → ≈$0.06/сек),
    // Creator $30/мес (5400 кред. → ≈$0.033/сек), Professional
    // $75/мес (14400 кред. → ≈$0.031/сек). Официальной страницы с
    // точным $/сек не нашлось (вторичный источник — makefun.ai),
    // взята середина диапазона тарифов Creator/Professional.
    // ОБЯЗАТЕЛЬНО перепроверить из личного кабинета Hedra и/или через
    // `POST /models/{model}/estimate` перед реальным использованием —
    // тот же класс предупреждения, что уже стоит у 'resemble-tts'.
    perSecond: 0.033 * USD,
    note: 'оценка по опубликованным тарифным планам (makefun.ai, не официальный $/сек) — ПРОВЕРИТЬ из личного кабинета или /models/{model}/estimate перед продакшном',
  },
  'resemble-voice-clone': {
    provider: 'RESEMBLE',
    // doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md, находка 6.3/§4.3/5.2б:
    // официальная страница цен на дату проверки описывала другой
    // продукт (детекция дипфейков), а деление вторичного источника
    // «rapid $2/мес / professional $5/мес за голос» не подтвердилось в
    // docs.resemble.ai — единого процесса клонирования там нет
    // отдельного $/клон. Ставка ниже — нижняя граница того диапазона
    // ($2), как консервативная оценка ОДНОРАЗОВОГО платежа за клон (не
    // подписка) до первого реального вызова с ключом.
    perCall: 2 * USD,
    note: 'нижняя граница диапазона вторичного источника ($2–5/голос), не найдено в docs.resemble.ai напрямую — ПРОВЕРИТЬ из личного кабинета перед продакшном',
  },
  'youtube-data-api': {
    provider: 'YOUTUBE',
    // Бесплатная квота 10 000 единиц в сутки; поиск стоит 100 единиц, но
    // денег не стоит, пока квота не превышена. Ноль здесь — не «забыли
    // ставку», а «этот вызов действительно бесплатный».
    perCall: 0,
    note: 'бесплатная суточная квота (поиск = 100 единиц из 10 000)',
  },

  // Модели xAI Grok (grok-4-fast и т.п., GrokBatchService, ТЗ §35.1) —
  // СОЗНАТЕЛЬНО без записи здесь. Реальный тариф Batch API (docs.x.ai —
  // на 20-50% дешевле синхронных вызовов, но точная ставка за токен не
  // проверена на дату этой правки) придумывать нельзя — правило прайса в
  // шапке файла. До появления сверенной ставки вызовы Grok честно пишутся
  // как `unpriced: true` (estimateCost вернёт это само, без ветки здесь);
  // добавить запись, когда ставка будет сверена с console.x.ai/докой.
};

/** Ставка модели с учётом переопределения переменными окружения. */
export function rateFor(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelRate | null {
  const base = MODEL_RATES[model];
  if (!base) return null;

  const override = (
    kind: 'input' | 'cached' | 'output' | 'second' | 'call' | 'chars',
    current: number | undefined,
  ): number | undefined => {
    const raw = env[priceEnvKey(model, kind)];
    if (raw === undefined || raw.trim() === '') return current;
    const dollars = Number(raw);
    // Мусор в переменной не должен молча обнулить ставку: лучше остаться
    // на значении из кода, чем показать нулевой расход как правду.
    if (!Number.isFinite(dollars) || dollars < 0) return current;
    return Math.round(dollars * USD);
  };

  return {
    ...base,
    inputPerMTok: override('input', base.inputPerMTok),
    cachedInputPerMTok: override('cached', base.cachedInputPerMTok),
    outputPerMTok: override('output', base.outputPerMTok),
    perSecond: override('second', base.perSecond),
    perCall: override('call', base.perCall),
    perMChars: override('chars', base.perMChars),
  };
}

export interface UsageUnits {
  /**
   * Все входные токены запроса, включая кешированные, — ровно как их
   * считает провайдер. Кеш вычитается при расчёте, а не при записи:
   * хранить надо то, что реально пришло в ответе.
   */
  inputTokens?: number;
  /** Из них повторно использованные (кеш) — тарифицируются дешевле. */
  cachedInputTokens?: number;
  outputTokens?: number;
  seconds?: number;
  calls?: number;
  /** Символы, ушедшие в синтез речи. */
  characters?: number;
}

export interface CostEstimate {
  costMicroUsd: number;
  /** Ставки для модели не нашлось: объём записан, деньги — нули. */
  unpriced: boolean;
  pricingVersion: string;
}

/**
 * Стоимость одного вызова в микродолларах. Чистая функция — её и
 * проверяют тесты; сервису остаётся только записать результат.
 *
 * Неизвестная модель НЕ считается бесплатной: расход равен нулю, но
 * `unpriced` поднят, и вкладка показывает такие вызовы отдельной строкой.
 * Иначе новая модель, добавленная в код и забытая в прайсе, тихо занижала
 * бы общую сумму — самый неприятный вид ошибки в отчёте о деньгах.
 */
export function estimateCost(
  model: string,
  units: UsageUnits,
  env: NodeJS.ProcessEnv = process.env,
): CostEstimate {
  const rate = rateFor(model, env);
  if (!rate) {
    return { costMicroUsd: 0, unpriced: true, pricingVersion: PRICING_VERSION };
  }

  let micro = 0;
  if (rate.inputPerMTok !== undefined && units.inputTokens) {
    // Кешированные токены входят в общий счётчик входа, поэтому их надо
    // ВЫЧЕСТЬ, а не просто добавить отдельной строкой: иначе один и тот
    // же токен оплачивается дважды.
    const cached = Math.min(
      Math.max(units.cachedInputTokens ?? 0, 0),
      units.inputTokens,
    );
    const fresh = units.inputTokens - cached;
    micro += (fresh / 1_000_000) * rate.inputPerMTok;
    micro +=
      (cached / 1_000_000) * (rate.cachedInputPerMTok ?? rate.inputPerMTok);
  }
  if (rate.outputPerMTok !== undefined && units.outputTokens) {
    micro += (units.outputTokens / 1_000_000) * rate.outputPerMTok;
  }
  if (rate.perSecond !== undefined && units.seconds) {
    micro += units.seconds * rate.perSecond;
  }
  if (rate.perMChars !== undefined && units.characters) {
    micro += (units.characters / 1_000_000) * rate.perMChars;
  }
  if (rate.perCall !== undefined) {
    micro += (units.calls ?? 1) * rate.perCall;
  }

  return {
    costMicroUsd: Math.round(micro),
    unpriced: false,
    pricingVersion: PRICING_VERSION,
  };
}

/** Микродоллары → строка вида «$1.23» / «$0.0042» для интерфейса. */
export function formatMicroUsd(micro: number): string {
  const usd = micro / USD;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Прайс в виде, пригодном для показа оператору (без переменных окружения в ответе). */
export function pricingTable(env: NodeJS.ProcessEnv = process.env): Array<{
  model: string;
  provider: AiProvider;
  inputPerMTokUsd: number | null;
  cachedInputPerMTokUsd: number | null;
  outputPerMTokUsd: number | null;
  perSecondUsd: number | null;
  perCallUsd: number | null;
  perMCharsUsd: number | null;
  overridden: boolean;
  note: string;
}> {
  return Object.keys(MODEL_RATES).map((model) => {
    const base = MODEL_RATES[model];
    const rate = rateFor(model, env)!;
    const overridden =
      rate.inputPerMTok !== base.inputPerMTok ||
      rate.cachedInputPerMTok !== base.cachedInputPerMTok ||
      rate.outputPerMTok !== base.outputPerMTok ||
      rate.perSecond !== base.perSecond ||
      rate.perCall !== base.perCall ||
      rate.perMChars !== base.perMChars;
    const usd = (v: number | undefined) => (v === undefined ? null : v / USD);
    return {
      model,
      provider: rate.provider,
      inputPerMTokUsd: usd(rate.inputPerMTok),
      cachedInputPerMTokUsd: usd(rate.cachedInputPerMTok),
      outputPerMTokUsd: usd(rate.outputPerMTok),
      perSecondUsd: usd(rate.perSecond),
      perCallUsd: usd(rate.perCall),
      perMCharsUsd: usd(rate.perMChars),
      overridden,
      note: rate.note,
    };
  });
}
