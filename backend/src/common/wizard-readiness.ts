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
