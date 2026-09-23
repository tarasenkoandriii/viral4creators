/**
 * Готовность к цели — «Тонкая красная линия», этап 4
 * (docs-tz/TZ-Tonkaya-Krasnaya-Liniya.md §7).
 *
 * ## Почему это чистая функция, а не вопрос к модели
 *
 * Ответ «чего ещё не хватает» обязан быть точным, одинаковым каждый
 * раз, бесплатным и работать при выключенном ИИ. Модель ни одного из
 * этих четырёх свойств не гарантирует, а список требований и так
 * существует в коде — просто в виде исключений, которые человек видит,
 * только НАЖАВ кнопку, то есть в конце пути.
 *
 * ## Один источник правды
 *
 * Условия переезжают СЮДА, а места, которые раньше бросали
 * `BadRequestException` сами, начинают читать эту функцию. Два
 * независимых списка требований расходятся — это не гипотеза, а то, как
 * ведут себя любые два списка; в этом же репозитории условия запуска
 * генерации уже написаны трижды.
 */

export interface ReadinessItem {
  /** Машинный ключ; подпись даёт интерфейс, у которого есть языки. */
  key: string;
  /** Шаг, на котором это заполняется, — чтобы строка кликалась. */
  stepId: string;
  /**
   * `false` — влияет на качество, но не блокирует.
   *
   * Отдельный признак, а не два списка: свалить всё в «обязательно» —
   * соврать, а не показать вовсе — молча отдать человеку худший ролик.
   */
  required: boolean;
  done: boolean;
}

export interface Readiness {
  items: ReadinessItem[];
  /** Сколько обязательных пунктов не закрыто. */
  missingRequired: number;
  canGenerate: boolean;
}

export function readinessOf(items: ReadinessItem[]): Readiness {
  const missingRequired = items.filter((i) => i.required && !i.done).length;
  return { items, missingRequired, canGenerate: missingRequired === 0 };
}

/** Что знает о черновике обучалки готовность. Ровно три факта. */
export interface ClientSiteReadinessInput {
  status: string;
  frames: number;
  title: string | null;
}

/**
 * Готовность обучалки по сайту заказчика.
 *
 * Список ровно повторяет предусловия `finish()`
 * (`client-site-tutorial.service.ts`): черновик редактируем, есть хотя
 * бы один кадр, задан заголовок.
 *
 * Числа «осталось N шагов» здесь нет и быть не может: раундов записи
 * столько, сколько потребует сайт заказчика, и заранее их не знает
 * никто. Прогресс-бар, не знающий своей длины, врёт каждым пикселем —
 * поэтому наружу идут условия, а интерфейс показывает состояние.
 */
export function clientSiteReadiness(
  draft: ClientSiteReadinessInput | null,
): Readiness {
  const editable = draft?.status === 'DRAFTING';
  return readinessOf([
    {
      key: 'draft',
      stepId: 'url',
      required: true,
      done: Boolean(draft),
    },
    {
      key: 'frames',
      stepId: 'record',
      required: true,
      done: (draft?.frames ?? 0) > 0,
    },
    {
      key: 'title',
      stepId: 'review',
      required: true,
      done: Boolean(draft?.title?.trim()),
    },
    {
      // Не блокирует: доработать черновик после модерации — обычный
      // путь, а не ошибка. Но сказать об этом надо, иначе человек
      // жмёт «Готово» и получает отказ без объяснения.
      key: 'editable',
      stepId: 'review',
      required: false,
      done: editable,
    },
  ]);
}

// ── Greeting (волна D, этап 12) ──────────────────────────────────────

/**
 * Что знает о поздравлении готовность.
 *
 * Ровно те факты, по которым сервер отказывает в рендере
 * (`GreetingVideoService.startVideo`), плюс два необязательных, которые
 * заметно влияют на результат. Ни одного поля «на всякий случай»:
 * лишний пункт в списке — это лишний повод человеку решить, что он
 * что-то не доделал.
 */
