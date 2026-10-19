/**
 * Образы рассказчика Story‑Tales (TODO стр. 79, WP5): одежда и лёгкий
 * makeup как отдельные производные изображения от фото персонажа-
 * рассказчика брендбука, отдельное согласие `story-parent-image-v1`,
 * предпросмотр до применения, откат к оригиналу одним действием и
 * сохранение режима фото/скетч/cartoon.
 *
 * ## Что неизменно
 *
 * Строка `BrandCharacter` (фото, `activeSketchId`) здесь только читается.
 * Вариант — отдельная строка `story_narrator_looks` со ссылкой на
 * исходник (`characterId`, `sourceUrl`, `sourceHash`), пресетами, хешами
 * изображений и версией согласия; байты лежат в Postgres и наружу идут
 * только владельцу (Story закрыта, `StoryDevelopmentGuard`).
 *
 * ## Деньги
 *
 * Платный вызов модели картинок — только по явному действию взрослого
 * (POST create / restyle), с показанным резервом (`maxReserveMicroUsd`),
 * под advisory-lock пользователя: квота считается по строкам вариантов
 * вместе с бронью в полёте и с неизвестными исходами. Сбой без ответа —
 * UNKNOWN, без автоповтора; повтор того же запроса — только с `repeat`.
 * Готовый такой же вариант возвращается без оплаты.
 *
 * ## Режим
 *
 * Если у персонажа применён скетч (pencil|lineart|flat|watercolor|
 * cartoon), вариант сразу проходит тот же стиль тем же промптом ИИ-скетча
 * (`buildNarratorStylePrompt`), и применяется именно стилизованный ассет:
 * сменили одежду — cartoon остался cartoon. Применённый ассет закреплён
 * (`narratorLookAsset`): позднейшая смена скетча персонажа не подменяет
 * одобренную картинку молча — интерфейс предлагает перестилизовать.
 */

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { BlobService } from '../storage/blob.service';
import { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import { pathnameFromUrl } from '../image-sketch/sketch-targets';
import { activeRowImage, mimeFromPath } from '../../common/active-image';
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_SKETCH_MODEL,
} from '../../common/gemini-image-model';
import { startOfMonthUtc } from '../../common/image-generation-quota';
import { promptFingerprint } from '../../common/sketch-prompts';
import {
  SketchOptions,
  SketchRendering,
  SketchStyle,
} from '../../common/types/sketch.types';
import {
  assetForMode,
  buildNarratorLookPrompt,
  buildNarratorStylePrompt,
  imageConsentActive,
  imageMimeOf,
  NARRATOR_LOOK_JSON_IMAGE_MAX_BYTES,
  NARRATOR_LOOK_MAX_BYTES,
  NARRATOR_LOOK_PROBLEM_MESSAGE,
  NARRATOR_LOOK_STALE_MS,
  NARRATOR_MAKEUPS,
  NARRATOR_OUTFITS,
  NarratorAsset,
  narratorLookConfigHash,
  NarratorLookPrice,
  narratorLookPrice,
  NarratorLookProblem,
  narratorLookProblem,
  narratorLookQuota,
  NarratorLookQuotaView,
  NarratorMakeup,
  NarratorMode,
  narratorModeOf,
  NarratorOutfit,
  narratorQuotaExhausted,
  sha256Hex,
  STORY_PARENT_IMAGE_CONSENT_TEXT,
  STORY_PARENT_IMAGE_CONSENT_VERSION,
} from './narrator-looks.rules';
import {
  CreateNarratorLookDto,
  NarratorImageConsentDto,
  RestyleNarratorLookDto,
} from './dto/narrator-looks.dto';

/** Операция журнала расходов (`ai-pricing.ts`). */
export const NARRATOR_LOOK_OPERATION = 'story-narrator-look' as const;

const STALE_MESSAGE =
  'Исход генерации неизвестен (нет ответа больше 10 минут). Автоповтора нет — повторите вручную, если нужно.';

const MANIFEST_SELECT = {
  id: true,
  userId: true,
  narratorCharacterId: true,
  narratorImageConsentAt: true,
  narratorImageConsentVersion: true,
  narratorImageConsentRevokedAt: true,
  narratorLookId: true,
  narratorLookAsset: true,
} as const;

/** Всё, кроме байтов: списки и статусы не тянут картинки. */
const LOOK_SELECT = {
  id: true,
  userId: true,
  manifestId: true,
  characterId: true,
  parentLookId: true,
  sourceUrl: true,
  sourceHash: true,
  outfit: true,
  makeup: true,
  configHash: true,
  consentVersion: true,
  consentAt: true,
  status: true,
  imageCalls: true,
  reservedMicroUsd: true,
  photoMime: true,
  photoHash: true,
  style: true,
  styleOptions: true,
  styleStatus: true,
  styledMime: true,
  styledHash: true,
  error: true,
  deletedAt: true,
  createdAt: true,
} as const;

interface ManifestRow {
  id: string;
  userId: string | null;
  narratorCharacterId: string | null;
  narratorImageConsentAt: Date | null;
  narratorImageConsentVersion: string | null;
  narratorImageConsentRevokedAt: Date | null;
  narratorLookId: string | null;
  narratorLookAsset: string | null;
}

interface CharacterRow {
  id: string;
  label: string;
  photoUrl: string | null;
  originalDeletedAt: Date | null;
  activeSketch: {
    id: string;
    url: string | null;
    pathname: string | null;
    mimeType: string | null;
    style: string;
    options: unknown;
    appliedAt: Date | null;
  } | null;
}

