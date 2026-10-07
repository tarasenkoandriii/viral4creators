/**
 * GreetingScenesService — сколько сцен снимать (фича №7).
 *
 * Тонкий сервис: вся драматургия и арифметика в
 * `common/greeting-scenes.ts`, здесь только сохранение выбора.
 *
 * Ограничений совместимости у фичи нет, и это следствие того, что
 * сцены описываются одним промптом, а не снимаются отдельными
 * клипами: пресетный голос xAI произносит реплику один раз на весь
 * ролик, сколько бы в нём ни было монтажных склеек.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { GreetingScenesView } from '../../common/types/greeting.types';
import {
  MAX_GREETING_SCENES,
  GREETING_SCENE_SECONDS,
  normalizeSceneCount,
  splitSceneDurations,
} from '../../common/greeting-scenes';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import {
  REGISTER_POLICY,
  evaluateGreetingPolicy,
  policyMessage,
  registerOfBrief,
} from '../../common/greeting-policy';
import { GreetingBriefSnapshot } from '../../common/types/greeting.types';
import { assertGreetingNotRendering } from '../../common/greeting-render-lock';
import { PrismaService } from '../../prisma/prisma.service';
import {
  GREETING_POLICY_KEYS,
  updateGreetingSnapshot,
} from '../../common/greeting-snapshot-write';

@Injectable()
export class GreetingScenesService {
  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async get(sessionId: string): Promise<GreetingScenesView> {
    const snapshot = (await this.load(sessionId)).greetingBriefSnapshot!;
    return this.toView(snapshot, normalizeSceneCount(snapshot.sceneCount ?? 1));
  }

  async setCount(
    sessionId: string,
    sceneCount: number,
  ): Promise<GreetingScenesView> {
    const session = await this.loadForEdit(sessionId);
    const next = normalizeSceneCount(sceneCount);
    // Только ключ `sceneCount` (C2), и только если повод и тон, по
    // которым решала политика, не поменяли между чтением и записью.
    const written = await updateGreetingSnapshot(
      this.prisma,
      sessionId,
      session.greetingBriefSnapshot!,
      (cur) => {
        assertSceneCountAllowed(cur, next);
        return { set: { sceneCount: next }, expect: GREETING_POLICY_KEYS };
      },
    );
    return this.toView(written, next);
  }

  private toView(
    snapshot: Pick<GreetingBriefSnapshot, 'occasion' | 'occasionRegister'>,
    sceneCount: number,
  ): GreetingScenesView {
    return {
      sceneCount,
      maxScenes: Math.min(
        MAX_GREETING_SCENES,
        REGISTER_POLICY[registerOfBrief(snapshot)].maxScenes,
      ),
      durations: splitSceneDurations(GREETING_SCENE_SECONDS, sceneCount),
    };
  }

  /**
   * Сессия для правки выбора: пока ролик считается — 409 с кодом
   * (CONTRACT6 п.2, `assertGreetingNotRendering`): рендер и постобработка
   * читают выбор из снимка, смена посреди рендера дала бы ролик ни по
   * прежнему, ни по новому выбору.
   */
  private async loadForEdit(sessionId: string): Promise<Session> {
    const session = await this.load(sessionId);
    assertGreetingNotRendering(session);
    return session;
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException('это не поздравительная сессия');
    }
    return session;
  }
}

/**
 * Этап B: потолок сцен — по регистру повода (траурному ролику нарезка
 * из четырёх склеек не подходит). Отказ, а не тихое урезание: иначе
 * человек увидел бы «сохранено» и получил другое число сцен.
 */
function assertSceneCountAllowed(
  snapshot: GreetingBriefSnapshot,
  sceneCount: number,
): void {
  const verdict = evaluateGreetingPolicy({
    occasion: snapshot.occasion,
    occasionRegister: snapshot.occasionRegister ?? null,
    tone: snapshot.tone,
    sceneCount,
  });
  if (verdict.violations.some((v) => v.field === 'sceneCount')) {
    throw new BadRequestException(
      policyMessage({
        ...verdict,
        violations: verdict.violations.filter((v) => v.field === 'sceneCount'),
      }),
    );
  }
}
