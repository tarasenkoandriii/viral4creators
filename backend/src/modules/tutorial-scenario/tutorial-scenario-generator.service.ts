/**
 * TutorialScenarioGeneratorService — крон-воркер `tutorial-scenario-
 * generate` (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.10,
 * этап 94). Вызывается `CronJobsService.runTutorialScenarioGenerate()`,
 * тем же способом, что и остальные воркеры этого модуля семейства
 * (`ExportService.runSyncTick`, `CatalogBatchWorkerService.runBatch` и
 * т.п.) — прогон делает вся эта логика, `CronJobsService` только
 * оборачивает джоб-локом и передаёт результат в `runAndLog`.
 *
 * ## Объём этой итерации (сознательно сужен)
 *
 * Только 10 шагов обучалки (`ASSISTANT_STEPS`, subjectKey '1'..'10'),
 * только локаль `ru` — тот же принцип, что уже применён к MVP части А
 * этого же ТЗ (§3.8/аудит §10 п.7): расширение на остальные локали и на
 * свободные ключи воркфлоу за пределами обучалки (`postprod-revoice` и
 * подобные, §4.4) — отдельный, более поздний шаг, не первая версия.
 * ИСПОЛНЕНИЕ сгенерированных сценариев (§5 ТЗ, headless-браузер) в этой
 * итерации НЕ реализуется — нет самой браузерной инфраструктуры (§3.2
 * ТЗ, зависимость ещё не заведена); этот сервис только пишет и
 * оценивает сценарии, оставляя `lastRunAt`/`lastRunStatus`/
 * `lastRunError` пустыми до тех пор, пока драйвер не появится.
 *
 * ## Best-effort по каждому шагу отдельно
 *
 * Один упавший/невалидный ответ модели на одном шаге не должен уронить
 * весь прогон — тот же принцип, что у остальных крон-воркеров проекта
 * (`best-effort`, см. доккомментарии `CronController`): считается и
 * логируется, прогон продолжается на следующем subjectKey.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { PrismaService } from '../../prisma/prisma.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { ASSISTANT_STEPS } from '../assistant/knowledge/generated';
import { estimateScenarioCost } from './scenario-cost';
import {
  buildScenarioPrompt,
  parseScenarioResponse,
} from './tutorial-scenario-prompt';

/** Только обучалка (§4.4 ТЗ), только ru — см. доккомментарий класса. */
const SUBJECT_LOCALE = 'ru';

export interface TutorialScenarioGenerateResult {
  subjectKeys: number;
  generated: number;
  costly: number;
  failed: number;
  failures: Array<{ subjectKey: string; reason: string }>;
}

@Injectable()
export class TutorialScenarioGeneratorService {
  private readonly logger = new Logger(TutorialScenarioGeneratorService.name);
  private readonly genai: GoogleGenAI;

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {
    // Тот же приём, что video-audit/relevance/analysis и т.п. — клиент
    // создаётся сервисом сам, не инжектится (common/gemini-client.ts).
    this.genai = createGeminiClient();
  }

  async run(): Promise<TutorialScenarioGenerateResult> {
    const steps = ASSISTANT_STEPS[SUBJECT_LOCALE] ?? [];
    const result: TutorialScenarioGenerateResult = {
      subjectKeys: steps.length,
      generated: 0,
      costly: 0,
      failed: 0,
      failures: [],
    };

    for (let i = 0; i < steps.length; i++) {
      const subjectKey = String(i + 1);
      const step = steps[i];
      try {
        const prompt = buildScenarioPrompt(subjectKey, SUBJECT_LOCALE, step);
        const res = await this.genai.models.generateContent({
          model: GEMINI_MODEL,
          contents: [{ text: prompt }],
          config: { responseMimeType: 'application/json' },
        });
        await this.aiUsage.recordGemini(res, {
          operation: 'tutorial-scenario-generate',
          model: GEMINI_MODEL,
        });

        const parsed = parseScenarioResponse(res.text ?? '');
        if (!parsed.ok) {
          result.failed++;
          result.failures.push({
            subjectKey,
            reason: parsed.reason ?? 'неизвестная причина',
          });
          this.logger.warn(
            `сценарий для шага ${subjectKey} не сгенерирован: ${parsed.reason}`,
          );
          continue;
        }

        const cost = estimateScenarioCost(parsed.steps);
        await this.prisma.tutorialScenario.create({
          data: {
            subjectKey,
            locale: SUBJECT_LOCALE,
            steps: parsed.steps as object,
            generatedBy: 'ai',
            costly: cost.costly,
            estimatedCostMicroUsd: cost.estimatedCostMicroUsd,
            costUnpriced: cost.unpriced,
          },
        });
        result.generated++;
        if (cost.costly) result.costly++;
        if (cost.unpriced) {
          this.logger.warn(
            `сценарий для шага ${subjectKey}: прикидка стоимости занижена (нет ставки хотя бы для одной модели) — проверьте common/ai-pricing.ts перед одобрением`,
          );
        }
      } catch (error) {
        result.failed++;
        const reason = error instanceof Error ? error.message : String(error);
        result.failures.push({ subjectKey, reason });
        this.logger.warn(
          `сценарий для шага ${subjectKey} упал с ошибкой: ${reason}`,
        );
      }
    }

    return result;
  }
}