export interface LookRow {
  id: string;
  userId: string;
  manifestId: string;
  characterId: string;
  parentLookId: string | null;
  sourceUrl: string;
  sourceHash: string;
  outfit: string;
  makeup: string;
  configHash: string;
  consentVersion: string;
  consentAt: Date;
  status: string;
  imageCalls: number;
  reservedMicroUsd: number;
  photoMime: string | null;
  photoHash: string | null;
  style: string | null;
  styleOptions: unknown;
  styleStatus: string;
  styledMime: string | null;
  styledHash: string | null;
  error: string | null;
  deletedAt: Date | null;
  createdAt: Date;
}

export interface NarratorLookView {
  id: string;
  parentLookId: string | null;
  characterId: string;
  outfit: NarratorOutfit;
  makeup: NarratorMakeup;
  status: string;
  styleStatus: string;
  /** Стиль стилизованного ассета; `null` — вариант только фото. */
  style: SketchStyle | null;
  sourceHash: string;
  photoHash: string | null;
  styledHash: string | null;
  consentVersion: string;
  imageCalls: number;
  reservedMicroUsd: number;
  error: string | null;
  createdAt: string;
  active: boolean;
  /** Почему нельзя применить в ТЕКУЩЕМ режиме; `null` — можно. */
  problem: NarratorLookProblem | null;
}

export interface NarratorLooksView {
  manifestId: string;
  consent: {
    version: string;
    text: string;
    active: boolean;
    acceptedAt: string | null;
    acceptedVersion: string | null;
    revokedAt: string | null;
  };
  character: null | {
    id: string;
    label: string;
    hasPhoto: boolean;
    originalDeleted: boolean;
    mode: NarratorMode;
    sketchRendering: SketchRendering | null;
  };
  /** Активный образ = (оригинал | вариант) × (фото | стиль). */
  active: {
    kind: 'original' | 'variant';
    lookId: string | null;
    asset: NarratorAsset | null;
    mode: NarratorMode;
    /** Вариант больше нельзя использовать в новых рендерах — откатите. */
    problem: NarratorLookProblem | null;
    /** Режим персонажа сменился после применения варианта. */
    modeChanged: boolean;
  };
  presets: { outfits: readonly string[]; makeups: readonly string[] };
  quota: NarratorLookQuotaView;
  price: {
    create: NarratorLookPrice | null;
    restyle: NarratorLookPrice | null;
  };
  items: NarratorLookView[];
}

/**
 * Изображение рассказчика для рендера Story (точка интеграции WP4).
 * `bytes` — ровно тот файл, хеш которого в `assetHash`.
 */
export interface NarratorImage {
  kind: 'original' | 'variant';
  manifestId: string;
  characterId: string;
  lookId: string | null;
  asset: 'original' | 'sketch' | NarratorAsset;
  assetHash: string;
  /** `photo` — фотография; иначе стиль ИИ-скетча. */
  style: NarratorMode;
  sketchRendering: SketchRendering | null;
  /** Версия согласия на синтетический образ; у оригинала без согласия — null. */
  consentVersion: string | null;
  mimeType: string;
  bytes: Buffer;
}

type PassFailure = 'unknown' | 'refused' | 'invalid';

class NarratorPassError extends Error {
  constructor(
    readonly kind: PassFailure,
    message: string,
  ) {
    super(message);
  }
}

