/**
 * Каркас разбора блока действий после разделителя (ТЗ лендинга §5.4,
 * ТЗ помощника §4.2: «каркас `parseActions`»).
 *
 * Что здесь общее: невалидный блок тихо превращается в «кнопок нет», а
 * не в ошибку ответа (посетитель уже получил текст, кнопки — украшение);
 * белый список `kind` и проверка полей каждого `kind`; лимит числа кнопок
 * и лимиты на отдельные `kind` — ограничения КОДОМ, а не просьбой в
 * промпте, которую модель может не соблюсти. Что у каждого продукта своё:
 * словарь `kind` и правила его полей — передаются параметром.
 * Чистый модуль (см. шапку `protocol.ts`).
 */

/** Проверка полей одного `kind`; на вход — уже объект с этим `kind`. */
export type ActionFieldsValidator = (
  fields: Record<string, unknown>,
) => boolean;

/** Белый список: ключи — допустимые `kind`, значения — проверка их полей. */
export type ActionKindValidators<TKind extends string = string> = Readonly<
  Record<TKind, ActionFieldsValidator>
>;

export interface ActionsParserOptions<TKind extends string> {
  validators: ActionKindValidators<TKind>;
  /** Сколько кнопок максимум (лишние отбрасываются с конца). */
  maxItems: number;
  /**
   * Потолок на отдельные `kind` внутри уже обрезанного списка: первые
   * встреченные сохраняются, остальные молча отбрасываются.
   */
  maxPerKind?: Readonly<Partial<Record<TKind, number>>>;
}

/**
 * Проверка элемента по белому списку. `hasOwnProperty`, а не `in`/индекс:
 * `kind: "toString"` или `"__proto__"` из ответа модели не должен найти
 * унаследованное свойство объекта и пройти как «известный».
 */
export function isAllowedAction<TKind extends string>(
  value: unknown,
  validators: ActionKindValidators<TKind>,
): value is { kind: TKind } & Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string') return false;
  if (!Object.prototype.hasOwnProperty.call(validators, v.kind)) return false;
  return validators[v.kind as TKind](v);
}

/**
 * Разбирает JSON вида `{"items":[...]}` после разделителя. Битый JSON,
 * не массив, непрошедшие элементы — молча отбрасываются, без исключения.
 * Порядок: фильтр белым списком → обрезка до `maxItems` → потолки по
 * `kind` (именно в таком порядке работал лендинг, менять его — менять
 * поведение лендинга).
 */
export function parseActionsBlock<
  TAction extends { kind: TKind },
  TKind extends string,
>(
  rawActionsJson: string | null,
  options: ActionsParserOptions<TKind>,
): TAction[] {
  if (!rawActionsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawActionsJson);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const valid = items.filter((item) =>
    isAllowedAction(item, options.validators),
  ) as unknown as TAction[];
  const limited = valid.slice(0, Math.max(0, options.maxItems));

  const caps = options.maxPerKind;
  if (!caps) return limited;
  const seen = new Map<string, number>();
  return limited.filter((action) => {
    const cap = caps[action.kind];
    if (cap === undefined) return true;
    const count = seen.get(action.kind) ?? 0;
    if (count >= cap) return false;
    seen.set(action.kind, count + 1);
    return true;
  });
}
