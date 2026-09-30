/**
 * ProjectSessionService — starts a generation Session FROM a ProductItem
 * (doc/PRODUCT-PROJECT-SPEC.md §7.8, Stage 10 of the plan) and keeps the
 * per-session Brand Manifest copy editable (§12).
 *
 * The one rule everything here follows: the Session gets COPIES. Item
 * fields land in `data.productInformation`, manifest fields + characters
 * in `data.brandManifestSnapshot`; `projectId` / `productItemId` are set
 * only so the UI can show "из какого товара этот ролик" and list a
 * project's sessions. Editing the item or the manifest afterwards does
 * not touch sessions already created, and editing a session's snapshot
 * never writes back to the manifest (open question §12.3 — left as a
 * future explicit action).
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PERSONAL_MANIFEST_GREETING_ONLY,
  PERSONA_VOICE_ONLY_PERSONAL,
  PERSONA_DISABLED_CODE,
  PERSONA_DISABLED_MESSAGE,
  PresenterLookRow,
  personaEnabled,
  presenterLookProblem,
  presenterProviderProblem,
  presenterSnapshotFrom,
} from '../../common/greeting-persona';
import { PRESENTER_LOOK_INCLUDE } from '../greeting-brief/greeting-brief.service';
import { isPersonaVoice } from '../user-voices/persona-voice';
import { assertGreetingNotRendering } from '../../common/greeting-render-lock';
import { writeWithGreetingRestamp } from '../greeting-session-edit/restamp';
import type { GreetingPresenterVariant } from '../../common/types/greeting.types';
import { PrismaService } from '../../prisma/prisma.service';
import { sessionData, SessionService } from '../../common/session.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { PlanService } from '../plan/plan.service';
import { Session } from '../../common/types/session.types';
import { BrandManifestSnapshot } from '../../common/types/brand-manifest.types';
import {
  brandManifestSnapshotFrom,
  greetingBriefSnapshotFrom,
  productInformationFromItem,
  SnapshotGreetingBriefSource,
  SnapshotItemSource,
  SnapshotManifestSource,
  SnapshotProjectSource,
} from './snapshot';
import { UpdateBrandSnapshotRequestDto } from './dto/update-brand-snapshot.dto';
import {
  SESSION_NOT_FOUND,
  PROJECT_NOT_FOUND,
} from '../../common/user-facing-errors';

/** Structural row shapes (see project.service.ts for why not Prisma types). */
interface ItemWithProjectRow extends SnapshotItemSource {
  projectId: string;
  project: SnapshotProjectSource & {
    id: string;
    brandManifest: SnapshotManifestSource | null;
  };
}

/** Structural row for a GREETING_VIDEO project's brief + its own project. */
interface GreetingBriefWithProjectRow extends SnapshotGreetingBriefSource {
  project: SnapshotProjectSource & {
    id: string;
    type: string;
    deletedAt: Date | null;
  };
  /** GreetingBrief's OWN brand manifest (§5.4 — CORPORATE branding),
   * distinct from `Project.brandManifestId`: a greeting can carry a
   * sender's company brand without the project itself being tagged with
   * one. See `CreateGreetingBriefDto.brandManifestId` vs
   * `CreateProjectRequestDto.brandManifestId`. */
  brandManifest: SnapshotManifestSource | null;
  /** Этап G (§4.8): образ-ведущий — проверяется и копируется в снимок. */
  presenterLook?: PresenterLookRow | null;
}

interface SessionListRow {
  id: string;
  status: string;
  createdAt: Date;
  lastActivityAt: Date;
  data: unknown;
  /** Этап 122: вторая колонка сессии, см. `sessionData`. Обязательна —
   * иначе выборка без неё компилируется молча, а ролики пропадают. */
  liveData: unknown;
}

/** Row of GET /projects/:id/items/:itemId/sessions — history, not the full Session. */
export interface ItemSessionSummary {
  sessionId: string;
  status: string;
  createdAt: string;
  lastActivityAt: string;
  /** Public URL of the finished video, when the run got that far. */
  videoUrl: string | null;
  hasBrandManifest: boolean;
}