function passHttpError(error: NarratorPassError, pass: string): HttpException {
  if (error.kind === 'refused') {
    return new HttpException(
      {
        code: 'NARRATOR_LOOK_REFUSED',
        message: `Модель отказалась рисовать ${pass}. Попробуйте другой пресет.`,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (error.kind === 'invalid') {
    return new HttpException(
      {
        code: 'NARRATOR_LOOK_INVALID_IMAGE',
        message: `Модель вернула непригодное изображение (${pass}) — вызов оплачен, повтор только вручную.`,
      },
      HttpStatus.BAD_GATEWAY,
    );
  }
  return new HttpException(
    {
      code: 'NARRATOR_LOOK_UNKNOWN',
      message: `Исход генерации неизвестен (${pass}): модель не ответила. Автоповтора нет — повтор только вручную и оплачивается заново.`,
    },
    HttpStatus.BAD_GATEWAY,
  );
}

@Injectable()
export class NarratorLooksService {
  private readonly logger = new Logger(NarratorLooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly aiUsage: AiUsageService,
    private readonly blob: BlobService,
    private readonly generator: SketchGeneratorService,
  ) {}

  // ── Чтение ────────────────────────────────────────────────────────

  async view(
    userId: string,
    manifestId: string,
    now: Date = new Date(),
  ): Promise<NarratorLooksView> {
    const m = await this.own(userId, manifestId);
    await this.expireStale(userId, now);
    const ch = await this.character(m);
    const { mode, options } = ch
      ? narratorModeOf(ch.activeSketch)
      : { mode: 'photo' as NarratorMode, options: null };
    const rows = (await this.prisma.storyNarratorLook.findMany({
      where: { manifestId: m.id, userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: LOOK_SELECT,
    })) as LookRow[];
    const quota = narratorLookQuota(await this.quotaRows(userId, now), now);
    let activeRow = m.narratorLookId
      ? (rows.find((r) => r.id === m.narratorLookId) ?? null)
      : null;
    if (m.narratorLookId && !activeRow) {
      activeRow = (await this.prisma.storyNarratorLook.findFirst({
        where: { id: m.narratorLookId, manifestId: m.id, userId },
        select: LOOK_SELECT,
      })) as LookRow | null;
    }
    const activeAsset = (m.narratorLookAsset as NarratorAsset | null) ?? null;
    const activeProblem =
      activeRow && activeAsset
        ? narratorLookProblem({
            look: activeRow,
            asset: activeAsset,
            consent: m,
            narratorCharacterId: m.narratorCharacterId,
            characterPhotoUrl: ch?.photoUrl ?? null,
            mode: null,
          })
        : m.narratorLookId
          ? 'deleted'
          : null;
    const activeMode: NarratorMode =
      activeRow && activeAsset === 'styled'
        ? (activeRow.style as SketchStyle)
        : activeRow
          ? 'photo'
          : mode;
    return {
      manifestId: m.id,
      consent: {
        version: STORY_PARENT_IMAGE_CONSENT_VERSION,
        text: STORY_PARENT_IMAGE_CONSENT_TEXT,
        active: imageConsentActive(m),
        acceptedAt: m.narratorImageConsentAt?.toISOString() ?? null,
        acceptedVersion: m.narratorImageConsentVersion,
        revokedAt: m.narratorImageConsentRevokedAt?.toISOString() ?? null,
      },
      character: ch
        ? {
            id: ch.id,
            label: ch.label,
            hasPhoto: !!ch.photoUrl && !ch.originalDeletedAt,
            originalDeleted: !!ch.originalDeletedAt,
            mode,
            sketchRendering: options?.sketchRendering ?? null,
          }
        : null,
      active: {
        kind: m.narratorLookId ? 'variant' : 'original',
        lookId: m.narratorLookId,
        asset: m.narratorLookId ? activeAsset : null,
        mode: activeMode,
        problem: activeProblem,
        modeChanged: !!m.narratorLookId && activeMode !== mode,
      },
      presets: { outfits: NARRATOR_OUTFITS, makeups: NARRATOR_MAKEUPS },
      quota,
      price: {
        create: narratorLookPrice(this.modelsFor(mode)),
        restyle:
          mode === 'photo' ? null : narratorLookPrice([GEMINI_SKETCH_MODEL]),
      },
      items: rows.map((r) =>
        this.lookView(r, m, ch, mode, m.narratorLookId === r.id),
      ),
    };
  }

  /**
   * Превью варианта JSON-ом (только владельцу; байты не уходят в Blob).
   * Больше `NARRATOR_LOOK_JSON_IMAGE_MAX_BYTES` — 413
   * `NARRATOR_LOOK_IMAGE_TOO_LARGE`: такой вариант отдаётся только
   * бинарно (`imageBytes`, маршрут `…/image/raw`), чтобы ответ не превысил
   * лимит Vercel.
   */
  async image(
    userId: string,
    manifestId: string,
    lookId: string,
    asset: string,
  ): Promise<{ base64: string; mime: string; hash: string }> {
    const img = await this.imageBytes(userId, manifestId, lookId, asset);
    if (img.bytes.length > NARRATOR_LOOK_JSON_IMAGE_MAX_BYTES) {
      throw new PayloadTooLargeException({
        code: 'NARRATOR_LOOK_IMAGE_TOO_LARGE',
        message:
          'Изображение слишком большое для JSON-превью — откройте его через …/image/raw',
        bytes: img.bytes.length,
        maxJsonBytes: NARRATOR_LOOK_JSON_IMAGE_MAX_BYTES,
      });
    }
    return {
      base64: img.bytes.toString('base64'),
      mime: img.mime,
      hash: img.hash,
    };
  }

  /** Байты варианта для бинарного превью (A-S3-10); те же проверки владельца. */
  async imageBytes(
    userId: string,
    manifestId: string,
    lookId: string,
    asset: string,
  ): Promise<{ bytes: Buffer; mime: string; hash: string }> {
    if (asset !== 'photo' && asset !== 'styled') {
      throw new BadRequestException('Изображение варианта: photo или styled');
    }
    await this.own(userId, manifestId);
    const row = (await this.prisma.storyNarratorLook.findFirst({
      where: { id: lookId, manifestId, userId, deletedAt: null },
      select:
        asset === 'photo'
          ? { photo: true, photoMime: true, photoHash: true }
          : { styled: true, styledMime: true, styledHash: true },
    })) as Record<string, unknown> | null;
    const bytes = row?.[asset] as Uint8Array | null | undefined;
    if (!row || !bytes) throw new NotFoundException('Изображение не найдено');
    const buffer = Buffer.from(bytes);
    // Only image types go out as Content-Type; anything else is sniffed.
    const stored = String(row[`${asset}Mime`] ?? '');
    return {
      bytes: buffer,
      mime: /^image\/(png|jpeg|webp)$/.test(stored)
        ? stored
        : (imageMimeOf(buffer) ?? 'image/png'),
      hash: String(row[`${asset}Hash`] ?? ''),
    };
  }

  // ── Согласие ──────────────────────────────────────────────────────

  async acceptConsent(
    userId: string,
    manifestId: string,
    dto: NarratorImageConsentDto,
  ): Promise<NarratorLooksView> {
    if (
      dto.accepted !== true ||
      dto.version !== STORY_PARENT_IMAGE_CONSENT_VERSION
    ) {
      throw new BadRequestException(
        'Подтвердите текущую версию согласия на синтетический образ',
      );
    }
    const m = await this.own(userId, manifestId);
    // Уже действует — ничего не трогаем: варианты, созданные под ним,
    // остаются доступными (повтор отправки формы не «перевыпускает» их).
    if (!imageConsentActive(m)) {
      await this.prisma.brandManifest.updateMany({
        where: { id: m.id, userId },
        data: {
          narratorImageConsentAt: new Date(),
          narratorImageConsentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
          narratorImageConsentRevokedAt: null,
        },
      });
    }
    return this.view(userId, manifestId);
  }

  /**
   * Отзыв: новые варианты не создаются, существующие недоступны для
   * новых рендеров (`resolveNarratorImage` → 409). Применённый вариант
   * НЕ подменяется оригиналом молча — откат делает сам взрослый.
   */
  async revokeConsent(
    userId: string,
    manifestId: string,
  ): Promise<NarratorLooksView> {
    const m = await this.own(userId, manifestId);
    if (m.narratorImageConsentAt && !m.narratorImageConsentRevokedAt) {
      await this.prisma.brandManifest.updateMany({
        where: { id: m.id, userId },
        data: { narratorImageConsentRevokedAt: new Date() },
      });
    }
    return this.view(userId, manifestId);
  }

  // ── Платные действия ──────────────────────────────────────────────

  async create(
    userId: string,
    manifestId: string,
    dto: CreateNarratorLookDto,
  ): Promise<{ look: NarratorLookView; reused: boolean }> {
    const m = await this.own(userId, manifestId);
    this.assertConsent(m);
    const ch = await this.character(m);
    const pathname = this.sourcePathname(ch);
    const { mode, options } = narratorModeOf(ch!.activeSketch);
    const calls = mode === 'photo' ? 1 : 2;
    const price = this.priceOrThrow(
      this.modelsFor(mode),
      dto.maxReserveMicroUsd,
    );
    await this.plans.assertCanSpendUser(userId);

    let source: Buffer;
    try {
      source = await this.blob.downloadBuffer(pathname);
    } catch {
      throw new HttpException(
        'Не удалось прочитать фото рассказчика',
        HttpStatus.BAD_GATEWAY,
      );
    }
    const sourceMime = imageMimeOf(source) ?? mimeFromPath(pathname);
    const sourceHash = sha256Hex(source);
    const prompt = buildNarratorLookPrompt({
      outfit: dto.outfit,
      makeup: dto.makeup,
    });
    const configHash = narratorLookConfigHash({
      kind: 'create',
      characterId: ch!.id,
      sourceHash,
      outfit: dto.outfit,
      makeup: dto.makeup,
      mode,
      options,
    });
    const reserved = await this.reserve(userId, m.id, configHash, {
      repeat: dto.repeat === true,
      calls,
      data: {
        userId,
        manifestId: m.id,
        characterId: ch!.id,
        sourceUrl: ch!.photoUrl!,
        sourceHash,
        outfit: dto.outfit,
        makeup: dto.makeup,
        configHash,
        promptHash: promptFingerprint(
          mode === 'photo'
            ? prompt
            : `${prompt}\n${buildNarratorStylePrompt(mode, options!)}`,
        ),
        consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
        consentAt: m.narratorImageConsentAt!,
        status: 'PENDING',
        imageCalls: calls,
        reservedMicroUsd: price.reserveMicroUsd,
        style: mode === 'photo' ? null : mode,
        styleOptions: mode === 'photo' ? undefined : (options as object),
        styleStatus: mode === 'photo' ? 'NONE' : 'PENDING',
      },
    });
    if ('reused' in reserved) {
      return {
        look: this.lookView(
          reserved.reused,
          m,
          ch,
          mode,
          m.narratorLookId === reserved.reused.id,
        ),
        reused: true,
      };
    }
    const id = reserved.id;
    try {
      let photo: { bytes: Buffer; mime: string };
      try {
        photo = await this.pass(
          userId,
          prompt,
          source,
          sourceMime,
          GEMINI_IMAGE_MODEL,
        );
      } catch (error) {
        if (!(error instanceof NarratorPassError)) throw error;
        await this.finish(id, {
          status: error.kind === 'unknown' ? 'UNKNOWN' : 'FAILED',
          // Второй вызов не начинался — квота его не держит.
          imageCalls: 1,
          ...(mode === 'photo' ? {} : { styleStatus: 'FAILED' }),
          error: error.message.slice(0, 500),
        });
        throw passHttpError(error, 'образ');
      }
      const photoHash = sha256Hex(photo.bytes);
      await this.finish(id, {
        photo: photo.bytes,
        photoMime: photo.mime,
        photoHash,
        model: GEMINI_IMAGE_MODEL,
        ...(mode === 'photo' ? { status: 'READY', error: null } : {}),
      });
      if (mode !== 'photo') {
        await this.stylePass(userId, id, mode, options!, photo);
      }
      return { look: await this.lookById(id, m, ch, mode), reused: false };
    } catch (error) {
      await this.abandon(id, error);
      throw error;
    }
  }

  /**
   * Перестилизовать вариант под ТЕКУЩИЙ режим персонажа: новая строка с
   * копией фото варианта и одним вызовом стилизации (фото не
   * перегенерируется — дешевле и лицо то же).
   */
  async restyle(
    userId: string,
    manifestId: string,
    lookId: string,
    dto: RestyleNarratorLookDto,
  ): Promise<{ look: NarratorLookView; reused: boolean }> {
    const m = await this.own(userId, manifestId);
    this.assertConsent(m);
    const parent = (await this.prisma.storyNarratorLook.findFirst({
      where: { id: lookId, manifestId: m.id, userId, deletedAt: null },
      select: { ...LOOK_SELECT, photo: true },
    })) as (LookRow & { photo: Uint8Array | null }) | null;
    if (!parent) throw new NotFoundException('Вариант не найден');
    if (!parent.photo || !parent.photoHash) {
      throw new BadRequestException('У варианта нет готового фото');
    }
    const ch = await this.character(m);
    this.sourcePathname(ch);
    const { mode, options } = narratorModeOf(ch!.activeSketch);
    if (mode === 'photo') {
      throw new BadRequestException(
        'Рассказчик в режиме фото — примените фото варианта, стилизация не нужна',
      );
    }
    const problem = narratorLookProblem({
      look: { ...parent, style: null, styledHash: null },
      asset: 'photo',
      consent: m,
      narratorCharacterId: m.narratorCharacterId,
      characterPhotoUrl: ch!.photoUrl,
      mode: null,
      // Restyle reuses the variant's finished PHOTO (checked by photoHash)
      // even after a failed/unknown styling pass; the result is a new row.
      requireReady: false,
    });
    if (problem) this.problemConflict(problem);
    if (parent.style === mode && parent.styledHash) {
      throw new BadRequestException('Вариант уже в этом стиле');
    }
    const price = this.priceOrThrow(
      [GEMINI_SKETCH_MODEL],
      dto.maxReserveMicroUsd,
    );
    await this.plans.assertCanSpendUser(userId);
    const configHash = narratorLookConfigHash({
      kind: 'restyle',
      characterId: parent.characterId,
      sourceHash: parent.sourceHash,
      outfit: parent.outfit as NarratorOutfit,
      makeup: parent.makeup as NarratorMakeup,
      mode,
      options,
      parentPhotoHash: parent.photoHash,
    });
    const reserved = await this.reserve(userId, m.id, configHash, {
      repeat: dto.repeat === true,
      calls: 1,
      data: {
        userId,
        manifestId: m.id,
        characterId: parent.characterId,
        parentLookId: parent.id,
        sourceUrl: parent.sourceUrl,
        sourceHash: parent.sourceHash,
        outfit: parent.outfit,
        makeup: parent.makeup,
        configHash,
        promptHash: promptFingerprint(buildNarratorStylePrompt(mode, options!)),
        consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
        consentAt: m.narratorImageConsentAt!,
        status: 'PENDING',
        imageCalls: 1,
        reservedMicroUsd: price.reserveMicroUsd,
        photo: Buffer.from(parent.photo),
        photoMime: parent.photoMime,
        photoHash: parent.photoHash,
        style: mode,
        styleOptions: options as object,
        styleStatus: 'PENDING',
      },
    });
    if ('reused' in reserved) {
      return {
        look: this.lookView(
          reserved.reused,
          m,
          ch,
          mode,
          m.narratorLookId === reserved.reused.id,
        ),
        reused: true,
      };
    }
    try {
      await this.stylePass(userId, reserved.id, mode, options!, {
        bytes: Buffer.from(parent.photo),
        mime: parent.photoMime ?? 'image/png',
      });
      return {
        look: await this.lookById(reserved.id, m, ch, mode),
        reused: false,
      };
    } catch (error) {
      await this.abandon(reserved.id, error);
      throw error;
    }
  }

  // ── Применить / откатить / удалить ────────────────────────────────

  /** Вариант становится активным ТОЛЬКО здесь — явным действием. */
  async apply(
    userId: string,
    manifestId: string,
    lookId: string,
  ): Promise<NarratorLooksView> {
    const m = await this.own(userId, manifestId);
    const look = (await this.prisma.storyNarratorLook.findFirst({
      where: { id: lookId, manifestId: m.id, userId },
      select: LOOK_SELECT,
    })) as LookRow | null;
    if (!look) throw new NotFoundException('Вариант не найден');
    if (look.status === 'PENDING') {
      throw new ConflictException({
        code: 'NARRATOR_LOOK_IN_PROGRESS',
        message: 'Вариант ещё генерируется — примените после результата',
      });
    }
    const ch = await this.character(m);
    const { mode } = ch
      ? narratorModeOf(ch.activeSketch)
      : { mode: 'photo' as NarratorMode };
    const asset = assetForMode(mode);
    const problem = narratorLookProblem({
      look,
      asset,
      consent: m,
      narratorCharacterId: m.narratorCharacterId,
      characterPhotoUrl: ch?.photoUrl ?? null,
      mode,
    });
    if (problem) this.problemConflict(problem);
    await this.prisma.brandManifest.updateMany({
      where: { id: m.id, userId },
      data: { narratorLookId: look.id, narratorLookAsset: asset },
    });
    return this.view(userId, manifestId);
  }

  /** Откат к оригиналу одним действием; варианты остаются в списке. */
  async revert(userId: string, manifestId: string): Promise<NarratorLooksView> {
    const m = await this.own(userId, manifestId);
    await this.prisma.brandManifest.updateMany({
      where: { id: m.id, userId },
      data: { narratorLookId: null, narratorLookAsset: null },
    });
    return this.view(userId, manifestId);
  }

  /**
   * Удаление варианта: байты стираются сразу, строка остаётся как
   * журнал (квота и провенанс). Активный вариант — откат к оригиналу.
   */
  async remove(
    userId: string,
    manifestId: string,
    lookId: string,
  ): Promise<NarratorLooksView> {
    const m = await this.own(userId, manifestId);
    await this.expireStale(userId, new Date());
    const look = (await this.prisma.storyNarratorLook.findFirst({
      where: { id: lookId, manifestId: m.id, userId, deletedAt: null },
      select: { id: true, status: true },
    })) as { id: string; status: string } | null;
    if (!look) throw new NotFoundException('Вариант не найден');
    if (look.status === 'PENDING') {
      throw new ConflictException(
        'Вариант ещё генерируется — удалить можно после ответа модели',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.storyNarratorLook.updateMany({
        where: { id: look.id, userId, deletedAt: null },
        data: {
          status: 'DELETED',
          deletedAt: new Date(),
          photo: null,
          styled: null,
        },
      });
      await tx.brandManifest.updateMany({
        where: { id: m.id, userId, narratorLookId: look.id },
        data: { narratorLookId: null, narratorLookAsset: null },
      });
    });
    return this.view(userId, manifestId);
  }

  // ── Точка интеграции WP4 ──────────────────────────────────────────

  /**
   * Активный образ рассказчика для НОВОГО рендера Story. Вариант
   * закреплён ровно тем ассетом, что одобрил взрослый; отозванное
   * согласие, удалённый или устаревший вариант — 409, без молчаливой
   * подмены оригиналом. Чужой брендбук — 404.
   */
  async resolveNarratorImage(
    manifestId: string,
    userId: string,
  ): Promise<NarratorImage> {
    const m = await this.own(userId, manifestId);
    const ch = await this.character(m);
    if (!ch) {
      throw new ConflictException({
        code: 'NARRATOR_IMAGE_MISSING',
        message: 'В брендбуке не выбран персонаж-рассказчик',
      });
    }
    if (m.narratorLookId) {
      const look = (await this.prisma.storyNarratorLook.findFirst({
        where: { id: m.narratorLookId, manifestId: m.id, userId },
        select: { ...LOOK_SELECT, photo: true, styled: true },
      })) as
        | (LookRow & { photo: Uint8Array | null; styled: Uint8Array | null })
        | null;
      const asset = (m.narratorLookAsset as NarratorAsset | null) ?? 'photo';
      const problem: NarratorLookProblem | null = look
        ? narratorLookProblem({
            look,
            asset,
            consent: m,
            narratorCharacterId: m.narratorCharacterId,
            characterPhotoUrl: ch.photoUrl,
            mode: null,
          })
        : 'deleted';
      if (problem) this.problemConflict(problem);
      const raw = asset === 'photo' ? look!.photo : look!.styled;
      const expected = asset === 'photo' ? look!.photoHash : look!.styledHash;
      const bytes = raw ? Buffer.from(raw) : null;
      if (!bytes || sha256Hex(bytes) !== expected) {
        this.problemConflict('asset-missing');
      }
      const options = (look!.styleOptions ?? null) as SketchOptions | null;
      return {
        kind: 'variant',
        manifestId: m.id,
        characterId: ch.id,
        lookId: look!.id,
        asset,
        assetHash: expected!,
        style: asset === 'photo' ? 'photo' : (look!.style as SketchStyle),
        sketchRendering:
          asset === 'photo' ? null : (options?.sketchRendering ?? null),
        consentVersion: look!.consentVersion,
        mimeType:
          (asset === 'photo' ? look!.photoMime : look!.styledMime) ??
          'image/png',
        bytes: bytes!,
      };
    }
    const image = activeRowImage(ch);
    const pathname = image
      ? (image.pathname ?? pathnameFromUrl(image.url))
      : null;
    if (!image || !pathname) {
      throw new ConflictException({
        code: 'NARRATOR_IMAGE_MISSING',
        message: 'У персонажа-рассказчика нет изображения',
      });
    }
    const bytes = await this.blob.downloadBuffer(pathname);
    const { mode, options } = narratorModeOf(ch.activeSketch);
    return {
      kind: 'original',
      manifestId: m.id,
      characterId: ch.id,
      lookId: null,
      asset: image.variant,
      assetHash: sha256Hex(bytes),
      style: image.variant === 'sketch' ? mode : 'photo',
      sketchRendering:
        image.variant === 'sketch' ? (options?.sketchRendering ?? null) : null,
      consentVersion: imageConsentActive(m)
        ? STORY_PARENT_IMAGE_CONSENT_VERSION
        : null,
      mimeType: imageMimeOf(bytes) ?? image.mimeType,
      bytes,
    };
  }

  // ── Внутреннее ────────────────────────────────────────────────────

  private async own(userId: string, manifestId: string): Promise<ManifestRow> {
    const m = (await this.prisma.brandManifest.findFirst({
      where: { id: manifestId, userId },
      select: MANIFEST_SELECT,
    })) as ManifestRow | null;
    if (!m) throw new NotFoundException('Бренд-бук не найден');
    return m;
  }

  private async character(m: ManifestRow): Promise<CharacterRow | null> {
    if (!m.narratorCharacterId) return null;
    return (await this.prisma.brandCharacter.findFirst({
      where: { id: m.narratorCharacterId, brandManifestId: m.id },
      include: { activeSketch: true },
    })) as CharacterRow | null;
  }

  private assertConsent(m: ManifestRow): void {
    if (!imageConsentActive(m)) {
      throw new ConflictException({
        code: 'NARRATOR_IMAGE_CONSENT_REQUIRED',
        message:
          'Сначала подтвердите согласие на синтетический образ (story-parent-image-v1)',
      });
    }
  }

  /** Путь оригинала — только из строки персонажа, клиент путей не шлёт. */
  private sourcePathname(ch: CharacterRow | null): string {
    if (!ch) {
      throw new BadRequestException({
        code: 'NARRATOR_CHARACTER_REQUIRED',
        message: 'Сначала выберите персонажа-рассказчика с фото',
      });
    }
    const pathname =
      ch.photoUrl && !ch.originalDeletedAt
        ? pathnameFromUrl(ch.photoUrl)
        : null;
    if (!pathname) {
      throw new BadRequestException({
        code: 'NARRATOR_PHOTO_REQUIRED',
        message:
          'Нужно фото рассказчика: варианты делаются только из оригинального фото',
      });
    }
    return pathname;
  }

  private modelsFor(mode: NarratorMode): string[] {
    return mode === 'photo'
      ? [GEMINI_IMAGE_MODEL]
      : [GEMINI_IMAGE_MODEL, GEMINI_SKETCH_MODEL];
  }

  private priceOrThrow(models: string[], accepted: number): NarratorLookPrice {
    const price = narratorLookPrice(models);
    if (!price) {
      throw new ServiceUnavailableException(
        'Нет ставки модели изображений — генерация вариантов выключена',
      );
    }
    if (!Number.isFinite(accepted) || price.reserveMicroUsd > accepted) {
      throw new ConflictException({
        code: 'NARRATOR_LOOK_PRICE_CHANGED',
        message: 'Цена изменилась — обновите экран и подтвердите новую',
        price,
      });
    }
    return price;
  }

  private problemConflict(problem: NarratorLookProblem): never {
    throw new ConflictException({
      code: `NARRATOR_LOOK_${problem.toUpperCase().replace(/-/g, '_')}`,
      problem,
      message: NARRATOR_LOOK_PROBLEM_MESSAGE[problem],
    });
  }

  private async quotaRows(
    userId: string,
    now: Date,
    client: Pick<PrismaService, 'storyNarratorLook'> = this.prisma,
  ): Promise<Array<{ createdAt: Date; imageCalls: number }>> {
    return (await client.storyNarratorLook.findMany({
      where: { userId, createdAt: { gte: startOfMonthUtc(now) } },
      select: { createdAt: true, imageCalls: true },
    })) as Array<{ createdAt: Date; imageCalls: number }>;
  }

  /** PENDING без ответа дольше 10 минут — UNKNOWN навсегда, без повтора. */
  private async expireStale(
    userId: string,
    now: Date,
    client: Pick<PrismaService, 'storyNarratorLook'> = this.prisma,
  ): Promise<void> {
    const stale = { lt: new Date(now.getTime() - NARRATOR_LOOK_STALE_MS) };
    await client.storyNarratorLook.updateMany({
      where: {
        userId,
        status: 'PENDING',
        styleStatus: 'PENDING',
        updatedAt: stale,
      },
      data: { status: 'UNKNOWN', styleStatus: 'UNKNOWN', error: STALE_MESSAGE },
    });
    await client.storyNarratorLook.updateMany({
      where: { userId, status: 'PENDING', updatedAt: stale },
      data: { status: 'UNKNOWN', error: STALE_MESSAGE },
    });
  }

  /**
   * Бронь под advisory-lock пользователя: одна генерация на брендбук в
   * полёте, готовый такой же вариант — без оплаты, после FAILED/UNKNOWN —
   * только явный `repeat`, затем квота с учётом всех начатых вызовов.
   */
  private async reserve(
    userId: string,
    manifestId: string,
    configHash: string,
    input: { repeat: boolean; calls: number; data: Record<string, unknown> },
  ): Promise<{ id: string } | { reused: LookRow }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-narrator-look:${userId}`}))::text`;
      const now = new Date();
      await this.expireStale(userId, now, tx);
      const inflight = await tx.storyNarratorLook.findFirst({
        where: { userId, manifestId, status: 'PENDING' },
        select: { id: true },
      });
      if (inflight) {
        throw new ConflictException({
          code: 'NARRATOR_LOOK_IN_PROGRESS',
          message: 'Вариант уже генерируется — дождитесь результата',
        });
      }
      if (!input.repeat) {
        const ready = (await tx.storyNarratorLook.findFirst({
          where: {
            userId,
            manifestId,
            configHash,
            status: 'READY',
            deletedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          select: LOOK_SELECT,
        })) as LookRow | null;
        if (ready) return { reused: ready };
        const failed = await tx.storyNarratorLook.findFirst({
          where: {
            userId,
            manifestId,
            configHash,
            status: { in: ['FAILED', 'UNKNOWN'] },
            deletedAt: null,
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, status: true },
        });
        if (failed) {
          throw new ConflictException({
            code: 'NARRATOR_LOOK_REPEAT_REQUIRED',
            lookId: failed.id,
            status: failed.status,
            message:
              failed.status === 'UNKNOWN'
                ? 'Прошлая такая же попытка закончилась с неизвестным исходом. Повтор оплачивается заново — подтвердите его явно.'
                : 'Прошлая такая же попытка не удалась. Повтор оплачивается заново — подтвердите его явно.',
          });
        }
      }
      const quota = narratorLookQuota(
        await this.quotaRows(userId, now, tx),
        now,
      );
      const exhausted = narratorQuotaExhausted(quota, input.calls);
      if (exhausted) {
        throw new HttpException(
          {
            code: 'NARRATOR_LOOK_QUOTA',
            message:
              exhausted === 'day'
                ? `Лимит генераций образа на сегодня исчерпан (${quota.dayLimit} вызовов). Обновится в 00:00 UTC.`
                : `Лимит генераций образа в этом месяце исчерпан (${quota.monthLimit} вызовов).`,
            quota,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      const row = await tx.storyNarratorLook.create({
        data: input.data as never,
        select: { id: true },
      });
      return { id: row.id };
    });
  }

  /** Один вызов модели картинок. Расход пишется за любой ответ модели. */
  private async pass(
    userId: string,
    prompt: string,
    bytes: Buffer,
    mimeType: string,
    model: string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const outcome = await this.generator.generate({
      prompt,
      source: { bytes, mimeType },
      model,
    });
    if (outcome.status === 'failed') {
      // Ответа нет: оплачен ли вызов — неизвестно. UNKNOWN, без повтора.
      this.logger.warn(
        `образ рассказчика: нет ответа модели — ${outcome.reason}`,
      );
      throw new NarratorPassError('unknown', 'модель не ответила');
    }
    await this.aiUsage
      .recordGemini(outcome.raw, {
        operation: NARRATOR_LOOK_OPERATION,
        model: outcome.model,
        userId,
      })
      .catch((error: unknown) =>
        this.logger.warn(
          `образ рассказчика: расход не записан — ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    if (outcome.status === 'refused') {
      // finishReason модели (SAFETY, OTHER…) — код, не чужой текст ошибки.
      const code = /^[A-Z_]{1,40}$/.test(outcome.reason)
        ? ` (${outcome.reason})`
        : '';
      throw new NarratorPassError('refused', `модель отказалась${code}`);
    }
    if (outcome.bytes.length > NARRATOR_LOOK_MAX_BYTES) {
      throw new NarratorPassError('invalid', 'больше 4 МБ');
    }
    const mime = imageMimeOf(outcome.bytes);
    if (!mime) throw new NarratorPassError('invalid', 'неизвестный формат');
    return { bytes: outcome.bytes, mime };
  }

  private async stylePass(
    userId: string,
    id: string,
    style: SketchStyle,
    options: SketchOptions,
    photo: { bytes: Buffer; mime: string },
  ): Promise<void> {
    try {
      const styled = await this.pass(
        userId,
        buildNarratorStylePrompt(style, options),
        photo.bytes,
        photo.mime,
        GEMINI_SKETCH_MODEL,
      );
      await this.finish(id, {
        styled: styled.bytes,
        styledMime: styled.mime,
        styledHash: sha256Hex(styled.bytes),
        styleStatus: 'READY',
        status: 'READY',
        error: null,
      });
    } catch (error) {
      if (!(error instanceof NarratorPassError)) throw error;
      const state = error.kind === 'unknown' ? 'UNKNOWN' : 'FAILED';
      await this.finish(id, {
        status: state,
        styleStatus: state,
        error: `Стилизация: ${error.message}`.slice(0, 500),
      });
      throw passHttpError(error, 'стиль образа');
    }
  }

  private async finish(
    id: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.storyNarratorLook.updateMany({
      where: { id, status: 'PENDING' },
      data: data as never,
    });
  }

  /** Любой сбой после брони: строка не остаётся PENDING навсегда. */
  private async abandon(id: string, error: unknown): Promise<void> {
    if (error instanceof HttpException) return;
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`образ рассказчика ${id}: ${message}`);
    await this.prisma.storyNarratorLook
      .updateMany({
        where: { id, status: 'PENDING' },
        data: { status: 'UNKNOWN', error: message.slice(0, 500) },
      })
      .catch(() => undefined);
  }

  private async lookById(
    id: string,
    m: ManifestRow,
    ch: CharacterRow | null,
    mode: NarratorMode,
  ): Promise<NarratorLookView> {
    const row = (await this.prisma.storyNarratorLook.findFirst({
      where: { id },
      select: LOOK_SELECT,
    })) as LookRow;
    return this.lookView(row, m, ch, mode, m.narratorLookId === id);
  }

  private lookView(
    r: LookRow,
    m: ManifestRow,
    ch: CharacterRow | null,
    mode: NarratorMode,
    active: boolean,
  ): NarratorLookView {
    return {
      id: r.id,
      parentLookId: r.parentLookId,
      characterId: r.characterId,
      outfit: r.outfit as NarratorOutfit,
      makeup: r.makeup as NarratorMakeup,
      status: r.status,
      styleStatus: r.styleStatus,
      style: (r.style as SketchStyle | null) ?? null,
      sourceHash: r.sourceHash,
      photoHash: r.photoHash,
      styledHash: r.styledHash,
      consentVersion: r.consentVersion,
      imageCalls: r.imageCalls,
      reservedMicroUsd: r.reservedMicroUsd,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      active,
      problem: narratorLookProblem({
        look: r,
        asset: assetForMode(mode),
        consent: m,
        narratorCharacterId: m.narratorCharacterId,
        characterPhotoUrl: ch?.photoUrl ?? null,
        mode,
      }),
    };
  }
}
