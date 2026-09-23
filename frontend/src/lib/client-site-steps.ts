/**
 * Шаги обучалки по сайту заказчика — «Тонкая красная линия», этап 3
 * (docs-tz/TZ-Tonkaya-Krasnaya-Liniya.md §4.4).
 *
 * ## Почему шагов три, а не «сколько раундов»
 *
 * У обучалки нет фиксированной длины: раундов записи столько, сколько
 * потребует сайт заказчика, и «раунд ≠ шаг» (§15 п.3 спеки обучалки) —
 * форма из трёх полей и кнопки это один кадр, а не четыре. Поэтому
 * степпер двухуровневый: три состояния сверху и лента раундов внутри
 * записи. Нумеровать раунды степпером нельзя — их число неизвестно
 * заранее, а степпер обещает конечный путь.
 *
 * ## Что здесь НЕ решается
 *
 * Переход вперёд. `url → record` происходит только ответом сервера
 * (`applyRound`), а «назад» в обучалке — это откат раунда на сервере, а
 * не навигация. Функции ниже отвечают на вопрос «куда можно», а не
 * «как туда попасть».
 */

import type { WizardStep } from './wizard-steps';

export type ClientSiteStepId = 'url' | 'record' | 'review';

export const CLIENT_SITE_STEP_IDS = ['url', 'record', 'review'] as const;

/** Состояния экрана визарда — те же, что были до появления степпера. */
export type ClientSiteStage = 'loading' | 'url' | 'page' | 'review';

/** Всё о черновике, что нужно шагам. Ровно три факта, не весь объект. */
export interface ClientSiteFacts {
  /** Черновик заведён. */
  exists: boolean;
  /** `status === 'DRAFTING'` — запись ещё можно продолжать. */
  editable: boolean;
  /** Сколько кадров записано (`roundScreenshots.length`). */
  frames: number;
}

export function clientSiteFactsOf(
  draft: { status: string; roundScreenshots: string[] } | null
): ClientSiteFacts {
  return {
    exists: Boolean(draft),
    editable: draft?.status === 'DRAFTING',
    frames: draft?.roundScreenshots.length ?? 0,
  };
}

/**
 * Шаг, соответствующий состоянию экрана.
 *
 * Возвращает `'loading'`, а не `null`, СПЕЦИАЛЬНО: `null` в
 * `toStepsView` означает «все шаги пройдены», и перепутать эти два
 * смысла стоило бы степпера, нарисованного целиком пройденным на
 * экране загрузки.
 */
export function clientSiteStepOfStage(
  stage: ClientSiteStage
): ClientSiteStepId | 'loading' {
  switch (stage) {
    case 'loading':
      return 'loading';
    case 'url':
      return 'url';
    case 'page':
      return 'record';
    case 'review':
      return 'review';
  }
}

/** Сегмент адреса для состояния. Первый шаг — голый маршрут: ссылки на
 * `/projects/:id/site-tutorial`, выданные до этого этапа, обязаны
 * продолжать работать. */
export function clientSiteUrlStep(stage: ClientSiteStage): string | undefined {
  const step = clientSiteStepOfStage(stage);
  return step === 'url' || step === 'loading' ? undefined : step;
}

/**
 * Состояние, которое можно восстановить из адреса после перезагрузки.
 *
 * Восстанавливается не всё, и это ограничение продукта, а не недоделка.
 * Экран записи рисуется по `exploration` — снимку страницы, который
 * приходит ТОЛЬКО ответом сервера на раунд. После перезагрузки его нет,
 * а звать `refresh` самим значило бы поднять браузерную сессию на
 * сервере без просьбы человека. Поэтому адрес `…/record` открывается на
 * просмотре, откуда запись продолжается одной кнопкой.
 */
export function clientSiteStageFromUrl(
  step: string | undefined,
  facts: ClientSiteFacts
): ClientSiteStage {
  if (!facts.exists) return 'url';
  if (step === 'review' || step === 'record') return 'review';
  return facts.frames > 0 ? 'review' : 'url';
}

/**
 * Доступность и завершённость трёх шагов.
 *
 * Завершённость задаётся явно, а не позиционно: на шаге записи просмотр
 * уже может быть пройден (черновик отправлен и вернулся на доработку), и
 * позиционное правило `i < current` объявило бы его непройденным.
 */
export function clientSiteSteps(
  facts: ClientSiteFacts,
  labels: Record<ClientSiteStepId, string>
): WizardStep<ClientSiteStepId>[] {
  return [
    {
      id: 'url',
      label: labels.url,
      // Черновик есть — назад к вводу ссылки нельзя: это не навигация,
      // а удаление записи вместе с шифрованными учётными данными.
      target: facts.exists ? null : 'url',
      done: facts.exists,
    },
    {
      id: 'record',
      label: labels.record,
      target: facts.exists && facts.editable ? 'record' : null,
      done: facts.frames > 0,
    },
    {
      id: 'review',
      label: labels.review,
      target: facts.frames > 0 ? 'review' : null,
      done: facts.exists && !facts.editable,
    },
  ];
}
