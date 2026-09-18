/**
 * Голос бренда → сессия перед первым рендером.
 *
 * Сессия замораживает копию бренда при создании. Если голос выбрали в
 * брендбуке ПОСЛЕ этого (типичный порядок: создать ролик из товара,
 * потом подобрать голос), ролик озвучивался старым голосом или не
 * озвучивался вовсе — и дубляж молча оставлял голос модели.
 *
 * Правила (см. `syncSnapshotVoice`):
 * - только до первого рендера — у сессии ещё нет `generatedVideo`;
 * - только если голос в самой сессии не выбирали вручную;
 * - режим озвучки не меняется — он уже вошёл в промпт.
 *
 * Вызывается только из пользовательского `POST /generate`, не из
 * `GenerationService.generateVideo()`: дочерние сессии экспорта,
 * партий и A/B-тестов несут голос родителя намеренно.
 *
 * Best-effort: любая ошибка — в лог, генерация продолжается как раньше.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from '../../common/session.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  syncSnapshotSketches,
  syncSnapshotVoice,
} from '../project-session/snapshot';
import { sketchRefFromRow } from '../../common/active-image';

@Injectable()
export class SnapshotVoiceSyncService {
  private readonly logger = new Logger(SnapshotVoiceSyncService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async syncBeforeRender(sessionId: string): Promise<void> {
    await this.syncVoice(sessionId);
    await this.syncSketches(sessionId);
  }

  private async syncVoice(sessionId: string): Promise<void> {
    try {
      const session = await this.sessions.getSession(sessionId);
      const snapshot = session?.brandManifestSnapshot;
      if (!session || !snapshot || session.generatedVideo) return;
      if (snapshot.voiceEditedAt) return;

      const manifest = await this.prisma.brandManifest.findUnique({
        where: { id: snapshot.brandManifestId },
        select: { ttsVoiceId: true, ttsModel: true, ttsProvider: true },
      });
      if (!manifest) return;

      const next = syncSnapshotVoice(snapshot, manifest);
      if (!next) return;

      await this.sessions.updateSession(sessionId, {
        brandManifestSnapshot: next,
      });
      this.logger.log(
        `сессия ${sessionId}: голос подтянут из бренда перед рендером (${
          snapshot.ttsVoiceId ?? '—'
        } → ${next.ttsVoiceId ?? '—'})`,
      );
    } catch (err) {
      this.logger.warn(
        `сессия ${sessionId}: голос из бренда не подтянут — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Применённые ИИ-скетчи бренда и товара — в сессию перед первым
   * рендером (§4 п.8 doc/AI-SKETCH-SPEC.md). Тот же принцип, что у
   * голоса: снимок замораживает бренд, но скетч, применённый ПОСЛЕ
   * создания сессии, иначе не доехал бы до ролика.
   *
   * Слоты, которые пользователь правил в самой сессии, не трогаем: у
   * них уже есть собственный скетч (или осознанно нет).
   */
  private async syncSketches(sessionId: string): Promise<void> {
    try {
      const session = await this.sessions.getSession(sessionId);
      if (!session || session.generatedVideo) return;

      const updates: Record<string, unknown> = {};

      // Товар: сессия создана из товара проекта — берём его активный скетч.
      const product = session.productInformation;
      if (session.productItemId && product && !product.sketch) {
        const item = await this.prisma.productItem.findUnique({
          where: { id: session.productItemId },
          include: { activeSketch: true },
        });
        const sketch = item?.activeSketch
          ? sketchRefFromRow(item.activeSketch)
          : null;
        if (sketch) {
          updates.productInformation = { ...product, sketch };
        }
      }

      // Персонажи и сцены бренда: сверяем снимок с манифестом.
      const snapshot = session.brandManifestSnapshot;
      if (snapshot) {
        const manifest = await this.prisma.brandManifest.findUnique({
          where: { id: snapshot.brandManifestId },
          include: {
            characters: { include: { activeSketch: true } },
            scenes: { include: { activeSketch: true } },
          },
        });
        if (manifest) {
          const next = syncSnapshotSketches(snapshot, manifest);
          if (next) updates.brandManifestSnapshot = next;
        }
      }

      if (Object.keys(updates).length === 0) return;
      await this.sessions.updateSession(sessionId, updates);
      this.logger.log(
        `сессия ${sessionId}: ИИ-скетчи подтянуты перед рендером (${Object.keys(
          updates,
        ).join(', ')})`,
      );
    } catch (err) {
      this.logger.warn(
        `сессия ${sessionId}: скетчи не подтянуты — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
