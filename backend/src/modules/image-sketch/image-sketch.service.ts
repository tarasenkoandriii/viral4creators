/**
 * ИИ-скетч: генерация кандидата, применение, откат, удаление оригинала
 * (doc/AI-SKETCH-SPEC.md §6.4).
 *
 * ## Почему «применить» устроено так странно
 *
 * Слоты сессии живут в JSON и пишутся сырым `updateSession` — общей
 * транзакции Prisma с ними не бывает. Поэтому захват делается ОДНИМ
 * условным `updateMany` по самому скетчу (`candidate → applied`): кто
 * перевёл строку, тот и применяет, второй параллельный запрос получает
 * 409. Если запись в слот после этого упадёт, статус возвращается назад
 * — иначе кандидат навсегда остался бы «применённым» ни к чему.
 *
 * ## Почему квота считается по расходам, а не по строкам скетчей
 *
 * `ai_usage` — единственное место, где видно ОПЛАЧЕННЫЕ вызовы: отказ
 * модели по безопасности тоже оплачен, а сетевой сбой — нет. Считать по
 * `ImageSketch` значило бы либо не считать отказы, либо считать сбои.
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import {
  exhaustedQuota,
  IMAGE_OPERATIONS,
  imageQuotaFor,
  startOfMonthUtc,
} from '../../common/image-generation-quota';
import {
  buildSketchPrompt,
  promptFingerprint,
} from '../../common/sketch-prompts';
import {
  SKETCH_CONFLICT,
  SketchMode,
  SketchOptions,
  SketchQuotaView,
  SketchRef,
  SketchSlotView,
  SketchStyle,
  SketchTarget,
  SketchView,
} from '../../common/types/sketch.types';
import { SketchGeneratorService } from './sketch-generator.service';
import { sha256, slotView, SketchTargetsService } from './sketch-targets';
import { mimeFromPath } from '../../common/active-image';
import { GEMINI_SKETCH_MODEL } from '../../common/gemini-image-model';
import { PlanId } from '../../common/plans';

/** Сколько живёт неприменённый кандидат, прежде чем его подберёт уборка. */
export const SKETCH_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;

/** Сколько держать файл вытесненного скетча, прежде чем убрать (§6.7). */
export const SUPERSEDED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Сколько ждать ответа модели, прежде чем бронь считается протухшей.
 * Бронь (`status: 'pending'`) — это способ увидеть параллельные запросы
 * ДО того, как расход попал в `ai_usage`: между проверкой квоты и
 * записью расхода окно в десятки секунд, и в него проходили все
 * одновременные запросы разом (аудит A-10).
 */
export const SKETCH_RESERVATION_TTL_MS = 5 * 60 * 1000;

export interface GenerateSketchInput {
  target: SketchTarget;
  mode: SketchMode;
  style: SketchStyle;
  options: SketchOptions;
  description?: string | null;
}

interface SketchRow {
  id: string;
  status: string;
  mode: string;
  style: string;
  options: unknown;
  url: string | null;
  pathname: string | null;
  mimeType: string | null;
  createdAt: Date;
  appliedAt: Date | null;
  auto: boolean;
  sourceHash: string | null;
}

export function toSketchView(row: SketchRow): SketchView {
  return {
    id: row.id,
    status: row.status as SketchView['status'],
    mode: row.mode as SketchMode,
    style: row.style as SketchStyle,
    options: (row.options ?? {}) as SketchOptions,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    auto: row.auto,
  };
}

export function sketchRefOf(row: SketchRow): SketchRef {
  const options = (row.options ?? {}) as SketchOptions;
  return {
    sketchId: row.id,
    url: row.url!,
    pathname: row.pathname!,
    mimeType: row.mimeType || mimeFromPath(row.pathname, 'image/png'),
    style: row.style as SketchStyle,
    sketchRendering: options.sketchRendering ?? 'realistic',
    appliedAt: (row.appliedAt ?? new Date()).toISOString(),
  };
}

@Injectable()
export class ImageSketchService {
  private readonly logger = new Logger(ImageSketchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: SketchTargetsService,
    private readonly generator: SketchGeneratorService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
    private readonly sessions: SessionService,
  ) {}

