/**
 * GreetingReferenceService — reference images for Grok reference-to-video
 * on GREETING_VIDEO sessions (доп. запрос пользователя к ТЗ
 * TZ-Greeting-Video-Project-Type.md: «дать возможность подгрузить
 * референс-кадр и ещё несколько изображений, до 7 — предел Grok, со
 * скетч-режимом как у остальных изображений проекта»).
 *
 * Deliberately its OWN small module, not a branch inside
 * `ReferenceAssetsService` (scenes/§17): that service's `createUploadUrl`/
 * `putSlots` gate behind `plans.assertUser(..., 'referenceAssets')`,
 * which is `false` on LITE (`common/plans.ts`). §7 ТЗ is explicit that
 * GREETING_VIDEO itself is available on every tariff — only
 * `presenterProvider`/`resolution` are capped by plan (see
 * `modules/project/greeting-config.ts`). Reusing the Standard+ gate here
 * would silently reintroduce a tier restriction nothing in the ТЗ or the
 * follow-up request asked for. So this module has no plan gate beyond
 * session ownership (the `/sessions/*` convention: the session UUID
 * itself is the bearer secret, see `ReferenceAssetsService`'s neighbours).
 *
 * Storage shape reuses `SceneAsset` (see `Session.greetingReferenceImages`
 * doc-comment) so the existing `activeSessionSceneImage()` helper
 * (`common/active-image.ts`) already picks sketch-vs-original correctly
 * for `GreetingVideoService` without any new helper.
 */

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { randomBytes } from 'crypto';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { SceneAsset } from '../../common/types/reference.types';
import { activeSessionSceneImage } from '../../common/active-image';
import { GreetingReferenceImageView } from '../../common/types/greeting.types';
import {
  GreetingReferenceConfirmRequestDto,
  GreetingReferenceUpdateRequestDto,
  GreetingReferenceUploadUrlRequestDto,
} from './dto/greeting-reference.dto';
import { SketchGeneratorService } from '../image-sketch/sketch-generator.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { buildGreetingFramePrompt } from './greeting-frame-prompt';
import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from '../../common/celebrity-likeness';

/**
 * Тот же приём, что `ReferenceSlotsPanel` получает от `ReferenceCandidate`
 * на фронтенде: наружу отдаём уже РАЗРЕШЁННОЕ активное изображение
 * (оригинал или применённый скетч), а не сырой `photoUrl` — фронтенду не
 * нужно (и не должно) самому знать правило выбора между ними.
 */
function toView(image: SceneAsset): GreetingReferenceImageView {
  const active = activeSessionSceneImage(image);
  return {
    id: image.id,
    label: image.label,
    description: image.description,
    photoUrl: active?.url ?? image.photoUrl,
    variant: active?.variant ?? 'original',
    originalPhotoUrl: image.originalDeleted ? null : image.photoUrl,
    originalDeleted: image.originalDeleted === true,
    createdAt: image.createdAt,
  };
}

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** docs.x.ai reference-to-video: до 7 `reference_images` за один запрос. */
export const MAX_GREETING_REFERENCE_IMAGES = 7;

/** Подпись сгенерированного кадра — по ней он отличим от загруженного
 * и в списке, и в поддержке, когда человек спросит «откуда это». */
export const GENERATED_FRAME_LABEL = 'Сгенерированный кадр';

export function newGreetingReferenceId(): string {
  return `gr_${randomBytes(6).toString('hex')}`;
}

export function greetingReferencePathname(
  sessionId: string,
  imageId: string,
  mimeType: string,
): string {
  return `sessions/${sessionId}/greeting-refs/${imageId}/photo.${
    mimeType === 'image/png' ? 'png' : 'jpg'
  }`;
}

@Injectable()
export class GreetingReferenceService {
  constructor(
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly frames: SketchGeneratorService,
    private readonly aiUsage: AiUsageService,
  ) {}

