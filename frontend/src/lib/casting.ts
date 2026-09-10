/**
 * Pure helpers of the character-casting screen (spec §10) — kept out of
 * the component so the order/slot rules can be unit-tested.
 */

import type { CastInput } from '../services/projects-api';
import type {
  AnalysisCharacter,
  CastReplacement,
  CharacterCast,
} from '../types';

/** Veo 3.1 referenceImages cap — spec §10.2/§10.3, same constant on the backend. */
export const REFERENCE_IMAGE_CAP = 3;

const NONE: CastReplacement = {
  kind: 'none',
  photoUrl: null,
  photoPathname: null,
  description: null,
  brandCharacterId: null,
  label: null,
};

/** One colour per character — chip, description bar and focus ring share it (§10). */
const PALETTE = [
  {
    chip: 'bg-accent/20 text-sky-800 dark:text-accent',
    bar: 'border-accent',
    tint: 'bg-accent/5',
    ring: 'ring-accent',
    dot: 'bg-accent',
  },
  {
    chip: 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-400',
    bar: 'border-emerald-500',
    tint: 'bg-emerald-500/5',
    ring: 'ring-emerald-500',
    dot: 'bg-emerald-500',
  },
  {
    chip: 'bg-amber-500/20 text-amber-800 dark:text-amber-400',
    bar: 'border-amber-500',
    tint: 'bg-amber-500/5',
    ring: 'ring-amber-500',
    dot: 'bg-amber-500',
  },
  {
    chip: 'bg-rose-500/20 text-rose-700 dark:text-rose-400',
    bar: 'border-rose-500',
    tint: 'bg-rose-500/5',
    ring: 'ring-rose-500',
    dot: 'bg-rose-500',
  },
  {
    chip: 'bg-violet-500/20 text-violet-700 dark:text-violet-400',
    bar: 'border-violet-500',
    tint: 'bg-violet-500/5',
    ring: 'ring-violet-500',
    dot: 'bg-violet-500',
  },
  {
    chip: 'bg-teal-500/20 text-teal-800 dark:text-teal-400',
    bar: 'border-teal-500',
    tint: 'bg-teal-500/5',
    ring: 'ring-teal-500',
    dot: 'bg-teal-500',
  },
] as const;

export function characterColor(index: number): (typeof PALETTE)[number] {
  return PALETTE[index % PALETTE.length];
}

/** CharacterCast → what PUT accepts (drops server-only fields like photoPathname). */
export function castsToInputs(casts: CharacterCast[]): CastInput[] {
  return casts.map((c) => ({
    characterId: c.characterId,
    active: c.active,
    order: c.order,
    replacement: {
      kind: c.replacement.kind,
      description: c.replacement.description,
      photoUrl: c.replacement.kind === 'brand' ? c.replacement.photoUrl : null,
      brandCharacterId: c.replacement.brandCharacterId,
      label: c.replacement.label,
    },
  }));
}

/** Everyone Gemini found stays in by default — the user deselects (§10 "форма опциональна"). */
export function defaultCasting(characters: AnalysisCharacter[]): CastInput[] {
  return characters.map((ch, i) => ({
    characterId: ch.id,
    active: true,
    order: i + 1,
    replacement: { kind: 'none' },
  }));
}

/**
 * Toggle one character. Activating appends it to the END of the order
 * (§10.3: "по порядку выбора"); deactivating keeps its replacement so a
 * re-activation doesn't lose an uploaded photo.
 */
export function toggleActive(
  casts: CharacterCast[],
  characterId: string
): CastInput[] {
  const maxOrder = Math.max(
    0,
    ...casts.filter((c) => c.active).map((c) => c.order)
  );
  const present = casts.some((c) => c.characterId === characterId);
  const base = present
    ? casts
    : [...casts, { characterId, active: false, order: 0, replacement: NONE }];
  return castsToInputs(
    base.map((c) =>
      c.characterId === characterId
        ? { ...c, active: !c.active, order: c.active ? 0 : maxOrder + 1 }
        : c
    )
  );
}

export function withReplacement(
  casts: CharacterCast[],
  characterId: string,
  replacement: Partial<CastInput['replacement']> & {
    kind: CastReplacement['kind'];
  }
): CastInput[] {
  return castsToInputs(casts).map((c) =>
    c.characterId === characterId
      ? {
          ...c,
          replacement: {
            kind: replacement.kind,
            description: replacement.description ?? null,
            photoUrl: replacement.photoUrl ?? null,
            brandCharacterId: replacement.brandCharacterId ?? null,
            label: replacement.label ?? null,
          },
        }
      : c
  );
}

/** Ids of the active photo-casts that actually get a referenceImage slot (first 3 by order). */
export function photoSlots(casts: CharacterCast[]): Set<string> {
  return new Set(
    casts
      .filter((c) => c.active && c.replacement.photoUrl)
      .sort((a, b) => a.order - b.order)
      .slice(0, REFERENCE_IMAGE_CAP)
      .map((c) => c.characterId)
  );
}

/**
 * Spec §10: the text field is "предзаполнено данными из ТЕКУЩЕГО проекта",
 * not empty — Gemini's appearance plus the product the person should be
 * handling, so the user edits a draft.
 */
export function defaultTextFor(
  character: AnalysisCharacter,
  productName: string | null,
  productDescription: string | null,
  t: { holdsProduct: string }
): string {
  const look = character.appearance.trim();
  const parts = [/[.!?…]$/.test(look) ? look : `${look}.`];
  const name = productName?.trim();
  if (name) {
    const desc = productDescription?.trim();
    const descSuffix = desc ? ` — ${desc.slice(0, 160)}` : '';
    parts.push(
      t.holdsProduct.replace('{{name}}', name).replace('{{desc}}', descSuffix)
    );
  }
  return parts.join(' ');
}