  async quota(userId: string): Promise<SketchQuotaView> {
    const plan = (await this.plans.planOfUser(userId)) as PlanId;
    const limits = imageQuotaFor(plan);
    const now = new Date();
    const [dayUsed, monthUsed] = await Promise.all([
      this.aiUsage.countToday(userId, IMAGE_OPERATIONS, now),
      this.aiUsage.countSince(userId, IMAGE_OPERATIONS, startOfMonthUtc(now)),
    ]);
    return {
      dayUsed,
      dayLimit: limits.day,
      monthUsed,
      monthLimit: limits.month,
    };
  }

  async list(
    target: SketchTarget,
    userId: string,
  ): Promise<{
    items: SketchView[];
    active: SketchView | null;
    quota: SketchQuotaView;
  }> {
    const slot = await this.targets.load(target, userId);
    const rows = (await this.prisma.imageSketch.findMany({
      where: {
        userId,
        targetType: target.type,
        targetId: target.id,
        targetSubId: target.subId ?? null,
        status: { in: ['candidate', 'applied', 'superseded'] },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })) as SketchRow[];
    const items = rows.map(toSketchView);
    return {
      items,
      active: items.find((i) => i.id === slot.sketch?.sketchId) ?? null,
      quota: await this.quota(userId),
    };
  }

  /**
   * Сгенерировать кандидата. Порядок проверок — от дешёвых к дорогим и
   * от «нельзя вообще» к «нельзя сейчас»: слот → тариф слота → тариф
   * скетча → блокировка и суточный бюджет → квота картинок → модель.
   */
  async generate(
    input: GenerateSketchInput,
    userId: string,
  ): Promise<{ sketch: SketchView; quota: SketchQuotaView }> {
    // Слот сессии — замок сессии: два скетча одного слота подряд (двойной
    // тап, повтор из очереди) не должны идти в модель параллельно.
    // Слоты бренда и товара сессии не имеют, их защищает бронь квоты ниже.
    const locked = input.target.type.startsWith('session-')
      ? await this.sessions.claimWork(
          input.target.id,
          'sketch',
          SKETCH_RESERVATION_TTL_MS,
        )
      : true;
    if (!locked) {
      throw new ConflictException(
        'Скетч для этой сессии уже генерируется — подождите результата',
      );
    }
    try {
      return await this.generateLocked(input, userId);
    } finally {
      if (input.target.type.startsWith('session-')) {
        await this.sessions
          .releaseWork(input.target.id, 'sketch')
          .catch(() => undefined);
      }
    }
  }

  private async generateLocked(
    input: GenerateSketchInput,
    userId: string,
  ): Promise<{ sketch: SketchView; quota: SketchQuotaView }> {
    const slot = await this.targets.load(input.target, userId);
    await this.targets.assertSlotAccess(slot);
    await this.plans.assertUser(userId, 'aiSketch');
    await this.plans.assertCanSpendUser(userId);

    const description =
      input.description?.trim() || slot.description?.trim() || null;
    if (input.mode === 'from-text' && !description) {
      throw new BadRequestException(
        'Для скетча по описанию нужен текст — опишите, что нарисовать',
      );
    }
    if (input.mode === 'from-image' && !slot.originalPathname) {
      throw new BadRequestException(
        'У этого слота нет своего файла — сделайте скетч по описанию',
      );
    }

    // §4 п.3 ТЗ: у людей, срисованных с фото, лицо меняется всегда —
    // что бы ни прислал клиент.
    const options: SketchOptions = {
      ...input.options,
      anonymizeFace:
        slot.kind === 'character' && input.mode === 'from-image'
          ? true
          : input.options.anonymizeFace,
      sketchRendering: input.options.sketchRendering ?? 'realistic',
    };
    const prompt = buildSketchPrompt({
      slotKind: slot.kind,
      mode: input.mode,
      style: input.style,
      options,
      description,
      name: slot.name,
    });

    // Бронь квоты ДО дорогого вызова: строка `pending` видна другим
    // запросам, и параллельные попытки перестают проходить скопом в
    // окно между проверкой и записью расхода (аудит A-10).
    const reservation = (await this.prisma.imageSketch.create({
      data: {
        userId,
        targetType: input.target.type,
        targetId: input.target.id,
        targetSubId: input.target.subId ?? null,
        mode: input.mode,
        style: input.style,
        options: options as object,
        sourcePathname: slot.originalPathname,
        description,
        modelName: GEMINI_SKETCH_MODEL,
        promptHash: promptFingerprint(prompt),
        status: 'pending',
        expiresAt: new Date(Date.now() + SKETCH_RESERVATION_TTL_MS),
      },
    })) as SketchRow;

    const drop = async (status: string, patch: object = {}): Promise<void> => {
      await this.prisma.imageSketch.updateMany({
        where: { id: reservation.id, status: 'pending' },
        data: { status, ...patch },
      });
    };

    const quotaBefore = await this.quotaWithReservations(
      userId,
      reservation.id,
    );
    const exhausted = exhaustedQuota(
      { dayUsed: quotaBefore.dayUsed, monthUsed: quotaBefore.monthUsed },
      { day: quotaBefore.dayLimit, month: quotaBefore.monthLimit },
    );
    if (exhausted) {
      // Бронь не пригодилась — снимаем, чтобы она не «съедала» лимит
      // ближайшие пять минут.
      await this.prisma.imageSketch.deleteMany({
        where: { id: reservation.id, status: 'pending' },
      });
      throw new HttpException(
        {
          message:
            exhausted === 'day'
              ? `Лимит скетчей на сегодня исчерпан (${quotaBefore.dayLimit}). Обновится в 00:00 UTC (03:00 по Киеву).`
              : `Лимит скетчей в этом месяце исчерпан (${quotaBefore.monthLimit}).`,
          quota: await this.quota(userId),
          upgrade: await this.upgradeSuggestion(userId),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let source: { bytes: Buffer; mimeType: string } | null = null;
    let sourceHash: string | null = null;
    try {
      if (input.mode === 'from-image') {
        const bytes = await this.targets.readOriginal(slot);
        sourceHash = sha256(bytes);
        source = {
          bytes,
          mimeType: mimeFromPath(slot.originalPathname, 'image/jpeg'),
        };
      }
    } catch (error) {
      await this.prisma.imageSketch.deleteMany({
        where: { id: reservation.id, status: 'pending' },
      });
      throw error;
    }

    const outcome = await this.generator.generate({ prompt, source });

    if (outcome.status === 'failed') {
      // Ответа не было — вызов не оплачен, расход не пишем, квота цела.
      await drop('failed', { modelName: outcome.model, expiresAt: null });
      throw new HttpException(
        `Не удалось сгенерировать скетч: ${outcome.reason}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    await this.aiUsage.recordGemini(outcome.raw, {
      operation: 'ai-sketch',
      model: outcome.model,
      userId,
      ...(input.target.type.startsWith('session-')
        ? { sessionId: input.target.id }
        : {}),
    });

    if (outcome.status === 'refused') {
      await drop('refused', { modelName: outcome.model, expiresAt: null });
      throw new HttpException(
        'Модель отказалась рисовать это изображение. Попробуйте режим «по описанию» или другое фото.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const ext = outcome.mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const pathname = `sketches/${userId}/${reservation.id}.${ext}`;
    const { url } = await this.blob.uploadBuffer(
      pathname,
      outcome.bytes,
      outcome.mimeType,
    );
    const withFile = (await this.prisma.imageSketch.update({
      where: { id: reservation.id },
      data: {
        status: 'candidate',
        modelName: outcome.model,
        sourceHash,
        mimeType: outcome.mimeType,
        pathname,
        url,
        expiresAt: new Date(Date.now() + SKETCH_CANDIDATE_TTL_MS),
      },
    })) as SketchRow;

    return { sketch: toSketchView(withFile), quota: await this.quota(userId) };
  }

  /**
   * Квота с учётом ЖИВЫХ броней (`pending`): своя бронь уже создана, и
   * её позиция среди одновременных решает, кто проходит. Одинаковый
   * ответ у всех параллельных запросов был бы либо «пропустить всех»
   * (перерасход), либо «отклонить всех» (несправедливо) — здесь
   * проходят первые N по времени создания.
   */
  private async quotaWithReservations(
    userId: string,
    ownId: string,
  ): Promise<SketchQuotaView> {
    const base = await this.quota(userId);
    const now = new Date();
    const live = (await this.prisma.imageSketch.findMany({
      where: { userId, status: 'pending', expiresAt: { gt: now } },
      select: { id: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })) as Array<{ id: string }>;
    const rank = live.findIndex((r) => r.id === ownId);
    // Брони живут минуты, так что все они и в сегодняшнем дне, и в
    // текущем месяце — одна и та же поправка к обоим счётчикам.
    const ahead = rank < 0 ? live.length : rank;
    return {
      ...base,
      dayUsed: base.dayUsed + ahead,
      monthUsed: base.monthUsed + ahead,
    };
  }

  /** Применить кандидата вместо оригинала. */
  async apply(
    sketchId: string,
    userId: string,
    sketchRendering?: SketchOptions['sketchRendering'],
  ): Promise<SketchSlotView> {
    const row = (await this.prisma.imageSketch.findFirst({
      where: { id: sketchId, userId },
    })) as
      | (SketchRow & {
          targetType: string;
          targetId: string;
          targetSubId: string | null;
        })
      | null;
    if (!row) throw new NotFoundException('Скетч не найден');
    if (!row.url || !row.pathname) {
      throw new BadRequestException('У этого скетча больше нет файла');
    }

    const target: SketchTarget = {
      type: row.targetType as SketchTarget['type'],
      id: row.targetId,
      subId: row.targetSubId,
    };
    const slot = await this.targets.load(target, userId);
    await this.targets.assertSlotAccess(slot);

    // Фото слота сменилось после генерации — применять нечего: скетч
    // нарисован с другого файла (§6.2 ТЗ, 409). Оригинал удалён —
    // сверять не с чем и не нужно: файла нет, подменять больше нечего
    // (раньше здесь падало 500 — аудит A-13).
    if (row.sourceHash && slot.originalPathname && !slot.originalDeleted) {
      const current = sha256(await this.targets.readOriginal(slot));
      if (current !== row.sourceHash) {
        throw new ConflictException({
          message: 'Фото изменилось — сгенерируйте скетч заново',
          reason: SKETCH_CONFLICT.stale,
        });
      }
    }

    // Статус ДО захвата — к нему возвращаемся, если запись в слот
    // сорвётся (читаем до `updateMany`, а не после).
    const statusBefore = row.status;

    // Атомарный захват: второй параллельный apply получит 0 строк.
    // Из истории (`superseded`) применять МОЖНО — пока у записи цел
    // файл: это «вернуть прежний скетч» без повторной оплаты (A-13).
    const claimed = await this.prisma.imageSketch.updateMany({
      where: {
        id: sketchId,
        userId,
        status: { in: ['candidate', 'superseded'] },
      },
      data: {
        status: 'applied',
        appliedAt: new Date(),
        expiresAt: null,
        ...(sketchRendering
          ? {
              options: {
                ...((row.options ?? {}) as SketchOptions),
                sketchRendering,
              } as object,
            }
          : {}),
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException({
        message:
          statusBefore === 'applied'
            ? 'Этот скетч уже применён'
            : 'Этот скетч больше не актуален — сгенерируйте новый',
        reason:
          statusBefore === 'applied'
            ? SKETCH_CONFLICT.alreadyApplied
            : SKETCH_CONFLICT.gone,
      });
    }

    const applied = (await this.prisma.imageSketch.findUnique({
      where: { id: sketchId },
    })) as SketchRow;
    const ref = sketchRefOf(applied);

    try {
      const next = await this.targets.writeActive(slot, ref);
      await this.prisma.imageSketch.updateMany({
        where: {
          userId,
          targetType: target.type,
          targetId: target.id,
          targetSubId: target.subId ?? null,
          status: 'applied',
          id: { not: sketchId },
        },
        data: { status: 'superseded' },
      });
      // §4 п.11 ТЗ: подмена доводится до конца СРАЗУ, а не только при
      // удалении оригинала — иначе уже опубликованная страница шеринга
      // бессрочно показывала бы оригинал (аудит A-3). Пропагация
      // идемпотентна и не должна ронять само применение.
      try {
        await this.targets.propagateSketch(next, ref);
      } catch (error) {
        this.logger.warn(
          `скетч ${sketchId} применён, но пропагация не прошла: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return slotView(next);
    } catch (error) {
      // Слот не записался — запись не должна остаться «применённой».
      // Возвращаем ИМЕННО прежний статус: применение из истории иначе
      // превращало бы `superseded` в вечного кандидата без срока.
      await this.prisma.imageSketch.updateMany({
        where: { id: sketchId, status: 'applied' },
        data: {
          status: statusBefore,
          appliedAt: null,
          ...(statusBefore === 'candidate'
            ? { expiresAt: new Date(Date.now() + SKETCH_CANDIDATE_TTL_MS) }
            : {}),
        },
      });
      throw error;
    }
  }

  /** Вернуть оригинал: скетч остаётся в истории. */
  async revert(target: SketchTarget, userId: string): Promise<SketchSlotView> {
    const slot = await this.targets.load(target, userId);
    await this.targets.assertSlotAccess(slot);
    if (slot.originalDeleted) {
      throw new BadRequestException(
        'Оригинал этого изображения удалён — возвращать нечего',
      );
    }
    if (!slot.sketch) return slotView(slot);
    const next = await this.targets.writeActive(slot, null);
    await this.prisma.imageSketch.updateMany({
      where: { id: slot.sketch.sketchId, status: 'applied' },
      data: { status: 'superseded' },
    });
    return slotView(next);
  }

  /**
   * Удалить оригинал (§4 п.10 ТЗ). Сначала — перевести на скетч ВСЕ
   * записи, которые ссылаются на тот же файл, и только потом удалять:
   * если процесс упадёт посередине, повтор доведёт дело до конца, а
   * битых ссылок не будет ни в один момент.
   */
  async deleteOriginal(
    target: SketchTarget,
    userId: string,
  ): Promise<{
    slot: SketchSlotView;
    updatedRefs: number;
    fileDeleted: boolean;
  }> {
    const slot = await this.targets.load(target, userId);
    await this.targets.assertSlotAccess(slot);
    if (!slot.sketch) {
      throw new BadRequestException(
        'Сначала примените скетч — иначе изображения не останется вовсе',
      );
    }
    if (slot.originalDeleted) {
      return { slot: slotView(slot), updatedRefs: 0, fileDeleted: false };
    }
    const updatedRefs = await this.targets.propagateSketch(slot, slot.sketch, {
      originalDeleted: true,
    });
    const fileDeleted = await this.targets.deleteOriginalBlob(slot);
    const next = await this.targets.writeActive(slot, slot.sketch, {
      originalDeleted: true,
    });
    this.logger.log(
      `оригинал слота ${target.type}:${target.id}${
        target.subId ? `/${target.subId}` : ''
      } ${fileDeleted ? 'удалён' : 'отвязан (файл общий, оставлен)'}` +
        `, ссылок переведено на скетч: ${updatedRefs}`,
    );
    return { slot: slotView(next), updatedRefs, fileDeleted };
  }

  /**
   * Одобрение промпта подмена изображения НЕ снимает — аудит A-7.
   *
   * Почему сначала снимало и почему это было ошибкой: считалось, что
   * смена референса меняет бриф. Но `referenceMappingText` в
   * одобряемый ТЕКСТ не входит — он дописывается к запросу Veo/Grok уже
   * во время рендера, из свежего плана. Пользователь одобряет сценарий,
   * а не список картинок; выбор самих слотов (`ReferenceSlotsPanel`)
   * живёт на том же шаге мастера и одобрение тоже не снимает.
   *
   * Цена ошибки была высокой: `ImageUpload` и `ReferenceSlotsPanel`
   * стоят на шаге ПОСЛЕ одобрения, так что применение скетча прямо
   * там делало кнопку «Сгенерировать» вечным 400 «Prompt must be
   * approved», а вернуться и одобрить заново экран не предлагал.
   */

  /** Какой тариф предложить, когда квота кончилась (§8.4 ТЗ). */
  private async upgradeSuggestion(userId: string): Promise<PlanId | null> {
    const plan = (await this.plans.planOfUser(userId)) as PlanId;
    if (plan === 'LITE') return 'STANDARD';
    if (plan === 'STANDARD') return 'PREMIUM';
    return null;
  }

  /**
   * Уборка скетчей (§6.7 ТЗ): просроченные кандидаты и давно
   * вытесненные версии теряют ФАЙЛ; сама запись остаётся — она же
   * журнал (§6.6). Вызывается из суточного крона `cleanup-sessions`.
   */
  async runCleanupTick(
    limit = 200,
    now: Date = new Date(),
  ): Promise<{ expired: number; purged: number }> {
    // Брони, у которых процесс умер посреди вызова модели: файла у них
    // нет и не будет, а квоту они держат до истечения срока.
    await this.prisma.imageSketch.updateMany({
      where: { status: 'pending', expiresAt: { lt: now } },
      data: { status: 'failed', expiresAt: null },
    });

    const orphans = await this.supersedeOrphans(limit);
    if (orphans > 0) {
      this.logger.log(
        `уборка скетчей: ${orphans} записей осиротело вместе с сессиями`,
      );
    }

    const expiredRows = (await this.prisma.imageSketch.findMany({
      where: {
        status: 'candidate',
        expiresAt: { lt: now },
      },
      select: { id: true, pathname: true },
      take: limit,
    })) as Array<{ id: string; pathname: string | null }>;
    const supersededCandidates = (await this.prisma.imageSketch.findMany({
      where: {
        status: 'superseded',
        pathname: { not: null },
        createdAt: { lt: new Date(now.getTime() - SUPERSEDED_KEEP_MS) },
      },
      select: { id: true, pathname: true },
      take: limit,
    })) as Array<{ id: string; pathname: string | null }>;

    // Ссылка на скетч ДЕНОРМАЛИЗОВАНА в JSON сессий и в строках Prisma:
    // вытесненный в одном слоте файл может оставаться активным в другом
    // (сессии, созданные из того же товара; снимки бренда). Удалить его
    // «по сроку» значило бы оставить битые ссылки — аудит A-5.
    const supersededRows: Array<{ id: string; pathname: string | null }> = [];
    let skipped = 0;
    for (const row of supersededCandidates) {
      if (await this.isSketchReferenced(row.id)) {
        skipped += 1;
        continue;
      }
      supersededRows.push(row);
    }
    if (skipped > 0) {
      this.logger.log(
        `уборка скетчей: ${skipped} файл(ов) оставлены — на них ещё есть ссылки`,
      );
    }

    for (const row of [...expiredRows, ...supersededRows]) {
      if (!row.pathname) continue;
      try {
        await this.blob.deleteBlob(row.pathname);
      } catch (error) {
        this.logger.warn(
          `скетч ${row.id}: файл не удалён — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (expiredRows.length > 0) {
      await this.prisma.imageSketch.updateMany({
        // `status: 'candidate'` обязателен: кандидат, применённый ПОСРЕДИ
        // тика, иначе получал бы `expired` и обнулённый путь, хотя слот
        // уже на него ссылается (аудит A-5).
        where: {
          id: { in: expiredRows.map((r) => r.id) },
          status: 'candidate',
        },
        data: { status: 'expired', pathname: null, url: null },
      });
    }
    if (supersededRows.length > 0) {
      await this.prisma.imageSketch.updateMany({
        where: {
          id: { in: supersededRows.map((r) => r.id) },
          status: 'superseded',
        },
        data: { pathname: null, url: null },
      });
    }
    return { expired: expiredRows.length, purged: supersededRows.length };
  }

  /**
   * Скетчи сессий, которых больше нет: сама сессия при удалении их не
   * трогает (файл лежит в `sketches/…`, вне её префикса, и может быть
   * разъехавшимся по другим записям). Переводим в `superseded` — дальше
   * их подхватит обычная уборка со счётом ссылок, и файл уйдёт только
   * если на него никто не смотрит.
   */
  private async supersedeOrphans(limit: number): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id"
      FROM "image_sketches" s
      WHERE s."targetType" LIKE 'session-%'
        AND s."status" IN ('candidate', 'applied')
        AND NOT EXISTS (
          SELECT 1 FROM "sessions" x WHERE x."id" = s."targetId"
        )
      LIMIT ${limit}
    `;
    if (rows.length === 0) return 0;
    const done = await this.prisma.imageSketch.updateMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        status: { in: ['candidate', 'applied'] },
      },
      data: { status: 'superseded' },
    });
    return done.count;
  }

  /**
   * На скетч ещё кто-то ссылается? Строки Prisma проверяются по
   * `activeSketchId`, слоты сессий — поиском id в JSON: ссылка там
   * денормализована, отдельной колонки под неё нет.
   */
  private async isSketchReferenced(sketchId: string): Promise<boolean> {
    const [asItem, asCharacter, asScene] = await Promise.all([
      this.prisma.productItem.count({ where: { activeSketchId: sketchId } }),
      this.prisma.brandCharacter.count({ where: { activeSketchId: sketchId } }),
      this.prisma.brandScene.count({ where: { activeSketchId: sketchId } }),
    ]);
    if (asItem + asCharacter + asScene > 0) return true;
    // Мягко удалённая сессия тоже считается ссылкой: весь грейс-период
    // её ещё можно вернуть, и файл ей нужен. Физически исчезнувшие
    // сессии отпускают свои скетчи через `supersedeOrphans` выше.
    const needle = `%${sketchId}%`;
    const rows = await this.prisma.$queryRaw<Array<{ one: number }>>`
      SELECT 1 AS one
      FROM "sessions"
      WHERE "data"::text LIKE ${needle} OR "liveData"::text LIKE ${needle}
      LIMIT 1
    `;
    return rows.length > 0;
  }
}
