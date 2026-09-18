/**
 * CastingService — persists the user's character decisions for one Session
 * (spec §10; Stage 14 of the plan, backend half). Pure session-data work:
 * no new tables — the casting is part of Session.data, dies with the
 * session, and is read by Stage 15's prompt/generation.
 *
 * Rules enforced here (not trusted from the client):
 *  - a cast may only reference a character the analysis actually found;
 *  - `order` is recomputed from the active casts' relative order and reset
 *    to 0 for inactive ones — it decides the three referenceImage slots
 *    (§10.3), so it must be dense and honest;
 *  - kind=photo may only carry a photo THIS session uploaded (attached
 *    through confirmPhoto, never by URL from the client); kind=brand may
 *    carry a URL, but only one that exists in the session's manifest
 *    snapshot (BrandCharacterSnapshot.photoUrl) — so a client cannot make
 *    Veo fetch an arbitrary image.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { Session } from '../../common/types/session.types';
import {
  CastReplacement,
  CharacterCast,
  CharacterCasting,
  NO_REPLACEMENT,
} from '../../common/types/casting.types';
import {
  CastPhotoConfirmRequestDto,
  CastPhotoUploadUrlRequestDto,
  CharacterCastDto,
  PutCastingRequestDto,
} from './dto/casting.dto';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function castPhotoPathname(
  sessionId: string,
  characterId: string,
  mimeType: string,
): string {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  return `sessions/${sessionId}/characters/${characterId}/photo.${ext}`;
}

/**
 * Pure normalisation of a client list against the session — exported for
 * tests. `existing` supplies session-uploaded photos so a PUT that keeps
 * kind=photo doesn't lose the pathname the client never sees as editable.
 */
export function normaliseCasting(
  session: Pick<Session, 'videoAnalysis' | 'brandManifestSnapshot'>,
  existing: CharacterCasting | undefined,
  dto: PutCastingRequestDto,
  now: Date = new Date(),
): CharacterCasting {
  const known = new Set(
    (session.videoAnalysis?.characters ?? []).map((c) => c.id),
  );
  if (known.size === 0) {
    throw new BadRequestException(
      'The analysis found no characters to cast (or the analysis is not complete yet)',
    );
  }
  const brandPhotos = new Map<string, string>(); // photoUrl → label
  for (const c of session.brandManifestSnapshot?.characters ?? []) {
    if (c.photoUrl) brandPhotos.set(c.photoUrl, c.label);
  }
  const previous = new Map(
    (existing?.casts ?? []).map((c) => [c.characterId, c] as const),
  );

  const seen = new Set<string>();
  const casts: CharacterCast[] = [];
  for (const d of dto.casts) {
    if (!known.has(d.characterId)) {
      throw new BadRequestException(
        `Unknown character "${d.characterId}" — not in this analysis`,
      );
    }
    if (seen.has(d.characterId)) {
      throw new BadRequestException(`Duplicate cast for "${d.characterId}"`);
    }
    seen.add(d.characterId);
    casts.push({
      characterId: d.characterId,
      active: d.active,
      order: d.active ? d.order : 0,
      replacement: replacementFrom(d, previous.get(d.characterId), brandPhotos),
    });
  }

  // Dense 1..n by the client's relative order (stable on ties).
  const active = casts
    .filter((c) => c.active)
    .sort((a, b) => a.order - b.order);
  active.forEach((c, i) => {
    c.order = i + 1;
  });

  return { casts, updatedAt: now.toISOString() };
}

function replacementFrom(
  d: CharacterCastDto,
  prev: CharacterCast | undefined,
  brandPhotos: Map<string, string>,
): CastReplacement {
  const r = d.replacement;
  switch (r.kind) {
    case 'none':
      return { ...NO_REPLACEMENT };
    case 'text':
      if (!r.description?.trim()) {
        throw new BadRequestException(
          `Text replacement for "${d.characterId}" needs a description`,
        );
      }
      return {
        ...NO_REPLACEMENT,
        kind: 'text',
        description: r.description.trim(),
      };
    case 'photo': {
      // Only a photo this session uploaded (confirmPhoto) may be kept.
      const kept = prev?.replacement.kind === 'photo' ? prev.replacement : null;
      if (!kept?.photoUrl) {
        throw new BadRequestException(
          `No uploaded photo for "${d.characterId}" — upload one via characters/${d.characterId}/photo first`,
        );
      }
      return {
        ...kept,
        description: r.description?.trim() || kept.description,
      };
    }
    case 'brand': {
      if (r.photoUrl && !brandPhotos.has(r.photoUrl)) {
        throw new BadRequestException(
          `photoUrl for "${d.characterId}" is not a brand character photo of this session`,
        );
      }
      if (!r.photoUrl && !r.description?.trim()) {
        throw new BadRequestException(
          `Brand replacement for "${d.characterId}" needs a photo or a description`,
        );
      }
      return {
        kind: 'brand',
        photoUrl: r.photoUrl ?? null,
        photoPathname: null,
        description: r.description?.trim() || null,
        brandCharacterId: r.brandCharacterId ?? null,
        label:
          r.label?.trim() ||
          (r.photoUrl ? (brandPhotos.get(r.photoUrl) ?? null) : null),
      };
    }
  }
}

