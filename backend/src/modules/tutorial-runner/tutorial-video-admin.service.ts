/**
 * TutorialVideoAdminService — вкладка «Видео-контент»/«Состояние данных»
 * админки (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.9, этап 99).
 * Тот же приём, что `TutorialScenarioAdminService`
 * (tutorial-scenario/tutorial-scenario-admin.service.ts): собственный
 * сервис/контроллер внутри фиче-модуля, читающая часть отдаёт «как в
 * базе», пишущая — только флаг `reviewed`, ничего не пересчитывает.
 *
 * Без `reviewed:true` собранное видео физически недоступно никому, кроме
 * прямого запроса к базе — ни консультанту (`AssistantService.
 * resolveVideoActions` фильтрует по этому же флагу), ни посетителю сайта.
 * Поэтому `setReviewed(id, true, ...)` — момент, когда видео становится
 * ЖИВЫМ для посетителей лендинга немедленно (см. предупреждение в
 * контроллере/фронтенде), а не «поставлено в очередь на публикацию».
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SUPPORTED_LOCALES, SupportedLocale } from '../../common/locale';
import {
  ASSISTANT_KNOWLEDGE_BUILT_AT,
  ASSISTANT_KNOWLEDGE_COMMIT,
  ASSISTANT_STEPS,
} from '../assistant/knowledge/generated';

export interface TutorialVideoListFilter {
  subjectKey?: string;
  locale?: string;
  reviewed?: boolean;
  page: number;
  pageSize: number;
}

/** Джобы, относящиеся к этой подсистеме (генерация сценариев, этап 94, их
 * headless-исполнение + сборка видео, этап 97/98, и крон-обход
 * интерфейса Части А ТЗ, `ui-snapshot-run`, этап 100) — единственное
 * место, где этот короткий список держится как код для сводки «Состояние
 * данных» (§4.9). `ui-snapshot-run` добавлен здесь именно этапом 100 —
 * до этого его не было намеренно (показывать сводку по несуществующей
 * джобе значило бы либо врать нулями, либо путать оператора отсутствующей
 * строкой), см. `## Сделано (этап 99 — ...)` в
 * `PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, где это было явно отложено. */
const RELEVANT_JOB_KEYS = [
  'tutorial-scenario-generate',
  'tutorial-scenario-run',
  'ui-snapshot-run',
] as const;

@Injectable()
export class TutorialVideoAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async list(filter: TutorialVideoListFilter) {
    const where = {
      subjectKey: filter.subjectKey || undefined,
      locale: filter.locale || undefined,
      reviewed: filter.reviewed,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tutorialVideoAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.tutorialVideoAsset.count({ where }),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize };
  }

  /**
   * Переключает `reviewed` (§4.9 — «просмотр/одобрение»). Не одобрение
   * траты (в отличие от `TutorialScenarioAdminService.approve` — там
   * идемпотентно и необратимо), а публикационный флаг: оператор может
   * снять одобрение так же легко, как поставить (например, если после
   * публикации нашёлся брак в кадрах) — поэтому не идемпотентный
   * one-way, а обычная установка значения.
   */
  async setReviewed(id: string, reviewed: boolean) {
    const row = await this.prisma.tutorialVideoAsset.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Видео не найдено');
    return this.prisma.tutorialVideoAsset.update({
      where: { id },
      data: { reviewed },
    });
  }

  /** «Состояние данных» (§4.9) — агрегированная сводка, без фильтров. */
  async dataStatus() {
    const stepCounts: Record<string, number> = {};
    for (const locale of SUPPORTED_LOCALES) {
      stepCounts[locale] = ASSISTANT_STEPS[locale]?.length ?? 0;
    }

    const [coverageGroups, lastRuns] = await Promise.all([
      this.prisma.tutorialVideoAsset.groupBy({
        by: ['subjectKey', 'locale'],
        where: { reviewed: true },
        _count: { _all: true },
      }),
      Promise.all(
        RELEVANT_JOB_KEYS.map((jobKey) =>
          this.prisma.cronRunLog.findFirst({
            where: { jobKey },
            orderBy: { startedAt: 'desc' },
          }),
        ),
      ),
    ]);

    const videoCoverage = coverageGroups.map((g) => ({
      subjectKey: g.subjectKey,
      locale: g.locale as SupportedLocale,
      reviewedCount: g._count._all,
    }));

    return {
      knowledge: {
        builtAt: ASSISTANT_KNOWLEDGE_BUILT_AT,
        commit: ASSISTANT_KNOWLEDGE_COMMIT,
      },
      stepCounts,
      videoCoverage,
      lastRuns: RELEVANT_JOB_KEYS.map((jobKey, i) => {
        const run = lastRuns[i];
        return {
          jobKey,
          status: run?.status ?? null,
          startedAt: run?.startedAt ?? null,
          finishedAt: run?.finishedAt ?? null,
          summary: run?.summary ?? null,
          errorMessage: run?.errorMessage ?? null,
        };
      }),
    };
  }
}
