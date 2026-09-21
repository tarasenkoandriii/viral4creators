/**
 * Тарифная стратегия качества/цены для GREETING_VIDEO (ТЗ
 * TZ-Greeting-Video-Project-Type.md §7) — pure functions, без Nest/Prisma,
 * чтобы юнит-тест не поднимал DI (тот же приём, что
 * project-session/snapshot.ts и project-session.service.ts's
 * applySnapshotEdit).
 *
 * Отклоняет запрос на 'hedra'/'1080p' с планом ниже нужного (403) — не
 * подставляет тихую замену на 'grok'/'720p' (§5.3, §7: тихая подмена
 * дешевле в реализации, но обманула бы пользователя, явно выбравшего
 * более дорогой вариант в форме).
 *
 * ВАЖНО (§7, §11.1 аудита ТЗ): в проекте до этого не было механизма
 * «максимальное значение параметра по тарифу» — `PlanService`/`plans.ts`
 * умеют только гейтить булевы фичи (`planAllows`). Этот файл — новый,
 * ЛОКАЛЬНЫЙ для GREETING_VIDEO механизм, сознательно не поднятый в
 * `PlanService` в этом ТЗ (см. §11.1/§11.2 — поднимать его туда стоит,
 * когда параметр-капы понадобятся другому типу проекта).
 */

import { ForbiddenException } from '@nestjs/common';
import { PlanId } from '../../common/plans';
import {
  GreetingPresenterProvider,
  GreetingResolution,
} from '../../common/types/greeting.types';

const MAX_RESOLUTION: Record<PlanId, GreetingResolution> = {
  LITE: '480p',
  STANDARD: '720p',
  PREMIUM: '1080p',
};

const RESOLUTION_RANK: Record<GreetingResolution, number> = {
  '480p': 0,
  '720p': 1,
  '1080p': 2,
};

export interface GreetingConfigRequest {
  presenterProvider?: GreetingPresenterProvider;
  resolution?: GreetingResolution;
}

export interface ResolvedGreetingConfig {
  presenterProvider: GreetingPresenterProvider;
  resolution: GreetingResolution;
}

/** Максимум разрешения для тарифа — экспортировано для текста отказа/UI. */
export function maxGreetingResolutionFor(plan: PlanId): GreetingResolution {
  return MAX_RESOLUTION[plan];
}

/**
 * §7 таблица:
 *  LITE     → grok (принудительно), максимум 480p
 *  STANDARD → grok (принудительно), максимум 720p
 *  PREMIUM  → grok ИЛИ hedra (выбор пользователя), максимум 1080p
 *
 * Дефолт `presenterProvider` — всегда 'grok', даже на PREMIUM (§3.2
 * doc-comment `GreetingBrief.presenterProvider`: «чтобы не удивлять
 * ценой без явного выбора») — 'hedra' только если запрошен явно.
 *
 * Бросает `ForbiddenException` (403), а не тихо понижает — см.
 * доккомментарий файла.
 */
export function resolveGreetingConfig(
  plan: PlanId,
  requested: GreetingConfigRequest,
): ResolvedGreetingConfig {
  const cap = MAX_RESOLUTION[plan];

  if (requested.presenterProvider === 'hedra' && plan !== 'PREMIUM') {
    throw new ForbiddenException(
      'Говорящий аватар (Hedra) доступен на тарифе PREMIUM',
    );
  }

  if (
    requested.resolution &&
    RESOLUTION_RANK[requested.resolution] > RESOLUTION_RANK[cap]
  ) {
    throw new ForbiddenException(
      `Разрешение ${requested.resolution} доступно на более высоком тарифе (максимум для ${plan}: ${cap})`,
    );
  }

  return {
    presenterProvider: requested.presenterProvider ?? 'grok',
    resolution: requested.resolution ?? cap,
  };
}
