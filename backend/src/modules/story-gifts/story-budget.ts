import { BadRequestException, ConflictException } from '@nestjs/common';
import { estimateCost, PRICING_VERSION } from '../../common/ai-pricing';
import {
  GEMINI_IMAGE_MODEL,
  GEMINI_SKETCH_MODEL,
} from '../../common/gemini-image-model';
import {
  narratorLookPrice,
  type NarratorLookPrice,
  type NarratorMode,
} from '../brand-manifest/narrator-looks.rules';

const ttsCost = (characters: number) => {
  const tts = estimateCost('resemble-tts', { characters });
  if (tts.unpriced) throw new Error('Story TTS rate unavailable');
  return tts.costMicroUsd;
};
/** Резерв аудиопилота по числу символов склейки; формула прежняя. */
export function storyAudioReservationForChars(characters: number): number {
  // Conservative reserve, not a provider invoice: 4x internal TTS estimate,
  // plus $0.02 for one bounded Soniox QA. No implicit retries.
  return Math.ceil(ttsCost(characters + 80) * 4 + 20_000);
}
/** Pilot has audio+static art only. Animation is NOT submitted by this quote. */
export function storyAudioReservation(text: string): number {
  return storyAudioReservationForChars(text.length);
}

/** Множитель резерва TTS (и образа) — как в действующих формулах. */
export const STORY_RESERVE_MULTIPLIER = 4;
/** Резерв одной проверки Soniox (аудио или MP4), как в действующих формулах. */
export const STORY_QA_RESERVE_MICRO_USD = 20_000;
/** Нижняя граница резерва сборки FFmpeg API (как в `storyVideoReserve`). */
export const STORY_ASSEMBLY_MIN_RESERVE_MICRO_USD = 500_000;
/**
 * ОЦЕНКА, не прайс провайдера: ≈14 символов RU/UK/EN речи в секунду при
 * спокойном чтении Nova. Используется только для подсказки длительности и
 * ожидаемой стоимости QA; фактическую длительность даёт синтез.
 */
export const STORY_SPEECH_CHARS_PER_SECOND = 14;
/**
 * Цена образа рассказчика — та же, что показывает и резервирует WP5
 * (`narratorLookPrice`, операция расходов `story-narrator-look`): один
 * фото-проход (одежда и makeup — в одном варианте) плюс проход стилизации,
 * если режим рассказчика — скетч. `null` — у модели нет ставки.
 */
export function storyLookPrice(
  mode: NarratorMode = 'photo',
  env: NodeJS.ProcessEnv = process.env,
): NarratorLookPrice | null {
  return narratorLookPrice(
    mode === 'photo'
      ? [GEMINI_IMAGE_MODEL]
      : [GEMINI_IMAGE_MODEL, GEMINI_SKETCH_MODEL],
    env,
  );
}
/** Анимация допустима только для преамбулы (WP4/ST-P3) и не длиннее её. */
export const STORY_ANIMATION_MAX_SECONDS = 20;

/**
 * Котировка видеоанимации. Сейчас провайдера нет (Hedra выключена решением
 * владельца), поэтому `provider: null, available: false`. Будущий адаптер
 * обязан вернуть цену за конкретные секунды ПРЕАМБУЛЫ, срок действия и резерв;
 * включать анимацию без такой котировки запрещено (`assertStoryAnimationAllowed`).
 */
export interface StoryAnimationQuote {
  provider: string | null;
  available: boolean;
  /** Секунды анимации — только преамбула, не длина сказки. */
  seconds: number;
  costMicroUsd: number | null;
  reserveMicroUsd: number | null;
  quotedAt: string | null;
  expiresAt: string | null;
  reason: string | null;
}
export function storyAnimationQuote(): StoryAnimationQuote {
  return {
    provider: null,
    available: false,
    seconds: 0,
    costMicroUsd: null,
    reserveMicroUsd: null,
    quotedAt: null,
    expiresAt: null,
    reason:
      'Видеоанимации нет: провайдер выключен. Используется статичный мастер и иллюстрации.',
  };
}
/**
 * Гард перед включением анимации: нужна действующая котировка провайдера,
 * секунды не больше преамбулы (≤20 с) и резерв, укладывающийся в остаток
 * бюджета. Возвращает резерв котировки. Пока провайдера нет — всегда 409.
 */
