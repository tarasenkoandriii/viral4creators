/**
 * AbTestService — A/B-варианты одного ролика (TODO §III.6, этап 66).
 * Из одного уже одобренного ролика (тот же товар, тот же стиль)
 * собираются 3 дополнительных дубля, отличающихся только хуком
 * (открывающие секунды) и CTA (закрывающий бит).
 *
 * Здесь — только создание запуска и чтение его статуса. Создание
 * синхронное: один вызов GPT-5 (`PromptService.generateAbVariants`,
 * тот же порядок величины, что у обычной сборки промпта — секунды) плюс
 * запись нескольких строк, без обращения к Veo. Сам старт рендеров (до
 * 3 последовательных вызовов Veo) идёт в `AbTestWorkerService` по крону
 * — тот же принцип §30 SPEC, что у `CatalogBatchService` (этап 65):
 * Veo-старт не должен блокировать ответ на запрос.
 *
 * Доступ — та же Premium-проверка, тот же признак 'library', что у
 * пакетной генерации по каталогу: механика тоже целиком построена на
 * переносе уже одобренного разбора на новые сессии.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { PromptService } from '../prompt/prompt.service';
import {
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';
import { SessionStatus } from '../../common/types/session.types';
import { PlanService } from '../plan/plan.service';
import { AbTestVariantStatus, Prisma } from '@prisma/client';

/** Число вариантов на один запуск — решение владельца продукта: всегда 3. */
export const AB_TEST_VARIANT_COUNT = 3;

export interface StartAbTestResult {
  runId: string;
  /** Сколько строк реально заведено — модель GPT-5 не гарантированно
   * возвращает ровно AB_TEST_VARIANT_COUNT, см. PromptService.generateAbVariants. */
  variantCount: number;
}

export interface AbTestVariantView {
  variantId: string;
  variantIndex: number;
  hookLabel: string;
  ctaLabel: string;
  sessionId: string | null;
  status: AbTestVariantStatus;
  error: string | null;
}

export interface AbTestStatusView {
  runId: string;
  projectId: string;
  variants: AbTestVariantView[];
  summary: {
    pending: number;
    generating: number;
    done: number;
    failed: number;
  };
}

