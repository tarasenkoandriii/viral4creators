/**
 * Reference plan — the ONE place that decides what goes into a Veo call
 * as `referenceImages` and what is described in words instead
 * (doc/PRODUCT-PROJECT-SPEC.md §10.2, §10.3, §10.4, §17). Pure: the prompt
 * writer uses it for the text brief, GenerationService to fetch exactly the
 * chosen images and to append the authoritative "reference image N = …"
 * mapping to the Veo prompt.
 *
 * Candidates for the three slots (§17):
 *  - active characters with a photo (uploaded skin or brand character);
 *  - scenes the user uploaded in this session (location / set / background);
 *  - permanent brand scenes from the manifest snapshot (§17.1, Stage 22) —
 *    only those with a photo become slot candidates, the rest are text;
 *  - the product photo.
 * The user may pick up to 3 explicitly (Session.data.referenceSelection);
 * without a choice the default rule applies — characters in activation
 * order, then session scenes (uploaded for THIS video, so they outrank the
 * standing brand set), then brand scenes, then the product photo in the
 * last free slot (§10.3/§10.4). Everything not in a slot is described in text.
 *
 * Veo does not accept `image` (first frame) together with
 * `referenceImages`; when there are no reference images at all the legacy
 * "product photo = first frame" path is used.
 */

import { Session } from './types/session.types';
import { AnalysisCharacter } from './types/analysis.types';
import { CharacterCast } from './types/casting.types';
import { BrandManifestSnapshot } from './types/brand-manifest.types';
import {
  ReferenceCandidateId,
  ReferenceCandidateView,
  ReferenceSlotsView,
} from './types/reference.types';

export const REFERENCE_IMAGE_CAP = 3;

export interface ReferenceImageSource {
  /** 1-based, as referred to in the Veo prompt ("reference image 2"). */
  index: number;
  kind: 'character' | 'scene' | 'product';
  candidateId: ReferenceCandidateId;
  characterId: string | null;
  label: string;
  /** Vercel Blob pathname when the file was uploaded by us (preferred fetch path). */
  pathname: string | null;
  /** Public URL fallback (brand character photos). */
  url: string | null;
  mimeType: string;
}

export interface CharacterBrief {
  characterId: string;
  label: string;
  /** Final appearance text for the prompt (Gemini's or the replacement's). */
  appearance: string;
  /** Set when this character is shown to Veo as a reference image. */
  referenceIndex: number | null;
  source: 'gemini' | 'text' | 'brand' | 'photo';
}

export interface SceneBrief {
  /** Candidate id ("scene:<id>" / "brand-scene:<id>") — also the key for referenceIndex matching. */
  sceneId: string;
  label: string;
  description: string | null;
  referenceIndex: number | null;
  origin: 'session' | 'brand';
}

export interface ReferencePlan {
  images: ReferenceImageSource[];
  /** Active characters in casting order, with the text Veo/GPT should use. */
  characters: CharacterBrief[];
  /** Analysed characters the user dropped — must not appear. */
  omitted: AnalysisCharacter[];
  scenes: SceneBrief[];
  /** Product photo rides as a reference image (index) or not (null). */
  productReferenceIndex: number | null;
  /** True when the legacy "product photo as first frame" path applies. */
  legacyFirstFrame: boolean;
  /** Every candidate, for the chooser. */
  candidates: ReferenceCandidateView[];
  /** Effective slot ids, in order. */
  slots: ReferenceCandidateId[];
  isDefaultSelection: boolean;
}

type PlanSession = Pick<
  Session,
  | 'videoAnalysis'
  | 'characterCasting'
  | 'productInformation'
  | 'scenes'
  | 'referenceSelection'
  | 'brandManifestSnapshot'
>;

function mimeFromUrlOrPath(s: string | null, fallback = 'image/jpeg'): string {
  if (!s) return fallback;
  const ext = s.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return fallback;
}

interface Candidate {
  view: ReferenceCandidateView;
  source: Omit<ReferenceImageSource, 'index'>;
}

const NONE_REPLACEMENT = {
  kind: 'none' as const,
  photoUrl: null,
  photoPathname: null,
  description: null,
  brandCharacterId: null,
  label: null,
};