@Injectable()
export class ProjectSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly ttsResolver: TtsProviderResolverService,
    private readonly plans: PlanService,
  ) {}

  /**
   * POST /projects/:projectId/items/:itemId/sessions
   * Ownership is checked through the parent project, like every item
   * route in ProjectService.
   */
  async createFromItem(
    userId: string,
    projectId: string,
    itemId: string,
    /** UI-локаль фронтенда (этап 59, ТЗ §35.5) — см. SessionService.createSession. */
    locale?: string,
  ): Promise<Session> {
    // `deletedAt: null` (этап 89, найдено доп. аудитом): без него можно
    // было запустить новую сессию генерации от мягко удалённого товара
    // весь грейс-период — тот же класс дыры, что и в ProductAnalogService.
    const item: ItemWithProjectRow | null =
      await this.prisma.productItem.findFirst({
        where: {
          id: itemId,
          projectId,
          deletedAt: null,
          project: { userId, deletedAt: null },
        },
        include: {
          // `activeSketch` — применённый ИИ-скетч слота: снимок должен
          // заморозить именно его, иначе сессия увезёт оригинал, который
          // пользователь уже подменил (§4 п.8 doc/AI-SKETCH-SPEC.md).
          activeSketch: true,
          project: {
            include: {
              brandManifest: {
                include: {
                  characters: {
                    orderBy: { createdAt: 'asc' as const },
                    include: { activeSketch: true },
                  },
                  scenes: {
                    orderBy: { createdAt: 'asc' as const },
                    include: { activeSketch: true },
                  },
                },
              },
            },
          },
        },
      });
    if (!item) {
      throw new NotFoundException(
        `Item ${itemId} not found in project ${projectId}`,
      );
    }

    const now = new Date();
    const manifest = item.project.brandManifest;
    // CONTRACT5 п.5в: личный бренд-бук — только у поздравлений. Привязку
    // к товарному проекту сервис проекта уже не пропускает; здесь — на
    // случай строк, привязанных до этой проверки.
    if (manifest?.kind === 'PERSONAL') {
      throw new BadRequestException(PERSONAL_MANIFEST_GREETING_ONLY);
    }
    return this.sessions.createSession(
      userId,
      {
        projectId: item.project.id,
        productItemId: item.id,
        productInformation: productInformationFromItem(item, item.project, now),
        ...(manifest
          ? { brandManifestSnapshot: brandManifestSnapshotFrom(manifest, now) }
          : {}),
      },
      locale,
    );
  }

  /**
   * POST /projects/:projectId/greeting-brief/sessions (ТЗ
   * TZ-Greeting-Video-Project-Type.md §4.3) — the GREETING_VIDEO
   * counterpart of `createFromItem` above: no ProductItem exists for this
   * project type, so the Session is seeded from its `GreetingBrief`
   * instead.
   *
   * Not literally the route the ТЗ's §8 table lists (it lists only the
   * two brief CRUD routes and says "everything else — existing routes,
   * unchanged") — but no existing route creates a Session without a
   * ProductItem in this codebase; `CLIENT_SITE` doesn't go through
   * ProjectSessionService at all (it has its own tutorial-runner
   * pipeline). This route is this ТЗ's necessary, if implicit, addition.
   */
  async createFromGreetingBrief(
    userId: string,
    projectId: string,
    locale?: string,
  ): Promise<Session> {
    const brief: GreetingBriefWithProjectRow | null =
      await this.prisma.greetingBrief.findFirst({
        where: { projectId, project: { userId, deletedAt: null } },
        include: {
          project: {
            select: {
              id: true,
              type: true,
              deletedAt: true,
              title: true,
              currency: true,
              countryCode: true,
            },
          },
          brandManifest: {
            include: {
              characters: {
                orderBy: { createdAt: 'asc' as const },
                include: { activeSketch: true },
              },
              scenes: {
                orderBy: { createdAt: 'asc' as const },
                include: { activeSketch: true },
              },
            },
          },
          presenterLook: { include: PRESENTER_LOOK_INCLUDE },
        },
      });
    if (!brief) {
      throw new NotFoundException(
        `Greeting brief not found for project ${projectId}`,
      );
    }
    // Не должно случиться при обычном флоу (бриф создаётся только вместе
    // с GREETING_VIDEO-проектом, §4.1), но проект тип мог сменить PATCH
    // /projects/:id (ProjectService.updateProject допускает смену type) —
    // защита от рассинхрона, а не догадка.
    if (brief.project.type !== 'GREETING_VIDEO') {
      throw new NotFoundException(
        `Project ${projectId} is not a GREETING_VIDEO project`,
      );
    }

    // Этап G (§4.8): образ-ведущий копируется в снимок. Проверка — та же,
    // что при выборе в брифе, и отказ, а не тихая замена на ИИ-ведущего:
    // образ могли удалить, режим — выключить, а человек выбирал себя.
    let presenter = null;
    if (brief.presenterLookId) {
      if (!personaEnabled()) {
        throw new BadRequestException({
          code: PERSONA_DISABLED_CODE,
          message: `${PERSONA_DISABLED_MESSAGE} Выберите ИИ-ведущего в брифе.`,
        });
      }
      const variant: GreetingPresenterVariant =
        brief.presenterVariant === 'sketch' ? 'sketch' : 'photo';
      const problem =
        presenterLookProblem(brief.presenterLook, variant, userId) ??
        presenterProviderProblem(
          brief.presenterProvider === 'hedra' ? 'hedra' : 'grok',
          variant,
        );
      if (problem) throw new BadRequestException(problem);
      presenter = presenterSnapshotFrom(brief.presenterLook!, variant);
    }

    const now = new Date();
    const manifest = brief.brandManifest;
    return this.sessions.createSession(
      userId,
      {
        projectId: brief.project.id,
        greetingBriefSnapshot: greetingBriefSnapshotFrom(brief, now, {
          presenter,
          manifest,
        }),
        ...(manifest
          ? { brandManifestSnapshot: brandManifestSnapshotFrom(manifest, now) }
          : {}),
      },
      locale,
    );
  }

  /** GET /projects/:projectId/items/:itemId/sessions — newest first. */
  async listForItem(
    userId: string,
    projectId: string,
    itemId: string,
  ): Promise<ItemSessionSummary[]> {
    const owned = await this.prisma.productItem.findFirst({
      where: {
        id: itemId,
        projectId,
        deletedAt: null,
        project: { userId, deletedAt: null },
      },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException(
        `Item ${itemId} not found in project ${projectId}`,
      );
    }
    // Найдено доп. аудитом (MEDIUM, этап 89): единственная выборка Session
    // в проекте без `deletedAt: null` — без этого фильтра мягко удалённая
    // сессия (со своим видео/ссылкой на скачивание) снова появлялась бы
    // здесь на весь grace-период. Сравни SessionService.getSession,
    // AdminPanelService.getSession, postprod-video-summary.ts —
    // у всех фильтр есть.
    const rows: SessionListRow[] = await this.prisma.session.findMany({
      where: { productItemId: itemId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        lastActivityAt: true,
        data: true,
        liveData: true,
      },
    });
    return rows.map(toSummary);
  }

  /**
   * GET /projects/:projectId/greeting-brief/sessions — newest first.
   * §8 ТЗ doesn't list this route either (see `createFromGreetingBrief`'s
   * doc-comment on the same gap for POST); without it a returning creator
   * has no way to resume a GREETING_VIDEO session they already started —
   * every other project type has an equivalent list route, and this one
   * would be the only one silently missing it.
   */
  async listForGreetingBrief(
    userId: string,
    projectId: string,
  ): Promise<ItemSessionSummary[]> {
    const owned = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null, type: 'GREETING_VIDEO' },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException(PROJECT_NOT_FOUND);
    }
    const rows: SessionListRow[] = await this.prisma.session.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        lastActivityAt: true,
        data: true,
        liveData: true,
      },
    });
    return rows.map(toSummary);
  }

  /**
   * PATCH /sessions/:sessionId/brand-manifest — edit THIS session's copy.
   * 404 when the session has no snapshot: there is nothing to edit, and
   * silently inventing one would hide a client bug (a project-less session
   * has no manifest to start from).
   */
  async updateSnapshot(
    sessionId: string,
    dto: UpdateBrandSnapshotRequestDto,
  ): Promise<BrandManifestSnapshot> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }
    if (!session.brandManifestSnapshot) {
      throw new NotFoundException(
        'у этой сессии нет снимка брендбука — править нечего',
      );
    }
    // CONTRACT6 п.2: голос и оформление поздравления читаются рендером из
    // снимка — посреди рендера их не менять. Только у поздравления:
    // товарная ветка этим маршрутом правит голос у ГОТОВОГО ролика
    // перед переозвучкой, и её поведение волна не трогает.
    if (session.greetingBriefSnapshot) {
      assertGreetingNotRendering(session);
    }
    // Доп. запрос владельца продукта: дубляж — премиальный уровень
    // озвучки (см. тот же гейт в brand-manifest.service.ts). Правка
    // снимка — тоже активный выбор voiceMode, а не то же самое, что
    // «манифест уже существует» — проверяем тариф ЗДЕСЬ, а не только
    // при создании манифеста. Только переход В dub, не пересылку уже
    // выставленного значения — та же причина, что в
    // brand-manifest.service.ts: форма шлёт текущий voiceMode при
    // каждом сохранении.
    if (
      dto.voiceMode === 'dub' &&
      session.brandManifestSnapshot.voiceMode !== 'dub'
    ) {
      await this.plans.assertUser(session.userId, 'voiceDub');
    }
    // Шестой аудит, Е-4.1: тот же дословный дефект и тот же приём, что в
    // brand-manifest.service.ts (см. её доккомментарий) — принадлежит ли
    // voiceId СВОЕМУ клону на Resemble, а не активному на стенде
    // TTS_PROVIDER. Анонимная сессия (`session.userId` нет) клонов не
    // имеет — запрос не нужен.
    const voiceId = dto.ttsVoiceId?.trim();
    const personaVoice =
      !!voiceId &&
      !!session.userId &&
      (await isPersonaVoice(this.prisma, session.userId, voiceId));
    // CONTRACT5 п.5а: клон голоса персоны — только в личном бренд-буке.
    // Первым: в корпоративном его нельзя и при включённом режиме.
    if (personaVoice && session.brandManifestSnapshot.kind !== 'PERSONAL') {
      throw new BadRequestException(PERSONA_VOICE_ONLY_PERSONAL);
    }
    // CONTRACT6 п.5: голос персоны — часть режима «Я в кадре»; при
    // выключенном режиме его не назначить и в личный бренд-бук (как у
    // голоса отправителя, `GreetingVoiceService.resolveOwnClone`).
    if (personaVoice && !personaEnabled()) {
      throw new BadRequestException({
        code: PERSONA_DISABLED_CODE,
        message: PERSONA_DISABLED_MESSAGE,
      });
    }
    const isResembleClone =
      !!voiceId && !!session.userId
        ? !!(await this.prisma.userVoice.findFirst({
            where: { userId: session.userId, resembleVoiceId: voiceId },
            select: { id: true },
          }))
        : false;
    const tts = await this.ttsResolver.resolve();
    const next = applySnapshotEdit(
      session.brandManifestSnapshot,
      dto,
      tts.providerKey,
      isResembleClone,
    );
    // М-2.6/М-7.1 седьмого аудита: режим озвучки и субтитры входят в
    // бриф промпта (`voiceModeBriefText`: «никто не говорит в кадре» при
    // своём голосе). Одобренный промпт, собранный под прежний режим,
    // после смены обязан потерять одобрение ЗДЕСЬ, на сервере — а не
    // полагаться на то, что клиент успешно вызовет пересборку вторым
    // запросом (GPT 429/таймаут оставлял старое одобрение, и
    // «Сгенерировать» проходило с несогласованными брифом и озвучкой).
    // Та же семантика, что у `PromptService.updatePrompt`/`applyFix`.
    const briefChanged =
      (dto.voiceMode !== undefined &&
        dto.voiceMode !== session.brandManifestSnapshot.voiceMode) ||
      (dto.subtitlesMode !== undefined &&
        dto.subtitlesMode !== session.brandManifestSnapshot.subtitlesMode);
    const resetApproval =
      briefChanged && session.generationPrompt?.approvedAt
        ? {
            generationPrompt: {
              ...session.generationPrompt,
              approvedAt: undefined,
            },
          }
        : {};
    // CONTRACT6 (регрессия аудита): у поздравления режим озвучки входит в
    // отпечаток сценария — смена режима без перештамповки делала рендер
    // невозможным («сценарий устарел»). Пишем под замком 'prompt' по
    // перечитанному снимку и перештамповываем сценарий той же записью;
    // снятие одобрения поздравлению не нужно — рендер смотрит на
    // модерацию и отпечаток, а не на `approvedAt`.
    const updated = session.greetingBriefSnapshot
      ? await writeWithGreetingRestamp(this.sessions, sessionId, (fresh) => ({
          brandManifestSnapshot: fresh.brandManifestSnapshot
            ? applySnapshotEdit(
                fresh.brandManifestSnapshot,
                dto,
                tts.providerKey,
                isResembleClone,
              )
            : next,
        }))
      : await this.sessions.updateSession(sessionId, {
          brandManifestSnapshot: next,
          ...resetApproval,
        });
    if (!updated?.brandManifestSnapshot) {
      throw new NotFoundException(SESSION_NOT_FOUND);
    }
    return updated.brandManifestSnapshot;
  }
}

