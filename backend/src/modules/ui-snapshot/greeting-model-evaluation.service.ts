import { FIXTURE_IDS } from '../tutorial-runner/fixture-seed';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { sessionData } from '../../common/session.service';
import { createGeminiClient } from '../../common/gemini-client';
import { readBodyWithLimit } from '../../common/external-url-guard';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { GeminiFilesService } from '../analysis/gemini-files.service';
import {
  GREETING_EVAL_FPS,
  GREETING_EVAL_MODELS,
  GREETING_EVAL_PROMPT,
  GREETING_EVAL_VERSION,
  GreetingEvalModel,
  GreetingModelAssessment,
  parseGreetingAssessment,
} from './greeting-model-evaluation';

export interface GreetingEvalRecord {
  sessionId: string;
  videoUrl: string;
  model: GreetingEvalModel;
  version: string;
  fps: number;
  startedAt: string;
  completedAt?: string;
  requestedBy: string;
  status: 'running' | 'complete' | 'failed';
  assessment?: GreetingModelAssessment;
  error?: string;
  elapsedMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  contentSha256?: string;
}
export interface GreetingEvalVideo {
  sessionId: string;
  title: string;
  videoUrl: string;
  createdAt: string;
  reports: GreetingEvalRecord[];
}
const PREFIX = 'greetingEval:';
export function greetingEvaluationKey(
  sessionId: string,
  url: string,
  model: string,
): string {
  return `${PREFIX}${GREETING_EVAL_VERSION}:${createHash('sha256').update(`${sessionId}\n${url}`).digest('hex')}:${model}`;
}

@Injectable()
export class GreetingModelEvaluationService {
  private readonly logger = new Logger(GreetingModelEvaluationService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: GeminiFilesService,
    private readonly usage: AiUsageService,
    private readonly plans: PlanService,
  ) {}

