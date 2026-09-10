/**
 * ExportService — автоэкспорт одной генерации под несколько площадок и
 * форматов сразу (TODO §III, «Уровень 6», п.35; `doc/MULTI-FORMAT-EXPORT-SPEC.md`,
 * этап 75). Закрывает «Горизонт 2» дорожной карты (`doc/TODO.md` §IV) —
 * последний из четырёх пунктов, отмеченных ✅ на этапах 60/61/67.
 *
 * ## Два яруса — два разных действия, не один список чекбоксов
 *
 * **Ярус A** (дёшево, без нового рендера) — обрезка уже готового файла в
 * форматы ТОГО ЖЕ семейства кадра (`aspectRatioFamily`), одной пакетной
 * задачей ffmpeg. Реализован в `PostProductionService.startExport()`/
 * `pollExport()` — тот же сервис, что уже владеет
 * `FfmpegApiService`/`BlobService`/журналом расходов для основной
 * постобработки, лишнего слоя здесь заводить незачем.
 *
 * **Ярус B** (дорого, второй платный рендер) — формат из ДРУГОГО
 * семейства не получить обрезкой без потери большей части кадра (§2.3/§3
 * документа). Технически это НЕ постобработка, а второй запуск Veo тем
 * же одобренным промптом с другим `aspectRatio` — тем же приёмом, что уже
 * использует `CatalogBatchWorkerService`/`AbTestWorkerService.processOne()`
 * для дочерних сессий (`ProjectSessionService.createFromItem` +
 * `PromptService.seedPrompt`/`approvePrompt` + `GenerationService.generateVideo`),
 * только без крона: одна дочерняя сессия создаётся синхронно по явному
 * запросу пользователя, а не строкой в очереди партии.
 *
 * Владелец продукта решил включить оба яруса сразу (этап 75, а не
 * выпускать сначала только A, как предлагал открытый вопрос §7.1
 * документа).
 *
 * ## Почему статус яруса B не хранит собственную задачу
 *
 * У яруса A есть `exportJobId` — id пакетной задачи ffmpeg. У яруса B
 * задачи нет: прогресс двигает САМА дочерняя сессия через уже
 * существующий `GenerationService.getVideoStatus()` (Veo-рендер, потом
 * её собственная постобработка). `syncStatus()` ниже просто читает её
 * состояние и переносит в `ExportVariant` родительской сессии — второй
 * механизм опроса ради того же самого был бы лишним (тот же принцип, что
 * у `PostProductionService.poll()`).
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SessionService, SessionSeed } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { PromptService } from '../prompt/prompt.service';
import { GenerationService } from '../generation/generation.service';
import {
  EXPORT_CLAIM_TTL_MS,
  PostProductionService,
} from '../postprod/postprod.service';
import { PostProdError } from '../../common/postprod';
import { aspectRatioFamily, presetByKey } from '../../common/aspect-ratio';
import {
  ExportVariant,
  GeneratedVideo,
  GenerationStatus,
  VideoQuality,
} from '../../common/types/generation.types';
import { Session } from '../../common/types/session.types';

/** Сколько сессий с ожидающим вариантом яруса B досматривает один тик
 * крон-аналога `advanceGenerating()` (Е-2.3 шестого аудита, этап 76) —
 * тот же порядок величины, что `cronBatch` у остальных батч-воркеров. */