export function assertStoryAnimationAllowed(
  quote: StoryAnimationQuote | null | undefined,
  input: {
    preambleSeconds: number;
    budgetMicroUsd: number;
    reservedMicroUsd: number;
    now?: Date;
  },
): number {
  if (!quote || !quote.available || !quote.provider)
    throw new ConflictException({
      code: 'STORY_ANIMATION_UNAVAILABLE',
      message:
        'Анимация недоступна: нет котировки видеопровайдера. Доступен статичный мастер.',
    });
  if (
    quote.costMicroUsd === null ||
    quote.reserveMicroUsd === null ||
    !Number.isFinite(quote.reserveMicroUsd) ||
    quote.reserveMicroUsd < quote.costMicroUsd ||
    !quote.expiresAt ||
    Date.parse(quote.expiresAt) <= (input.now ?? new Date()).getTime()
  )
    throw new ConflictException({
      code: 'STORY_ANIMATION_QUOTE_INVALID',
      message: 'Котировка анимации устарела или без резерва — запросите новую',
    });
  if (
    quote.seconds <= 0 ||
    quote.seconds > STORY_ANIMATION_MAX_SECONDS ||
    quote.seconds > input.preambleSeconds + 0.5
  )
    throw new BadRequestException({
      code: 'STORY_ANIMATION_SCOPE',
      message:
        'Анимируется только короткая преамбула (до 20 с); основная часть — базовый видеопакет',
    });
  if (input.reservedMicroUsd + quote.reserveMicroUsd > input.budgetMicroUsd)
    throw new BadRequestException({
      code: 'STORY_ANIMATION_OVER_BUDGET',
      message: 'Резерв анимации не помещается в выбранный бюджет',
    });
  return quote.reserveMicroUsd;
}

export type StoryEstimateLineId =
  | 'voice'
  | 'image'
  | 'animation'
  | 'assembly'
  | 'qa';
export type StoryEstimateLine = {
  id: StoryEstimateLineId;
  label: string;
  /** included — входит в итог; not-selected — 0, пока не выбрано; unavailable — нет провайдера; not-included — вне этого заказа. */
  status: 'included' | 'not-selected' | 'unavailable' | 'not-included';
  /** Ожидаемая стоимость по внутреннему прайсу (оценка). */
  costMicroUsd: number;
  /** Консервативный резерв до платного вызова. */
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
  version: 1;
  currency: 'USD';
  basis: 'internal-estimate';
  pricingVersion: string;
  reserveMultiplier: number;
  lines: StoryEstimateLine[];
  totalCostMicroUsd: number;
  totalReserveMicroUsd: number;
  /** Часть резерва, которую фиксирует создание черновика (аудио). */
  audioReserveMicroUsd: number;
  videoReserveMicroUsd: number;
  budgetMicroUsd: number;
  remainingMicroUsd: number;
  overByMicroUsd: number;
  withinBudget: boolean;
  speech: {
    mainSeconds: number;
    giftNoteSeconds: number;
    preambleSeconds: number;
    outroSeconds: number;
  };
  animation: StoryAnimationQuote;
  policy: string;
};
export type StoryEstimateInput = {
  /** Основной текст редакции (заголовок + главы). */
  mainChars: number;
  /** Нормализованная реплика о подарке; 0 — нет реплики. */
  giftNoteChars?: number;
  budgetMicroUsd: number;
  /** Видео «Репки»: преамбула + сборка + проверка MP4. */
  video?: null | {
    preambleChars: number;
    /**
     * parent — основная речь пересинтезируется семейным голосом, а реплика
     * о подарке (если есть) — отдельным сегментом (WP4: у Nova она уже
     * внутри одобренной MP3 и повторно не синтезируется).
     */
    voice?: 'nova' | 'parent';
    /** Завершение видео (≤180), синтезируется отдельным сегментом любым голосом. */
    outroChars?: number;
  };
  look?: {
    outfit?: boolean;
    makeup?: boolean;
    /** Режим рассказчика: photo — один проход; скетч — плюс стилизация. */
    mode?: NarratorMode;
    /** Такой вариант уже есть (WP5 переиспользует по configHash) — строка 0. */
    existing?: boolean;
  };
  animation?: StoryAnimationQuote | null;
};
const seconds = (chars: number) =>
  Math.round((chars / STORY_SPEECH_CHARS_PER_SECOND) * 10) / 10;

/**
 * Р-ST-WP3-7. Смета по строкам. Резервы повторяют действующие формулы
 * (`storyAudioReservation`, `storyVideoReserve`) — тест сверяет суммы.
 * Длинный рассказ не превращается в анимацию каждой секунды: строка
 * анимации зависит только от преамбулы и сейчас `unavailable`.
 */
