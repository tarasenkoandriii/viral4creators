/**
 * GreetingBriefService — GET/PATCH /projects/:id/greeting-brief (ТЗ
 * TZ-Greeting-Video-Project-Type.md §8).
 *
 * Creation lives in `ProjectService.createGreetingVideoProject` (§4.1,
 * §4.3): a GreetingBrief is always created together with its Project, in
 * one transaction, so there's never a GREETING_VIDEO project without one
 * — this service only ever edits/reads a brief that already exists.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { resolveGreetingConfig } from '../project/greeting-config';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import {
  allowedTonesFor,
  toneAllowedFor,
} from '../../common/greeting-occasions';
import {
  GreetingBriefView,
  GreetingOccasion,
  GreetingPresenterProvider,
  GreetingResolution,
  GreetingTone,
} from '../../common/types/greeting.types';

interface GreetingBriefRow {
  id: string;
  projectId: string;
  occasion: GreetingOccasion;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: GreetingTone;
  personalMessage: string | null;
  presenterProvider: string;
  resolution: string;
  brandManifestId: string | null;
  occasionDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class GreetingBriefService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async getBrief(
    userId: string,
    projectId: string,
  ): Promise<GreetingBriefView> {
    const row = await this.findOwnBrief(userId, projectId);
    return toGreetingBriefView(row);
  }

  /**
   * §8: правка текста/повода/тона до запуска генерации. Нет замка по
   * статусу сессии — сам бриф не знает, начата ли уже генерация (это
   * знает Session, которая копирует бриф СНИМКОМ при создании, §4.3):
   * правка брифа ПОСЛЕ того, как из него уже сделана сессия, просто не
   * затрагивает эту сессию, как и правка ProductItem не затрагивает уже
   * созданные из него Session сегодня.
   */
  async updateBrief(
    userId: string,
    projectId: string,
    dto: UpdateGreetingBriefDto,
  ): Promise<GreetingBriefView> {
    const current = await this.findOwnBrief(userId, projectId);

    const occasion = dto.occasion ?? current.occasion;
    const customOccasionText =
      dto.customOccasionText !== undefined
        ? dto.customOccasionText?.trim() || null
        : current.customOccasionText;
    if (occasion === 'OTHER' && !customOccasionText) {
      throw new BadRequestException(
        'customOccasionText is required when occasion is OTHER',
      );
    }

    /**
     * Этап 2, фича №3 компаньон-ТЗ: тон проверяется на СЕРВЕРЕ, а не
     * прячется в интерфейсе. §3 ТЗ требует именно этого — и не зря:
     * визард можно обойти прямым запросом к API, а шутливое
     * соболезнование обойти нечем.
     *
     * Проверяется ПАРА (повод, тон), а не каждое поле по отдельности,
     * потому что сломать её можно с двух сторон: поставить FUNNY при
     * уже выбранном CONDOLENCE — и сменить повод на CONDOLENCE, когда
     * FUNNY стоял там с прошлой правки. Второй путь незаметнее, и без
     * этой проверки он молча прошёл бы.
     *
     * Отказ, а не тихая подмена тона на допустимый, — принцип 4 раздела
     * 3 компаньон-ТЗ, тот же, по которому `resolveGreetingConfig`
     * отвечает 403 вместо подмены hedra на grok.
     */
    const tone = dto.tone ?? current.tone;
    if (!toneAllowedFor(occasion, tone)) {
      throw new BadRequestException(
        `Тон ${tone} недопустим для повода ${occasion}. Допустимые: ${allowedTonesFor(
          occasion,
        ).join(', ')}.`,
      );
    }

    if (dto.brandManifestId) {
      await this.assertOwnBrandManifest(userId, dto.brandManifestId);
    }

    // §7: провайдер/разрешение — то же самое гейтирование, что при
    // создании (см. `resolveGreetingConfig`'s doc-comment) — правка снимка
    // конфигурации тоже активный выбор, не только его первичное задание.
    let presenterProvider: GreetingPresenterProvider =
      current.presenterProvider as GreetingPresenterProvider;
    let resolution: GreetingResolution =
      current.resolution as GreetingResolution;
    if (dto.presenterProvider !== undefined || dto.resolution !== undefined) {
      const plan = await this.plans.planOfUser(userId);
      const resolved = resolveGreetingConfig(plan, {
        presenterProvider: dto.presenterProvider ?? presenterProvider,
        resolution: dto.resolution ?? resolution,
      });
      presenterProvider = resolved.presenterProvider;
      resolution = resolved.resolution;
    }

    const row: GreetingBriefRow = await this.prisma.greetingBrief.update({
      where: { id: current.id },
      data: {
        occasion,
        customOccasionText,
        ...(dto.recipientName !== undefined
          ? { recipientName: dto.recipientName.trim() }
          : {}),
        ...(dto.senderName !== undefined
          ? { senderName: dto.senderName?.trim() || null }
          : {}),
        // `tone`, а не `dto.tone`: в базу уходит ровно то значение,
        // которое прошло проверку пары выше.
        tone,
        ...(dto.personalMessage !== undefined
          ? { personalMessage: dto.personalMessage?.trim() || null }
          : {}),
        presenterProvider,
        resolution,
        ...(dto.brandManifestId !== undefined
          ? { brandManifestId: dto.brandManifestId }
          : {}),
        ...(dto.occasionDate !== undefined
          ? {
              occasionDate: dto.occasionDate
                ? new Date(dto.occasionDate)
                : null,
            }
          : {}),
      },
    });
    return toGreetingBriefView(row);
  }

  private async findOwnBrief(
    userId: string,
    projectId: string,
  ): Promise<GreetingBriefRow> {
    // Ownership through the parent project (same pattern as
    // ProjectService.findOwnItem) — `deletedAt: null` on the project so a
    // soft-deleted project's brief reads as 404 during the grace period,
    // like everything else under it.
    const row: GreetingBriefRow | null =
      await this.prisma.greetingBrief.findFirst({
        where: { projectId, project: { userId, deletedAt: null } },
      });
    if (!row) {
      throw new NotFoundException(
        `Greeting brief not found for project ${projectId}`,
      );
    }
    return row;
  }

  private async assertOwnBrandManifest(
    userId: string,
    brandManifestId: string,
  ): Promise<void> {
    const manifest = await this.prisma.brandManifest.findFirst({
      where: { id: brandManifestId, userId },
      select: { id: true },
    });
    if (!manifest) {
      throw new BadRequestException(
        `Brand manifest ${brandManifestId} not found`,
      );
    }
  }
}

export function toGreetingBriefView(row: GreetingBriefRow): GreetingBriefView {
  return {
    id: row.id,
    projectId: row.projectId,
    occasion: row.occasion,
    customOccasionText: row.customOccasionText,
    recipientName: row.recipientName,
    senderName: row.senderName,
    tone: row.tone,
    personalMessage: row.personalMessage,
    presenterProvider: row.presenterProvider as GreetingPresenterProvider,
    resolution: row.resolution as GreetingResolution,
    brandManifestId: row.brandManifestId,
    occasionDate: row.occasionDate ? row.occasionDate.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