export const EXPORT_SYNC_BATCH = 50;

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly prompt: PromptService,
    private readonly generation: GenerationService,
    private readonly postprod: PostProductionService,
  ) {}

  private async ownSessionWithVideo(
    sessionId: string,
  ): Promise<{ session: Session; video: GeneratedVideo }> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    const video = session.generatedVideo;
    if (!video || video.status !== GenerationStatus.COMPLETE) {
      throw new BadRequestException(
        'ролик ещё не готов — автоэкспорт доступен только для готового ролика',
      );
    }
    return { session, video };
  }

  /**
   * POST /sessions/:id/export — ярус A. `targets` — пресеты или голые
   * форматы вперемешку; резолвится здесь, дальше в
   * `PostProductionService.startExport()` уходят только форматы.
   */
  async startBatch(
    sessionId: string,
    rawTargets: string[],
  ): Promise<GeneratedVideo> {
    await this.plans.assertSession(sessionId, 'customAspectRatio');
    const { video } = await this.ownSessionWithVideo(sessionId);

    const resolved = rawTargets.map((raw) => {
      const preset = presetByKey(raw);
      return { format: preset?.format ?? raw.trim(), preset: preset?.key };
    });
    // Пресеты передаём вниз меткой поверх результата — `startExport`
    // работает только с форматами и не знает о пресетах вовсе.
    const byFormat = new Map(resolved.map((r) => [r.format, r.preset]));

    let updated: GeneratedVideo;
    try {
      updated = await this.postprod.startExport(
        sessionId,
        video,
        resolved.map((r) => r.format),
      );
    } catch (e) {
      // `PostProdError` — обычный Error, не Nest HttpException (та же
      // причина, что у `common/reframe.ts`'s `ReframeError`): не
      // перехваченный здесь, дошёл бы до клиента как 500, хотя это
      // обычная ошибка валидации запроса пользователя.
      if (e instanceof PostProdError) throw new BadRequestException(e.message);
      throw e;
    }
    if (!byFormat.size) return updated;
    return this.attachPresetLabels(sessionId, updated, byFormat);
  }

  /** Проставить `preset` на только что созданные варианты — отдельным шагом, чтобы не тащить эту деталь в `PostProductionService` (он про форматы, не про площадки). */
  private async attachPresetLabels(
    sessionId: string,
    video: GeneratedVideo,
    byFormat: Map<string, string | undefined>,
  ): Promise<GeneratedVideo> {
    const variants = (video.exportVariants ?? []).map((v) =>
      !v.preset && byFormat.has(v.format)
        ? { ...v, preset: byFormat.get(v.format) }
        : v,
    );
    const saved = await this.sessions.updateSession(sessionId, {
      generatedVideo: { ...video, exportVariants: variants },
    });
    return saved?.generatedVideo ?? { ...video, exportVariants: variants };
  }

  /**
   * POST /sessions/:id/export/rerender — ярус B: новая дочерняя сессия,
   * тем же одобренным промптом, другой целевой формат, обычный платный
   * рендер Veo.
   *
   * ## Захват работы + свежее чтение (Е-2.1 шестого аудита, этап 76)
   *
   * Дешёвые пре-проверки ниже (семейство кадра, «уже одобрен промпт»)
   * идут по снимку `video`/`session`, прочитанному чуть выше — они не
   * могут навредить, даже если снимок успеет устареть, потому что
   * ничего не пишут. Но создание дочерней сессии и платный
   * `generateVideo()` — необратимые внешние эффекты: без замка два
   * конкурентных запроса на ОДИН И ТОТ ЖЕ формат оба проходят проверку
   * «уже запрошен» по устаревшему `video`, оба стартуют свою дочернюю
   * сессию и платят за рендер Veo дважды за один и тот же формат
   * (потерянного обновления при записи здесь при этом ДАЖЕ нет — у
   * каждой дочерней сессии свой резерв кредита, — но двойная реальная
   * оплата есть). Тот же приём, что у `PostProductionService.startExport`
   * (см. её доккомментарий) — один общий вид работы `'export'` на оба
   * яруса.
   */
  async startRerender(
    sessionId: string,
    targetAspectRatio: string,
    preset: string | undefined,
    quality: VideoQuality | undefined,
  ): Promise<{ video: GeneratedVideo; childSessionId: string }> {
    await this.plans.assertSession(sessionId, 'customAspectRatio');
    const { session, video } = await this.ownSessionWithVideo(sessionId);

    const target = targetAspectRatio.trim();
    const sourceFamily = aspectRatioFamily(
      video.renderedAspectRatio ?? video.aspectRatio ?? '9:16',
    );
    if (aspectRatioFamily(target) === sourceFamily) {
      throw new BadRequestException(
        `формат ${target} — того же семейства кадра, что уже отрендерен; ` +
          'используйте дешёвый POST /export вместо повторного рендера',
      );
    }
    const already = (video.exportVariants ?? []).find(
      (v) => v.tier === 'B' && v.format === target && v.status !== 'failed',
    );
    if (already) {
      throw new BadRequestException(
        `формат ${target} уже запрошен (статус: ${already.status})`,
      );
    }

    const prompt = session.generationPrompt;
    if (!prompt?.approvedAt) {
      throw new BadRequestException(
        'у сессии нет одобренного промпта — перерендер копирует именно его',
      );
    }

    const claimed = await this.sessions.claimWork(
      sessionId,
      'export',
      EXPORT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new BadRequestException(
        'автоэкспорт уже выполняется — дождитесь его завершения',
      );
    }
    try {
      const fresh = await this.sessions.getSession(sessionId);
      const freshVideo = fresh?.generatedVideo ?? video;
      const stillAlready = (freshVideo.exportVariants ?? []).find(
        (v) => v.tier === 'B' && v.format === target && v.status !== 'failed',
      );
      if (stillAlready) {
        throw new BadRequestException(
          `формат ${target} уже запрошен параллельным запросом (статус: ${stillAlready.status})`,
        );
      }

      // Дочерняя сессия наследует ровно то же, что уже носит в себе
      // `createFromItem` (см. доккомментарий класса): copy productInformation
      // + brandManifestSnapshot, а не ссылку на них — правка оригинала не
      // должна задним числом менять то, что уже отрендерено.
      const hasProjectLink = !!(session.projectId && session.productItemId);
      const seed: SessionSeed | undefined = hasProjectLink
        ? {
            projectId: session.projectId!,
            productItemId: session.productItemId!,
            productInformation: session.productInformation,
            brandManifestSnapshot: session.brandManifestSnapshot,
          }
        : undefined;
      const child = await this.sessions.createSession(
        session.userId ?? undefined,
        seed,
        session.locale,
      );
      if (
        !hasProjectLink &&
        (session.productInformation || session.brandManifestSnapshot)
      ) {
        // Сессия без привязки к проекту (обычный визард) — `createSession`
        // без seed их не пишет, докладываем тем же UPDATE, что и любую
        // другую правку данных сессии (см. SessionService.updateSession).
        await this.sessions.updateSession(child.sessionId, {
          productInformation: session.productInformation,
          brandManifestSnapshot: session.brandManifestSnapshot,
        });
      }

      await this.prompt.seedPrompt(
        child.sessionId,
        prompt.finalText,
        prompt.finalVoiceoverScript ?? prompt.voiceoverScript ?? null,
      );
      await this.prompt.approvePrompt(child.sessionId);
      // Бросает на отказе (гейт формата/режима, блокировка, суточный лимит)
      // — тот же явный платный вызов, что и обычная генерация, отказ должен
      // дойти до пользователя, а не раствориться.
      await this.generation.generateVideo(
        child.sessionId,
        quality ?? video.quality ?? 'fast',
        target,
      );

      const variant: ExportVariant = {
        format: target,
        preset,
        tier: 'B',
        status: 'pending',
        childSessionId: child.sessionId,
        requestedAt: new Date().toISOString(),
      };
      const saved = await this.sessions.updateSession(sessionId, {
        generatedVideo: {
          ...freshVideo,
          exportVariants: [...(freshVideo.exportVariants ?? []), variant],
        },
      });
      return {
        video: saved?.generatedVideo ?? freshVideo,
        childSessionId: child.sessionId,
      };
    } finally {
      await this.sessions.releaseWork(sessionId, 'export');
    }
  }

  /**
   * GET /sessions/:id/export/status — продвигает ярус A (через
   * `PostProductionService.pollExport`) и ярус B (опрашивая каждую
   * незавершённую дочернюю сессию) и возвращает актуальное состояние
   * ролика целиком — тот же формат ответа, что `GET /generate`, чтобы
   * фронтенд не заводил отдельный тип под это.
   *
   * Е-2.1 шестого аудита: опрос дочерних сессий сам по себе не платный
   * (генерация уже оплачена при `startRerender`) и не гонка сам по себе,
   * но ФИНАЛЬНАЯ запись — read-modify-write ЦЕЛОГО `exportVariants`, и
   * без замка два конкурентных `syncStatus` (два открытых таба) либо
   * `syncStatus`, гоняющийся со свежим `startRerender`/`pollExport`,
   * затирают результат друг друга. Захват + перечитывание — тот же
   * приём, что у `PostProductionService.startExport` (см. её
   * доккомментарий), и слияние по `childSessionId` (устойчивый
   * идентификатор варианта), а не по индексу/идентичности объекта —
   * перечитанный массив после чужой записи мог измениться по составу.
   */
  async syncStatus(sessionId: string): Promise<GeneratedVideo> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    let video = session.generatedVideo;
    if (!video) {
      throw new NotFoundException('Video generation has not been initiated');
    }

    video = await this.postprod.pollExport(sessionId, video);

    const pendingB = (video.exportVariants ?? []).filter(
      (v) => v.tier === 'B' && v.status === 'pending' && v.childSessionId,
    );
    if (pendingB.length === 0) return video;

    const updates = new Map<string, Partial<ExportVariant>>();
    for (const variant of pendingB) {
      let childVideo: GeneratedVideo;
      try {
        childVideo = await this.generation.getVideoStatus(
          variant.childSessionId!,
        );
      } catch {
        continue; // дочерняя сессия временно недоступна — следующий опрос повторит
      }
      if (childVideo.status === GenerationStatus.FAILED) {
        updates.set(variant.childSessionId!, {
          status: 'failed',
          error: childVideo.error?.message ?? 'рендер не удался',
        });
      } else if (
        childVideo.status === GenerationStatus.COMPLETE &&
        childVideo.postStatus !== 'pending'
      ) {
        // `postStatus !== 'pending'` — ждём, пока у дочерней сессии
        // закончится СВОЯ постобработка (озвучка/субтитры/кроп), не
        // только сам рендер Veo: иначе вариант показал бы «готово» с
        // файлом, который через секунду подменится обработанным.
        updates.set(variant.childSessionId!, {
          status: 'complete',
          pathname: childVideo.postPathname ?? childVideo.pathname,
          url: childVideo.downloadUrl,
        });
      }
    }
    if (updates.size === 0) return video;

    const claimed = await this.sessions.claimWork(
      sessionId,
      'export',
      EXPORT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      // Другой запрос уже пишет — наш результат не потерян: то, что мы
      // выяснили о дочерних сессиях, детерминировано и будет получено
      // заново следующим опросом.
      return video;
    }
    try {
      const fresh = await this.sessions.getSession(sessionId);
      const freshVideo = fresh?.generatedVideo ?? video;
      let changed = false;
      const nextVariants = (freshVideo.exportVariants ?? []).map((v) => {
        const update =
          v.tier === 'B' && v.childSessionId
            ? updates.get(v.childSessionId)
            : undefined;
        if (!update) return v;
        changed = true;
        return { ...v, ...update };
      });
      if (!changed) return freshVideo;
      const saved = await this.sessions.updateSession(sessionId, {
        generatedVideo: { ...freshVideo, exportVariants: nextVariants },
      });
      return (
        saved?.generatedVideo ?? { ...freshVideo, exportVariants: nextVariants }
      );
    } finally {
      await this.sessions.releaseWork(sessionId, 'export');
    }
  }

  /**
   * Крон-аналог `advanceGenerating()` (Е-2.3 шестого аудита, этап 76) —
   * досматривает статус варианта(ов) яруса B НЕЗАВИСИМО от того, открыт
   * ли у пользователя экран прогресса. До этой правки единственный путь
   * продвижения — `syncStatus()`, вызываемый только клиентским
   * поллингом (`GET /sessions/:id/export/status`): закрыл вкладку до
   * завершения дочернего рендера — вариант остаётся `pending` навсегда,
   * а TTL дочерней сессии наступает раньше, чем пользователь вернётся —
   * `cleanupExpiredSessions()` физически удалит и её, и уже готовый,
   * оплаченный файл ролика.
   *
   * Вызывается изнутри уже существующего крона
   * (`CronJobsService.runExportSyncRun`), одна проваленная сессия не
   * должна портить весь тик — каждая сессия обёрнута собственным
   * try/catch, тем же приёмом, что `CatalogBatchWorkerService.runBatch()`.
   */
  async runSyncTick(
    limit: number = EXPORT_SYNC_BATCH,
  ): Promise<{ checked: number; failed: number }> {
    const ids = await this.sessions.findSessionsWithPendingTierBExport(limit);
    let failed = 0;
    for (const id of ids) {
      try {
        await this.syncStatus(id);
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `крон-досмотр автоэкспорта яруса B: сессия ${id} — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { checked: ids.length, failed };
  }
}