export function storyEstimate(input: StoryEstimateInput): StoryEstimate {
  const note = Math.max(0, input.giftNoteChars ?? 0);
  const audioChars = input.mainChars + (note ? note + 2 : 0);
  const mainTts = ttsCost(input.mainChars + 80);
  const noteTts = note ? ttsCost(note + 2) : 0;
  const audioTts = ttsCost(audioChars + 80);
  const video = input.video ?? null;
  const preambleChars = video ? Math.max(0, video.preambleChars) : 0;
  const parentMain = video?.voice === 'parent' ? input.mainChars : 0;
  // B-S3-4: the same characters `StoryVideoService` reserves for — synth
  // segments (intro + parent gift note + outro) plus the parent main speech,
  // priced as ONE sum exactly like `storyVideoReserve(synth, main)`.
  const parentNote = video?.voice === 'parent' ? note : 0;
  const outroChars = video ? Math.max(0, video.outroChars ?? 0) : 0;
  const videoTts = video
    ? ttsCost(preambleChars + parentNote + outroChars + parentMain)
    : 0;
  const preambleTts = video && preambleChars ? ttsCost(preambleChars) : 0;
  const assembly = estimateCost('ffmpeg-api', {});
  if (assembly.unpriced) throw new Error('Story assembly rate unavailable');
  const qaRate = (s: number) =>
    estimateCost('soniox-stt-async', { seconds: s }).costMicroUsd;
  const lookSelected = !!(input.look?.outfit || input.look?.makeup);
  const lookExisting = lookSelected && input.look?.existing === true;
  const lookPrice =
    lookSelected && !lookExisting ? storyLookPrice(input.look?.mode) : null;
  const lookUnpriced = lookSelected && !lookExisting && !lookPrice;
  const animation = input.animation ?? storyAnimationQuote();
  const audioSeconds = seconds(audioChars);
  const videoSeconds = video
    ? seconds(preambleChars + input.mainChars + note + outroChars)
    : 0;

  const voiceItems: StoryEstimateLine['items'] = [
    {
      id: 'voice.main',
      label: 'Основная озвучка Nova (текст редакции)',
      characters: input.mainChars,
      seconds: seconds(input.mainChars),
      costMicroUsd: mainTts,
    },
  ];
  if (note)
    voiceItems.push({
      id: 'voice.giftNote',
      label: 'Реплика о подарке',
      characters: note,
      seconds: seconds(note),
      costMicroUsd: noteTts,
    });
  if (video)
    voiceItems.push({
      id: 'voice.preamble',
      label: 'Преамбула видео',
      characters: preambleChars,
      seconds: seconds(preambleChars),
      costMicroUsd: preambleTts,
    });
  if (parentMain)
    voiceItems.push({
      id: 'voice.parentMain',
      label: 'Основная речь семейным голосом',
      characters: parentMain,
      seconds: seconds(parentMain),
      costMicroUsd: ttsCost(parentMain),
    });
  if (parentNote)
    voiceItems.push({
      id: 'voice.parentGiftNote',
      label: 'Реплика о подарке семейным голосом (отдельный сегмент видео)',
      characters: parentNote,
      seconds: seconds(parentNote),
      costMicroUsd: ttsCost(parentNote),
    });
  if (outroChars)
    voiceItems.push({
      id: 'voice.outro',
      label: 'Завершение видео',
      characters: outroChars,
      seconds: seconds(outroChars),
      costMicroUsd: ttsCost(outroChars),
    });
  const voiceReserve =
    audioTts * STORY_RESERVE_MULTIPLIER + videoTts * STORY_RESERVE_MULTIPLIER;
  const lookCost = lookPrice?.estimateMicroUsd ?? 0;
  const lookWhat = [
    input.look?.outfit ? 'одежда' : null,
    input.look?.makeup ? 'makeup' : null,
  ]
    .filter(Boolean)
    .join(' + ');
  const assemblyReserve = video
    ? Math.max(STORY_ASSEMBLY_MIN_RESERVE_MICRO_USD, assembly.costMicroUsd * 50)
    : 0;
  const qaReserve = STORY_QA_RESERVE_MICRO_USD * (video ? 2 : 1);
  const lines: StoryEstimateLine[] = [
    {
      id: 'voice',
      label: 'Голос (Resemble TTS)',
      status: 'included',
      costMicroUsd: voiceItems.reduce((s, i) => s + i.costMicroUsd, 0),
      reserveMicroUsd: voiceReserve,
      items: voiceItems,
      note: 'Резерв — 4× внутренней оценки синтеза; одна попытка, без автоматических повторов.',
    },
    {
      id: 'image',
      label: 'Образ рассказчика: одежда / makeup',
      status: !lookSelected
        ? 'not-selected'
        : lookUnpriced
          ? 'unavailable'
          : 'included',
      costMicroUsd: lookCost,
      // Резерв WP5: 2× оценки на каждый вызов изображения (`narratorLookPrice`).
      reserveMicroUsd: lookPrice?.reserveMicroUsd ?? 0,
      items: (lookPrice?.perCall ?? []).map((call, i) => ({
        id: i === 0 ? 'image.look' : 'image.style',
        label:
          i === 0 ? `Вариант образа (${lookWhat})` : 'Стилизация под скетч',
        costMicroUsd: call.estimateMicroUsd,
      })),
      note: !lookSelected
        ? '0, пока производный образ не выбран.'
        : lookExisting
          ? 'Такой вариант уже есть — переиспользуется без новой генерации и оплаты.'
          : lookUnpriced
            ? 'Нет ставки модели изображений — генерация образа выключена.'
            : 'Оценка по прайсу модели изображений (операция story-narrator-look); одежда и makeup — один вариант, резерв 2× на вызов, без автоматических повторов.',
    },
    {
      id: 'animation',
      label: 'Анимация преамбулы',
      status: animation.available ? 'included' : 'unavailable',
      costMicroUsd: animation.available ? (animation.costMicroUsd ?? 0) : 0,
      reserveMicroUsd: animation.available
        ? (animation.reserveMicroUsd ?? 0)
        : 0,
      items: [],
      note:
        animation.reason ??
        'Анимируется только преамбула; основная часть — базовый пакет.',
    },
    {
      id: 'assembly',
      label: 'Сборка видео (FFmpeg API)',
      status: video ? 'included' : 'not-included',
      costMicroUsd: video ? assembly.costMicroUsd : 0,
      reserveMicroUsd: assemblyReserve,
      items: [],
      note: video
        ? 'Один статичный мастер + аудиодорожки; резерв не ниже $0.50.'
        : 'Аудиоподарок без видео; видео «Репки» собирается отдельно после проверки озвучки.',
    },
    {
      id: 'qa',
      label: 'Проверка речи (Soniox)',
      status: 'included',
      costMicroUsd: qaRate(audioSeconds) + (video ? qaRate(videoSeconds) : 0),
      reserveMicroUsd: qaReserve,
      items: [],
      note: video ? 'Две проверки: MP3 и итоговый MP4.' : 'Одна проверка MP3.',
    },
  ];
  const totalCost = lines.reduce(
    (s, l) => s + (l.status === 'included' ? l.costMicroUsd : 0),
    0,
  );
  const totalReserve = Math.ceil(
    lines.reduce((s, l) => s + l.reserveMicroUsd, 0),
  );
  const audioReserve = storyAudioReservationForChars(audioChars);
  const budget = Math.max(0, Math.round(input.budgetMicroUsd));
  return {
    version: 1,
    currency: 'USD',
    basis: 'internal-estimate',
    pricingVersion: PRICING_VERSION,
    reserveMultiplier: STORY_RESERVE_MULTIPLIER,
    lines,
    totalCostMicroUsd: totalCost,
    totalReserveMicroUsd: totalReserve,
    audioReserveMicroUsd: audioReserve,
    videoReserveMicroUsd: video
      ? Math.ceil(
          videoTts * STORY_RESERVE_MULTIPLIER +
            assemblyReserve +
            STORY_QA_RESERVE_MICRO_USD,
        )
      : 0,
    budgetMicroUsd: budget,
    remainingMicroUsd: Math.max(0, budget - totalReserve),
    overByMicroUsd: Math.max(0, totalReserve - budget),
    withinBudget: totalReserve <= budget,
    speech: {
      mainSeconds: seconds(input.mainChars),
      giftNoteSeconds: seconds(note),
      preambleSeconds: seconds(preambleChars),
      outroSeconds: seconds(outroChars),
    },
    animation,
    policy:
      'Длинный рассказ не оплачивается как анимация каждой секунды: анимируется только короткая преамбула (когда появится провайдер), основная часть — базовый видеопакет или иллюстрации.',
  };
}