/**
 * Pure merge — exported for the unit test. `activeProviderKey` —
 * `TtsProvider.providerKey` активного на стенде провайдера
 * (doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md §4.2), передаётся вызывающим
 * (у которого есть DI), а не читается здесь — эта функция намеренно
 * остаётся чистой (без Nest-инъекций) для юнит-теста в изоляции.
 *
 * До этапа 91 клиент не решал, какой провайдер сейчас активен, и не
 * присылал `ttsProvider` в DTO вовсе — тег всегда выводился сервером
 * (клон → `resemble`, иначе активный на стенде). Этап 91 (доп. запрос
 * владельца продукта — явный выбор провайдера в `RevoicePanel`, «и
 * только если человеку подходит — жмёт переозвучить») добавил
 * `dto.ttsProvider`: явный выбор одного из настоящих провайдеров
 * синтеза (изначально `elevenlabs`/`resemble`, с 29.09.2026 и `soniox`
 * — `EXPLICIT_TTS_PROVIDER_KEYS`; DTO не пропускает `'veo'`, см. её
 * доккомментарий) для ОДНОЙ сессии, в обход платформенного дефолта —
 * тот же смысл, что `resolveByKey` уже даёт `/tts/voices`/`/tts/preview`
 * (см. их доккомментарии), теперь распространённый и на само сохранение
 * тега, который читает `postprod.service.ts` при реальном синтезе.
 * Приоритет тот же, что был у `activeProviderKey`: собственный клон на
 * Resemble — ВСЕГДА `resemble` (серверный факт из БД, не клиентская
 * догадка), иначе — явный выбор клиента, если он есть, иначе — прежнее
 * поведение (активный на стенде).
 */