/** Active casts in order — or "everyone as Gemini saw them" when no casting was saved. */
function activeCastsOf(session: PlanSession): {
  casts: CharacterCast[];
  explicit: boolean;
} {
  const analysed = session.videoAnalysis?.characters ?? [];
  const known = new Set(analysed.map((c) => c.id));
  const saved = (session.characterCasting?.casts ?? []).filter((c) =>
    known.has(c.characterId),
  );
  if (saved.length > 0) {
    return {
      casts: saved.filter((c) => c.active).sort((a, b) => a.order - b.order),
      explicit: true,
    };
  }
  return {
    casts: analysed.map((c, i) => ({
      characterId: c.id,
      active: true,
      order: i + 1,
      replacement: NONE_REPLACEMENT,
    })),
    explicit: false,
  };
}

export function buildReferencePlan(
  session: PlanSession,
  cap: number = REFERENCE_IMAGE_CAP,
): ReferencePlan {
  const analysed = session.videoAnalysis?.characters ?? [];
  const byId = new Map(analysed.map((c) => [c.id, c] as const));
  const { casts: activeCasts, explicit } = activeCastsOf(session);
  const activeIds = new Set(activeCasts.map((c) => c.characterId));
  const omitted = explicit ? analysed.filter((c) => !activeIds.has(c.id)) : [];

  // ── candidates, in default-priority order ──────────────────────────
  const candidates: Candidate[] = [];
  const characterBriefs: CharacterBrief[] = [];

  for (const cast of activeCasts) {
    const ch = byId.get(cast.characterId)!;
    const r = cast.replacement;
    const label = r.kind === 'brand' && r.label ? r.label : ch.label;
    const appearance =
      (r.kind !== 'none' && r.description?.trim()) ||
      (r.kind === 'brand' && r.label
        ? `${r.label} — brand character${r.photoUrl ? ' (see reference image)' : ''}`
        : '') ||
      ch.appearance;
    characterBriefs.push({
      characterId: ch.id,
      label,
      appearance,
      referenceIndex: null,
      source: r.kind === 'none' ? 'gemini' : r.kind,
    });
    if (r.photoUrl) {
      candidates.push({
        view: {
          id: `character:${ch.id}`,
          kind: 'character',
          label,
          thumbnailUrl: r.photoUrl,
          textFallback: appearance,
          origin: r.kind === 'brand' ? 'brand' : 'session',
        },
        source: {
          kind: 'character',
          candidateId: `character:${ch.id}`,
          characterId: ch.id,
          label,
          pathname: r.photoPathname,
          url: r.photoUrl,
          mimeType: mimeFromUrlOrPath(r.photoPathname ?? r.photoUrl),
        },
      });
    }
  }

  const sceneBriefs: SceneBrief[] = [];
  for (const sc of session.scenes ?? []) {
    const id = `scene:${sc.id}`;
    sceneBriefs.push({
      sceneId: id,
      label: sc.label,
      description: sc.description,
      referenceIndex: null,
      origin: 'session',
    });
    candidates.push({
      view: {
        id,
        kind: 'scene',
        label: sc.label,
        thumbnailUrl: sc.photoUrl,
        textFallback: sc.description?.trim() || sc.label,
        origin: 'session',
      },
      source: {
        kind: 'scene',
        candidateId: id,
        characterId: null,
        label: sc.label,
        pathname: sc.photoPathname,
        url: sc.photoUrl,
        mimeType: mimeFromUrlOrPath(sc.photoPathname),
      },
    });
  }

  // Brand scenes (§17.1): frozen in the manifest snapshot at session
  // creation. A scene without a photo is still part of the SETTING brief
  // (text only) but cannot fill a slot.
  (session.brandManifestSnapshot?.scenes ?? []).forEach((bs, i) => {
    const id = `brand-scene:${bs.sourceSceneId ?? `i${i}`}`;
    sceneBriefs.push({
      sceneId: id,
      label: bs.label,
      description: bs.description,
      referenceIndex: null,
      origin: 'brand',
    });
    if (!bs.photoUrl) return;
    candidates.push({
      view: {
        id,
        kind: 'scene',
        label: bs.label,
        thumbnailUrl: bs.photoUrl,
        textFallback: bs.description?.trim() || bs.label,
        origin: 'brand',
      },
      source: {
        kind: 'scene',
        candidateId: id,
        characterId: null,
        label: bs.label,
        pathname: null,
        url: bs.photoUrl,
        mimeType: mimeFromUrlOrPath(bs.photoUrl),
      },
    });
  });

  const product = session.productInformation;
  if (product?.productImagePathname) {
    candidates.push({
      view: {
        id: 'product',
        kind: 'product',
        label: product.productName || 'product',
        thumbnailUrl: product.productImageUrl ?? null,
        textFallback: [product.productName, product.productDescription]
          .filter(Boolean)
          .join(' — '),
        origin: 'session',
      },
      source: {
        kind: 'product',
        candidateId: 'product',
        characterId: null,
        label: product.productName || 'product',
        pathname: product.productImagePathname,
        url: product.productImageUrl ?? null,
        mimeType:
          product.productImageMimeType ??
          mimeFromUrlOrPath(product.productImagePathname),
      },
    });
  }

  // ── slots: explicit selection (validated) or the default rule ──────
  const byCandidateId = new Map(candidates.map((c) => [c.view.id, c] as const));
  const explicitSlots = (session.referenceSelection?.slots ?? []).filter(
    (id, i, arr) => byCandidateId.has(id) && arr.indexOf(id) === i,
  );
  const isDefaultSelection = !session.referenceSelection;
  let slots: ReferenceCandidateId[];
  if (!isDefaultSelection) {
    slots = explicitSlots.slice(0, cap);
  } else {
    // Default: characters (activation order) → session scenes → brand
    // scenes → product, cap 3 (candidates are already in that order).
    // Without any character photo or scene the legacy first-frame path
    // applies, so the product photo alone does NOT open reference mode.
    const nonProduct = candidates.filter((c) => c.view.kind !== 'product');
    slots = nonProduct.slice(0, cap).map((c) => c.view.id);
    if (
      slots.length > 0 &&
      slots.length < cap &&
      byCandidateId.has('product')
    ) {
      slots.push('product');
    }
  }

  const images: ReferenceImageSource[] = slots.map((id, i) => ({
    index: i + 1,
    ...byCandidateId.get(id)!.source,
  }));
  for (const img of images) {
    if (img.kind === 'character') {
      const b = characterBriefs.find((c) => c.characterId === img.characterId);
      if (b) b.referenceIndex = img.index;
    } else if (img.kind === 'scene') {
      const b = sceneBriefs.find((s) => s.sceneId === img.candidateId);
      if (b) b.referenceIndex = img.index;
    }
  }
  const productReferenceIndex =
    images.find((i) => i.kind === 'product')?.index ?? null;

  return {
    images,
    characters: characterBriefs,
    omitted,
    scenes: sceneBriefs,
    productReferenceIndex,
    legacyFirstFrame: images.length === 0,
    candidates: candidates.map((c) => c.view),
    slots,
    isDefaultSelection,
  };
}

