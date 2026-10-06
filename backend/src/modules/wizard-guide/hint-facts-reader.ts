/**
 * Чтение фактов состояния проекта из базы — одно на советника и на
 * «Админку» помощника платформы (Э-С Ш6).
 *
 * До Ш6 это был приватный `WizardHintService.factsOf`. Ш6 добавил второго
 * читателя — OpenAPI-эндпоинты фактов генератора для режима «Админка»
 * (`modules/guide-assist`): помощник платформы отвечает пользователю TMA
 * о его проекте по тем же фактам, что видит советник. Две копии чтения
 * разошлись бы молча («повод задан» у одного и «не задан» у другого),
 * поэтому чтение вынесено сюда, а сервис советника зовёт эту функцию.
 *
 * Формулировки фактов — по-прежнему в `hint-facts.ts`, рядом с
 * карточками (см. шапку того файла); здесь только чтение из базы.
 * Значения полей наружу НЕ уходят — только факты словами (§5.10).
 */

import type { PrismaService } from '../../prisma/prisma.service';
import type { FreeScenario } from '../../common/test-user-scenarios';
import { factsOfScenario, greetingStateOf } from './hint-facts';
// Через enum, а не строкой (см. `greetingStateOf` в `hint-facts.ts`).
import { GenerationStatus } from '../../common/types/generation.types';
import { activeProductImage } from '../../common/active-image';
import { usesTemplate } from '../../common/scene-templates';

/** Ровно те поля сессии, которые читают факты состояния. */
interface SessionShape {
  status?: string;
  greetingBriefSnapshot?: {
    occasion?: string;
    customOccasionText?: string | null;
    recipientName?: string;
    senderName?: string | null;
    presenterProvider?: string;
    resolvedPresenterProvider?: string;
  } | null;
  greetingReferenceImages?: unknown[] | null;
  generationPrompt?: {
    approvedAt?: string | null;
    moderationStatus?: string | null;
  } | null;
  generatedVideo?: { status?: string } | null;
  videoAnalysis?: { status?: string } | null;
  /** Приём сцены вместо референса (этап 153). */
  sceneTemplate?: { templateId?: string } | null;
  productInformation?: unknown;
}

/** Только те делегаты Prisma, что нужны чтению. */
export type FactsPrisma = Pick<
  PrismaService,
  'clientSiteTutorialDraft' | 'session'
>;

/**
 * Факты состояния словами.
 *
 * Владение проектом здесь НЕ проверяется — его проверяет вызывающий
 * (советник — `projectOf`, «Админка» — `ownProject`) до вызова.
 */
export async function readScenarioFacts(
  prisma: FactsPrisma,
  scenario: FreeScenario,
  projectId: string,
): Promise<string[]> {
  if (scenario === 'CLIENT_SITE') {
    const draft: {
      stepsPerRound: number[];
      title: string | null;
      status: string;
      requiresLiveLoginReplay: boolean;
      credentialsEnc: string | null;
      storeHasCredentials?: boolean;
    } | null = await prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
      select: {
        stepsPerRound: true,
        title: true,
        status: true,
        requiresLiveLoginReplay: true,
        credentialsEnc: true,
        // Э-С Ш2: поля входа могут лежать в хранилище sites-backend.
        storeHasCredentials: true,
      },
    });
    return factsOfScenario({
      scenario,
      state: draft
        ? {
            rounds: draft.stepsPerRound.length,
            title: draft.title,
            status: draft.status,
            hasCredentials:
              !!draft.credentialsEnc || draft.storeHasCredentials === true,
            requiresLiveLoginReplay: draft.requiresLiveLoginReplay,
          }
        : null,
    });
  }

  // Greeting и товарка живут в сессии. Берём последнюю: мастер
  // работает с ней же, а прошлые прогоны к текущему шагу отношения
  // не имеют.
  const row: { status: string; data: unknown; liveData: unknown } | null =
    await prisma.session.findFirst({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { status: true, data: true, liveData: true },
    });
  const session = row
    ? ({
        ...(row.data as Record<string, unknown>),
        ...(row.liveData as Record<string, unknown>),
        status: row.status,
      } as SessionShape)
    : null;

  if (scenario === 'GREETING_VIDEO') {
    // Чтение состояния — общее с голосом (`greetingStateOf`, K4): ответ
    // на вопрос голосом и подсказка видят одно и то же.
    return factsOfScenario({ scenario, state: greetingStateOf(session) });
  }

  return factsOfScenario({
    scenario,
    state: session
      ? {
          hasReference: !!session.videoAnalysis,
          analysisComplete: session.videoAnalysis?.status === 'complete',
          onSceneTemplate: usesTemplate(
            session.videoAnalysis?.status,
            session.sceneTemplate?.templateId,
          ),
          hasProductInfo: !!session.productInformation,
          hasProductImage: !!activeProductImage(
            session.productInformation as never,
          )?.pathname,
          promptApproved: !!session.generationPrompt?.approvedAt,
          renderInFlight:
            session.generatedVideo?.status === GenerationStatus.PENDING ||
            session.generatedVideo?.status === GenerationStatus.PROCESSING,
          hasVideo:
            session.generatedVideo?.status === GenerationStatus.COMPLETE,
        }
      : null,
  });
}
