/**
 * Story‑Tales мастер (WP3): чистая логика повода, темы, реплики о подарке,
 * предпросмотра и сметы. Без React и сети — проверяется
 * `scripts/story-wizard.test.ts`. Сервер остаётся источником истины:
 * здесь только подсказки до запроса и разбор ответа.
 */
import { parseUsdBudget } from './story-library';

export const OCCASION_KINDS = [
  'birthday',
  'bedtime',
  'separation',
  'support',
  'other',
] as const;
export type OccasionKind = (typeof OCCASION_KINDS)[number];
export const OCCASION_LABELS: Record<OccasionKind, string> = {
  birthday: 'День рождения',
  bedtime: 'Перед сном',
  separation: 'Когда мы далеко',
  support: 'Поддержка',
  other: 'Другой повод',
};
export const STORY_THEME_IDS = [
  'calm',
  'celebration',
  'night',
  'warm',
  'gentle',
] as const;
export type StoryThemeId = (typeof STORY_THEME_IDS)[number];
export type StoryThemeIcon = 'book' | 'cake' | 'moon' | 'heart' | 'sun';
export const STORY_THEMES: Record<
  StoryThemeId,
  { label: string; accent: string; soft: string; icon: StoryThemeIcon }
> = {
  calm: {
    label: 'Спокойная',
    accent: '#5f9ea0',
    soft: '#e3f0ef',
    icon: 'book',
  },
  celebration: {
    label: 'Праздничная',
    accent: '#d9822b',
    soft: '#fbead6',
    icon: 'cake',
  },
  night: { label: 'Ночная', accent: '#5b6bbf', soft: '#e3e6f7', icon: 'moon' },
  warm: { label: 'Тёплая', accent: '#c45c66', soft: '#f7e1e3', icon: 'heart' },
  gentle: { label: 'Мягкая', accent: '#7a9a4a', soft: '#e9f1dc', icon: 'sun' },
};
const THEME_BY_KIND: Record<OccasionKind, StoryThemeId> = {
  birthday: 'celebration',
  bedtime: 'night',
  separation: 'warm',
  support: 'gentle',
  other: 'calm',
};
/** Тема: явный выбор, иначе по поводу, иначе спокойная (как на сервере). */
export function themeFor(
  kind: OccasionKind | null | undefined,
  explicit?: StoryThemeId | string | null
): StoryThemeId {
  if (explicit && (STORY_THEME_IDS as readonly string[]).includes(explicit))
    return explicit as StoryThemeId;
  return kind ? THEME_BY_KIND[kind] : 'calm';
}
/** Подпись повода для списка/карточки: пресет по коду, `other` — своя подпись. */
export function occasionCaption(gift: {
  occasionKind?: string | null;
  occasion?: string | null;
}): string | null {
  const kind = gift.occasionKind as OccasionKind | null | undefined;
  if (kind && kind !== 'other') return OCCASION_LABELS[kind] ?? null;
  return (
    gift.occasion?.trim() || (kind === 'other' ? OCCASION_LABELS.other : null)
  );
}

export type GiftNotePosition = 'beginning' | 'end';
export type WizardState = {
  catalogId: string;
  budget: string;
  country: string;
  occasionKind: OccasionKind | null;
  occasionLabel: string;
  /** null — тема по поводу. */
  theme: StoryThemeId | null;
  giftNoteEnabled: boolean;
  giftNote: string;
  giftNotePosition: GiftNotePosition;
  photoDescription: string;
  includeVideo: boolean;
};
export type CreatePayload = {
  catalogId: string;
  budgetUsd: number;
  countryCode: string;
  occasionKind?: OccasionKind;
  occasion?: string;
  theme?: StoryThemeId;
  giftNoteEnabled: boolean;
  giftNote?: string;
  giftNotePosition: GiftNotePosition;
  giftPhotoDescription?: string;
};
/** Пробелы как на сервере: реплика без переводов строк и двойных пробелов. */
export function squashSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
/** Ошибки, которые видно до запроса; итоговое решение — за сервером. */
export function wizardIssues(state: WizardState): string[] {
  const issues: string[] = [];
  const budget = parseUsdBudget(state.budget);
  if (budget.error) issues.push(budget.error);
  if (
    state.occasionKind === 'other' &&
    squashSpaces(state.occasionLabel).length > 80
  )
    issues.push('Подпись повода — до 80 символов');
  const note = squashSpaces(state.giftNote);
  if (state.giftNoteEnabled && !note)
    issues.push('Введите реплику о подарке или выключите упоминание');
  if (state.giftNoteEnabled && note.length > 180)
    issues.push('Реплика о подарке — до 180 символов');
  if (squashSpaces(state.photoDescription).length > 200)
    issues.push('Описание фото — до 200 символов');
  return issues;
}
/** Тело `POST /story-gifts` (и основа `POST /story-gifts/preview`). */
export function buildStoryPayload(state: WizardState): CreatePayload {
  const note = squashSpaces(state.giftNote);
  const label = squashSpaces(state.occasionLabel);
  const description = squashSpaces(state.photoDescription);
  return {
    catalogId: state.catalogId,
    budgetUsd: parseUsdBudget(state.budget).value ?? Number(state.budget),
    countryCode: state.country,
    ...(state.occasionKind ? { occasionKind: state.occasionKind } : {}),
    ...(state.occasionKind === 'other' && label ? { occasion: label } : {}),
    ...(state.theme ? { theme: state.theme } : {}),
    giftNoteEnabled: state.giftNoteEnabled && Boolean(note),
    ...(state.giftNoteEnabled && note ? { giftNote: note } : {}),
    giftNotePosition: state.giftNotePosition,
    ...(description ? { giftPhotoDescription: description } : {}),
  };
}
export function buildPreviewPayload(state: WizardState) {
  return { ...buildStoryPayload(state), includeVideo: state.includeVideo };
}
/** Ключ актуальности предпросмотра: любое изменение ввода его сбрасывает. */
export function previewKey(state: WizardState): string {
  return JSON.stringify(buildPreviewPayload(state));
}
/**
 * Создание с репликой разрешено только после свежего предпросмотра точной
 * реплики (9945); без реплики предпросмотр рекомендован, но не обязателен.
 */
