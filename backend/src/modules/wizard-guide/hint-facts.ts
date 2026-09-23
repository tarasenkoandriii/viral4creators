/**
 * Факты состояния для дайджеста — «Тонкая красная линия» §5.5, волна D.
 *
 * ## Почему это отдельный файл рядом с карточками
 *
 * Добавить сценарий в `SCENARIO_HINTS` и забыть про факты — ошибка,
 * которую невозможно заметить глазами и легко сделать: подсказки
 * появятся, тесты будут зелёными, а дайджест состояния окажется
 * ПОСТОЯННЫМ. Это значит один кеш на всех: «заполните повод» приедет
 * тому, кто его уже заполнил, и никакой признак на это не укажет.
 * Поэтому факты лежат в паре с карточками и сверяются тестом
 * (`hint-facts.spec.ts`): у каждого сценария из `SCENARIO_HINTS` обязан
 * быть свой набор.
 *
 * ## Почему факты — слова, а не значения
 *
 * «Повод задан», а не «повод = день рождения». Инъекция через поле
 * невозможна не потому, что мы её фильтруем, а потому, что значения
 * полей в промпт не попадают вовсе (§5.10). Это же делает кеш общим для
 * всех пользователей: в ключе нет ничего персонального.
 *
 * ## Почему и положительные, и отрицательные
 *
 * Без «-title» ситуации «заголовка нет» и «поле ещё не читали» дают
 * один дайджест, а это разные ситуации и разные советы.
 */

import type { FreeScenario } from '../../common/test-user-scenarios';

/** Что известно о черновике обучалки. */
export interface ClientSiteState {
  rounds: number;
  title: string | null;
  status: string;
  hasCredentials: boolean;
  requiresLiveLoginReplay: boolean;
}

/** Что известно о сессии greeting. */
export interface GreetingState {
  occasion: string | null;
  customOccasionText: string | null;
  recipientName: string | null;
  senderName: string | null;
  usesAvatar: boolean;
  referenceImages: number;
  hasPrompt: boolean;
  promptFlagged: boolean;
  hasVideo: boolean;
}

/** Что известно о прогоне товарки. */
export interface ProductState {
  hasReference: boolean;
  analysisComplete: boolean;
  hasProductInfo: boolean;
  hasProductImage: boolean;
  promptApproved: boolean;
  renderInFlight: boolean;
  hasVideo: boolean;
}

export type ScenarioState =
  | { scenario: 'CLIENT_SITE'; state: ClientSiteState | null }
  | { scenario: 'GREETING_VIDEO'; state: GreetingState | null }
  | { scenario: 'PRODUCT_VIDEO'; state: ProductState | null };

export function clientSiteFacts(state: ClientSiteState | null): string[] {
  if (!state) return ['черновика ещё нет'];
  return [
    state.rounds > 0
      ? `записано шагов: ${state.rounds}`
      : 'не записано ни одного шага',
    state.title?.trim() ? 'название задано' : 'название не задано',
    state.status === 'DRAFTING'
      ? 'черновик редактируется'
      : `черновик в статусе ${state.status}`,
    state.hasCredentials
      ? 'вход на сайт уже пройден'
      : 'вход на сайт ещё не проходили',
    state.requiresLiveLoginReplay
      ? 'вход придётся повторить живой сессией'
      : 'повтор входа не требуется',
  ];
}

export function greetingFacts(state: GreetingState | null): string[] {
  if (!state) return ['сессия поздравления ещё не начата'];
  return [
    state.occasion ? 'повод задан' : 'повод не задан',
    state.occasion === 'OTHER'
      ? state.customOccasionText?.trim()
        ? 'свой повод описан'
        : 'свой повод не описан'
      : 'повод из списка',
    state.recipientName?.trim() ? 'получатель назван' : 'получатель не назван',
    state.senderName?.trim() ? 'отправитель назван' : 'отправитель не назван',
    state.usesAvatar ? 'ведущий — говорящий аватар' : 'ведущий — без аватара',
    state.referenceImages > 0
      ? `фото добавлено: ${state.referenceImages}`
      : 'фото не добавлено',
    state.hasPrompt ? 'сценарий собран' : 'сценарий не собран',
    state.promptFlagged
      ? 'сценарий помечен проверкой содержания'
      : 'претензий к сценарию нет',
    state.hasVideo ? 'ролик готов' : 'ролика ещё нет',
  ];
}

export function productFacts(state: ProductState | null): string[] {
  if (!state) return ['прогон ещё не начат'];
  return [
    state.hasReference ? 'референс выбран' : 'референс не выбран',
    state.analysisComplete ? 'разбор завершён' : 'разбор не завершён',
    state.hasProductInfo ? 'товар описан' : 'товар не описан',
    state.hasProductImage ? 'фото товара есть' : 'фото товара нет',
    state.promptApproved ? 'промпт одобрен' : 'промпт не одобрен',
    state.renderInFlight ? 'рендер идёт' : 'рендер не идёт',
    state.hasVideo ? 'ролик готов' : 'ролика ещё нет',
  ];
}

/**
 * Факты по сценарию. Ключи обязаны совпадать с `SCENARIO_HINTS` —
 * это и проверяет тест.
 */
export function factsOfScenario(input: ScenarioState): string[] {
  switch (input.scenario) {
    case 'CLIENT_SITE':
      return clientSiteFacts(input.state);
    case 'GREETING_VIDEO':
      return greetingFacts(input.state);
    case 'PRODUCT_VIDEO':
      return productFacts(input.state);
  }
}

/** Сценарии, у которых факты есть. Для сверки с карточками. */
export const SCENARIOS_WITH_FACTS: readonly FreeScenario[] = [
  'CLIENT_SITE',
  'GREETING_VIDEO',
  'PRODUCT_VIDEO',
];
