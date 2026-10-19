import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  STORY_CATALOG,
  storyText,
  type StoryCatalogEntry,
} from './story-catalog';
import {
  composeStoryNarration,
  normalizeStorySpeechText,
  type StoryGiftNotePosition,
  type StoryNarrationLayout,
} from './story-gift-note';
import {
  resolveStoryOccasion,
  storyOccasionLines,
  type StoryOccasion,
} from './story-occasion';
import {
  assertStoryPromiseFree,
  checkStoryPromises,
  type StoryPromiseHint,
} from './story-promise';
import {
  storyAudioReservation,
  storyEstimate,
  STORY_SPEECH_CHARS_PER_SECOND,
  type StoryEstimate,
} from './story-budget';

/** Вход мастера: общий для `POST /story-gifts` и `POST /story-gifts/preview`. */
export type StoryDraftInput = {
  catalogId: string;
  budgetUsd?: number;
  countryCode?: string;
  occasionKind?: string | null;
  /** Свободная подпись (для `other`; у старых клиентов — единственное поле). */
  occasion?: string | null;
  theme?: string | null;
  giftNoteEnabled?: boolean;
  giftNote?: string | null;
  giftNotePosition?: StoryGiftNotePosition;
  giftPhotoDescription?: string | null;
};
export type StoryPreviewOptions = {
  /** Учесть в смете будущую видеоверсию: преамбула + сборка + проверка MP4. */
  includeVideo?: boolean;
  preambleText?: string | null;
  videoVoice?: 'nova' | 'parent';
  /** Завершение видео (≤180): отдельный синтезируемый сегмент (B-S3-4). */
  outroText?: string | null;
};
export type StoryDraft = {
  story: StoryCatalogEntry;
  main: string;
  text: string;
  textHash: string;
  layout: StoryNarrationLayout;
  giftNote: string | null;
  giftNoteEnabled: boolean;
  giftNotePosition: StoryGiftNotePosition | null;
  giftPhotoDescription: string | null;
  occasion: StoryOccasion;
  budgetUsd: number;
  countryCode: string;
  reserveMicroUsd: number;
  hints: StoryPromiseHint[];
};
const digest = (v: string) => createHash('sha256').update(v).digest('hex');
/** Синтез отклоняет дорожки вне 8–240 с; предпросмотр предупреждает заранее. */
export const STORY_AUDIO_SECONDS = { min: 8, max: 240 } as const;

/** Описание фото подарка: как описание товара, без доставки и обещаний. */
export function normalizeStoryPhotoDescription(
  value: string | null | undefined,
  locale: string,
): string | null {
  if (value === undefined || value === null) return null;
  const text = normalizeStorySpeechText(value, 200);
  if (!text) return null;
  assertStoryPromiseFree(text, locale);
  return text;
}

/**
 * Р-ST-WP3-5. Чистая сборка черновика без БД и провайдеров: каталог,
 * повод/тема, реплика (явное включение, нормализация, валидатор),
 * склейка + раскладка сегментов, резерв по прежней формуле.
 */
export function prepareStoryDraft(input: StoryDraftInput): StoryDraft {
  const story = STORY_CATALOG.find((s) => s.id === input.catalogId);
  if (!story) throw new BadRequestException('Редакция сказки недоступна');
  const budgetUsd = input.budgetUsd ?? 1;
  const occasion = resolveStoryOccasion(input, story.locale);
  const rawNote = input.giftNote ?? '';
  const note = rawNote ? normalizeStorySpeechText(rawNote, 180) : '';
  if (note && input.giftNoteEnabled !== true)
    throw new BadRequestException({
      code: 'STORY_GIFT_NOTE_NOT_ENABLED',
      message:
        'Реплика о подарке войдёт в озвучку только после явного включения «Упомянуть подарок»',
    });
  if (input.giftNoteEnabled === true && !note)
    throw new BadRequestException({
      code: 'STORY_GIFT_NOTE_EMPTY',
      message: 'Введите реплику о подарке или выключите упоминание',
    });
  if (note) assertStoryPromiseFree(note, story.locale);
  const position: StoryGiftNotePosition =
    input.giftNotePosition === 'beginning' ? 'beginning' : 'end';
  const main = storyText(story.id);
  const { text, layout } = composeStoryNarration(main, note || null, position);
  const reserve = storyAudioReservation(text);
  return {
    story,
    main,
    text,
    textHash: digest(text),
    layout,
    giftNote: note || null,
    giftNoteEnabled: Boolean(note),
    giftNotePosition: note ? position : null,
    giftPhotoDescription: normalizeStoryPhotoDescription(
      input.giftPhotoDescription,
      story.locale,
    ),
    occasion,
    budgetUsd,
    countryCode: input.countryCode ?? 'UA',
    reserveMicroUsd: reserve,
    hints: note ? checkStoryPromises(note, story.locale).hints : [],
  };
}

