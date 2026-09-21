/**
 * Адаптеры слотов ИИ-скетча (doc/AI-SKETCH-SPEC.md §6.4).
 *
 * Шесть мест хранят изображение по-разному: три в JSON сессии, три в
 * Prisma. Всё, что различается, живёт здесь; сам сервис оперирует одним
 * интерфейсом и ничего не знает ни про `characterCasting`, ни про
 * `BrandCharacter`.
 *
 * Главное правило адаптера: **путь оригинала берётся ТОЛЬКО отсюда**,
 * из самого слота. Клиент путей не присылает — раньше именно на этом
 * попадались соседние маршруты (§6.8 ТЗ).
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { BlobService } from '../storage/blob.service';
import { Session } from '../../common/types/session.types';
import { PlanFeature } from '../../common/plans';
import {
  SketchRef,
  SketchSlotView,
  SketchTarget,
} from '../../common/types/sketch.types';
import { SketchSlotKind } from '../../common/sketch-prompts';
import { activeRowImage } from '../../common/active-image';

/** Слот, прочитанный со всех сторон сразу: и для генерации, и для UI. */
export interface SketchSlot {
  target: SketchTarget;
  kind: SketchSlotKind;
  /** Кто владеет слотом — он же платит и на него считается квота. */
  userId: string;
  /** Признак тарифа, который даёт доступ К СЛОТУ (не к скетчу). */
  feature: PlanFeature | null;
  /** Оригинал: путь в нашем Blob и публичный URL (что есть). */
  originalPathname: string | null;
  originalUrl: string | null;
  /**
   * Файл оригинала принадлежит ИМЕННО этому слоту. `false` — файл общий
   * (сессия, созданная из товара проекта, показывает файл товара):
   * «Удалить оригинал» в таком слоте снимает только ссылку, сам файл
   * остаётся жить у владельца — §4 п.10 ТЗ, аудит A-4.
   */
  ownsOriginalFile: boolean;
  /** Уже применённый скетч. */
  sketch: SketchRef | null;
  originalDeleted: boolean;
  /** Текст слота — предзаполнение режима «по описанию». */
  description: string | null;
  /** Название товара (для промпта товара). */
  name: string | null;
  /** Сессия — для тех адаптеров, которым она нужна при записи. */
  session?: Session;
}

export function slotView(slot: SketchSlot): SketchSlotView {
  return {
    target: slot.target,
    variant: slot.sketch ? 'sketch' : 'original',
    url: slot.sketch?.url ?? slot.originalUrl,
    sketchId: slot.sketch?.sketchId ?? null,
    originalDeleted: slot.originalDeleted,
  };
}

/** Размер страницы при обходе сессий владельца (пропагация, §4 п.10). */
const PROPAGATION_PAGE = 200;

/**
 * Строка ассета бренда в том объёме, в каком её читает этот модуль.
 * Описана структурно, а не типом Prisma, по той же причине, что и
 * остальные row-типы проекта: файл должен компилироваться без
 * сгенерированного клиента.
 */
interface BrandAssetRow {
  id: string;
  photoUrl: string | null;
  description: string | null;
  activeSketchId: string | null;
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

/**
 * Минимальная форма делегата Prisma для ассетов бренда.
 *
 * Зачем она: `prisma.brandCharacter` и `prisma.brandScene` — два РАЗНЫХ
 * генерик-типа, и тернарник между ними даёт union, вызвать который
 * TypeScript отказывается («This expression is not callable. Each member
 * of the union type … has signatures, but none of those signatures are
 * compatible with each other»). Тот же приём уже применён в
 * `brand-manifest.service.ts` (`AssetDelegate`): описать структурно
 * ровно то, чем пользуемся, и привести через `unknown`.
 *
 * Локальный `tsc` эту ошибку не видит — там, где клиент Prisma не
 * сгенерирован, делегаты имеют тип `any`, и падает только прод-сборка.
 */
interface BrandAssetDelegate {
  findFirst(args: {
    where: Record<string, unknown>;
    include?: Record<string, unknown>;
  }): Promise<BrandAssetRow | null>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<unknown>;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

@Injectable()
export class SketchTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly plans: PlanService,
    private readonly blob: BlobService,
  ) {}

