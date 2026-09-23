/**
 * WizardGuideService — чекбокс «использовать ИИ» и рубильники
 * («Тонкая красная линия», §3, этап 5).
 *
 * На этом этапе модель не зовётся ни разу: сначала рубильник, потом то,
 * что он выключает. Порядок не случайный — возможность погасить фичу
 * должна существовать раньше самой фичи, иначе гасить её нечем до
 * следующего деплоя.
 */

import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  AI_GUIDE_TOO_LATE,
  canEnableAiGuide,
  type ScenarioProgress,
} from '../../common/wizard-guide-access';
import { scenarioOfProjectType } from '../../common/test-user-scenarios';
import { AI_GUIDE_ENABLED_KEY } from './guide-settings';
import { SessionStatus } from '../../common/types/session.types';

/**
 * Статусы сессии товарки, при которых мастер ещё на первом шаге.
 *
 * `created` — сессию только что завели кнопкой на экране товара;
 * `video_uploaded` — референс выбран, но разбор не запущен. Всё
 * остальное означает, что путь пошёл.
 */
const UNSTARTED_PRODUCT_STATUSES: string[] = [
  SessionStatus.CREATED,
  SessionStatus.VIDEO_UPLOADED,
];

/**
 * Глобальный рубильник фичи — правится оператором без деплоя. Ключ
 * живёт в `guide-settings.ts` вместе с остальными; реэкспорт оставлен,
 * потому что на него ссылаются тесты и админский сервис.
 */
export { AI_GUIDE_ENABLED_KEY };

export interface WizardGuideState {
  /** Галочка стоит у этого проекта. */
  enabled: boolean;
  /**
   * Галочку ещё можно поставить. `false` не значит «выключено» —
   * значит «сценарий уже идёт» (§3.2).
   */
  canEnable: boolean;
  /**
   * Фича включена оператором глобально. `false` — интерфейс прячет
   * чекбокс целиком, а не показывает его неработающим: неработающий
   * переключатель хуже отсутствующего, потому что обещает.
   */
  available: boolean;
}

@Injectable()
export class WizardGuideService {
  private readonly logger = new Logger(WizardGuideService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  /** Умолчание — выключено, как у лендингового ассистента. */
  async available(): Promise<boolean> {
    return (await this.settings.get(AI_GUIDE_ENABLED_KEY)) === 'true';
  }

  async stateOf(userId: string, projectId: string): Promise<WizardGuideState> {
    const project = await this.ownProject(userId, projectId);
    return {
      enabled: project.aiGuideEnabled,
      canEnable: canEnableAiGuide(
        await this.progressOf(projectId, project.type),
      ),
      available: await this.available(),
    };
  }

  /**
   * Выключение проходит всегда, включение — только в начале сценария.
   *
   * Асимметрия и есть смысл §3.2, и проверка обязана быть здесь:
   * интерфейс обходится прямым запросом.
   */
  async setEnabled(
    userId: string,
    projectId: string,
    enabled: boolean,
  ): Promise<WizardGuideState> {
    const project = await this.ownProject(userId, projectId);
    if (enabled && !project.aiGuideEnabled) {
      const progress = await this.progressOf(projectId, project.type);
      if (!canEnableAiGuide(progress)) {
        throw new ConflictException(AI_GUIDE_TOO_LATE);
      }
    }
    if (enabled !== project.aiGuideEnabled) {
      await this.prisma.project.update({
        where: { id: projectId },
        data: { aiGuideEnabled: enabled },
      });
      this.logger.log(
        `проект ${projectId}: советы ИИ ${enabled ? 'включены' : 'выключены'}`,
      );
    }
    return this.stateOf(userId, projectId);
  }

  /**
   * Сценарий проекта — для телеметрии (§8).
   *
   * Заодно это и проверка владения: чужой `projectId` бросает 404, и
   * приписать событие чужому сценарию нельзя. `null` — проект есть, но
   * его тип советнику неизвестен (сценарии добавляются волнами).
   */
  async scenarioOf(userId: string, projectId: string): Promise<string | null> {
    const project = await this.ownProject(userId, projectId);
    return scenarioOfProjectType(project.type);
  }

  private async ownProject(
    userId: string,
    projectId: string,
  ): Promise<{ type: string; aiGuideEnabled: boolean }> {
    // Владение проверяется здесь, явно: маршруты мини-аппа опознают
    // звонящего `TelegramIdentityGuard`, а принадлежность проекта
    // сервисы проверяют сами (конвенция `GreetingBriefController`).
    const row: { type: string; aiGuideEnabled: boolean } | null =
      await this.prisma.project.findFirst({
        where: { id: projectId, userId, deletedAt: null },
        select: { type: true, aiGuideEnabled: true },
      });
    if (!row) throw new NotFoundException(`Project ${projectId} not found`);
    return row;
  }

  /**
   * Признаки «сценарий уже идёт», по одному на тип проекта.
   *
   * Читается ровно то, что нужно: у обучалки — длина `stepsPerRound`
   * (колонка, а не производное значение), у остальных — факт
   * существования сессии.
   */
  private async progressOf(
    projectId: string,
    type: string,
  ): Promise<ScenarioProgress> {
    const scenario = scenarioOfProjectType(type);
    if (scenario === 'CLIENT_SITE') {
      const draft: { stepsPerRound: number[] } | null =
        await this.prisma.clientSiteTutorialDraft.findUnique({
          where: { projectId },
          select: { stepsPerRound: true },
        });
      return { clientSiteFrames: draft?.stepsPerRound.length ?? 0 };
    }

    if (scenario === 'PRODUCT_VIDEO') {
      // У товарки сессия создаётся той же кнопкой, которая ОТКРЫВАЕТ
      // мастер (`createSessionFromItem` на экране товара). Считать её
      // признаком «сценарий пошёл» значит не дать включить советы
      // никогда — чекбокс был бы недоступен уже на первом кадре.
      // Первый шаг товарки — выбор референса, и он длится, пока не
      // начался разбор (ТЗ §3.2).
      const started = await this.prisma.session.count({
        where: {
          projectId,
          deletedAt: null,
          status: { notIn: UNSTARTED_PRODUCT_STATUSES },
        },
      });
      return { hasAnalysis: started > 0 };
    }

    // Greeting: сессия создаётся кнопкой ПОСЛЕ брифа, то есть весь
    // первый шаг она ещё не существует.
    const sessions = await this.prisma.session.count({
      where: { projectId, deletedAt: null },
    });
    return { hasSession: sessions > 0 };
  }
}