@Injectable()
export class AbTestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly prompts: PromptService,
    private readonly plans: PlanService,
  ) {}

  async create(
    userId: string,
    projectId: string,
    dto: { sourceSessionId: string },
  ): Promise<StartAbTestResult> {
    // Решение владельца продукта: та же Premium-проверка, что у
    // пакетной генерации по каталогу (этап 65) — тем же признаком.
    await this.plans.assertUser(userId, 'library');

    const source = await this.sessions.getSession(dto.sourceSessionId);
    if (!source || source.userId !== userId || source.projectId !== projectId) {
      throw new NotFoundException(
        `Session ${dto.sourceSessionId} not found in project ${projectId}`,
      );
    }
    if (
      source.status !== SessionStatus.VIDEO_COMPLETE ||
      !source.generatedVideo
    ) {
      throw new BadRequestException(
        'A/B-варианты собираются только из уже готового ролика — сначала завершите генерацию для исходной сессии.',
      );
    }
    if (!source.generationPrompt?.finalText) {
      throw new BadRequestException(
        'У исходной сессии нет одобренного промпта — A/B-варианты невозможны.',
      );
    }
    if (!source.librarySourceKey) {
      // Тот же случай, что у catalog-batch: не должно происходить в
      // обычном потоке (каждый завершённый разбор сохраняется в
      // библиотеку автоматически), но кнопка на фронте не должна была
      // это предложить, если всё же произошло — лучше явная ошибка.
      throw new BadRequestException(
        'У исходной сессии нет сохранённого разбора в библиотеке — A/B-варианты невозможны.',
      );
    }
    if (!source.productItemId) {
      throw new BadRequestException(
        'У исходной сессии нет привязанного товара — A/B-варианты собираются только для товаров каталога.',
      );
    }
    const entry = await this.prisma.analysisLibraryEntry.findUnique({
      where: { sourceKey: source.librarySourceKey },
      select: { id: true },
    });
    if (!entry) {
      throw new NotFoundException(
        `Library entry for source ${source.librarySourceKey} not found`,
      );
    }

    // Е-2.5 шестого аудита: не было НИКАКОЙ защиты от конкурентного
    // создания запуска — двойной клик «Собрать A/B» вызывал платный
    // GPT-5 (`generateAbVariants`) дважды и заводил два независимых
    // `AbTestRun` по 3 варианта, воркер отрендерил бы 6 Veo-вариантов
    // вместо 3. Предварительная проверка — ДО дорогого вызова ИИ, чтобы
    // явный повторный клик не платил за GPT-5 вообще; `FAILED` не
    // считается «занято» — тем же приёмом, что `CatalogBatchService.create()`,
    // повторный запуск для уже провалившегося набора вариантов легален.
    await this.assertNotBusy(dto.sourceSessionId);

    // Единственный дорогой вызов — один раз на весь запуск, не по
    // одному на строку (см. комментарий класса выше).
    const drafts = await this.prompts.generateAbVariants(
      dto.sourceSessionId,
      AB_TEST_VARIANT_COUNT,
    );
    if (drafts.length === 0) {
      throw new BadRequestException(
        'Сервис ИИ не вернул ни одного варианта — попробуйте ещё раз.',
      );
    }

    // Serializable — та же защита от гонки «прочитать свободно → вставить»
    // между двумя параллельными create() с одним и тем же sourceSessionId,
    // что уже есть у `CatalogBatchService.create()` (Д-2.2 пятого аудита);
    // предварительная проверка выше не мешает ей случиться, только экономит
    // GPT-5 при явном повторном клике после уже готового ответа сервера.
    const MAX_SERIALIZATION_RETRIES = 3;
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_SERIALIZATION_RETRIES; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await this.assertNotBusy(dto.sourceSessionId, tx);
            const created = await tx.abTestRun.create({
              data: {
                projectId,
                userId,
                sourceSessionId: dto.sourceSessionId,
                productItemId: source.productItemId as string,
                libraryEntryId: entry.id,
                quality: (source.generatedVideo?.quality ??
                  'fast') as VideoQuality,
                aspectRatio: source.generatedVideo?.aspectRatio ?? null,
                locale: source.locale ?? null,
              },
            });
            await tx.abTestVariant.createMany({
              data: drafts.map((d, i) => ({
                runId: created.id,
                variantIndex: i,
                hookLabel: d.hookLabel,
                ctaLabel: d.ctaLabel,
                promptText: d.prompt,
                voiceoverScript: d.voiceoverScript,
              })),
            });
            return { runId: created.id, variantCount: drafts.length };
          },
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        // P2034 — сериализационный конфликт, тот же повод для повтора
        // ЦЕЛИКОМ, что и в `CatalogBatchService.create()`.
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== 'P2034') throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * Е-2.5 шестого аудита — «занято», если у этого `sourceSessionId` уже
   * есть запуск с хотя бы одним вариантом НЕ в статусе `FAILED` (то есть
   * ждёт/рендерится/уже готов). Полностью провалившийся набор вариантов
   * не блокирует повторный запуск — та же логика, что у
   * `CatalogBatchService.create()` для отдельных товаров партии.
   */
  private async assertNotBusy(
    sourceSessionId: string,
    tx: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const busy = await tx.abTestVariant.findFirst({
      where: {
        status: { not: 'FAILED' },
        run: { sourceSessionId },
      },
      select: { id: true },
    });
    if (busy) {
      throw new BadRequestException(
        'Для этого ролика уже собирается или готов набор A/B-вариантов — повторный запуск не нужен.',
      );
    }
  }

  async getStatus(
    userId: string,
    projectId: string,
    runId: string,
  ): Promise<AbTestStatusView> {
    const run = await this.prisma.abTestRun.findUnique({
      where: { id: runId },
      include: { variants: { orderBy: { variantIndex: 'asc' } } },
    });
    if (!run || run.userId !== userId || run.projectId !== projectId) {
      throw new NotFoundException(`A/B run ${runId} not found`);
    }

    const views: AbTestVariantView[] = [];
    for (const variant of run.variants) {
      let status: AbTestVariantStatus = variant.status;
      let error = variant.error;
      // Живое чтение — сам рендер отслеживается штатно через
      // session.data.generatedVideo (тот же приём, что у CatalogBatchService.
      // getStatus, этап 65) — воркер сюда за этим не возвращается.
      if (status === 'GENERATING' && variant.sessionId) {
        const session = await this.sessions.getSession(variant.sessionId);
        const video = session?.generatedVideo;
        if (video?.status === GenerationStatus.COMPLETE) {
          status = 'DONE';
          await this.prisma.abTestVariant
            .update({ where: { id: variant.id }, data: { status: 'DONE' } })
            .catch(() => undefined);
        } else if (video?.status === GenerationStatus.FAILED) {
          status = 'FAILED';
          error = video.error?.message ?? 'Рендер не удался';
          await this.prisma.abTestVariant
            .update({
              where: { id: variant.id },
              data: { status: 'FAILED', error },
            })
            .catch(() => undefined);
        }
      }
      views.push({
        variantId: variant.id,
        variantIndex: variant.variantIndex,
        hookLabel: variant.hookLabel,
        ctaLabel: variant.ctaLabel,
        sessionId: variant.sessionId,
        status,
        error,
      });
    }

    const summary = {
      pending: views.filter((v) => v.status === 'PENDING').length,
      generating: views.filter((v) => v.status === 'GENERATING').length,
      done: views.filter((v) => v.status === 'DONE').length,
      failed: views.filter((v) => v.status === 'FAILED').length,
    };

    return {
      runId: run.id,
      projectId: run.projectId,
      variants: views,
      summary,
    };
  }
}