  /**
   * Прочитать слот и проверить владельца. Чужое и несуществующее
   * отвечают одинаково (404) — тот же приём, что у соседних модулей.
   */
  async load(target: SketchTarget, userId: string): Promise<SketchSlot> {
    switch (target.type) {
      case 'session-character':
        return this.loadSessionCharacter(target, userId);
      case 'session-product':
        return this.loadSessionProduct(target, userId);
      case 'session-scene':
        return this.loadSessionScene(target, userId);
      case 'session-greeting-reference':
        return this.loadSessionGreetingReference(target, userId);
      case 'brand-character':
      case 'brand-scene':
        return this.loadBrandAsset(target, userId);
      case 'project-item':
        return this.loadProjectItem(target, userId);
      default:
        throw new BadRequestException(`Неизвестный тип слота: ${target.type}`);
    }
  }

  /** Тариф слота: скетч не должен открывать доступ к тому, что закрыто. */
  async assertSlotAccess(slot: SketchSlot): Promise<void> {
    if (slot.feature) {
      await this.plans.assertUser(slot.userId, slot.feature);
    }
  }

  /** Байты оригинала — только по пути из самого слота. */
  async readOriginal(slot: SketchSlot): Promise<Buffer> {
    if (!slot.originalPathname) {
      throw new BadRequestException(
        'У этого слота нет своего файла — сделайте скетч по описанию',
      );
    }
    return this.blob.downloadBuffer(slot.originalPathname);
  }

