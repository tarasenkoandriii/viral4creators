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

import { Injectable, NotFoundException } from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { GreetingScenesView } from '../../common/types/greeting.types';
import {
  MAX_GREETING_SCENES,
  GREETING_SCENE_SECONDS,
  normalizeSceneCount,
  splitSceneDurations,
} from '../../common/greeting-scenes';

@Injectable()
export class GreetingScenesService {
  constructor(private readonly sessions: SessionService) {}

  async get(sessionId: string): Promise<GreetingScenesView> {
    const snapshot = (await this.load(sessionId)).greetingBriefSnapshot!;
    return this.toView(normalizeSceneCount(snapshot.sceneCount ?? 1));
  }

  async setCount(
    sessionId: string,
    sceneCount: number,
  ): Promise<GreetingScenesView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    const next = normalizeSceneCount(sceneCount);
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, sceneCount: next },
    });
    return this.toView(next);
  }

  private toView(sceneCount: number): GreetingScenesView {
    return {
      sceneCount,
      maxScenes: MAX_GREETING_SCENES,
      durations: splitSceneDurations(GREETING_SCENE_SECONDS, sceneCount),
    };
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException(
        `Session ${sessionId} is not a greeting session`,
      );
    }
    return session;
  }
}