export function applySnapshotEdit(
  current: BrandManifestSnapshot,
  dto: UpdateBrandSnapshotRequestDto,
  activeProviderKey: string,
  // Шестой аудит, Е-4.1 — тот же смысл, что у `manifestDataFromDto` в
  // brand-manifest.service.ts (см. её доккомментарий): вызывающий решает
  // ДО вызова, чтобы функция осталась чистой для юнит-теста в изоляции.
  isResembleClone = false,
  now: Date = new Date(),
): BrandManifestSnapshot {
  return {
    ...current,
    ...(dto.styleNotes !== undefined ? { styleNotes: dto.styleNotes } : {}),
    ...(dto.voiceNotes !== undefined ? { voiceNotes: dto.voiceNotes } : {}),
    ...(dto.voiceMode !== undefined ? { voiceMode: dto.voiceMode } : {}),
    ...(dto.ttsVoiceId !== undefined
      ? {
          ttsVoiceId: dto.ttsVoiceId,
          ttsProvider: snapshotTtsProvider(
            dto,
            activeProviderKey,
            isResembleClone,
          ),
        }
      : {}),
    ...(dto.ttsModel !== undefined ? { ttsModel: dto.ttsModel } : {}),
    ...(dto.cameraMove !== undefined ? { cameraMove: dto.cameraMove } : {}),
    ...(dto.subtitlesMode !== undefined
      ? { subtitlesMode: dto.subtitlesMode }
      : {}),
    ...(dto.subtitleTheme !== undefined
      ? { subtitleTheme: dto.subtitleTheme }
      : {}),
    ...(dto.filters !== undefined ? { filters: dto.filters } : {}),
    ...(dto.effects !== undefined ? { effects: dto.effects } : {}),
    ...(dto.characters !== undefined
      ? {
          characters: dto.characters.map((c) => {
            // Правка снимка редактирует ЧЕТЫРЕ поля формы; ИИ-скетч и
            // признак удалённого оригинала формой не управляются и
            // должны пережить сохранение — иначе активным снова
            // становится оригинал (аудит A-11).
            const kept = c.sourceCharacterId
              ? current.characters.find(
                  (p) => p.sourceCharacterId === c.sourceCharacterId,
                )
              : undefined;
            // Форма показывает АКТИВНОЕ изображение: если это скетч и
            // клиент вернул его URL, канонический URL оригинала терять
            // нельзя — иначе «Вернуть оригинал» ведёт в никуда.
            const echoedSketch =
              !!kept?.sketch && c.photoUrl === kept.sketch.url;
            return {
              sourceCharacterId: c.sourceCharacterId ?? null,
              label: c.label,
              photoUrl: echoedSketch
                ? (kept?.photoUrl ?? null)
                : (c.photoUrl ?? null),
              description: c.description ?? null,
              ...(kept?.sketch ? { sketch: kept.sketch } : {}),
              ...(kept?.originalDeleted ? { originalDeleted: true } : {}),
            };
          }),
        }
      : {}),
    editedAt: now.toISOString(),
    // Форма шлёт голос при каждом сохранении — отметка ставится только
    // при реальной смене, иначе правка стиля «замораживала» бы голос.
    // Явно выбранный тег тоже голос: «Soniox по умолчанию» и «голоса
    // нет» — оба с `ttsVoiceId: null`, и без сравнения тега такая смена
    // не ставила бы отметку — перед рендером `syncSnapshotVoice` молча
    // вернул бы голос бренда поверх выбора человека. Только при явном
    // `dto.ttsProvider`: старый клиент тег не шлёт, и выведенный сервером
    // тег (смена активного провайдера стенда) не должен «замораживать»
    // голос при правке стиля.
    ...((dto.ttsVoiceId !== undefined &&
      ((dto.ttsVoiceId ?? null) !== (current.ttsVoiceId ?? null) ||
        (dto.ttsProvider !== undefined &&
          // Свой клон при том же voiceId — итоговый тег всегда
          // 'resemble': эхо исторически неверного тега (этапы 73–76)
          // голоса не меняет и не должно отключать автообновление из
          // бренда (`syncSnapshotVoice`).
          !isResembleClone &&
          snapshotTtsProvider(dto, activeProviderKey, isResembleClone) !==
            (current.ttsProvider ?? null)))) ||
    (dto.ttsModel !== undefined &&
      (dto.ttsModel ?? null) !== (current.ttsModel ?? null))
      ? { voiceEditedAt: now.toISOString() }
      : {}),
  };
}

