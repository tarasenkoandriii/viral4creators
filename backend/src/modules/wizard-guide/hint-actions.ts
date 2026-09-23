/**
 * Действия под подсказкой — «Тонкая красная линия» §5.7, этап 7.
 *
 * Механика взята у лендингового ассистента (`assistant/actions.ts`):
 * блок после разделителя, строгий JSON, не больше трёх штук. НАБОР —
 * свой: у ассистента он лендинговый (`step | open-app | plan | faq |
 * legal | video`), и внутри мини-аппа «открыть приложение» и «шаг
 * лендинговой обучалки» бессмысленны.
 *
 * Два правила скопированы дословно, потому что там они уже доказали
 * себя:
 *
 * 1. **Модель называет только идентификатор.** Подпись и адрес
 *    подставляет сервер. Иначе модель однажды придумает ссылку — и она
 *    будет выглядеть настоящей.
 * 2. **Невалидное действие отбрасывается молча, ответ остаётся.**
 *    Кнопка на несуществующий шаг хуже отсутствия кнопки: человек
 *    жмёт, ничего не происходит, и виноват в этом продукт.
 */

export const HINT_ACTIONS_DELIMITER = '<<<actions>>>';

/** Не больше трёх: четвёртая кнопка под однострочным советом — это уже меню. */
export const MAX_HINT_ACTIONS = 3;

/**
 * Слаги документов, на которые можно повесить кнопку.
 *
 * Тот же список, что у лендингового ассистента (`VALID_LEGAL_SLUGS`), и
 * по той же причине: слаг — это адрес страницы, и открытый набор
 * означал бы, что модель однажды придумает адрес, который выглядит
 * настоящим. Список короткий намеренно: в мастере уместна ссылка на
 * условия, а не экскурсия по сайту.
 */
export const HINT_DOC_SLUGS: readonly string[] = ['offer', 'terms-of-use'];

export type GuideActionKind =
  /** Перейти на другой шаг ЭТОГО же мастера. */
  | 'goto-step'
  /** Открыть документ по слагу из белого списка. */
  | 'open-doc';

export interface GuideAction {
  kind: GuideActionKind;
  /** goto-step: идентификатор шага этого сценария. */
  stepId?: string;
  /** open-doc: слаг из белого списка. */
  slug?: string;
}

export interface SplitHint {
  /** Текст подсказки без блока действий. */
  text: string;
  /** Сырой JSON действий или `null`, если блока не было. */
  actionsJson: string | null;
}

/** Отделить блок действий от текста. */
export function splitHintActions(full: string): SplitHint {
  const at = full.indexOf(HINT_ACTIONS_DELIMITER);
  if (at < 0) return { text: full.trim(), actionsJson: null };
  return {
    text: full.slice(0, at).trim(),
    actionsJson: full.slice(at + HINT_ACTIONS_DELIMITER.length).trim() || null,
  };
}

/**
 * Разбор и проверка действий.
 *
 * `knownSteps` — идентификаторы шагов ЭТОГО сценария, тот же список,
 * что рисует степпер. Второго списка не заводим: он разошёлся бы, и
 * кнопки начали бы вести в никуда ровно на тех шагах, которые
 * переименовали.
 */
export function parseHintActions(
  actionsJson: string | null,
  knownSteps: readonly string[],
  knownDocs: readonly string[] = [],
): GuideAction[] {
  if (!actionsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(actionsJson);
  } catch {
    // Модель не справилась с JSON — подсказка при этом в порядке.
    return [];
  }
  const items = (parsed as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];

  const out: GuideAction[] = [];
  for (const raw of items) {
    if (out.length >= MAX_HINT_ACTIONS) break;
    const item = raw as Partial<GuideAction>;
    if (item?.kind === 'goto-step') {
      if (typeof item.stepId === 'string' && knownSteps.includes(item.stepId)) {
        out.push({ kind: 'goto-step', stepId: item.stepId });
      }
      continue;
    }
    if (item?.kind === 'open-doc') {
      if (typeof item.slug === 'string' && knownDocs.includes(item.slug)) {
        out.push({ kind: 'open-doc', slug: item.slug });
      }
    }
  }
  return out;
}
