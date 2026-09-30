/**
 * BrandManifestService — Brand Manifest + Brand Character CRUD.
 * doc/PRODUCT-PROJECT-SPEC.md §12 (+ §5 model, §10 third option on the
 * character form); Stage 7 of the implementation plan.
 *
 * Same conventions as ProjectService: every query is scoped by userId
 * (`{ id, userId }`), a miss is a 404 (never reveals foreign ids),
 * structural row types so the file compiles without the generated
 * Prisma client (doc/TELEGRAM-ADMIN.md §5).
 *
 * What a manifest IS here: a template the user edits in its own section
 * and attaches to any number of projects (Project.brandManifestId,
 * ProjectService). What happens at generation time — copying it into the
 * Session as an editable snapshot (§12 "Правки перед конкретной
 * генерацией") — is Stage 10, not this module: this one only owns the
 * canonical record.
 *
 * `filters`/`effects`: opaque JSON for v1 (spec open question §12.1).
 * Validated only as "plain object ≤ 16 KB" (dto/json-object.validator);
 * shape is decided when Stage 15 wires them into the Veo prompt.
 *
 * Stage 22 (§17.1): brand SCENES — permanent locations of the brand. Same
 * row shape and the same presigned-photo flow as characters, so both are
 * served by one set of private helpers parameterised by `AssetKind`
 * ('characters' | 'scenes'); the public methods keep the explicit names
 * the controller and tests already use.
 */

import { normalizeVoiceMode } from '../../common/voice-mode';
import { normalizeCameraMove } from '../../common/camera-move';
import {
  normalizeSubtitlesMode,
  normalizeSubtitleTheme,
} from '../../common/subtitles';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { isPersonaVoice } from '../user-voices/persona-voice';
import { createGeminiClient } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import {
  FaceCheckGenerator,
  checkFaces,
  mayContainFace,
} from '../persona/face-check';
import { head } from '@vercel/blob';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
import { activeRowImage, SketchableRow } from '../../common/active-image';
import { PlanService } from '../plan/plan.service';
import { SessionService } from '../../common/session.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import {
  BrandCharacterView,
  BrandManifestSummaryView,
  BrandManifestView,
  BrandSceneView,
  JsonObject,
} from '../../common/types/brand-manifest.types';
import { BrandManifestRequestDto } from './dto/brand-manifest-request.dto';
import { normalizeCardStyle } from '../../common/greeting-cards';
import {
  FACE_CHECKED_SCENE_PREFIX,
  PERSONA_VOICE_ONLY_PERSONAL,
  isFaceCheckedScenePhoto,
  personaUsable,
  PERSONA_DISABLED_CODE,
  PERSONA_DISABLED_MESSAGE,
  personaEnabled,
} from '../../common/greeting-persona';
import { GREETING_TONES } from '../../common/types/greeting.types';
import type { GreetingTone } from '../../common/types/greeting.types';

/** Этап G (§4.7): тексты отказов личного бренд-бука. */
export const PERSONAL_NEEDS_PERSONA =
  'Личный бренд-бук привязан к вашей проверенной персоне — сначала создайте её и пройдите проверку в разделе «Я в кадре».';

export const KIND_IMMUTABLE =
  'Вид бренд-бука (личный или корпоративный) задаётся при создании и не меняется — создайте новый бренд-бук.';
export const DEFAULT_LOOK_ONLY_PERSONAL =
  'Образ по умолчанию есть только у личного бренд-бука.';
export const DEFAULT_LOOK_NOT_FOUND =
  'Образ не найден среди ваших образов (он удалён или принадлежит не вам).';
/**
 * Размер для текста «фото больше 10 МБ»: вверх до десятой и с запятой.
 * Обычное округление превращало 10 МБ + 1 байт в «(10.0 МБ)» — отказ,
 * который противоречит сам себе.
 */
function photoSizeMb(bytes: number): string {
  return String(Math.ceil((bytes / 1024 / 1024) * 10) / 10).replace('.', ',');
}

/** Бренд-бука нет или он чужой — снаружи это одно и то же. */
export const BRAND_MANIFEST_NOT_FOUND = 'Бренд-бук не найден';

/** Фото персонажа или сцены не нашлось там, куда его велели положить. */
const ASSET_PHOTO_UPLOAD_FAILED =
  'Фото не загрузилось — попробуйте загрузить его ещё раз';

/** Свой клон голоса выпущен Resemble — озвучить его другим провайдером нельзя. */
export const CLONE_NEEDS_RESEMBLE =
  'Ваш клонированный голос работает только через Resemble — выберите Resemble или другой голос.';
import { BrandCharacterRequestDto } from './dto/brand-character-request.dto';
import { AddCharacterFromSessionCastDto } from './dto/add-character-from-session-cast.dto';
import {
  CharacterPhotoConfirmRequestDto,
  CharacterPhotoUploadUrlRequestDto,
} from './dto/character-photo.dto';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// ── Structural row types (see file doc comment) ────────────────────────

/** Shared row shape of brand_characters and brand_scenes. */
interface AssetRow extends SketchableRow {
  id: string;
  brandManifestId: string;
  label: string;
  photoUrl: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}
type CharacterRow = AssetRow;
type SceneRow = AssetRow;

/** Which of the two asset tables a helper works on — also the URL segment and Blob folder. */
export type AssetKind = 'characters' | 'scenes';

/** Minimal Prisma-delegate surface the asset helpers need (structural, no generated client). */
interface AssetDelegate {
  create(args: {
    data: Record<string, unknown>;
    include?: Record<string, unknown>;
  }): Promise<AssetRow>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
    include?: Record<string, unknown>;
  }): Promise<AssetRow>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  findFirst(args: {
    where: Record<string, unknown>;
    include?: Record<string, unknown>;
  }): Promise<AssetRow | null>;
}

