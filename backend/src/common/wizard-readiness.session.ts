/**
 * Готовность по сессии — «Тонкая красная линия» §7.3, волна D.
 *
 * Отдельный файл от `wizard-readiness.ts` намеренно: там чистые правила
 * без единого знания о том, как у нас устроена сессия, и это их главное
 * свойство — их можно прочитать и проверить, не держа в голове схему.
 * Здесь — перевод сессии в аргументы этих правил, и ничего больше.
 *
 * Один вход на два сценария: отличает их снимок брифа. Разводить их по
 * двум функциям значило бы заставить вызывающего решать, какой сценарий
 * перед ним, — а он это уже решил тем, что создал сессию.
 */

import { activeProductImage } from './active-image';
import { ModerationStatus } from './types/prompt.types';
import {
  greetingReadiness,
  productReadiness,
  type Readiness,
} from './wizard-readiness';

/** Ровно те поля сессии, которые нужны готовности. */
export interface ReadinessSession {
  greetingBriefSnapshot?: {
    occasion?: string;
    customOccasionText?: string | null;
    recipientName?: string;
    senderName?: string | null;
    presenterProvider?: string;
    /** Провайдер после тарифного резолвера — по нему и рендерит сервис. */
    resolvedPresenterProvider?: string;
  } | null;
  /** Референс-кадры поздравления лежат в самой сессии. */
  greetingReferenceImages?: unknown[] | null;
  brandManifestSnapshot?: unknown;
  productInformation?: unknown;
  videoAnalysis?: { status?: string } | null;
  /** Шаблон сцены вместо референса (этап 149). */
  sceneTemplate?: { templateId?: string } | null;
  generationPrompt?: {
    approvedAt?: string | Date | null;
    moderationStatus?: string | null;
  } | null;
}

/** Говорящий аватар — единственный ведущий, которому нужно лицо. */
export const AVATAR_PRESENTER = 'hedra';

export function readinessOfSession(session: ReadinessSession): Readiness {
  const brief = session.greetingBriefSnapshot;
  if (brief) {
    return greetingReadiness({
      occasion: brief.occasion ?? '',
      customOccasionText: brief.customOccasionText ?? null,
      recipientName: brief.recipientName ?? '',
      senderName: brief.senderName ?? null,
      // РАЗРЕШЁННЫЙ провайдер, а не выбранный: тариф мог понизиться
      // после сохранения брифа, и рендерить будет именно резолвер —
      // требовать лицо по выбору значило бы просить фото там, где
      // аватара всё равно не будет.
      usesAvatar:
        (brief.resolvedPresenterProvider ?? brief.presenterProvider) ===
        AVATAR_PRESENTER,
      referenceImages: session.greetingReferenceImages?.length ?? 0,
      hasPrompt: !!session.generationPrompt,
      // Модерация помечает сценарий флагом, и рендер после этого
      // откажет. У greeting нет экрана ручного одобрения, поэтому это
      // не «предупреждение», а настоящее препятствие.
      promptFlagged:
        session.generationPrompt?.moderationStatus === ModerationStatus.FLAGGED,
    });
  }

  return productReadiness({
    analysisComplete: session.videoAnalysis?.status === 'complete',
    hasSceneTemplate: !!session.sceneTemplate?.templateId,
    hasProductInfo: !!session.productInformation,
    // Через резолвер, а не по наличию поля: при применённом скетче в
    // генерацию уходит скетч, и «фото есть» означает именно то, что
    // прочитает `GenerationService`.
    hasProductImage: !!activeProductImage(session.productInformation as never)
      ?.pathname,
    promptApproved: !!session.generationPrompt?.approvedAt,
    hasBrandManifest: !!session.brandManifestSnapshot,
  });
}