/** GET /sessions/:id/references shape. */
export function slotsView(plan: ReferencePlan): ReferenceSlotsView {
  return {
    candidates: plan.candidates,
    slots: plan.slots,
    max: REFERENCE_IMAGE_CAP,
    isDefault: plan.isDefaultSelection,
  };
}

// ── Prompt text ────────────────────────────────────────────────────────

/**
 * Character section for the GPT prompt-writer (§10.3: all active
 * characters at once). Deliberately WITHOUT image numbers: slots can be
 * re-chosen after the prompt is written (§17), so the authoritative
 * numbering is appended to the Veo prompt at generation time
 * (`referenceMappingText`), not baked into GPT's text.
 */
export function characterBriefText(plan: ReferencePlan): string {
  if (plan.characters.length === 0 && plan.omitted.length === 0) return '';
  const lines: string[] = [
    'CHARACTERS TO KEEP (describe each exactly like this in the prompt):',
  ];
  for (const c of plan.characters) {
    const ref =
      c.referenceIndex !== null
        ? " [the video model also receives this person's photo as a reference image — keep the description consistent with a real photo, do not invent extra features]"
        : '';
    lines.push(`- ${c.label}: ${c.appearance}${ref}`);
  }
  if (plan.omitted.length > 0) {
    lines.push(
      `CHARACTERS TO REMOVE (must not appear in the new video): ${plan.omitted
        .map((c) => c.label)
        .join('; ')}.`,
    );
  }
  return lines.join('\n');
}

/** Scene / set section (§17): chosen scenes are matched, others described. */
export function sceneBriefText(plan: ReferencePlan): string {
  if (plan.scenes.length === 0) return '';
  const lines = ['SETTING (where the ad takes place):'];
  for (const s of plan.scenes) {
    const how =
      s.referenceIndex !== null
        ? 'the video model receives a photo of this location as a reference image — match it'
        : 'described in words only';
    const who = s.origin === 'brand' ? " (the brand's permanent location)" : '';
    lines.push(
      `- ${s.label}${who}${s.description ? `: ${s.description}` : ''} [${how}]`,
    );
  }
  return lines.join('\n');
}

/**
 * Appended to the Veo prompt by GenerationService — the single source of
 * truth for what each reference image is. Computed at generation time,
 * so it always matches the images actually sent.
 */