interface ManifestRow {
  id: string;
  title: string;
  styleNotes: string | null;
  voiceNotes?: string | null;
  voiceMode?: string | null;
  cameraMove?: string | null;
  subtitlesMode?: string | null;
  subtitleTheme?: string | null;
  ttsVoiceId?: string | null;
  ttsModel?: string | null;
  ttsProvider?: string | null;
  filters: unknown;
  effects: unknown;
  /** Этап G (§4.7); необязательные — фикстуры до этапа G их не несут. */
  kind?: string | null;
  personaId?: string | null;
  defaultLookId?: string | null;
  signature?: string | null;
  defaultTone?: string | null;
  cardStyle?: unknown;
  createdAt: Date;
  updatedAt: Date;
  characters?: CharacterRow[];
  scenes?: SceneRow[];
  _count?: { projects: number; characters?: number; scenes?: number };
}

const FULL_INCLUDE = {
  // `activeSketch` — чтобы выдача показывала АКТИВНОЕ изображение, а не
  // оригинал: иначе после перезагрузки на экране фото, а в ролик уходит
  // скетч (аудит A-8).
  characters: {
    orderBy: { createdAt: 'asc' as const },
    include: { activeSketch: true },
  },
  scenes: {
    orderBy: { createdAt: 'asc' as const },
    include: { activeSketch: true },
  },
  _count: { select: { projects: true } },
};

/** Тот же `include` для одиночных чтений ассета. */
export const ASSET_INCLUDE = { activeSketch: true };

const SUMMARY_INCLUDE = {
  _count: { select: { projects: true, characters: true, scenes: true } },
};

export interface CharacterPhotoUploadUrl {
  uploadUrl: string;
  pathname: string;
}

/** Deterministic Blob key for a character's or scene's photo. Exported for tests. */
export function assetPhotoPathname(
  kind: AssetKind,
  manifestId: string,
  assetId: string,
  mimeType: string,
): string {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  return `brand-manifests/${manifestId}/${kind}/${assetId}/photo.${ext}`;
}

/**
 * Разбор пути фото замены персонажа сессии — ровно той формы, что
 * выдаёт `castPhotoPathname` (casting.service.ts). Всё прочее — `null`.
 */
export function parseSessionCastPhotoPathname(
  pathname: string,
): { sessionId: string; characterId: string; ext: 'png' | 'jpg' } | null {
  const m = /^sessions\/([^/]+)\/characters\/([^/]+)\/photo\.(png|jpg)$/.exec(
    pathname,
  );
  if (!m || m[1] === '..' || m[2] === '..') return null;
  return { sessionId: m[1], characterId: m[2], ext: m[3] as 'png' | 'jpg' };
}

/** Kept under its Stage-7 name — callers and tests use it. */
export function characterPhotoPathname(
  manifestId: string,
  characterId: string,
  mimeType: string,
): string {
  return assetPhotoPathname('characters', manifestId, characterId, mimeType);
}

export function scenePhotoPathname(
  manifestId: string,
  sceneId: string,
  mimeType: string,
): string {
  return assetPhotoPathname('scenes', manifestId, sceneId, mimeType);
}

@Injectable()
export class BrandManifestService {
  private readonly logger = new Logger(BrandManifestService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
    private readonly plans: PlanService,
    private readonly ttsResolver: TtsProviderResolverService,
    private readonly sessions: SessionService,
    /**
     * Расход проверки лица на фото сцены (CONTRACT5 п.10). Необязательный:
     * модуль расхода глобальный, но юнит-тесты сервиса строят его без него.
     */
    @Optional() private readonly aiUsage?: AiUsageService,
  ) {}

  /**
   * Клиент Gemini для проверки лица — лениво: без ключа он бросает, и в
   * конструкторе это сломало бы весь бренд-бук на стенде без ключа.
   */
  private faceClient: FaceCheckGenerator | null = null;
  private get faceGenai(): FaceCheckGenerator {
    this.faceClient ??= createGeminiClient() as unknown as FaceCheckGenerator;
    return this.faceClient;
  }

  // ── Manifests ─────────────────────────────────────────────────────────