  async list(): Promise<{
    models: readonly string[];
    version: string;
    fps: number;
    videos: GreetingEvalVideo[];
  }> {
    const rows = await this.prisma.session.findMany({
      where: {
        deletedAt: null,
        project: { type: 'GREETING_VIDEO' },
        OR: [
          { user: { isTestUser: true } },
          { projectId: FIXTURE_IDS.greetingDoneProject },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        createdAt: true,
        data: true,
        liveData: true,
        project: { select: { title: true } },
      },
    });
    const stored = await this.prisma.platformSetting.findMany({
      where: { key: { startsWith: PREFIX } },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    const reports = new Map(stored.map((r) => [r.key, r.value]));
    const videos: GreetingEvalVideo[] = [];
    for (const row of rows) {
      const data = sessionData(row);
      const video = data.generatedVideo as
        | {
            status?: string;
            downloadUrl?: string;
            postStatus?: string;
            postError?: unknown;
          }
        | undefined;
      if (
        video?.status !== 'complete' ||
        !video.downloadUrl ||
        video.postStatus === 'pending' ||
        video.postStatus === 'failed' ||
        video.postError
      )
        continue;
      let url: URL;
      try {
        url = new URL(video.downloadUrl);
      } catch {
        continue;
      }
      if (
        url.protocol !== 'https:' ||
        !url.hostname.endsWith('.public.blob.vercel-storage.com') ||
        url.username ||
        url.password ||
        url.port
      )
        continue;
      const found: GreetingEvalRecord[] = [];
      for (const model of GREETING_EVAL_MODELS) {
        const text = reports.get(
          greetingEvaluationKey(row.id, video.downloadUrl, model),
        );
        if (text) {
          try {
            found.push(JSON.parse(text) as GreetingEvalRecord);
          } catch {
            /* malformed stored row is not an assessment */
          }
        }
      }
      videos.push({
        sessionId: row.id,
        title: row.project?.title ?? 'Поздравление',
        videoUrl: video.downloadUrl,
        createdAt: row.createdAt.toISOString(),
        reports: found,
      });
      if (videos.length === 20) break;
    }
    return {
      models: GREETING_EVAL_MODELS,
      version: GREETING_EVAL_VERSION,
      fps: GREETING_EVAL_FPS,
      videos,
    };
  }

  async run(
    sessionId: unknown,
    model: unknown,
    retry: unknown,
    actor: string,
  ): Promise<GreetingEvalRecord> {
    if (
      typeof sessionId !== 'string' ||
      typeof model !== 'string' ||
      !GREETING_EVAL_MODELS.includes(model as GreetingEvalModel) ||
      (retry !== undefined && typeof retry !== 'boolean')
    )
      throw new BadRequestException(
        'Укажите ролик и одну из двух моделей сравнения',
      );
    const video = (await this.list()).videos.find(
      (v) => v.sessionId === sessionId,
    );
    if (!video)
      throw new NotFoundException('Готовое тестовое поздравление не найдено');
    const key = greetingEvaluationKey(sessionId, video.videoUrl, model);
    const previous = await this.prisma.platformSetting.findUnique({
      where: { key },
    });
    if (previous) {
      const prior = JSON.parse(previous.value) as GreetingEvalRecord;
      if (!retry || prior.status !== 'failed') return prior;
    }
    await this.plans.assertCanSpendUser(actor);
    const record: GreetingEvalRecord = {
      sessionId,
      videoUrl: video.videoUrl,
      model: model as GreetingEvalModel,
      version: GREETING_EVAL_VERSION,
      fps: GREETING_EVAL_FPS,
      status: 'running',
      startedAt: new Date().toISOString(),
      requestedBy: actor,
    };
    const encoded = JSON.stringify(record);
    if (previous) {
      const claim = await this.prisma.platformSetting.updateMany({
        where: { key, value: previous.value },
        data: { value: encoded, updatedBy: actor },
      });
      if (!claim.count)
        return JSON.parse(
          (
            await this.prisma.platformSetting.findUniqueOrThrow({
              where: { key },
            })
          ).value,
        ) as GreetingEvalRecord;
    } else {
      try {
        await this.prisma.platformSetting.create({
          data: { key, value: encoded, updatedBy: actor },
        });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
        return JSON.parse(
          (
            await this.prisma.platformSetting.findUniqueOrThrow({
              where: { key },
            })
          ).value,
        ) as GreetingEvalRecord;
      }
    }
    let fileName: string | undefined;
    try {
      const res = await fetch(video.videoUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error('video download failed');
      const bytes = await readBodyWithLimit(res, 32 * 1024 * 1024);
      record.contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const file = await this.files.uploadAndWaitActive(bytes, 'video/mp4');
      fileName = file.name;
      const response = await createGeminiClient().models.generateContent({
        model,
        contents: [
          {
            fileData: { fileUri: file.uri, mimeType: 'video/mp4' },
            videoMetadata: { fps: GREETING_EVAL_FPS },
          },
          { text: GREETING_EVAL_PROMPT },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0,
          maxOutputTokens: 6000,
          httpOptions: { timeout: 100000 },
        },
      });
      await this.usage.recordGemini(response, {
        operation: 'audit',
        model,
        userId: actor,
        sessionId,
        provider: 'GEMINI',
      });
      record.inputTokens = response.usageMetadata?.promptTokenCount;
      record.outputTokens = response.usageMetadata?.candidatesTokenCount;
      record.assessment = parseGreetingAssessment(response.text ?? '');
      record.status = 'complete';
    } catch (e) {
      const status =
        (e as { status?: number; code?: number }).status ??
        (e as { code?: number }).code;
      record.status = 'failed';
      record.error =
        typeof status === 'number'
          ? `Gemini HTTP ${status}: оценка не получена. Другая модель не подставлялась.`
          : 'Оценка не завершена: ошибка загрузки, ответа или учёта. Повтор возможен только явно.';
      this.logger.warn(
        `Greeting evaluation failed (${model}, ${sessionId}): ${e instanceof Error ? e.name : 'unknown'}`,
      );
    } finally {
      if (fileName) await this.files.deleteFile(fileName);
    }
    record.completedAt = new Date().toISOString();
    record.elapsedMs = Date.now() - Date.parse(record.startedAt);
    await this.prisma.platformSetting.update({
      where: { key },
      data: { value: JSON.stringify(record), updatedBy: actor },
    });
    return record;
  }
}