/**
 * Тег провайдера для правки голоса снимка. §4.2 + Е-4.1: свой клон на
 * Resemble — безусловно 'resemble'; этап 91: иначе явный выбор клиента
 * (`dto.ttsProvider`), иначе — активный на стенде. Голос очищен (null) —
 * тег тоже не нужен, КРОМЕ явного Soniox: у него есть голос по
 * умолчанию (`SONIOX_TTS_VOICE`/Maya, `SonioxTtsService.defaultVoice`),
 * и `{ ttsProvider: 'soniox', ttsVoiceId: null }` — осознанный выбор
 * этого голоса, а не «голоса нет». У elevenlabs/resemble без voiceId
 * синтеза нет — там тег по-прежнему очищается.
 */
function snapshotTtsProvider(
  dto: UpdateBrandSnapshotRequestDto,
  activeProviderKey: string,
  isResembleClone: boolean,
): string | null {
  if (!dto.ttsVoiceId) return dto.ttsProvider === 'soniox' ? 'soniox' : null;
  if (isResembleClone) return 'resemble';
  return dto.ttsProvider ?? activeProviderKey;
}

function toSummary(row: SessionListRow): ItemSessionSummary {
  const data = sessionData(row);
  const video = data.generatedVideo as { downloadUrl?: string } | null;
  return {
    sessionId: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    videoUrl: video?.downloadUrl ?? null,
    hasBrandManifest: !!data.brandManifestSnapshot,
  };
}
