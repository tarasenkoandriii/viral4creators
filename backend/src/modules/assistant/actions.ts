/**
 * Разбор блока `actions` в ответе модели (ТЗ §5.4).
 *
 * Модель заканчивает ответ разделителем `<<<actions>>>` и JSON с кнопками
 * действий. Сервер режет по разделителю, парсит и ВАЛИДИРУЕТ JSON —
 * невалидный блок тихо превращается в «кнопок нет», а не в ошибку
 * ответа: посетитель получил текст, кнопки — необязательное украшение.
 */
import { PLAN_IDS } from '../../common/plans';
import { AssistantAction, AssistantActionKind } from './assistant.types';

export const ACTIONS_DELIMITER = '<<<actions>>>';

/** Не длиннее разделителя — используется буфером стриминга (assistant.service.ts). */
export const ACTIONS_DELIMITER_MAX_PREFIX = ACTIONS_DELIMITER.length;

const VALID_KINDS: readonly AssistantActionKind[] = [
  'step',
  'open-app',
  'plan',
  'faq',
  'legal',
];

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

export interface SplitResult {
  /** Текст ДО разделителя — то, что видит посетитель. */
  text: string;
  /** Всё, что было после разделителя (сырой JSON) — `null`, если разделителя не было вовсе. */
  rawActionsJson: string | null;
}

/** Режет полный текст ответа модели по разделителю (не потоково — на уже собранном тексте). */
export function splitActionsBlock(fullText: string): SplitResult {
  const idx = fullText.indexOf(ACTIONS_DELIMITER);
  if (idx === -1) return { text: fullText, rawActionsJson: null };
  return {
    text: fullText.slice(0, idx),
    rawActionsJson: fullText.slice(idx + ACTIONS_DELIMITER.length),
  };
}

function isValidAction(value: unknown): value is AssistantAction {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.kind !== 'string' ||
    !VALID_KINDS.includes(v.kind as AssistantActionKind)
  ) {
    return false;
  }
  switch (v.kind as AssistantActionKind) {
    case 'step':
      // Этап 92: обучалка выросла до 10 шагов (десятый — «Постпродакшн»).
      return typeof v.stepId === 'number' && v.stepId >= 1 && v.stepId <= 10;
    case 'open-app':
      return true;
    case 'plan':
      return (
        typeof v.planId === 'string' &&
        (PLAN_IDS as string[]).includes(v.planId)
      );
    case 'faq':
      return (
        typeof v.faqIndex === 'number' &&
        v.faqIndex >= 0 &&
        v.faqIndex < FAQ_ITEMS_COUNT
      );
    case 'legal':
      return typeof v.slug === 'string' && VALID_LEGAL_SLUGS.includes(v.slug);
    default:
      return false;
  }
}

/**
 * Разбирает и валидирует JSON после разделителя. Невалидно (битый JSON,
 * не массив, элемент не прошёл проверку, больше трёх элементов) — `[]`,
 * без исключения: разделитель уже отрезан от текста (§5.4 — «разделитель
 * никогда не попадает в стрим»), молча остаться без кнопок безопаснее,
 * чем сломать уже показанный ответ.
 */
export function parseActions(rawActionsJson: string | null): AssistantAction[] {
  if (!rawActionsJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawActionsJson);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  const valid = items.filter(isValidAction);
  return valid.slice(0, 3);
}