  /** Записать применённый скетч в слот (или снять его, если `null`). */
  async writeActive(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean } = {},
  ): Promise<SketchSlot> {
    switch (slot.target.type) {
      case 'session-character':
        await this.writeSessionCharacter(slot, sketch, opts);
        break;
      case 'session-product':
        await this.writeSessionProduct(slot, sketch, opts);
        break;
      case 'session-scene':
        await this.writeSessionScene(slot, sketch, opts);
        break;
      case 'session-greeting-reference':
        await this.writeSessionGreetingReference(slot, sketch, opts);
        break;
      case 'brand-character':
        await this.writeBrandAsset('brandCharacter', slot, sketch, opts);
        break;
      case 'brand-scene':
        await this.writeBrandAsset('brandScene', slot, sketch, opts);
        break;
      case 'project-item':
        await this.writeProjectItem(slot, sketch, opts);
        break;
    }
    return this.load(slot.target, slot.userId);
  }

  // ── Сессия ────────────────────────────────────────────────────────

  private async loadSession(sessionId: string, userId: string) {
    const session = await this.sessions.getSession(sessionId);
    if (!session || (session.userId ?? null) !== userId) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return session;
  }

  private async loadSessionCharacter(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const session = await this.loadSession(target.id, userId);
    const cast = (session.characterCasting?.casts ?? []).find(
      (c) => c.characterId === target.subId,
    );
    if (!cast) {
      throw new NotFoundException(
        `Персонаж ${target.subId} не выбран в этой сессии`,
      );
    }
    return {
      target,
      kind: 'character',
      userId,
      feature: 'characterReplacement',
      originalPathname: cast.replacement.photoPathname,
      originalUrl: cast.replacement.photoUrl,
      // `photo` — файл сессии (`sessions/…`), он её и есть; `brand` —
      // общий файл ассета бренда, его сессия удалять не вправе.
      ownsOriginalFile: cast.replacement.kind === 'photo',
      sketch: cast.replacement.sketch ?? null,
      originalDeleted: cast.replacement.originalDeleted === true,
      description: cast.replacement.description,
      name: null,
      session,
    };
  }

  private async writeSessionCharacter(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    const session =
      slot.session ?? (await this.loadSession(slot.target.id, slot.userId));
    const casting = session.characterCasting;
    if (!casting) return;
    const casts = casting.casts.map((c) =>
      c.characterId === slot.target.subId
        ? {
            ...c,
            replacement: {
              ...c.replacement,
              // Персонаж «по описанию» после применения скетча становится
              // полноценным фото-референсом (§6.3 ТЗ): картинка у него
              // теперь есть, пусть и нарисованная.
              kind:
                sketch && c.replacement.kind === 'text'
                  ? ('photo' as const)
                  : c.replacement.kind,
              sketch,
              originalDeleted:
                opts.originalDeleted ?? c.replacement.originalDeleted ?? false,
            },
          }
        : c,
    );
    await this.sessions.updateSession(slot.target.id, {
      characterCasting: {
        ...casting,
        casts,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private async loadSessionProduct(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const session = await this.loadSession(target.id, userId);
    const product = session.productInformation;
    if (!product) {
      throw new NotFoundException('У сессии ещё нет товара');
    }
    return {
      target,
      kind: 'product',
      userId,
      feature: null, // фото товара есть на всех тарифах
      originalPathname: product.productImagePathname ?? null,
      originalUrl: product.productImageUrl ?? null,
      // Сессия, созданная из товара проекта, показывает ФАЙЛ ТОВАРА
      // (`projects/{pid}/items/{iid}/photo.*`). Удалять его отсюда
      // нельзя: он общий для товара, всех его сессий и страниц —
      // аудит A-4.
      ownsOriginalFile: isSessionOwnedPathname(
        product.productImagePathname ?? null,
        target.id,
      ),
      sketch: product.sketch ?? null,
      originalDeleted: product.originalDeleted === true,
      description: product.productDescription ?? null,
      name: product.productName ?? null,
      session,
    };
  }

  private async writeSessionProduct(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    const session =
      slot.session ?? (await this.loadSession(slot.target.id, slot.userId));
    if (!session.productInformation) return;
    await this.sessions.updateSession(slot.target.id, {
      productInformation: {
        ...session.productInformation,
        sketch,
        originalDeleted:
          opts.originalDeleted ??
          session.productInformation.originalDeleted ??
          false,
      },
    });
  }

  private async loadSessionScene(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const session = await this.loadSession(target.id, userId);
    const scene = (session.scenes ?? []).find((s) => s.id === target.subId);
    if (!scene) {
      throw new NotFoundException(`Сцена ${target.subId} не найдена в сессии`);
    }
    return {
      target,
      kind: 'scene',
      userId,
      feature: 'referenceAssets',
      originalPathname: scene.photoPathname,
      originalUrl: scene.photoUrl,
      ownsOriginalFile: isSessionOwnedPathname(scene.photoPathname, target.id),
      sketch: scene.sketch ?? null,
      originalDeleted: scene.originalDeleted === true,
      description: scene.description ?? scene.label,
      name: null,
      session,
    };
  }

  private async writeSessionScene(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    const session =
      slot.session ?? (await this.loadSession(slot.target.id, slot.userId));
    const scenes = (session.scenes ?? []).map((s) =>
      s.id === slot.target.subId
        ? {
            ...s,
            sketch,
            originalDeleted: opts.originalDeleted ?? s.originalDeleted ?? false,
          }
        : s,
    );
    await this.sessions.updateSession(slot.target.id, { scenes });
  }

  /**
   * GREETING_VIDEO — референс-изображение Grok (§ доккомментарий
   * `Session.greetingReferenceImages`). Тот же паттерн, что
   * `loadSessionScene`, только `feature: null`: §7 ТЗ прямо требует
   * GREETING_VIDEO доступным на всех тарифах, а `session-scene` гейтит
   * себя `referenceAssets` (Standard+) — сюда этот гейт протаскивать
   * нельзя.
   */
  private async loadSessionGreetingReference(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const session = await this.loadSession(target.id, userId);
    const image = (session.greetingReferenceImages ?? []).find(
      (s) => s.id === target.subId,
    );
    if (!image) {
      throw new NotFoundException(
        `Референс-изображение ${target.subId} не найдено в сессии`,
      );
    }
    return {
      target,
      kind: 'scene',
      userId,
      feature: null,
      originalPathname: image.photoPathname,
      originalUrl: image.photoUrl,
      ownsOriginalFile: isSessionOwnedPathname(image.photoPathname, target.id),
      sketch: image.sketch ?? null,
      originalDeleted: image.originalDeleted === true,
      description: image.description ?? image.label,
      name: null,
      session,
    };
  }

  private async writeSessionGreetingReference(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    const session =
      slot.session ?? (await this.loadSession(slot.target.id, slot.userId));
    const images = (session.greetingReferenceImages ?? []).map((s) =>
      s.id === slot.target.subId
        ? {
            ...s,
            sketch,
            originalDeleted: opts.originalDeleted ?? s.originalDeleted ?? false,
          }
        : s,
    );
    await this.sessions.updateSession(slot.target.id, {
      greetingReferenceImages: images,
    });
  }

  // ── Бренд и товар проекта (Prisma) ────────────────────────────────

  /** Единственное место приведения — см. комментарий у `BrandAssetDelegate`. */
  private brandDelegate(
    name: 'brandCharacter' | 'brandScene',
  ): BrandAssetDelegate {
    return (name === 'brandCharacter'
      ? this.prisma.brandCharacter
      : this.prisma.brandScene) as unknown as BrandAssetDelegate;
  }

  private async loadBrandAsset(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const isCharacter = target.type === 'brand-character';
    const delegate = this.brandDelegate(
      isCharacter ? 'brandCharacter' : 'brandScene',
    );
    const row = await delegate.findFirst({
      where: {
        id: target.subId ?? '',
        brandManifestId: target.id,
        brandManifest: { userId },
      },
      include: { activeSketch: true },
    });
    if (!row) {
      throw new NotFoundException('Ассет бренда не найден');
    }
    const image = activeRowImage(row);
    return {
      target,
      kind: isCharacter ? 'character' : 'scene',
      userId,
      feature: 'brandManifest',
      // В строке бренда хранится только публичный URL, но файл наш, и
      // путь из URL восстанавливается однозначно. Без этого режим «по
      // фото» у персонажа и сцены бренда всегда отвечал 400 — аудит A-6.
      originalPathname: pathnameFromUrl(row.photoUrl ?? null),
      originalUrl: row.photoUrl ?? null,
      ownsOriginalFile: true,
      sketch:
        image?.variant === 'sketch'
          ? {
              sketchId: row.activeSketchId!,
              url: image.url,
              pathname: image.pathname!,
              mimeType: image.mimeType,
              style: (row.activeSketch?.style ??
                'pencil') as SketchRef['style'],
              sketchRendering: image.sketchRendering ?? 'realistic',
              appliedAt:
                row.activeSketch?.appliedAt?.toISOString() ??
                new Date().toISOString(),
            }
          : null,
      originalDeleted: !!row.originalDeletedAt,
      description: row.description ?? null,
      name: null,
    };
  }

  private async writeBrandAsset(
    delegateName: 'brandCharacter' | 'brandScene',
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    const delegate = this.brandDelegate(delegateName);
    await delegate.update({
      where: { id: slot.target.subId ?? '' },
      data: {
        activeSketchId: sketch?.sketchId ?? null,
        ...(opts.originalDeleted ? { originalDeletedAt: new Date() } : {}),
      },
    });
  }

  private async loadProjectItem(
    target: SketchTarget,
    userId: string,
  ): Promise<SketchSlot> {
    const row = await this.prisma.productItem.findFirst({
      where: { id: target.id, deletedAt: null, project: { userId } },
      include: { activeSketch: true },
    });
    if (!row) {
      throw new NotFoundException(`Item ${target.id} not found`);
    }
    const image = activeRowImage(row);
    return {
      target,
      kind: 'product',
      userId,
      feature: null,
      originalPathname: itemPathnameOf(row.photoUrl),
      originalUrl: row.photoUrl ?? null,
      ownsOriginalFile: true,
      sketch:
        image?.variant === 'sketch'
          ? {
              sketchId: row.activeSketchId!,
              url: image.url,
              pathname: image.pathname!,
              mimeType: image.mimeType,
              style: (row.activeSketch?.style ??
                'pencil') as SketchRef['style'],
              sketchRendering: image.sketchRendering ?? 'realistic',
              appliedAt:
                row.activeSketch?.appliedAt?.toISOString() ??
                new Date().toISOString(),
            }
          : null,
      originalDeleted: !!row.originalDeletedAt,
      description: row.description ?? null,
      name: row.title ?? null,
    };
  }

  private async writeProjectItem(
    slot: SketchSlot,
    sketch: SketchRef | null,
    opts: { originalDeleted?: boolean },
  ): Promise<void> {
    await this.prisma.productItem.update({
      where: { id: slot.target.id },
      data: {
        activeSketchId: sketch?.sketchId ?? null,
        ...(opts.originalDeleted ? { originalDeletedAt: new Date() } : {}),
      },
    });
  }

  /**
   * Ссылки на ЭТОТ ЖЕ файл в других записях (§4 п.10 ТЗ): сессии,
   * созданные из товара, и снимки бренда держат тот же Blob. Пока они не
   * переведены на скетч, удалять оригинал нельзя — иначе повтор рендера,
   * экспорт и опрос готовой сессии упрутся в 404.
   */
  async propagateSketch(
    slot: SketchSlot,
    sketch: SketchRef,
    opts: { originalDeleted?: boolean } = {},
  ): Promise<number> {
    if (slot.target.type === 'project-item') {
      return this.propagateToSessionsOfItem(slot.target.id, sketch, opts);
    }
    if (
      slot.target.type === 'brand-character' ||
      slot.target.type === 'brand-scene'
    ) {
      return this.propagateToSnapshots(slot, sketch, opts);
    }
    if (slot.target.type === 'session-product') {
      return this.propagateToSharedPages(slot.target.id, sketch);
    }
    return 0;
  }

  private async propagateToSessionsOfItem(
    itemId: string,
    sketch: SketchRef,
    opts: { originalDeleted?: boolean },
  ): Promise<number> {
    const sessions = await this.prisma.session.findMany({
      where: { productItemId: itemId, deletedAt: null },
      select: { id: true },
    });
    let updated = 0;
    for (const row of sessions) {
      const session = await this.sessions.getSession(row.id);
      if (!session?.productInformation) continue;
      await this.sessions.updateSession(row.id, {
        productInformation: {
          ...session.productInformation,
          sketch,
          // Без этого в дочерней сессии остаётся кнопка «Вернуть
          // оригинал» на файл, которого уже нет — аудит A-12.
          ...(opts.originalDeleted ? { originalDeleted: true } : {}),
        },
      });
      updated += 1;
      updated += await this.propagateToSharedPages(row.id, sketch);
    }
    return updated;
  }

  /**
   * Снимки бренда во ВСЕХ живых сессиях владельца и brand-замены в их
   * кастинге. Раньше бралось 200 последних сессий — в более старых
   * оставался оригинал (аудит A-12); теперь идём страницами по всем,
   * фильтруя по манифесту прямо в запросе.
   */
  private async propagateToSnapshots(
    slot: SketchSlot,
    sketch: SketchRef,
    opts: { originalDeleted?: boolean },
  ): Promise<number> {
    const isCharacter = slot.target.type === 'brand-character';
    let updated = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.session.findMany({
        where: { userId: slot.userId, deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PROPAGATION_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      for (const row of page) {
        const session = await this.sessions.getSession(row.id);
        const snapshot = session?.brandManifestSnapshot;
        if (!snapshot || snapshot.brandManifestId !== slot.target.id) continue;
        const list = isCharacter
          ? snapshot.characters
          : (snapshot.scenes ?? []);
        let touched = false;
        const next = list.map((entry) => {
          const sourceId = isCharacter
            ? (entry as { sourceCharacterId: string | null }).sourceCharacterId
            : (entry as { sourceSceneId: string | null }).sourceSceneId;
          if (sourceId !== slot.target.subId) return entry;
          touched = true;
          return {
            ...entry,
            sketch,
            ...(opts.originalDeleted ? { originalDeleted: true } : {}),
          };
        });
        if (touched) {
          await this.sessions.updateSession(row.id, {
            brandManifestSnapshot: isCharacter
              ? { ...snapshot, characters: next as typeof snapshot.characters }
              : {
                  ...snapshot,
                  scenes: next as NonNullable<typeof snapshot.scenes>,
                },
          });
          updated += 1;
        }
        if (isCharacter && session) {
          updated += (await this.propagateToCasting(session, slot, sketch))
            ? 1
            : 0;
        }
      }
      if (page.length < PROPAGATION_PAGE) break;
    }
    return updated;
  }

  /**
   * Замены `kind:'brand'` в кастинге держат URL оригинала из снимка —
   * при удалении файла он превратился бы в 404. Активное изображение
   * такой замены резолвится через снимок (`activeCastImage`), но URL
   * всё равно нужно перевести на скетч: он показывается в интерфейсе и
   * проверяется при следующем PUT (аудит A-1/A-12).
   */
  private async propagateToCasting(
    session: Session,
    slot: SketchSlot,
    sketch: SketchRef,
  ): Promise<boolean> {
    const casting = session.characterCasting;
    if (!casting) return false;
    const snapshot = session.brandManifestSnapshot;
    const snap = (snapshot?.characters ?? []).find(
      (c) => c.sourceCharacterId === slot.target.subId,
    );
    if (!snap) return false;
    let touched = false;
    const casts = casting.casts.map((c) => {
      const r = c.replacement;
      if (r.kind !== 'brand') return c;
      const mine =
        (r.brandCharacterId && r.brandCharacterId === slot.target.subId) ||
        (!!r.photoUrl && r.photoUrl === snap.photoUrl);
      if (!mine || r.sketch?.sketchId === sketch.sketchId) return c;
      touched = true;
      return {
        ...c,
        replacement: {
          ...r,
          brandCharacterId: r.brandCharacterId ?? slot.target.subId ?? null,
          sketch,
        },
      };
    });
    if (!touched) return false;
    await this.sessions.updateSession(session.sessionId, {
      characterCasting: {
        ...casting,
        casts,
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  }

  /**
   * Опубликованные страницы шеринга держат СВОЮ копию фото товара
   * (`keepOwnCopy`). Скетч применён — публичная страница обязана
   * показывать его, иначе подмена не доведена до конца (§4 п.11 ТЗ).
   */
  private async propagateToSharedPages(
    sessionId: string,
    sketch: SketchRef,
  ): Promise<number> {
    const pages = await this.prisma.sharedVideoPage.findMany({
      where: { sessionId, productImagePathname: { not: null } },
      select: { id: true, productImagePathname: true },
    });
    let updated = 0;
    for (const page of pages) {
      const url = await this.blob.copyBlob(
        sketch.pathname,
        page.productImagePathname!,
        sketch.mimeType,
      );
      if (!url) continue;
      await this.prisma.sharedVideoPage.update({
        where: { id: page.id },
        data: { productImageUrl: url },
      });
      updated += 1;
    }
    return updated;
  }

  /**
   * Удалить файл оригинала — последним шагом, после пропагации. Слот, у
   * которого файл ОБЩИЙ (`ownsOriginalFile: false`), файл не трогает:
   * там «Удалить оригинал» снимает только ссылку (§4 п.10 ТЗ, аудит
   * A-4). `false` в ответе — «ссылка снята, файл остался».
   */
  async deleteOriginalBlob(slot: SketchSlot): Promise<boolean> {
    const pathname = slot.originalPathname ?? pathnameFromUrl(slot.originalUrl);
    if (!pathname) {
      throw new BadRequestException(
        'У слота нет собственного файла — удалять нечего',
      );
    }
    if (!slot.ownsOriginalFile) return false;
    await this.blob.deleteBlob(pathname);
    return true;
  }
}

/**
 * Файл принадлежит этой сессии? Сессия, созданная из товара проекта,
 * показывает файл товара (`projects/…`), а не свой (`sessions/{id}/…`).
 */
function isSessionOwnedPathname(
  pathname: string | null | undefined,
  sessionId: string,
): boolean {
  if (!pathname) return false;
  return pathname.startsWith(`sessions/${sessionId}/`);
}

/** Публичный Blob-URL → pathname (`https://…/projects/p/items/i/photo.jpg`). */
export function pathnameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    return path || null;
  } catch {
    return null;
  }
}

function itemPathnameOf(photoUrl: string | null): string | null {
  return pathnameFromUrl(photoUrl);
}