  async list(sessionId: string): Promise<GreetingReferenceImageView[]> {
    const images = (await this.load(sessionId)).greetingReferenceImages ?? [];
    return images.map(toView);
  }

  async createUploadUrl(
    sessionId: string,
    dto: GreetingReferenceUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; imageId: string }> {
    const session = await this.load(sessionId);
    if (!session.greetingBriefSnapshot) {
      throw new BadRequestException(
        'This session has no greeting brief — reference images only apply to GREETING_VIDEO sessions.',
      );
    }
    const current = session.greetingReferenceImages ?? [];
    if (current.length >= MAX_GREETING_REFERENCE_IMAGES) {
      throw new BadRequestException(
        `At most ${MAX_GREETING_REFERENCE_IMAGES} reference images per session (Grok reference-to-video limit) — delete one first`,
      );
    }
    const imageId = newGreetingReferenceId();
    const pathname = greetingReferencePathname(sessionId, imageId, dto.mimeType);
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_PHOTO_BYTES,
    );
    return { uploadUrl, pathname, imageId };
  }

  async confirm(
    sessionId: string,
    dto: GreetingReferenceConfirmRequestDto,
  ): Promise<GreetingReferenceImageView[]> {
    const session = await this.load(sessionId);
    const prefix = `sessions/${sessionId}/greeting-refs/`;
    if (!dto.pathname.startsWith(prefix)) {
      throw new BadRequestException(`pathname must start with "${prefix}"`);
    }
    const imageId = dto.pathname.slice(prefix.length).split('/')[0];
    const images = session.greetingReferenceImages ?? [];
    if (images.some((s) => s.id === imageId)) {
      throw new BadRequestException(
        `Reference image ${imageId} already confirmed`,
      );
    }
    if (images.length >= MAX_GREETING_REFERENCE_IMAGES) {
      throw new BadRequestException(
        `At most ${MAX_GREETING_REFERENCE_IMAGES} reference images per session`,
      );
    }
    let url: string;
    try {
      url = (await head(dto.pathname)).url;
    } catch (e) {
      throw new BadRequestException(
        `Reference photo not found in storage at "${dto.pathname}" — upload it first (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const image: SceneAsset = {
      id: imageId,
      label: dto.label.trim(),
      description: dto.description?.trim() || null,
      photoUrl: url,
      photoPathname: dto.pathname,
      createdAt: new Date().toISOString(),
    };
    const next = [...images, image];
    await this.sessions.updateSession(sessionId, {
      greetingReferenceImages: next,
    });
    return next.map(toView);
  }

  /**
   * Нарисовать референс-кадр по брифу сессии — фича №6 компаньон-ТЗ.
   *
   * Кадр ложится в тот же список, что и загруженные человеком, и дальше
   * идёт в Grok как родной `reference_images` — `GreetingVideoService`
   * об этой фиче не знает вовсе и правок не потребовал.
   *
   * Потолок — тот же `MAX_GREETING_REFERENCE_IMAGES` (предел Grok), и
   * отдельной квоты у фичи нет НАМЕРЕННО. Семь картинок на сессию —
   * это уже потолок расхода, а заводить второй счётчик поверх
   * существующего значило бы городить ограничение, которое ничего не
   * ограничивает сверх первого. Зато расход пишется в `AiUsage`
   * отдельной операцией (`greeting-frame`): себестоимость целого типа
   * проекта должна быть видна в отчёте строкой, а не растворяться в
   * «ИИ-скетче».
   *
   * Три исхода модели различаются так же, как у скетча, и по той же
   * причине: `failed` — вызов не оплачен, расход не пишем; `refused` —
   * оплачен, пишем, и говорим человеку понятным текстом, что модель
   * отказалась рисовать, а не «ошибка 500».
   */
  async generateFrame(
    sessionId: string,
    userId: string | null,
  ): Promise<GreetingReferenceImageView[]> {
    const session = await this.load(sessionId);
    const brief = session.greetingBriefSnapshot;
    if (!brief) {
      throw new BadRequestException(
        'Session has no greeting brief — reference frame generation is only for GREETING_VIDEO sessions',
      );
    }
    const images = session.greetingReferenceImages ?? [];
    if (images.length >= MAX_GREETING_REFERENCE_IMAGES) {
      throw new BadRequestException(
        `At most ${MAX_GREETING_REFERENCE_IMAGES} reference images per session — delete one first`,
      );
    }

    // Фича №35 и здесь, а не только на сборке сценария: свой повод
    // (`customOccasionText`) — единственный пользовательский текст,
    // который доходит до МОДЕЛИ ИЗОБРАЖЕНИЙ, и «в образе Пугачёвой» в
    // нём уехало бы в картинку в обход гейта на сценарии.
    const likeness = findCelebrityLikeness(brief.customOccasionText);
    if (likeness) {
      throw new BadRequestException(celebrityLikenessMessage(likeness));
    }

    const prompt = buildGreetingFramePrompt({
      occasion: brief.occasion,
      customOccasionText: brief.customOccasionText,
      tone: brief.tone,
      presenter: brief.resolvedPresenterProvider,
    });
    const outcome = await this.frames.generate({ prompt, source: null });

    if (outcome.status === 'failed') {
      throw new HttpException(
        `Не удалось нарисовать кадр: ${outcome.reason}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.aiUsage.recordGemini(outcome.raw, {
      operation: 'greeting-frame',
      model: outcome.model,
      sessionId,
      ...(userId ? { userId } : {}),
    });
    if (outcome.status === 'refused') {
      throw new HttpException(
        'Модель отказалась рисовать этот кадр. Попробуйте ещё раз или загрузите своё изображение.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Те же помощники, что у загрузки: формат идентификатора и путь в
    // хранилище обязаны совпадать, иначе уборка блобов
    // (`sessionBlobPathnames`) и разбор пути в `confirm` начнут видеть
    // два разных соглашения.
    const imageId = newGreetingReferenceId();
    const pathname = greetingReferencePathname(
      sessionId,
      imageId,
      outcome.mimeType,
    );
    const { url } = await this.blob.uploadBuffer(
      pathname,
      outcome.bytes,
      outcome.mimeType,
    );
    const image: SceneAsset = {
      id: imageId,
      label: GENERATED_FRAME_LABEL,
      description: null,
      photoUrl: url,
      photoPathname: pathname,
      createdAt: new Date().toISOString(),
    };
    const next = [...images, image];
    await this.sessions.updateSession(sessionId, {
      greetingReferenceImages: next,
    });
    return next.map(toView);
  }

  async update(
    sessionId: string,
    imageId: string,
    dto: GreetingReferenceUpdateRequestDto,
  ): Promise<GreetingReferenceImageView[]> {
    const session = await this.load(sessionId);
    const images = session.greetingReferenceImages ?? [];
    if (!images.some((s) => s.id === imageId)) {
      throw new NotFoundException(`Reference image ${imageId} not found`);
    }
    const next = images.map((s) =>
      s.id === imageId
        ? {
            ...s,
            ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
          }
        : s,
    );
    await this.sessions.updateSession(sessionId, {
      greetingReferenceImages: next,
    });
    return next.map(toView);
  }

  /** Removes the image, its blob (best effort). */
  async remove(sessionId: string, imageId: string): Promise<GreetingReferenceImageView[]> {
    const session = await this.load(sessionId);
    const images = session.greetingReferenceImages ?? [];
    const image = images.find((s) => s.id === imageId);
    if (!image) throw new NotFoundException(`Reference image ${imageId} not found`);
    const next = images.filter((s) => s.id !== imageId);
    await this.sessions.updateSession(sessionId, {
      greetingReferenceImages: next,
    });
    void this.blob.deleteBlob(image.photoPathname).catch(() => undefined);
    return next.map(toView);
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
