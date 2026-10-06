/**
 * Гид мастера → режим «Админка» помощника платформы (Э-С Ш6).
 *
 * Две стороны:
 *  - **TMA** (вошедший пользователь): какой гид у него (флаг), и
 *    employee-JWT для загрузчика «Админки» (`V4CAssist('identify-admin')`);
 *  - **коннектор платформы** (ключ коннектора + `X-V4C-Actor`): факты
 *    проектов словами (Э7 `read`).
 *
 * Конфигурация читается из env на каждом запросе (дёшево, и смена env на
 * Vercel не требует ничего, кроме передеплоя).
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { scenarioOfProjectType } from '../../common/test-user-scenarios';
import { PROJECT_NOT_FOUND } from '../../common/user-facing-errors';
import { readScenarioFacts } from '../wizard-guide/hint-facts-reader';
import {
  readGuideAssistConfig,
  resolveGuideEngine,
  readGuideFactsConfig,
  type GuideAssistEnv,
  type GuideEngine,
} from './guide-assist-config';
import { signGuideJwt, userIdOfActor } from './guide-assist-jwt';
import {
  projectFactsView,
  projectListItem,
  type ProjectFactsView,
  type ProjectListItem,
} from './guide-assist-facts';

/** Сколько проектов отдаёт список (новые сверху). */
export const GUIDE_PROJECTS_LIMIT = 20;

/** Ответ TMA «какой у меня гид». Для `legacy` — больше ничего. */
export type GuideAssistClientConfig =
  | { engine: 'legacy' }
  | { engine: 'assist'; pk: string; origin: string };

export class GuideAssistDisabledError extends Error {
  constructor() {
    super('Помощник в режиме «Админка» для этого пользователя не включён');
    this.name = 'GuideAssistDisabledError';
  }
}

@Injectable()
export class GuideAssistService {
  private readonly logger = new Logger(GuideAssistService.name);
  private warned = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly plan: PlanService,
  ) {}

  /** Переопределяется в тестах. */
  protected env(): GuideAssistEnv {
    return process.env;
  }

  private config() {
    const r = readGuideAssistConfig(this.env());
    // Неполная конфигурация — старый гид и одно предупреждение в лог на
    // каждый новый набор причин (без значений переменных).
    const sig = r.problems.join('|');
    if (sig && sig !== this.warned) {
      this.warned = sig;
      this.logger.warn(
        `гид «Админка» (${r.requested}) не включён: ${r.problems.join('; ')}`,
      );
    }
    return r.config;
  }

  /** Гид этого человека: `legacy` | `assist`. */
  async engineOf(userId: string | null | undefined): Promise<GuideEngine> {
    return resolveGuideEngine(this.config(), userId, (id) =>
      this.prisma.user.findUnique({
        where: { id },
        select: { id: true, telegramId: true },
      }),
    );
  }

  async clientConfig(
    userId: string | null | undefined,
  ): Promise<GuideAssistClientConfig> {
    const config = this.config();
    if (!config || (await this.engineOf(userId)) !== 'assist') {
      return { engine: 'legacy' };
    }
    return { engine: 'assist', pk: config.pk, origin: config.origin };
  }

  /**
   * employee-JWT. Только тем, у кого гид — «Админка»: остальным JWT не
   * нужен, а выдавать его «на всякий случай» значило бы открыть чат
   * сотрудника мимо флага.
   */
  async issueIdentity(userId: string): Promise<{ jwt: string; exp: number }> {
    const config = this.config();
    if (!config || (await this.engineOf(userId)) !== 'assist') {
      throw new GuideAssistDisabledError();
    }
    return signGuideJwt({
      userId,
      siteId: config.siteId,
      role: config.role,
      ttlSec: config.ttlSec,
      jwtSecret: config.jwtSecret,
    });
  }

  // ── Коннектор платформы ───────────────────────────────────────────

  /** Ключи API фактов; `null` — API выключен (404). */
  factsConfig() {
    return readGuideFactsConfig(this.env());
  }

  /** `X-V4C-Actor` → пользователь; `null` — подпись чужая или нет такого. */
  async userOfActor(actor: string | undefined): Promise<string | null> {
    const cfg = this.factsConfig();
    if (!cfg) return null;
    const userId = userIdOfActor(actor, cfg.jwtSecret);
    if (!userId) return null;
    const row: { id: string } | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  async listProjects(
    userId: string,
    now = new Date(),
  ): Promise<{ projects: ProjectListItem[] }> {
    const rows: Array<{ id: string; type: string; updatedAt: Date }> =
      await this.prisma.project.findMany({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: GUIDE_PROJECTS_LIMIT,
        select: { id: true, type: true, updatedAt: true },
      });
    return {
      projects: rows.map((r, i) =>
        projectListItem(r, i + 1, scenarioOfProjectType(r.type), now),
      ),
    };
  }

  async projectFacts(
    userId: string,
    projectId: string,
  ): Promise<ProjectFactsView> {
    // Владение — здесь, явно: чужой и удалённый проект — 404 (как у
    // советника), без различия «нет» и «чужой».
    const row: { type: string } | null = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { type: true },
    });
    if (!row) throw new NotFoundException(PROJECT_NOT_FOUND);
    const scenario = scenarioOfProjectType(row.type);
    const facts = scenario
      ? await readScenarioFacts(this.prisma, scenario, projectId)
      : [];
    return projectFactsView(projectId, scenario, facts);
  }

  async accountSummary(
    userId: string,
  ): Promise<{ plan: string; projects: number }> {
    const [plan, projects] = await Promise.all([
      this.plan.planOfUser(userId),
      this.prisma.project.count({ where: { userId, deletedAt: null } }),
    ]);
    return { plan, projects };
  }
}
