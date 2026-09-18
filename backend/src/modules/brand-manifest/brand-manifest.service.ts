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
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { pathnameFromBlobUrl } from '../../common/blob-paths';
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
import { BrandCharacterRequestDto } from './dto/brand-character-request.dto';
import { AddCharacterFromSessionCastDto } from './dto/add-character-from-session-cast.dto';
import {
  CharacterPhotoConfirmRequestDto,
  CharacterPhotoUploadUrlRequestDto,
} from './dto/character-photo.dto';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// ── Structural row types (see file doc comment) ────────────────────────

/** Shared row shape of brand_characters and brand_scenes. */
interface AssetRow {
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
  create(args: { data: Record<string, unknown> }): Promise<AssetRow>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<AssetRow>;
  delete(args: { where: { id: string } }): Promise<unknown>;
  findFirst(args: { where: Record<string, unknown> }): Promise<AssetRow | null>;
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
  createdAt: Date;
  updatedAt: Date;
  characters?: CharacterRow[];
  scenes?: SceneRow[];
  _count?: { projects: number; characters?: number; scenes?: number };
}

const FULL_INCLUDE = {
  characters: { orderBy: { createdAt: 'asc' as const } },
  scenes: { orderBy: { createdAt: 'asc' as const } },
  _count: { select: { projects: true } },
};

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly blobService: BlobService,
    private readonly plans: PlanService,
    private readonly ttsResolver: TtsProviderResolverService,
    private readonly sessions: SessionService,
  ) {}

  // ── Manifests ─────────────────────────────────────────────────────────

  async create(
    userId: string,
    dto: BrandManifestRequestDto,
  ): Promise<BrandManifestView> {
    // §23: манифест бренда — от Standard и выше. Проверяем только при
    // создании: уже созданные манифесты остаются доступны, если человек
    // вернулся на Lite — отбирать сделанное было бы враждебно.
    await this.plans.assertUser(userId, 'brandManifest');
    if (!dto.title?.trim()) {
      throw new BadRequestException('title is required to create a manifest');
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
    const isResembleClone = await this.isOwnResembleVoice(userId, dto);
    const tts = await this.ttsResolver.resolve();
    const data = manifestDataFromDto(dto, tts.providerKey, isResembleClone);
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
    if (!dto.label?.trim()) {
      throw new BadRequestException(
        `label is required to add a ${kind === 'characters' ? 'character' : 'scene'}`,
      );
    }
    const row = await this.delegate(kind).create({
      data: { brandManifestId: manifestId, ...characterDataFromDto(dto) },
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
      // Best-effort: the blob key is deterministic, derive it from the URL's
      // stored pathname convention rather than parsing the CDN URL.
      void this.blobService.deleteBlob(
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
        `Photo exceeds the 10MB limit (received ${dto.fileSize} bytes)`,
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
    await this.findOwnAsset(kind, userId, manifestId, assetId);
    const expectedPrefix = `brand-manifests/${manifestId}/${kind}/${assetId}/`;
    if (!dto.pathname.startsWith(expectedPrefix)) {
      throw new BadRequestException(
        `pathname must start with "${expectedPrefix}"`,
      );
    }
    let url: string;
    try {
      url = (await head(dto.pathname)).url;
    } catch (e) {
      throw new BadRequestException(
        `Photo not found in storage at "${dto.pathname}" — upload it first via the photo/upload-url step (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const row = await this.delegate(kind).update({
      where: { id: assetId },
      data: { photoUrl: url },
    });
    await this.touch(manifestId);
    return toCharacterView(row);
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
      throw new NotFoundException(`Brand manifest ${manifestId} not found`);
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
      throw new NotFoundException(
        `${kind === 'characters' ? 'Character' : 'Scene'} ${assetId} not found in manifest ${manifestId}`,
      );
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
 * провайдера (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2). Клиент НЕ
 * присылает `ttsProvider` — DTO такого поля не имеет; голос и
 * провайдер, который его выпустил, всегда меняются вместе, и решает
 * это сервисный слой, не клиент, который не знает, какой провайдер
 * сейчас активен.
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
    data.ttsProvider = voiceId
      ? isResembleClone
        ? 'resemble'
        : activeProviderKey
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
  return {
    id: row.id,
    brandManifestId: row.brandManifestId,
    label: row.label,
    photoUrl: row.photoUrl,
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
