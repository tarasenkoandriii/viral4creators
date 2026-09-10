/**
 * ReferenceAssetsService — spec §17: user-uploaded scenes and the explicit
 * choice of Veo's three referenceImage slots. Session-data only.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { randomBytes } from 'crypto';
import { BlobService } from '../storage/blob.service';
import { SessionService } from '../../common/session.service';
import { PlanService } from '../plan/plan.service';
import { Session } from '../../common/types/session.types';
import {
  ReferenceSelection,
  ReferenceSlotsView,
  SceneAsset,
} from '../../common/types/reference.types';
import {
  buildReferencePlan,
  REFERENCE_IMAGE_CAP,
  slotsView,
} from '../../common/reference-plan';
import {
  PutReferenceSlotsRequestDto,
  SceneConfirmRequestDto,
  ScenePhotoUploadUrlRequestDto,
  SceneUpdateRequestDto,
} from './dto/reference-assets.dto';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_SCENES = 5;

export function newSceneId(): string {
  return `sc_${randomBytes(6).toString('hex')}`;
}

export function scenePathname(
  sessionId: string,
  sceneId: string,
  mimeType: string,
): string {
  return `sessions/${sessionId}/scenes/${sceneId}/photo.${mimeType === 'image/png' ? 'png' : 'jpg'}`;
}

@Injectable()
export class ReferenceAssetsService {
  constructor(
    private readonly plans: PlanService,
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
  ) {}

  // ── Scenes ────────────────────────────────────────────────────────────

  async listScenes(sessionId: string): Promise<SceneAsset[]> {
    return (await this.load(sessionId)).scenes ?? [];
  }

  /** Presigned PUT; a fresh scene id is minted here and returned in the pathname. */
  async createUploadUrl(
    sessionId: string,
    dto: ScenePhotoUploadUrlRequestDto,
  ): Promise<{ uploadUrl: string; pathname: string; sceneId: string }> {
    const session = await this.load(sessionId);
    // §23: свои сцены и ручной выбор слотов — от Standard и выше.
    await this.plans.assertUser(session.userId ?? null, 'referenceAssets');
    if ((session.scenes ?? []).length >= MAX_SCENES) {
      throw new BadRequestException(
        `At most ${MAX_SCENES} scenes per session — delete one first`,
      );
    }
    const sceneId = newSceneId();
    const pathname = scenePathname(sessionId, sceneId, dto.mimeType);
    const { uploadUrl } = await this.blob.createUploadUrl(
      pathname,
      dto.mimeType,
      MAX_PHOTO_BYTES,
    );
    return { uploadUrl, pathname, sceneId };
  }

  async confirmScene(
    sessionId: string,
    dto: SceneConfirmRequestDto,
  ): Promise<SceneAsset[]> {
    const session = await this.load(sessionId);
    const prefix = `sessions/${sessionId}/scenes/`;
    if (!dto.pathname.startsWith(prefix)) {
      throw new BadRequestException(`pathname must start with "${prefix}"`);
    }
    const sceneId = dto.pathname.slice(prefix.length).split('/')[0];
    const scenes = session.scenes ?? [];
    if (scenes.some((s) => s.id === sceneId)) {
      throw new BadRequestException(`Scene ${sceneId} already confirmed`);
    }
    if (scenes.length >= MAX_SCENES) {
      throw new BadRequestException(`At most ${MAX_SCENES} scenes per session`);
    }
    let url: string;
    try {
      url = (await head(dto.pathname)).url;
    } catch (e) {
      throw new BadRequestException(
        `Scene photo not found in storage at "${dto.pathname}" — upload it first (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    const scene: SceneAsset = {
      id: sceneId,
      label: dto.label.trim(),
      description: dto.description?.trim() || null,
      photoUrl: url,
      photoPathname: dto.pathname,
      createdAt: new Date().toISOString(),
    };
    const next = [...scenes, scene];
    await this.sessions.updateSession(sessionId, { scenes: next });
    return next;
  }

  async updateScene(
    sessionId: string,
    sceneId: string,
    dto: SceneUpdateRequestDto,
  ): Promise<SceneAsset[]> {
    const session = await this.load(sessionId);
    const scenes = session.scenes ?? [];
    if (!scenes.some((s) => s.id === sceneId)) {
      throw new NotFoundException(`Scene ${sceneId} not found`);
    }
    const next = scenes.map((s) =>
      s.id === sceneId
        ? {
            ...s,
            ...(dto.label !== undefined ? { label: dto.label.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description?.trim() || null }
              : {}),
          }
        : s,
    );
    await this.sessions.updateSession(sessionId, { scenes: next });
    return next;
  }

  /** Removes the scene, its blob (best effort) and its slot, if it held one. */
  async deleteScene(sessionId: string, sceneId: string): Promise<SceneAsset[]> {
    const session = await this.load(sessionId);
    const scenes = session.scenes ?? [];
    const scene = scenes.find((s) => s.id === sceneId);
    if (!scene) throw new NotFoundException(`Scene ${sceneId} not found`);
    const next = scenes.filter((s) => s.id !== sceneId);
    const selection = session.referenceSelection
      ? {
          slots: session.referenceSelection.slots.filter(
            (id) => id !== `scene:${sceneId}`,
          ),
          updatedAt: new Date().toISOString(),
        }
      : undefined;
    await this.sessions.updateSession(sessionId, {
      scenes: next,
      ...(selection ? { referenceSelection: selection } : {}),
    });
    void this.blob.deleteBlob(scene.photoPathname).catch(() => undefined);
    return next;
  }

  // ── Slots ─────────────────────────────────────────────────────────────

  async getSlots(sessionId: string): Promise<ReferenceSlotsView> {
    return slotsView(buildReferencePlan(await this.load(sessionId)));
  }

  /**
   * Explicit choice. Ids must be current candidates (an unknown id is a
   * client bug, not something to silently drop); an empty list is a valid
   * choice — "no reference images, describe everything in text" (then the
   * legacy first-frame path applies).
   */
  async putSlots(
    sessionId: string,
    dto: PutReferenceSlotsRequestDto,
  ): Promise<ReferenceSlotsView> {
    const session = await this.load(sessionId);
    await this.plans.assertUser(session.userId ?? null, 'referenceAssets');
    const plan = buildReferencePlan(session);
    const known = new Set(plan.candidates.map((c) => c.id));
    const seen = new Set<string>();
    for (const id of dto.slots) {
      if (!known.has(id)) {
        throw new BadRequestException(
          `"${id}" is not a reference candidate of this session`,
        );
      }
      if (seen.has(id)) throw new BadRequestException(`Duplicate slot "${id}"`);
      seen.add(id);
    }
    if (dto.slots.length > REFERENCE_IMAGE_CAP) {
      throw new BadRequestException(`At most ${REFERENCE_IMAGE_CAP} slots`);
    }
    const selection: ReferenceSelection = {
      slots: dto.slots,
      updatedAt: new Date().toISOString(),
    };
    await this.sessions.updateSession(sessionId, {
      referenceSelection: selection,
    });
    return slotsView(
      buildReferencePlan({ ...session, referenceSelection: selection }),
    );
  }

  /** Back to the default rule. */
  async resetSlots(sessionId: string): Promise<ReferenceSlotsView> {
    const session = await this.load(sessionId);
    await this.sessions.updateSession(sessionId, {
      referenceSelection: undefined,
    });
    return slotsView(
      buildReferencePlan({ ...session, referenceSelection: undefined }),
    );
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);
    return session;
  }
}
