/**
 * GreetingVoiceService — голос отправителя для озвучки поздравления
 * (фича №34 компаньон-ТЗ `TZ-Greeting-Video-Upgrade-40-Features.md`).
 *
 * Своей инфраструктуры клонирования не заводит: она уже в проде
 * (`UserVoicesService`, этап 73 — запись образца, согласие, лимит на
 * пользователя, обучение у Resemble, вебхук/poll статуса). Здесь
 * только ВЫБОР одного из уже готовых клонов для конкретной сессии и
 * проверка, что клон действительно свой и действительно готов.
 *
 * Почему отдельный модуль, а не поле в брифе: бриф правится до
 * создания сессии и общий для всех сессий проекта, а голос относится к
 * одному ролику (записал дед — озвучили дедом). Хранится поэтому в
 * `session.greetingBriefSnapshot.senderVoice` — снимок и так живёт
 * посессионно, и новая колонка в БД не нужна.
 *
 * Почему не через `PATCH /sessions/:id` (`applySnapshotEdit`,
 * `ttsVoiceId` в манифесте бренда): тот путь требует существующего
 * `brandManifestSnapshot` и 400-ит без него
 * (`ProjectSessionService.updateSnapshot`), а у бытового поздравления
 * манифеста нет — именно у таких пользователей фича и нужна.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { GreetingSenderVoice } from '../../common/types/greeting.types';

type UserVoiceRow = {
  id: string;
  label: string;
  status: string;
  resembleVoiceId: string | null;
};

@Injectable()
export class GreetingVoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  async get(sessionId: string): Promise<GreetingSenderVoice | null> {
    const session = await this.load(sessionId);
    return session.greetingBriefSnapshot?.senderVoice ?? null;
  }

  /**
   * `null` снимает выбор — озвучка возвращается к голосу по умолчанию
   * (активный на стенде провайдер), а не молчит: это именно снятие
   * выбора, а не выключение звука.
   */
  async select(
    sessionId: string,
    resembleVoiceId: string | null,
  ): Promise<GreetingSenderVoice | null> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    const next = resembleVoiceId
      ? await this.resolveOwnClone(session.userId, resembleVoiceId)
      : null;
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: { ...snapshot, senderVoice: next },
    });
    return next;
  }

  /**
   * Клон обязан быть СВОИМ и ГОТОВЫМ.
   *
   * «Свой» — потому что `resembleVoiceId` приходит от клиента, а на
   * аккаунте Resemble у продукта один ключ на всех пользователей
   * (см. `UserVoicesService`, MAX_USER_VOICES): без проверки владельца
   * чужой идентификатор озвучил бы поздравление чужим голосом.
   *
   * «Готовый» — потому что у `TRAINING` голоса синтез гарантированно
   * провалится, и узнать об этом человек успеет только после рендера.
   * Отказываем сразу и вслух.
   */
  private async resolveOwnClone(
    userId: string | null | undefined,
    resembleVoiceId: string,
  ): Promise<GreetingSenderVoice> {
    const row: UserVoiceRow | null = userId
      ? ((await this.prisma.userVoice.findFirst({
          where: { userId, resembleVoiceId },
          select: {
            id: true,
            label: true,
            status: true,
            resembleVoiceId: true,
          },
        })) as UserVoiceRow | null)
      : null;
    if (!row) {
      throw new NotFoundException('Такого своего голоса нет');
    }
    if (row.status !== 'READY' || !row.resembleVoiceId) {
      throw new NotFoundException('Голос ещё не готов');
    }
    return {
      userVoiceId: row.id,
      resembleVoiceId: row.resembleVoiceId,
      label: row.label,
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
