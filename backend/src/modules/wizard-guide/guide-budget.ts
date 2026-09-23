/**
 * Дневной бюджет советника — «Тонкая красная линия» §5.8, найдено
 * аудитом волны C.
 *
 * ## Почему бюджет один на три операции
 *
 * До волны C платной операцией была одна — подсказка, и потолок
 * проверялся по ней. Волна C добавила ещё две: сведение дублей
 * (`wizard-sibling`) и перевод записи (`wizard-translate`). Если
 * считать потолок по-прежнему только по подсказкам, то «$2 в сутки»
 * перестаёт быть потолком фичи: жалобы с формы запускают сравнение,
 * сравнение не смотрит ни на какой бюджет, и счёт растёт мимо
 * настройки, которую оператор считает ограничителем.
 *
 * Отдельные строки в `ai-pricing.ts` при этом остаются — они нужны,
 * чтобы ВИДЕТЬ, куда ушли деньги. Ограничивает же их общая сумма:
 * оператор настраивает «сколько в сутки стоит советник», а не
 * «сколько стоит каждая его часть по отдельности».
 */

import type { AiOperation } from '../../common/ai-pricing';

/** Всё, за что платит советник. */
export const GUIDE_OPERATIONS: readonly AiOperation[] = [
  'wizard-hint',
  'wizard-sibling',
  'wizard-translate',
];

export interface SpentReader {
  spentTodayForOperation(
    operation: AiOperation | readonly AiOperation[],
  ): Promise<number>;
}

/**
 * Сколько потрачено сегодня всеми операциями советника.
 *
 * ОДНИМ запросом, а не тремя: сумма считается в базе, и три поездки к
 * одной таблице ради одного числа стоили бы дороже самого числа — а
 * проверка стоит на пути каждой подсказки.
 */
export async function guideSpentToday(
  aiUsage: SpentReader,
  operations: readonly AiOperation[] = GUIDE_OPERATIONS,
): Promise<number> {
  return aiUsage.spentTodayForOperation(operations);
}