export function referenceMappingText(plan: ReferencePlan): string {
  if (plan.images.length === 0) return '';
  const what = (i: ReferenceImageSource): string => {
    if (i.kind === 'character')
      return `the person "${i.label}" — match their appearance exactly`;
    if (i.kind === 'scene')
      return `the location/set "${i.label}" — shoot the ad in this place`;
    return `the actual product "${i.label}" — it must look exactly like this`;
  };
  const lines = plan.images.map(
    (i) => `Reference image ${i.index} shows ${what(i)}.`,
  );
  const textOnly = [
    ...plan.characters
      .filter((c) => c.referenceIndex === null)
      .map((c) => c.label),
    ...plan.scenes.filter((s) => s.referenceIndex === null).map((s) => s.label),
    ...(plan.productReferenceIndex === null &&
    plan.candidates.some((c) => c.kind === 'product')
      ? [plan.candidates.find((c) => c.kind === 'product')!.label]
      : []),
  ];
  if (textOnly.length > 0) {
    lines.push(
      `Not shown as images, described in the text above: ${textOnly.join('; ')}.`,
    );
  }
  return lines.join(' ');
}

/**
 * То же самое, что `referenceMappingText`, но для Grok reference-to-
 * video (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §15) — официальная
 * конвенция xAI ожидает метки `<IMAGE_1>`, `<IMAGE_2>` … ПРЯМО в тексте
 * промпта, а не отдельным списком-приложением, как у Veo.
 *
 * Честно: это ПРИБЛИЖЕНИЕ к конвенции, не точное следование ей.
 * Официальный пример вплетает метку В ДЕЙСТВИЕ («they wear the shirt
 * from <IMAGE_2>») — это требует переписывать саму сцену под каждый
 * референс, а не добавлять список после неё; тот текст пишет GPT-5 для
 * Veo и ничего не знает про метки Grok. Здесь — тот же список, что у
 * Veo, просто с меткой вместо номера («Reference <IMAGE_2> shows …»)
 * — модель, скорее всего, поймёт связь (метки те же, что в массиве
 * `reference_images`, и упомянуты рядом с описанием того, что на них),
 * но это не то же самое, что естественная фраза внутри действия.
 * Кандидат на улучшение через отдельный шаг генерации текста (§8 ТЗ),
 * если качество этого приближения окажется недостаточным на практике.
 */
export function grokReferencePromptText(plan: ReferencePlan): string {
  if (plan.images.length === 0) return '';
  const what = (i: ReferenceImageSource): string => {
    if (i.kind === 'character')
      return `the person "${i.label}" — match their appearance exactly`;
    if (i.kind === 'scene')
      return `the location/set "${i.label}" — shoot the ad in this place`;
    return `the actual product "${i.label}" — it must look exactly like this`;
  };
  const lines = plan.images.map(
    (i) => `Reference <IMAGE_${i.index}> shows ${what(i)}.`,
  );
  const textOnly = [
    ...plan.characters
      .filter((c) => c.referenceIndex === null)
      .map((c) => c.label),
    ...plan.scenes.filter((s) => s.referenceIndex === null).map((s) => s.label),
    ...(plan.productReferenceIndex === null &&
    plan.candidates.some((c) => c.kind === 'product')
      ? [plan.candidates.find((c) => c.kind === 'product')!.label]
      : []),
  ];
  if (textOnly.length > 0) {
    lines.push(
      `Not shown as images, described in the text above: ${textOnly.join('; ')}.`,
    );
  }
  return lines.join(' ');
}

/**
 * Brand section (§12). Open question §12.2 — override vs complement — is
 * resolved here provisionally as "complement; on conflict the brand wins":
 * the reference's aesthetic stays the backbone (that is the whole point of
 * cloning a viral video), the manifest constrains palette/tone/effects.
 */
export function brandBriefText(
  snapshot: BrandManifestSnapshot | undefined,
): string {
  if (!snapshot) return '';
  const parts: string[] = [
    'BRAND STYLE GUIDE (apply on top of the reference aesthetic; where they conflict, the brand guide wins):',
  ];
  if (snapshot.styleNotes?.trim()) parts.push(snapshot.styleNotes.trim());
  if (snapshot.filters && Object.keys(snapshot.filters).length > 0) {
    parts.push(
      `Filters / colour treatment: ${JSON.stringify(snapshot.filters)}`,
    );
  }
  if (snapshot.effects && Object.keys(snapshot.effects).length > 0) {
    parts.push(`Effects / transitions: ${JSON.stringify(snapshot.effects)}`);
  }
  return parts.length > 1 ? parts.join('\n') : '';
}
