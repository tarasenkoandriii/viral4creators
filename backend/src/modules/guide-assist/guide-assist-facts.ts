/**
 * Факты гида как ответы OpenAPI-эндпоинтов для «Админки» помощника
 * платформы (Э-С Ш6, Э7 `read`).
 *
 * Принцип `hint-facts.ts` сохранён: наружу уходят ФАКТЫ словами («повод
 * задан»), а не значения полей («повод = день рождения»). Название проекта,
 * имя получателя, текст сценария — пользовательский ввод: в ответы API они
 * не попадают вовсе, поэтому через них нельзя ни сделать инъекцию в модель
 * «Админки», ни утечь в журнал платформы.
 *
 * Чистый модуль.
 */
import type { FreeScenario } from '../../common/test-user-scenarios';
import { SCENARIO_HINTS, stepIdsOf } from '../wizard-guide/hint-scenarios';

/**
 * `data-assist-id` позиции степпера в TMA — по сценарию (разметка Ш6 в
 * `frontend/src/components/ui/Stepper.tsx`). У товарки и поздравления это
 * те же литералы, что `data-qa` обучалки (каталог `qa-hooks.ts`), у
 * обучалки по сайту — свои (`client-site-step-*`).
 */
export const STEP_TARGET_PREFIX: Record<FreeScenario, string> = {
  PRODUCT_VIDEO: 'wizard-step-',
  GREETING_VIDEO: 'greeting-step-',
  CLIENT_SITE: 'client-site-step-',
};

/** Сценарий словами — для модели «Админки» и знаний. */
export const SCENARIO_TITLES: Record<FreeScenario, string> = {
  PRODUCT_VIDEO: 'рекламный ролик товара по образцу',
  GREETING_VIDEO: 'видеопоздравление',
  CLIENT_SITE: 'обучающий ролик по своему сайту',
};

export interface StepView {
  id: string;
  /** Что делают на шаге — карточка советника. */
  goal: string;
  /** `data-assist-id` кнопки шага в степпере TMA. */
  uiTarget: string;
}

export interface ProjectFactsView {
  projectId: string;
  /** `null` — тип проекта гиду неизвестен (фактов нет). */
  scenario: FreeScenario | null;
  scenarioTitle: string | null;
  scenarioGoal: string | null;
  steps: StepView[];
  /** Факты словами; значения полей не передаются. */
  facts: string[];
}

export function stepsOf(scenario: FreeScenario): StepView[] {
  const hints = SCENARIO_HINTS[scenario];
  if (!hints) return [];
  return stepIdsOf(scenario).map((id) => ({
    id,
    goal: hints.cards[id].goal,
    uiTarget: `${STEP_TARGET_PREFIX[scenario]}${id}`,
  }));
}

export function projectFactsView(
  projectId: string,
  scenario: FreeScenario | null,
  facts: string[],
): ProjectFactsView {
  if (!scenario || !SCENARIO_HINTS[scenario]) {
    return {
      projectId,
      scenario: null,
      scenarioTitle: null,
      scenarioGoal: null,
      steps: [],
      facts: [],
    };
  }
  return {
    projectId,
    scenario,
    scenarioTitle: SCENARIO_TITLES[scenario],
    scenarioGoal: SCENARIO_HINTS[scenario]!.goal,
    steps: stepsOf(scenario),
    facts,
  };
}

/** Давность словами: число дней — не персональное значение, а мера. */
export function ageWords(date: Date, now: Date): string {
  const days = Math.floor(
    (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) /
      86_400_000,
  );
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} дн. назад`;
}

export interface ProjectListItem {
  id: string;
  /** Порядковый номер в списке, 1 — последний изменённый. */
  order: number;
  type: string;
  scenario: FreeScenario | null;
  scenarioTitle: string | null;
  updated: string;
}

/**
 * Строка списка проектов. Названия проекта НЕТ: это пользовательский
 * текст (см. шапку). Проект называют по номеру, сценарию и давности.
 */
export function projectListItem(
  row: { id: string; type: string; updatedAt: Date },
  order: number,
  scenario: FreeScenario | null,
  now: Date,
): ProjectListItem {
  return {
    id: row.id,
    order,
    type: row.type,
    scenario,
    scenarioTitle: scenario ? SCENARIO_TITLES[scenario] : null,
    updated: ageWords(row.updatedAt, now),
  };
}