export function canCreate(
  state: WizardState,
  lastPreviewKey: string | null
): { ok: boolean; reason: string | null } {
  const issues = wizardIssues(state);
  if (issues.length) return { ok: false, reason: issues[0] };
  if (state.giftNoteEnabled && lastPreviewKey !== previewKey(state))
    return {
      ok: false,
      reason: 'Сначала посмотрите точную реплику: она войдёт в озвучку',
    };
  return { ok: true, reason: null };
}

export type EstimateLine = {
  id: 'voice' | 'image' | 'animation' | 'assembly' | 'qa';
  label: string;
  status: 'included' | 'not-selected' | 'unavailable' | 'not-included';
  costMicroUsd: number;
  reserveMicroUsd: number;
  items: Array<{
    id: string;
    label: string;
    characters?: number;
    seconds?: number;
    costMicroUsd: number;
  }>;
  note: string;
};
export type StoryEstimate = {
  lines: EstimateLine[];
  totalCostMicroUsd: number;
  totalReserveMicroUsd: number;
  audioReserveMicroUsd: number;
  videoReserveMicroUsd: number;
  budgetMicroUsd: number;
  remainingMicroUsd: number;
  overByMicroUsd: number;
  withinBudget: boolean;
  policy: string;
};
export type StoryPreview = {
  text: string;
  textHash: string;
  parts: Array<{ kind: 'giftNote' | 'main'; text: string }>;
  giftNote: null | {
    text: string;
    position: GiftNotePosition;
    characters: number;
    seconds: number;
  };
  occasion: {
    kind: OccasionKind | null;
    label: string | null;
    theme: StoryThemeId;
    lines: string[];
  };
  giftPhotoDescription: string | null;
  durationSeconds: {
    estimated: number;
    min: number;
    max: number;
    withinLimits: boolean;
  };
  estimate: StoryEstimate;
  hints: Array<{ code: string; message: string }>;
};

export function formatUsd(micro: number): string {
  const usd = micro / 1e6;
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
const STATUS_TEXT: Record<EstimateLine['status'], string> = {
  included: '',
  'not-selected': 'не выбрано',
  unavailable: 'недоступно',
  'not-included': 'не входит',
};
export type EstimateRow = {
  id: EstimateLine['id'];
  label: string;
  cost: string;
  reserve: string;
  status: string;
  detail: string;
  muted: boolean;
};
export function estimateRows(estimate: StoryEstimate): EstimateRow[] {
  return estimate.lines.map((line) => ({
    id: line.id,
    label: line.label,
    cost: line.status === 'included' ? formatUsd(line.costMicroUsd) : '—',
    reserve: line.status === 'included' ? formatUsd(line.reserveMicroUsd) : '—',
    status: STATUS_TEXT[line.status],
    detail: [
      line.items
        .map(
          (i) =>
            `${i.label}${i.characters !== undefined ? ` · ${i.characters} симв.` : ''}${i.seconds ? ` · ≈${Math.round(i.seconds)} с` : ''}`
        )
        .join('; '),
      line.note,
    ]
      .filter(Boolean)
      .join(' — '),
    muted: line.status !== 'included',
  }));
}
/** Предупреждение о выходе резерва за бюджет (null — укладывается). */
export function budgetWarning(estimate: StoryEstimate): string | null {
  if (estimate.withinBudget) return null;
  return `Резерв ${formatUsd(estimate.totalReserveMicroUsd)} превышает бюджет ${formatUsd(estimate.budgetMicroUsd)} на ${formatUsd(estimate.overByMicroUsd)}. Увеличьте бюджет, сократите реплику или откажитесь от видеоверсии — превышение не допускается.`;
}
/**
 * Сегменты озвучки сохранённого черновика для показа: реплика выделяется.
 * Сервер хранит раскладку `narrationLayout`; без неё — по позиции реплики.
 */
export function draftParts(gift: {
  giftNote: string | null;
  giftNotePosition: string | null;
  title: string;
  chapters: Array<{ text: string }>;
}): Array<{ kind: 'giftNote' | 'main'; text: string }> {
  const main = {
    kind: 'main' as const,
    text: `${gift.title}.\n\n${gift.chapters.map((c) => c.text).join('\n\n')}`,
  };
  if (!gift.giftNote) return [main];
  const note = { kind: 'giftNote' as const, text: gift.giftNote };
  return gift.giftNotePosition === 'beginning' ? [note, main] : [main, note];
}