@Injectable()
export class CastingService {
  constructor(
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly plans: PlanService,
  ) {}

  async get(sessionId: string): Promise<CharacterCasting> {
    const session = await this.load(sessionId);
    return session.characterCasting ?? { casts: [], updatedAt: '' };
  }

  async put(
    sessionId: string,
    dto: PutCastingRequestDto,
  ): Promise<CharacterCasting> {
    const session = await this.load(sessionId);
    const casting = normaliseCasting(session, session.characterCasting, dto);
    await this.sessions.updateSession(sessionId, { characterCasting: casting });
    return casting;
  }

  /** Presigned PUT for a replacement photo ("новый скин", §10). */
  async createPhotoUploadUrl(
    sessionId: string,
    characterId: string,
    dto: CastPhotoUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string }> {
    const session = await this.load(sessionId);
    // §23: замена персонажа своим фото — от Standard. Снять персонажа или
    // описать словами можно в любом режиме: это часть разбора, а не
    // отдельная возможность.
    await this.plans.assertUser(session.userId ?? null, 'characterReplacement');
    this.assertKnown(session, characterId);
    const pathname = castPhotoPathname(sessionId, characterId, dto.mimeType);
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_PHOTO_BYTES,
    );
    return { uploadUrl, pathname };
  }

  /**
   * After the browser PUT: verify the blob exists, then upsert the cast as
   * kind=photo (activating the character if it wasn't — uploading a skin
   * for someone you're dropping makes no sense).
   */
  async confirmPhoto(
    sessionId: string,
    characterId: string,
    dto: CastPhotoConfirmRequestDto,
  ): Promise<CharacterCasting> {
    const session = await this.load(sessionId);
    // §6.8 doc/AI-SKETCH-SPEC.md: тариф проверял только шаг upload-url,
    // а «использовать превью как фото» шёл сразу сюда — в обход него.
    // Проверка здесь закрывает оба пути сразу; для обычной загрузки
    // ничего не меняется (upload-url уже требовал тот же признак).
    await this.plans.assertUser(session.userId ?? null, 'characterReplacement');
    this.assertKnown(session, characterId);
    const expectedPrefix = `sessions/${sessionId}/characters/${characterId}/`;
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

    const current = session.characterCasting ?? { casts: [], updatedAt: '' };
    const others = current.casts.filter((c) => c.characterId !== characterId);
    const prev = current.casts.find((c) => c.characterId === characterId);
    const maxOrder = Math.max(
      0,
      ...others.filter((c) => c.active).map((c) => c.order),
    );
    const cast: CharacterCast = {
      characterId,
      active: true,
      order: prev?.active ? prev.order : maxOrder + 1,
      replacement: {
        kind: 'photo',
        photoUrl: url,
        photoPathname: dto.pathname,
        description:
          dto.description?.trim() || prev?.replacement.description || null,
        brandCharacterId: null,
        label: null,
      },
    };
    const casts = [...others, cast];
    const active = casts
      .filter((c) => c.active)
      .sort((a, b) => a.order - b.order);
    active.forEach((c, i) => {
      c.order = i + 1;
    });
    const casting: CharacterCasting = {
      casts,
      updatedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, { characterCasting: casting });
    return casting;
  }

  /**
   * Всё, что нужно проверить ДО платного превью персонажа (§6.8
   * doc/AI-SKETCH-SPEC.md): персонаж есть в разборе, тариф даёт замену
   * персонажа (превью существует ради «использовать как фото»),
   * пользователь не заблокирован и не выбрал суточный бюджет. Квоту на
   * число картинок проверяет сам `CharacterPreviewService`. Возвращает
   * владельца — без него квоту не посчитать, поэтому гость получает 403.
   */
  async assertPreviewAllowed(
    sessionId: string,
    characterId: string,
  ): Promise<string> {
    const session = await this.load(sessionId);
    this.assertKnown(session, characterId);
    const userId = session.userId ?? null;
    await this.plans.assertUser(userId, 'characterReplacement');
    if (!userId) {
      throw new ForbiddenException(
        'Превью персонажа доступно после входа через Telegram',
      );
    }
    await this.plans.assertCanSpendUser(userId);
    return userId;
  }

  /** Для «использовать превью как фото»: персонаж и тариф — без проверки
   * бюджета (превью уже оплачено, копирование бесплатно). */
  async assertCanReplaceCharacter(
    sessionId: string,
    characterId: string,
  ): Promise<void> {
    const session = await this.load(sessionId);
    this.assertKnown(session, characterId);
    await this.plans.assertUser(session.userId ?? null, 'characterReplacement');
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }

  private assertKnown(session: Session, characterId: string): void {
    const ok = (session.videoAnalysis?.characters ?? []).some(
      (c) => c.id === characterId,
    );
    if (!ok) {
      throw new NotFoundException(
        `Character "${characterId}" is not in this session's analysis`,
      );
    }
  }
}