  async create(
    userId: string,
    dto: BrandManifestRequestDto,
  ): Promise<BrandManifestView> {
    // §23: манифест бренда — от Standard и выше. Проверяем только при
    // создании: уже созданные манифесты остаются доступны, если человек
    // вернулся на Lite — отбирать сделанное было бы враждебно.
    // Этап G (§4.7, В-1): личный бренд-бук — отдельный признак тарифа
    // `personalBrand` (на всех тарифах), а не `brandManifest` (Standard+).
    // Персона и режим проверяются раньше тарифа: при выключенном режиме
    // ответ — тот же 404 PERSONA_DISABLED, что у маршрутов персоны.
    const personal = dto.kind === 'PERSONAL';
    let personaFields: Record<string, unknown> = {};
    if (personal) {
      const personaId = await this.personalPersonaId(userId);
      if (dto.defaultLookId) {
        await this.assertOwnLook(personaId, dto.defaultLookId);
      }
      personaFields = {
        kind: 'PERSONAL',
        personaId,
        defaultLookId: dto.defaultLookId ?? null,
      };
    } else if (dto.defaultLookId) {
      throw new BadRequestException(DEFAULT_LOOK_ONLY_PERSONAL);
    }
    await this.assertPersonaVoiceAllowed(userId, dto.ttsVoiceId, personal);
    await this.plans.assertUser(
      userId,
      personal ? 'personalBrand' : 'brandManifest',
    );
    if (!dto.title?.trim()) {
      throw new BadRequestException('Назовите бренд-бук');
    }
    // Доп. запрос владельца продукта: дубляж (voiceMode: 'dub') —
    // премиальный уровень озвучки, отдельный от обычного voiceover,
    // который уже под тем же гейтом, что brandManifest выше. Проверяем
    // здесь, а не в чистой manifestDataFromDto: тариф решает вызывающий
    // сервис (см. её же доккомментарий про activeProviderKey).
    if (dto.voiceMode === 'dub') {
      await this.plans.assertUser(userId, 'voiceDub');
    }
    const isResembleClone = await this.isOwnResembleVoice(userId, dto);
    const tts = await this.ttsResolver.resolve();
    // `manifestDataFromDto` возвращает `Record<string, unknown>` (нужно
    // для `update()`, где ЛЮБОЕ поле, включая `title`, может отсутствовать
    // при частичной правке) — статически Prisma не может убедиться, что
    // здесь, при СОЗДАНИИ, обязательный `title` в объекте есть, хотя
    // проверка выше (`if (!dto.title?.trim()) throw ...`) это по факту
    // гарантирует. Каст, а не смена типа `manifestDataFromDto` — та же
    // функция используется и в `update()`, где `title` необязателен.
    const row: ManifestRow = await this.prisma.brandManifest.create({
      data: {
        userId,
        ...manifestDataFromDto(dto, tts.providerKey, isResembleClone),
        ...personaFields,
      } as unknown as Prisma.BrandManifestUncheckedCreateInput,
      include: FULL_INCLUDE,
    });
    return toManifestView(row);
  }

