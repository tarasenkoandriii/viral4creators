/**
 * Разбор блока `actions` в ответе модели (ТЗ §5.4).
 *
 * Модель заканчивает ответ разделителем `<<<actions>>>` и JSON с кнопками
 * действий. Сервер режет по разделителю, парсит и ВАЛИДИРУЕТ JSON —
 * невалидный блок тихо превращается в «кнопок нет», а не в ошибку
 * ответа: посетитель получил текст, кнопки — необязательное украшение.
 */
import { PLAN_IDS } from '../../common/plans';
import {
  ActionKindValidators,
  parseActionsBlock,
} from '../../common/assist-chat-core';
import { AssistantAction, AssistantActionKind } from './assistant.types';

// Протокол разделителя и его разбор — общие с Помощником (ядро
// `assist-chat-core`); здесь — только словарь действий лендинга.
// Реэкспорт, чтобы промпт, сервис и спеки лендинга не меняли импорты.
export {
  ACTIONS_DELIMITER,
  ACTIONS_DELIMITER_MAX_PREFIX,
  splitActionsBlock,
} from '../../common/assist-chat-core';
export type { SplitResult } from '../../common/assist-chat-core';

/** Разумный верхний предел длины `subjectKey` — не смысловая граница,
 * просто защита от бессмысленно длинной строки в JSON от модели. */
const SUBJECT_KEY_MAX_LENGTH = 100;

const VALID_LEGAL_SLUGS = ['offer', 'terms-of-use'];

/**
 * Сколько вопросов в FAQ базы знаний (§5.2, п.2) — `faqIndex` должен
 * попадать в этот диапазон.
 *
 * Нитпик доп. аудита (LOW) — не выводится автоматически из
 * `landing/src/dictionaries/*.json`'s `faq.items` (сейчас в каждой из
 * пяти локалей ровно 10 вопросов, см. `Faq.tsx`), а держится числом
 * руками здесь же. При добавлении/удалении вопроса в словарях эту
 * константу нужно поправить вручную — иначе `faqIndex` на новый/
 * последний вопрос будет отбрасываться валидацией ниже как «вне
 * диапазона» (см. `parseActions`). Не вынесено в общий генератор
 * (`knowledge/generated.ts`) в этом заходе — тот собирается отдельным
 * скриптом сборки знаний, а не рантаймом бэкенда.
 */
export const FAQ_ITEMS_COUNT = 10;

/**
 * Белый список `kind` лендинга и проверка полей каждого. Ключи объекта и
 * есть белый список: `kind`, которого здесь нет, отбрасывается ядром.
 */
const ACTION_VALIDATORS: ActionKindValidators<AssistantActionKind> = {
  // Этап 92: обучалка выросла до 10 шагов (десятый — «Постпродакшн»).
  step: (v) => typeof v.stepId === 'number' && v.stepId >= 1 && v.stepId <= 10,
  'open-app': () => true,
  plan: (v) =>
    typeof v.planId === 'string' && (PLAN_IDS as string[]).includes(v.planId),
  faq: (v) =>
    typeof v.faqIndex === 'number' &&
    v.faqIndex >= 0 &&
    v.faqIndex < FAQ_ITEMS_COUNT,
  legal: (v) =>
    typeof v.slug === 'string' && VALID_LEGAL_SLUGS.includes(v.slug),
  // Модель называет только subjectKey — url/title подставляет сервер
  // (assistant.service.ts's resolveVideoActions), см. assistant.types.ts.
  video: (v) =>
    typeof v.subjectKey === 'string' &&
    v.subjectKey.trim().length > 0 &&
    v.subjectKey.length <= SUBJECT_KEY_MAX_LENGTH,
};

/**
 * Разбирает и валидирует JSON после разделителя. Невалидно (битый JSON,
 * не массив, элемент не прошёл проверку, больше трёх элементов) — `[]`,
 * без исключения: разделитель уже отрезан от текста (§5.4 — «разделитель
 * никогда не попадает в стрим»), молча остаться без кнопок безопаснее,
 * чем сломать уже показанный ответ.
 *
 * Аудит §10, п.8: не больше одного video-действия на ответ — это
 * структурное ограничение в коде, а не только инструкция в промпте
 * (модель может её не соблюсти). Первое встреченное сохраняется,
 * остальные молча отбрасываются.
 */
export function parseActions(rawActionsJson: string | null): AssistantAction[] {
  return parseActionsBlock<AssistantAction, AssistantActionKind>(
    rawActionsJson,
    { validators: ACTION_VALIDATORS, maxItems: 3, maxPerKind: { video: 1 } },
  );
}
