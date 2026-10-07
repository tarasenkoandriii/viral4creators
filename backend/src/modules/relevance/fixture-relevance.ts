/**
 * Готовый отчёт релевантности фикстуры обучалки (заход 7, 07.10.2026;
 * аудит: «ночная регрессия платит Gemini без клика»).
 *
 * `RelevancePanel` при открытии сам зовёт `POST …/relevance`, если у
 * сессии нет отчёта, — а сценарный прогон открывает её каждую ночь на
 * пересеянной фикстуре. Отсюда две стороны одной защиты:
 *  - сид фикстуры (`tutorial-runner/fixture-seed.ts`) кладёт этот отчёт
 *    в сессии — панель видит готовое и ничего не запускает;
 *  - `RelevanceService.run` для пользователя фикстуры (тестовый аккаунт
 *    `FIXTURE_TELEGRAM_ID`) отдаёт его же, не обращаясь к Gemini
 *    (сценарий мог открыть свежую сессию «чистого мастера»).
 *
 * Детерминированный: одинаковые данные — одинаковый ролик обучалки, и
 * отпечаток кадров не дрожит от слов модели. Формат — тот же
 * `RelevanceState`, что пишет `RelevanceService.run`.
 */
import { RelevanceState } from '../../common/types/relevance.types';

/** Фиксированные id и время: состояние фикстуры не меняется между ночами. */
export const FIXTURE_RELEVANCE_REPORT_ID = 'fixture-tutorial-relevance';
export const FIXTURE_RELEVANCE_AT = '2026-10-07T00:00:00.000Z';

export function fixtureRelevanceState(): RelevanceState {
  return {
    report: {
      reportId: FIXTURE_RELEVANCE_REPORT_ID,
      generatedAt: FIXTURE_RELEVANCE_AT,
      score: 82,
      verdict: 'use',
      summary:
        'Референс подходит товару: ночной город и динамичный монтаж хорошо продают автомобильный аксессуар той же аудитории.',
      reasoning: [
        'Аудитория референса — водители 25–45 лет, как и у товара.',
        'Сцены с салоном автомобиля прямо показывают место использования товара.',
      ],
      matches: ['Возраст и интересы аудитории', 'Сцены в автомобиле'],
      gaps: ['В референсе нет крупного плана самого товара'],
      adjustments: ['Добавить крупный план товара во второй сцене'],
      promptAdvice:
        'Keep the night-city mood; in scene 2 add a close-up of the product inside the car.',
      inputs: {
        productAudience: false,
        videoAudience: false,
        promotedProduct: false,
      },
    },
    useInPrompt: true,
    updatedAt: FIXTURE_RELEVANCE_AT,
  };
}
