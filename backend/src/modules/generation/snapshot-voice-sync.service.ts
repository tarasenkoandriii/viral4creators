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
import { syncSnapshotVoice } from '../project-session/snapshot';

@Injectable()
export class SnapshotVoiceSyncService {
  private readonly logger = new Logger(SnapshotVoiceSyncService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
  ) {}

  async syncBeforeRender(sessionId: string): Promise<void> {
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
}