export interface GreetingReadinessInput {
  occasion: string;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  /** Ведущий — говорящий аватар: ему обязательно нужно лицо. */
  usesAvatar: boolean;
  /** Сколько фото-референсов добавлено. */
  referenceImages: number;
  hasPrompt: boolean;
  /** Сценарий не прошёл модерацию — рендер откажет. */
  promptFlagged: boolean;
}

/**
 * Готовность поздравления.
 *
 * ## Почему часть пунктов появляется и исчезает
 *
 * «Текст повода» нужен только при поводе «другое», «лицо ведущего» —
 * только у говорящего аватара, «сценарий прошёл проверку» — только
 * когда сценарий уже есть. Показывать их всегда значило бы считать
 * «осталось 4 пункта» там, где до кнопки один шаг, и объяснять
 * человеку, что два из четырёх к нему не относятся.
 *
 * Это отличие от обучалки, где список фиксирован: там условия не
 * зависят ни от выбора ведущего, ни от повода.
 */
export function greetingReadiness(input: GreetingReadinessInput): Readiness {
  const items: ReadinessItem[] = [
    {
      key: 'recipient',
      stepId: 'brief',
      required: true,
      done: !!input.recipientName.trim(),
    },
  ];

  if (input.occasion === 'OTHER') {
    items.push({
      key: 'occasionText',
      stepId: 'brief',
      required: true,
      done: !!input.customOccasionText?.trim(),
    });
  }

  if (input.usesAvatar) {
    items.push({
      key: 'face',
      stepId: 'references',
      required: true,
      done: input.referenceImages > 0,
    });
  }

  items.push({
    key: 'script',
    stepId: 'script',
    required: true,
    done: input.hasPrompt,
  });

  if (input.hasPrompt) {
    items.push({
      key: 'scriptClean',
      stepId: 'script',
      required: true,
      done: !input.promptFlagged,
    });
  }

  // Качество. Отправитель не обязателен — поздравление без подписи
  // законно, но почти всегда это забытое поле, а не решение.
  items.push({
    key: 'sender',
    stepId: 'brief',
    required: false,
    done: !!input.senderName?.trim(),
  });
  if (!input.usesAvatar) {
    items.push({
      key: 'photos',
      stepId: 'references',
      required: false,
      done: input.referenceImages > 0,
    });
  }

  return readinessOf(items);
}

// ── Товарка (волна D, этап 13) ───────────────────────────────────────

/**
 * Что знает о прогоне товарки готовность.
 *
 * Список собран ПО КОДУ, а не по памяти: два условия бросает
 * `PromptService.generatePrompt` (разбор завершён, товар описан), два —
 * `GenerationService` (промпт одобрен, фото товара загружено). Прежняя
 * формулировка ТЗ («цена + непустое описание») описывала готовность
 * товара в каталоге, а не готовность прогона (аудит ТЗ перед волной D).
 */
export interface ProductReadinessInput {
  /** Разбор референса завершён (`videoAnalysis.status === 'complete'`). */
  analysisComplete: boolean;
  /** Снимок товара в сессии есть. */
  hasProductInfo: boolean;
  /** Активное изображение товара разрешается резолвером. */
  hasProductImage: boolean;
  /** `generationPrompt.approvedAt` проставлен. */
  promptApproved: boolean;
  /** Качество: снимок бренд-манифеста в сессии. */
  hasBrandManifest: boolean;
}

export function productReadiness(input: ProductReadinessInput): Readiness {
  return readinessOf([
    {
      key: 'analysis',
      stepId: 'analysis',
      required: true,
      done: input.analysisComplete,
    },
    {
      key: 'product',
      stepId: 'product',
      required: true,
      done: input.hasProductInfo,
    },
    {
      key: 'photo',
      stepId: 'product',
      required: true,
      done: input.hasProductImage,
    },
    {
      key: 'prompt',
      stepId: 'prompt',
      required: true,
      done: input.promptApproved,
    },
    {
      // Не блокирует: ролик соберётся и без манифеста, но вне
      // фирменного стиля — а это ровно то, ради чего его заводят.
      key: 'brandManifest',
      stepId: 'product',
      required: false,
      done: input.hasBrandManifest,
    },
  ]);
}