export type StoryPreview = {
  sideEffects: 'none';
  catalogId: string;
  title: string;
  locale: string;
  kind: string;
  /** Точный текст, который уйдёт в синтез аудиоверсии. */
  text: string;
  textHash: string;
  /** Тот же текст по сегментам в порядке звучания; `giftNote` — выделенная вставка. */
  parts: Array<{ kind: 'giftNote' | 'main'; text: string }>;
  layout: StoryNarrationLayout;
  giftNote: null | {
    text: string;
    position: StoryGiftNotePosition;
    characters: number;
    seconds: number;
  };
  occasion: StoryOccasion & { lines: string[] };
  giftPhotoDescription: string | null;
  durationSeconds: {
    estimated: number;
    min: number;
    max: number;
    withinLimits: boolean;
  };
  reserveMicroUsd: number;
  estimate: StoryEstimate;
  hints: StoryPromiseHint[];
};

/** Предпросмотр: никаких записей, синтеза и платных вызовов. */
export function previewStoryDraft(
  input: StoryDraftInput,
  options: StoryPreviewOptions = {},
): StoryPreview {
  const draft = prepareStoryDraft(input);
  const preamble = options.preambleText
    ? normalizeStorySpeechText(options.preambleText, 180)
    : '';
  if (preamble) assertStoryPromiseFree(preamble, draft.story.locale);
  const outro = options.outroText
    ? normalizeStorySpeechText(options.outroText, 180)
    : '';
  if (outro) assertStoryPromiseFree(outro, draft.story.locale);
  // B-S3-4: with the family voice the gift note is re-synthesized as its own
  // video segment, and the outro always is — the preview reserve matches
  // what POST :id/video will actually hold (`storyVideoReserve`).
  const estimate = storyEstimate({
    mainChars: draft.main.length,
    giftNoteChars: draft.giftNote?.length ?? 0,
    budgetMicroUsd: Math.round(draft.budgetUsd * 1e6),
    video: options.includeVideo
      ? {
          preambleChars: preamble.length,
          voice: options.videoVoice ?? 'nova',
          outroChars: outro.length,
        }
      : null,
  });
  const estimated =
    Math.round((draft.text.length / STORY_SPEECH_CHARS_PER_SECOND) * 10) / 10;
  const noteParts = draft.giftNote
    ? [{ kind: 'giftNote' as const, text: draft.giftNote }]
    : [];
  const mainPart = [{ kind: 'main' as const, text: draft.main }];
  return {
    sideEffects: 'none',
    catalogId: draft.story.id,
    title: draft.story.title,
    locale: draft.story.locale,
    kind: draft.story.kind,
    text: draft.text,
    textHash: draft.textHash,
    parts:
      draft.giftNotePosition === 'beginning'
        ? [...noteParts, ...mainPart]
        : [...mainPart, ...noteParts],
    layout: draft.layout,
    giftNote: draft.giftNote
      ? {
          text: draft.giftNote,
          position: draft.giftNotePosition!,
          characters: draft.giftNote.length,
          seconds: estimate.speech.giftNoteSeconds,
        }
      : null,
    occasion: {
      ...draft.occasion,
      lines: storyOccasionLines(draft.occasion.kind, draft.story.locale),
    },
    giftPhotoDescription: draft.giftPhotoDescription,
    durationSeconds: {
      estimated,
      min: STORY_AUDIO_SECONDS.min,
      max: STORY_AUDIO_SECONDS.max,
      withinLimits:
        estimated >= STORY_AUDIO_SECONDS.min &&
        estimated <= STORY_AUDIO_SECONDS.max,
    },
    reserveMicroUsd: draft.reserveMicroUsd,
    estimate,
    hints: [
      ...draft.hints,
      ...(preamble
        ? checkStoryPromises(preamble, draft.story.locale).hints
        : []),
      ...(outro ? checkStoryPromises(outro, draft.story.locale).hints : []),
    ].filter((h, i, all) => all.findIndex((x) => x.code === h.code) === i),
  };
}

/** Смета сохранённого подарка (GET :id, create, photo): аудиочасть. */
export function storedStoryEstimate(row: {
  catalogId: string;
  chapters: unknown;
  title: string;
  giftNote: string | null;
  narrationLayout?: unknown;
  budgetCents: number;
}): StoryEstimate {
  const layout = row.narrationLayout as StoryNarrationLayout | null | undefined;
  let mainChars: number;
  if (layout?.version === 1) mainChars = layout.main.end - layout.main.start;
  else {
    try {
      mainChars = storyText(row.catalogId).length;
    } catch {
      const chapters = Array.isArray(row.chapters)
        ? (row.chapters as Array<{ text?: string }>)
        : [];
      mainChars =
        `${row.title}.`.length +
        chapters.reduce((s, c) => s + 2 + (c.text?.length ?? 0), 0);
    }
  }
  const noteChars =
    layout?.version === 1
      ? layout.giftNote
        ? layout.giftNote.end - layout.giftNote.start
        : 0
      : (row.giftNote?.length ?? 0);
  return storyEstimate({
    mainChars,
    giftNoteChars: noteChars,
    budgetMicroUsd: row.budgetCents * 10_000,
  });
}