  async list(userId: string): Promise<BrandManifestSummaryView[]> {
    const rows: ManifestRow[] = await this.prisma.brandManifest.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: SUMMARY_INCLUDE,
    });
    return rows.map(toSummaryView);
  }

  async get(userId: string, manifestId: string): Promise<BrandManifestView> {
    const row = await this.findOwn(userId, manifestId, FULL_INCLUDE);
    return toManifestView(row);
  }

  async update(
    userId: string,
    manifestId: string,
    dto: BrandManifestRequestDto,
  ): Promise<BrandManifestView> {
    const current = await this.findOwn(userId, manifestId, FULL_INCLUDE);
    // Только переход В dub спрашивает тариф — иначе даунгрейднутый
    // пользователь с уже выбранным (когда-то законно) dub не смог бы
    // сохранить вообще ничего в манифесте: форма пересылает текущий
    // voiceMode при каждом сохранении, не только когда его действительно
    // поменяли.
    if (dto.voiceMode === 'dub' && current.voiceMode !== 'dub') {
      await this.plans.assertUser(userId, 'voiceDub');
    }
    // Этап G (§4.7): вид не меняется — корпоративный, ставший личным,
    // мог уже стоять на аукционе, а личный, ставший корпоративным, ушёл
    // бы туда с лицом автора. Форма пересылает текущий вид при каждом
    // сохранении — то же значение не отказ.
    const currentKind = current.kind === 'PERSONAL' ? 'PERSONAL' : 'COMPANY';
    if (dto.kind !== undefined && dto.kind !== currentKind) {
      throw new BadRequestException(KIND_IMMUTABLE);
    }
    await this.assertPersonaVoiceAllowed(
      userId,
      dto.ttsVoiceId,
      currentKind === 'PERSONAL',
    );
    const lookData: Record<string, unknown> = {};
    if (dto.defaultLookId !== undefined) {
      if (dto.defaultLookId === null) {
        lookData.defaultLookId = null;
      } else if (currentKind !== 'PERSONAL') {
        throw new BadRequestException(DEFAULT_LOOK_ONLY_PERSONAL);
      } else {
        const personaId = await this.personalPersonaId(userId);
        await this.assertOwnLook(personaId, dto.defaultLookId);
        // Персону могли удалить и создать заново (§4.9: личные бренд-буки
        // остаются без персоны) — привязка следует за образом.
        lookData.defaultLookId = dto.defaultLookId;
        lookData.personaId = personaId;
      }
    }
    const isResembleClone = await this.isOwnResembleVoice(userId, dto);
    const tts = await this.ttsResolver.resolve();
    const data = {
      ...manifestDataFromDto(
        dto,
        tts.providerKey,
        isResembleClone,
        current.ttsProvider ?? null,
      ),
      ...lookData,
    };
    if (Object.keys(data).length === 0) return toManifestView(current);
    const row: ManifestRow = await this.prisma.brandManifest.update({
      where: { id: manifestId },
      data,
      include: FULL_INCLUDE,
    });
    return toManifestView(row);
  }

  /**
   * Characters and scenes go with it (DB cascade); projects that used it
   * are kept with brandManifestId → NULL (SetNull, verified in Stage 2).
   * Sessions already generated are untouched — they hold their own snapshot.
   *
   * The cascade is the DB's, so it bypasses removeCharacter/removeScene and
   * their blob cleanup — the photos have to be collected here, before the
   * rows disappear (doc/STORAGE-AUDIT.md, Stage 27; this was listed there
   * as known debt after Stage 26 and is what closes it).
   */
  async remove(userId: string, manifestId: string): Promise<void> {
    await this.findOwn(userId, manifestId);
    const prefix = `brand-manifests/${manifestId}/`;
    // Узкий `select` (только `photoUrl` — единственное, что здесь читаем)
    // не удовлетворяет полному `AssetRow[]`: та же ошибка класса «select
    // уже сузил результат, а объявленный тип требует больше полей», что
    // в library.service.ts/project.service.ts (см. doc/PRODUCT-PROJECT-
    // IMPLEMENTATION-PLAN.md, «Внеплановый фикс №2»).
    const [characters, scenes]: [
      Pick<AssetRow, 'photoUrl'>[],
      Pick<AssetRow, 'photoUrl'>[],
    ] = await Promise.all([
      this.prisma.brandCharacter.findMany({
        where: { brandManifestId: manifestId },
        select: { photoUrl: true },
      }),
      this.prisma.brandScene.findMany({
        where: { brandManifestId: manifestId },
        select: { photoUrl: true },
      }),
    ]);
    await this.prisma.brandManifest.delete({ where: { id: manifestId } });
    const paths = [...characters, ...scenes]
      .map((row) => pathnameFromBlobUrl(row.photoUrl, prefix))
      .filter((p): p is string => !!p);
    if (paths.length > 0) await this.blobService.deleteMany(paths);
  }

  // ── Characters (§12 / §10) ────────────────────────────────────────────

  addCharacter(
    userId: string,
    manifestId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    return this.addAsset('characters', userId, manifestId, dto);
  }

  updateCharacter(
    userId: string,
    manifestId: string,
    characterId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    return this.updateAsset('characters', userId, manifestId, characterId, dto);
  }

  removeCharacter(
    userId: string,
    manifestId: string,
    characterId: string,
  ): Promise<void> {
    return this.removeAsset('characters', userId, manifestId, characterId);
  }

  /**
   * Доп. запрос владельца продукта — сохранить замену персонажа,
   * сделанную на экране сессии (`kind: 'photo' | 'text'` в
   * `CharacterCasting.tsx`), постоянным персонажем бренда. Переиспользует
   * уже существующие кирпичи (`addCharacter`, `blobService.copyBlob`,
   * `confirmAssetPhoto`) — не дублирует их логику заново.
   *
   * Фото копируется, не переиспользуется напрямую: сессионное фото
   * удаляется вместе с сессией (см. `CastReplacement.photoPathname`),
   * прямая ссылка стала бы битой уже после этой же сессии. Best-effort
   * по копированию — `copyBlob` сам возвращает `null` при сбое (лог
   * внутри неё же), персонаж всё равно создаётся с текстом, просто без
   * фото, а не падает целиком из-за одной картинки.
   */
  async addCharacterFromSessionCast(
    userId: string,
    manifestId: string,
    dto: AddCharacterFromSessionCastDto,
  ): Promise<BrandCharacterView> {
    // §6.8 doc/AI-SKETCH-SPEC.md: путь приходит от клиента, поэтому
    // сверяем его с сессией ДО создания персонажа. Раньше копировался
    // любой присланный Blob — в том числе чужой сессии — и всегда с типом
    // `image/jpeg`, даже для PNG.
    const source = dto.photoPathname
      ? await this.resolveSessionCastPhoto(userId, dto.photoPathname)
      : null;

    const created = await this.addCharacter(userId, manifestId, {
      label: dto.label,
      description: dto.description,
    });

    if (!source) return created;

    const toPathname = assetPhotoPathname(
      'characters',
      manifestId,
      created.id,
      source.contentType,
    );
    const url = await this.blobService.copyBlob(
      source.pathname,
      toPathname,
      source.contentType,
    );
    if (!url) return created; // копирование не удалось — персонаж остаётся без фото, не падаем

    return this.confirmAssetPhoto(
      'characters',
      userId,
      manifestId,
      created.id,
      {
        pathname: toPathname,
      },
    );
  }

  /**
   * Фото замены из сессии, которое можно перенести в бренд: путь той
   * формы, что выдаёт `castPhotoPathname`, сессия принадлежит этому же
   * пользователю, и в её кастинге у этого персонажа сейчас именно это
   * фото. Чужая или несуществующая сессия — 404 (как везде: чужое не
   * отличается от несуществующего).
   */
  private async resolveSessionCastPhoto(
    userId: string,
    pathname: string,
  ): Promise<{ pathname: string; contentType: string }> {
    const parsed = parseSessionCastPhotoPathname(pathname);
    if (!parsed) {
      throw new BadRequestException(
        'photoPathname должен указывать на фото персонажа сессии',
      );
    }
    const session = await this.sessions.getSession(parsed.sessionId);
    if (!session || session.userId !== userId) {
      throw new NotFoundException('Фото персонажа сессии не найдено');
    }
    const matches = (session.characterCasting?.casts ?? []).some(
      (c) =>
        c.characterId === parsed.characterId &&
        c.replacement.photoPathname === pathname,
    );
    if (!matches) {
      throw new BadRequestException(
        'Это фото больше не выбрано для персонажа — обновите экран и попробуйте снова',
      );
    }
    return {
      pathname,
      contentType: parsed.ext === 'png' ? 'image/png' : 'image/jpeg',
    };
  }

  createCharacterPhotoUploadUrl(
    userId: string,
    manifestId: string,
    characterId: string,
    dto: CharacterPhotoUploadUrlRequestDto,
  ): Promise<CharacterPhotoUploadUrl> {
    return this.createAssetPhotoUploadUrl(
      'characters',
      userId,
      manifestId,
      characterId,
      dto,
    );
  }

  confirmCharacterPhoto(
    userId: string,
    manifestId: string,
    characterId: string,
    dto: CharacterPhotoConfirmRequestDto,
  ): Promise<BrandCharacterView> {
    return this.confirmAssetPhoto(
      'characters',
      userId,
      manifestId,
      characterId,
      dto,
    );
  }

  // ── Scenes (§17.1, Stage 22) — same flow, other table ─────────────────

  addScene(
    userId: string,
    manifestId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandSceneView> {
    return this.addAsset('scenes', userId, manifestId, dto);
  }

  updateScene(
    userId: string,
    manifestId: string,
    sceneId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandSceneView> {
    return this.updateAsset('scenes', userId, manifestId, sceneId, dto);
  }

  removeScene(
    userId: string,
    manifestId: string,
    sceneId: string,
  ): Promise<void> {
    return this.removeAsset('scenes', userId, manifestId, sceneId);
  }

  createScenePhotoUploadUrl(
    userId: string,
    manifestId: string,
    sceneId: string,
    dto: CharacterPhotoUploadUrlRequestDto,
  ): Promise<CharacterPhotoUploadUrl> {
    return this.createAssetPhotoUploadUrl(
      'scenes',
      userId,
      manifestId,
      sceneId,
      dto,
    );
  }

  confirmScenePhoto(
    userId: string,
    manifestId: string,
    sceneId: string,
    dto: CharacterPhotoConfirmRequestDto,
  ): Promise<BrandSceneView> {
    return this.confirmAssetPhoto('scenes', userId, manifestId, sceneId, dto);
  }

  // ── Generic asset helpers (characters and scenes) ─────────────────────

  private delegate(kind: AssetKind): AssetDelegate {
    return (kind === 'characters'
      ? this.prisma.brandCharacter
      : this.prisma.brandScene) as unknown as AssetDelegate;
  }

  private async addAsset(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    await this.findOwn(userId, manifestId);
    // Две ветки с литералами, а не тернарник: шов текстов отказа
    // проверяет первый аргумент исключения, и выражение он бы пропустил.
    if (!dto.label?.trim() && kind === 'characters') {
      throw new BadRequestException(
        'Подпишите персонажа — без подписи его не добавить',
      );
    }
    if (!dto.label?.trim()) {
      throw new BadRequestException(
        'Подпишите сцену — без подписи её не добавить',
      );
    }
    const row = await this.delegate(kind).create({
      data: { brandManifestId: manifestId, ...characterDataFromDto(dto) },
      include: ASSET_INCLUDE,
    });
    await this.touch(manifestId);
    return toCharacterView(row);
  }

  private async updateAsset(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    assetId: string,
    dto: BrandCharacterRequestDto,
  ): Promise<BrandCharacterView> {
    await this.findOwnAsset(kind, userId, manifestId, assetId);
    const row = await this.delegate(kind).update({
      where: { id: assetId },
      data: characterDataFromDto(dto),
      include: ASSET_INCLUDE,
    });
    await this.touch(manifestId);
    return toCharacterView(row);
  }

  private async removeAsset(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    assetId: string,
  ): Promise<void> {
    const asset = await this.findOwnAsset(kind, userId, manifestId, assetId);
    await this.delegate(kind).delete({ where: { id: assetId } });
    if (asset.photoUrl) {
      // Best-effort. Путь — из самого URL (под префиксом этого ассета): с
      // волны CONTRACT5 п.10 фото сцены может лежать под серверным
      // `checked-<hex>`, и фиксированный `photo.<ext>` оставил бы его
      // сиротой. Не разобрался — прежнее детерминированное имя.
      void this.blobService.deleteBlob(
        pathnameFromBlobUrl(
          asset.photoUrl,
          `brand-manifests/${manifestId}/${kind}/${assetId}/`,
        ) ??
          assetPhotoPathname(
            kind,
            manifestId,
            assetId,
            asset.photoUrl.endsWith('.png') ? 'image/png' : 'image/jpeg',
          ),
      );
    }
    await this.touch(manifestId);
  }

  // Presigned Blob flow, like every file in the app.
  private async createAssetPhotoUploadUrl(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    assetId: string,
    dto: CharacterPhotoUploadUrlRequestDto,
  ): Promise<CharacterPhotoUploadUrl> {
    await this.findOwnAsset(kind, userId, manifestId, assetId);
    if (dto.fileSize > MAX_PHOTO_BYTES) {
      throw new BadRequestException(
        `Фото больше 10 МБ (${photoSizeMb(dto.fileSize)} МБ) — выберите файл поменьше`,
      );
    }
    const pathname = assetPhotoPathname(
      kind,
      manifestId,
      assetId,
      dto.mimeType,
    );
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_PHOTO_BYTES,
    );
    return { uploadUrl, pathname };
  }

  /** After the PUT: verify the blob exists and record its public URL. */
  private async confirmAssetPhoto(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    assetId: string,
    dto: CharacterPhotoConfirmRequestDto,
  ): Promise<BrandCharacterView> {
    const previous = await this.findOwnAsset(kind, userId, manifestId, assetId);
    const expectedPrefix = `brand-manifests/${manifestId}/${kind}/${assetId}/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      this.logger.warn(
        `бренд-бук ${manifestId}: путь фото ${dto.pathname} не под ${expectedPrefix}`,
      );
      throw new BadRequestException(ASSET_PHOTO_UPLOAD_FAILED);
    }
    let url: string;
    try {
      url = (await head(dto.pathname)).url;
    } catch (e) {
      this.logger.warn(
        `бренд-бук ${manifestId}: фото ${dto.pathname} не нашлось в хранилище (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
      throw new BadRequestException(ASSET_PHOTO_UPLOAD_FAILED);
    }
    if (kind === 'scenes' && personaEnabled()) {
      url = await this.faceCheckedScenePhoto(
        manifestId,
        assetId,
        dto.pathname,
        url,
      );
    }
    const row = await this.delegate(kind).update({
      where: { id: assetId },
      // §3.3 ТЗ скетча: новое фото ассета отвязывает прежний скетч
      // (аудит A-14) — иначе загрузка молча ничего не меняла бы.
      data: { photoUrl: url, activeSketchId: null, originalDeletedAt: null },
      include: ASSET_INCLUDE,
    });
    // Прежний серверный `checked-<hex>` при новом фото больше никому не
    // принадлежит — клиентский `photo.<ext>` перезаписывается загрузкой
    // сам, а этот остался бы сиротой (CONTRACT5 п.10, аудит волны).
    const oldPath = pathnameFromBlobUrl(previous.photoUrl, expectedPrefix);
    const newPath = pathnameFromBlobUrl(url, expectedPrefix);
    if (
      oldPath &&
      oldPath !== newPath &&
      isFaceCheckedScenePhoto(previous.photoUrl)
    ) {
      await this.blobService
        .deleteBlob(oldPath)
        .catch((e: unknown) =>
          this.logger.warn(
            `${kind} ${assetId}: прежний файл не удалён: ${String(e)}`,
          ),
        );
    }
    await this.touch(manifestId);
    return toCharacterView(row);
  }

  /**
   * Лица на фото сцены бренд-бука (CONTRACT5 п.10) — только при
   * включённом режиме. Сцена бренда — место; фото, на котором лица точно
   * нет, сервер копирует под путь с отметкой проверки
   * (`FACE_CHECKED_SCENE_PREFIX` + случайный суффикс) и удаляет
   * клиентский файл. Фото, где лицо есть или проверка не ответила
   * (fail-closed), остаётся как загружено: в бренд-буке оно видно, но в
   * видеомодель уходит только словами — до скетча, который рисует место
   * без людей (`brandSceneImageAllowed`). Отказ здесь не нужен: человек
   * должен иметь возможность сделать из этого фото скетч.
   */
  private async faceCheckedScenePhoto(
    manifestId: string,
    sceneId: string,
    pathname: string,
    url: string,
  ): Promise<string> {
    let data: Buffer;
    let genai: FaceCheckGenerator;
    try {
      genai = this.faceGenai;
      data = await this.blobService.downloadBuffer(pathname);
    } catch (e) {
      this.logger.warn(
        `сцена ${sceneId}: проверка лица недоступна — фото пойдёт в ролик только словами: ${String(e)}`,
      );
      return url;
    }
    const mimeType = pathname.endsWith('.png') ? 'image/png' : 'image/jpeg';
    const result = await checkFaces(
      genai,
      { purpose: 'reference', photo: { data, mimeType } },
      {
        model: GEMINI_MODEL,
        onResponse: (res) =>
          this.aiUsage?.recordGemini(res, {
            operation: 'reference-face-check',
            model: GEMINI_MODEL,
          }),
      },
    );
    if (mayContainFace(result)) {
      this.logger.warn(
        `сцена ${sceneId}: ${result ? 'на фото лицо' : 'проверка лица не ответила'} — фото пойдёт в ролик только словами`,
      );
      return url;
    }
    const checkedPath = `brand-manifests/${manifestId}/scenes/${sceneId}/${FACE_CHECKED_SCENE_PREFIX}${randomBytes(12).toString('hex')}.${
      mimeType === 'image/png' ? 'png' : 'jpg'
    }`;
    const uploaded = await this.blobService.uploadBuffer(
      checkedPath,
      data,
      mimeType,
    );
    await this.blobService
      .deleteBlob(pathname)
      .catch((e: unknown) =>
        this.logger.warn(
          `сцена ${sceneId}: клиентский файл не удалён: ${String(e)}`,
        ),
      );
    return uploaded.url;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Шестой аудит, Е-4.1: принадлежит ли присланный `ttsVoiceId` СВОЕМУ
   * клону на Resemble — единственный надёжный признак (клонирование
   * всегда идёт через Resemble независимо от активного TTS_PROVIDER,
   * см. tts.module.ts). Голос не меняется (`dto.ttsVoiceId === undefined`)
   * или очищается (пусто/только пробелы) — запрос не нужен вовсе.
   */
  private async isOwnResembleVoice(
    userId: string,
    dto: BrandManifestRequestDto,
  ): Promise<boolean> {
    const voiceId = dto.ttsVoiceId?.trim();
    if (!voiceId) return false;
    const own = await this.prisma.userVoice.findFirst({
      where: { userId, resembleVoiceId: voiceId },
      select: { id: true },
    });
    return !!own;
  }

  /**
   * Персона автора для личного бренд-бука: режим включён, персона есть и
   * не отозвана. Иначе — 404 PERSONA_DISABLED (как маршруты персоны) или
   * 400 с подсказкой, где её создать.
   */
  private async personalPersonaId(userId: string): Promise<string> {
    if (!personaEnabled()) {
      throw new NotFoundException({
        code: PERSONA_DISABLED_CODE,
        message: PERSONA_DISABLED_MESSAGE,
      });
    }
    // CONTRACT5 п.13: персона проверена (живость пройдена) и без отказа
    // (в том числе «младше 18» — надгробие с `revokedAt`).
    const persona = await this.prisma.persona.findFirst({
      where: { userId, revokedAt: null },
      select: {
        id: true,
        livenessCheckedAt: true,
        revokedAt: true,
        verifyResult: true,
      },
    });
    if (!persona || !personaUsable(persona)) {
      throw new BadRequestException(PERSONAL_NEEDS_PERSONA);
    }
    return persona.id;
  }

  /**
   * CONTRACT5 п.5а: клон голоса персоны — только в личном бренд-буке.
   * Корпоративный бренд-бук продаётся на аукционе и не несёт признака
   * персоны, и голос живого человека ушёл бы туда без следа. В личном —
   * только при включённом режиме.
   */
  private async assertPersonaVoiceAllowed(
    userId: string,
    voiceId: string | null | undefined,
    personal: boolean,
  ): Promise<void> {
    if (!voiceId?.trim()) return;
    if (!(await isPersonaVoice(this.prisma, userId, voiceId))) return;
    if (!personal) throw new BadRequestException(PERSONA_VOICE_ONLY_PERSONAL);
    if (!personaEnabled()) {
      throw new NotFoundException({
        code: PERSONA_DISABLED_CODE,
        message: PERSONA_DISABLED_MESSAGE,
      });
    }
  }

  /** Образ своей персоны, не удалённый. Чужой — «не найден», без подробностей. */
  private async assertOwnLook(personaId: string, lookId: string) {
    const look = await this.prisma.personaLook.findFirst({
      where: { id: lookId, personaId, deletedAt: null },
      select: { id: true },
    });
    if (!look) throw new BadRequestException(DEFAULT_LOOK_NOT_FOUND);
  }

  private async findOwn(
    userId: string,
    manifestId: string,
    include?: Record<string, unknown>,
  ): Promise<ManifestRow> {
    const row: ManifestRow | null = await this.prisma.brandManifest.findFirst({
      where: { id: manifestId, userId },
      ...(include ? { include } : {}),
    });
    if (!row) {
      this.logger.warn(`бренд-бук ${manifestId} не найден у ${userId}`);
      throw new NotFoundException(BRAND_MANIFEST_NOT_FOUND);
    }
    return row;
  }

  private async findOwnAsset(
    kind: AssetKind,
    userId: string,
    manifestId: string,
    assetId: string,
  ): Promise<AssetRow> {
    const row = await this.delegate(kind).findFirst({
      where: {
        id: assetId,
        brandManifestId: manifestId,
        brandManifest: { userId },
      },
    });
    if (!row) {
      this.logger.warn(
        `бренд-бук ${manifestId}: ${kind === 'characters' ? 'персонажа' : 'сцены'} ${assetId} нет`,
      );
      if (kind === 'characters') {
        throw new NotFoundException('Персонаж не найден в бренд-буке');
      }
      throw new NotFoundException('Сцена не найдена в бренд-буке');
    }
    return row;
  }

  /** Character/scene edits surface the manifest at the top of "recently edited". */
  private async touch(manifestId: string): Promise<void> {
    await this.prisma.brandManifest.update({
      where: { id: manifestId },
      data: { updatedAt: new Date() },
    });
  }
}

// ── Pure helpers (exported for tests) ──────────────────────────────────

/**
 * `activeProviderKey` — `TtsProvider.providerKey` активного на стенде
 * провайдера (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2). Голос и
 * провайдер, который его выпустил, всегда меняются вместе. Раньше тег
 * решал только сервер; теперь клиент МОЖЕТ прислать явный
 * `dto.ttsProvider` (выбор провайдера в `VoicePicker` — голос взят из
 * каталога именно этого провайдера), и тогда тег — его выбор. Не
 * прислал — прежнее поведение: клон → resemble, иначе активный на стенде.
 * Исключение — Soniox без voiceId: это «голос Soniox по умолчанию»
 * (`SONIOX_TTS_VOICE`/Maya, см. `SonioxTtsService.defaultVoice`), и тег
 * сохраняется; у elevenlabs/resemble без voiceId синтеза нет — тег
 * очищается, как и раньше.
 */
export function manifestDataFromDto(
  dto: BrandManifestRequestDto,
  activeProviderKey: string,
  // Шестой аудит, Е-4.1: клонирование голоса всегда идёт через
  // ResembleService НЕЗАВИСИМО от активного на стенде TTS_PROVIDER
  // (tts.module.ts) — значит `voiceId` клонированного голоса тоже
  // всегда принадлежит Resemble, каким бы ни был активный провайдер.
  // Раньше сюда безусловно шёл `activeProviderKey`, и на стенде с
  // TTS_PROVIDER=elevenlabs (обычный деплой, RESEMBLE_API_KEY — только
  // ради клонирования) клон тегировался 'elevenlabs' — защитный guard в
  // postprod.service.ts сравнивает это поле само с собой в момент
  // синтеза, и совпадение было гарантировано, даже когда voiceId
  // физически принадлежал другому провайдеру. Вызывающий (сервис, у
  // которого есть доступ к БД) решает это ДО вызова — функция остаётся
  // чистой ради юнит-теста в изоляции.
  isResembleClone = false,
  // Тег, уже сохранённый в строке (правка) — чтобы отличить эхо формы от
  // нового выбора, см. проверку клона ниже. При создании — `null`.
  currentTtsProvider: string | null = null,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (dto.title !== undefined) data.title = dto.title.trim();
  if (dto.styleNotes !== undefined) {
    data.styleNotes = dto.styleNotes?.trim() ?? null;
  }
  if (dto.voiceNotes !== undefined) {
    data.voiceNotes = dto.voiceNotes?.trim() ?? null;
  }
  // ТЗ §15.1: режим озвучки и голос — часть бренда, а не настройка одной
  // сессии: серия роликов узнаётся именно по голосу.
  if (dto.voiceMode !== undefined) {
    data.voiceMode = normalizeVoiceMode(dto.voiceMode);
  }
  if (dto.cameraMove !== undefined) {
    data.cameraMove = normalizeCameraMove(dto.cameraMove);
  }
  if (dto.subtitlesMode !== undefined) {
    data.subtitlesMode = normalizeSubtitlesMode(dto.subtitlesMode);
  }
  if (dto.subtitleTheme !== undefined) {
    data.subtitleTheme = normalizeSubtitleTheme(dto.subtitleTheme);
  }
  if (dto.ttsVoiceId !== undefined) {
    const voiceId = dto.ttsVoiceId?.trim() || null;
    data.ttsVoiceId = voiceId;
    // §4.2 + Е-4.1 шестого аудита: провайдер, выпустивший этот голос, —
    // безусловно Resemble, если voiceId совпадает со своим клоном
    // (`UserVoice.resembleVoiceId`, проверено вызывающим), иначе —
    // активный на стенде TTS_PROVIDER; голос очищен — провайдер тоже
    // не нужен.
    // Клон физически живёт на Resemble: явный тег другого провайдера
    // значил бы синтез чужим провайдером с UUID Resemble — заведомо
    // обречённый платный вызов. Молча переписывать НОВЫЙ выбор клиента
    // нельзя (он увидел бы «Soniox», а звучал бы Resemble) — отказ. Но
    // форма эхом шлёт тег, который отдал сервер, а у старых бренд-буков с
    // клоном он исторически неверный (`elevenlabs`, этапы 73–76): отказ
    // на эхо запер бы любую правку такого бренд-бука. Эхо (тот же тег,
    // что в строке) молча переписывается на 'resemble' ниже.
    if (
      voiceId &&
      isResembleClone &&
      dto.ttsProvider &&
      dto.ttsProvider !== 'resemble' &&
      dto.ttsProvider !== currentTtsProvider
    ) {
      throw new BadRequestException(CLONE_NEEDS_RESEMBLE);
    }
    data.ttsProvider = voiceId
      ? isResembleClone
        ? 'resemble'
        : (dto.ttsProvider ?? activeProviderKey)
      : dto.ttsProvider === 'soniox'
        ? 'soniox'
        : null;
  }
  if (dto.ttsModel !== undefined) {
    data.ttsModel = dto.ttsModel?.trim() || null;
  }
  // Prisma refuses a plain JS `null` for a Json column ("use JsonNull or
  // DbNull") — a nullable `Json?` cleared to SQL NULL must be Prisma.DbNull.
  if (dto.filters !== undefined) {
    data.filters = dto.filters === null ? Prisma.DbNull : dto.filters;
  }
  if (dto.effects !== undefined) {
    data.effects = dto.effects === null ? Prisma.DbNull : dto.effects;
  }
  // Этап G (§4.7, Г-6): подпись, тон и стиль карточек — у любого вида
  // бренд-бука. Вид и образ по умолчанию решает сервис (нужна персона).
  if (dto.signature !== undefined) {
    data.signature = dto.signature?.trim() || null;
  }
  if (dto.defaultTone !== undefined) {
    data.defaultTone = dto.defaultTone ?? null;
  }
  if (dto.cardStyle !== undefined) {
    const style = normalizeCardStyle(dto.cardStyle);
    data.cardStyle = style ?? Prisma.DbNull;
  }
  return data;
}

export function characterDataFromDto(
  dto: BrandCharacterRequestDto,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (dto.label !== undefined) data.label = dto.label.trim();
  if (dto.description !== undefined) {
    data.description = dto.description?.trim() ?? null;
  }
  return data;
}

function asJsonObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

/** Same shape for characters and scenes (BrandSceneView is structurally identical). */
export function toCharacterView(row: AssetRow): BrandCharacterView {
  const active = activeRowImage(row);
  return {
    id: row.id,
    brandManifestId: row.brandManifestId,
    label: row.label,
    // Показываем то же изображение, что уйдёт в ролик (§6.3, аудит A-8).
    photoUrl: active?.url ?? row.photoUrl,
    photoVariant: active?.variant ?? 'original',
    originalPhotoUrl: row.photoUrl,
    originalDeleted: !!row.originalDeletedAt,
    activeSketchId: active?.variant === 'sketch' ? row.activeSketch!.id : null,
    photoFaceChecked: isFaceCheckedScenePhoto(row.photoUrl),
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toManifestView(row: ManifestRow): BrandManifestView {
  return {
    id: row.id,
    title: row.title,
    styleNotes: row.styleNotes,
    voiceNotes: row.voiceNotes ?? null,
    voiceMode: normalizeVoiceMode(row.voiceMode),
    cameraMove: normalizeCameraMove(row.cameraMove),
    subtitlesMode: normalizeSubtitlesMode(row.subtitlesMode),
    subtitleTheme: normalizeSubtitleTheme(row.subtitleTheme),
    ttsVoiceId: row.ttsVoiceId ?? null,
    ttsModel: row.ttsModel ?? null,
    ttsProvider: row.ttsProvider ?? null,
    filters: asJsonObject(row.filters),
    effects: asJsonObject(row.effects),
    characters: (row.characters ?? []).map(toCharacterView),
    scenes: (row.scenes ?? []).map(toCharacterView),
    projectCount: row._count?.projects ?? 0,
    kind: row.kind === 'PERSONAL' ? 'PERSONAL' : 'COMPANY',
    defaultLookId: row.defaultLookId ?? null,
    signature: row.signature ?? null,
    defaultTone: toneOrNull(row.defaultTone),
    cardStyle: normalizeCardStyle(row.cardStyle),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toSummaryView(row: ManifestRow): BrandManifestSummaryView {
  return {
    id: row.id,
    title: row.title,
    characterCount: row._count?.characters ?? row.characters?.length ?? 0,
    sceneCount: row._count?.scenes ?? row.scenes?.length ?? 0,
    projectCount: row._count?.projects ?? 0,
    kind: row.kind === 'PERSONAL' ? 'PERSONAL' : 'COMPANY',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Тон из строки БД — только известный код, иначе `null`. */
function toneOrNull(value: string | null | undefined): GreetingTone | null {
  return (GREETING_TONES as readonly string[]).includes(value ?? '')
    ? (value as GreetingTone)
    : null;
}
