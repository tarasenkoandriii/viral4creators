/**
 * Проактивная речь помощника — чистые правила (ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4А.2 п.1, п.5,
 * §4А.4, §4А.7.4; этап K4).
 *
 * Помощник говорит сам по четырём поводам сверх подсказки на шаге:
 * отказ сервера (тон, проверка содержания, лимит, стена), готовый
 * ролик, сводка перед согласием на генерацию и ответ на вопрос о шаге.
 *
 * ## Главное правило: текст собирает СЕРВЕР
 *
 * Клиент присылает только ВИД реплики и коды (`refusal: 'tone'`,
 * `topic: 'how-long'`) — никогда текст. Иначе маршрут озвучки стал бы
 * синтезатором произвольного текста за счёт потолка голоса человека и
 * общего бюджета советника, а в общий аудиокеш попадало бы что угодно.
 * Здесь — шаблоны на пяти языках и сборка фразы из фактов; сервис
 * (`proactive-speech.service.ts`) только читает состояние и озвучивает
 * через тот же аудиокеш и те же потолки, что подсказка
 * (`HintAudioService.synthesizeCached`).
 *
 * Фразы короткие и спокойные, без восклицаний: их слышат и на
 * соболезновании, и все они проходят `speechForRegister` (§3.7, «коротко»
 * в траурном).
 */

import type { SupportedLocale } from '../../common/locale';
import {
  VOICE_QUESTION_TOPICS,
  VOICE_REFUSAL_CODES,
  type VoiceQuestionTopic,
  type VoiceRefusalCode,
} from '../../common/greeting-voice-contract';
import {
  OCCASION_LABELS,
  PRESENTER_HEDRA_LABEL,
  TONE_LABELS,
} from '../../common/greeting-voice-intent-labels';
import { consentHint } from '../../common/greeting-voice-phrases';
import type { RenderCharge } from '../../common/render-charge';

/** Виды реплики — закрытый список маршрута `speak`. */
export const SPEAK_KINDS = [
  'refusal',
  'video-ready',
  'consent-summary',
  'answer',
] as const;
export type SpeakKind = (typeof SPEAK_KINDS)[number];

export { VOICE_QUESTION_TOPICS, VOICE_REFUSAL_CODES };
export type { VoiceQuestionTopic, VoiceRefusalCode };

/** Запрос речи — уже проверенный DTO. */
export type SpeakRequest =
  | { kind: 'refusal'; refusal: VoiceRefusalCode; locale: SupportedLocale }
  | { kind: 'video-ready'; locale: SupportedLocale }
  | { kind: 'consent-summary'; locale: SupportedLocale }
  /**
   * `topic: null` — вопрос без факта: помощник ВСЛУХ говорит «не знаю,
   * посмотрите справку» (CONTRACT5) — фраза та же, что строка разбора.
   */
  | {
      kind: 'answer';
      topic: VoiceQuestionTopic | null;
      locale: SupportedLocale;
    };

/**
 * Ключ речи в аудиокеше (столбец `hintKey` у `WizardHintAudio`).
 *
 * Только вид и коды — БЕЗ личных данных: имя получателя из сводки
 * попадает в хеш файла через сам текст (`hintAudioKey`), но не в
 * читаемый столбец. Префикс `speak|` не пересекается с ключами подсказок
 * (`СЦЕНАРИЙ|шаг|…`), так что разбор кеша различает два источника.
 */
export function speechCacheKey(req: SpeakRequest): string {
  const detail =
    req.kind === 'refusal'
      ? req.refusal
      : req.kind === 'answer'
        ? (req.topic ?? 'unknown')
        : '';
  return ['speak', req.kind, detail, req.locale].join('|');
}

// ── Шаблоны ─────────────────────────────────────────────────────────────

interface SpeechTexts {
  videoReady: string;
  /** Тон не для повода; `allowed` — подписи доступных тонов. */
  tone: (allowed: string[]) => string;
  toneGeneric: string;
  quota: string;
  locked: string;
  summary: (p: {
    recipient: string;
    occasion: string;
    quality: string;
    cost: string;
    phrase: string;
  }) => string;
  costCredit: (balance: number) => string;
  costIncluded: string;
  presenterGrok: string;
  /** Ведущий — образ персоны автора (этап G): «вы в кадре». */
  presenterPersona: string;
}

const SPEECH: Readonly<Record<SupportedLocale, SpeechTexts>> = {
  ru: {
    videoReady: 'Ролик готов. Его можно посмотреть и отправить.',
    tone: (a) => `Этот тон не подходит к поводу. Подойдут: ${a.join(', ')}.`,
    toneGeneric: 'Этот тон не подходит к поводу. Выберите другой.',
    quota:
      'Суточный лимит расходов исчерпан, запустить ролик сейчас нельзя. Всё, что вы заполнили, сохранено.',
    locked:
      'Чтобы запустить ролик, нужен доступ. Чем он открывается, написано на экране.',
    summary: (p) =>
      `Проверьте: ${p.recipient}, ${p.occasion}, ${p.quality}. Спишется: ${p.cost}. Чтобы запустить, скажите «${p.phrase}» ещё раз.`,
    costCredit: (b) => `одна генерация из ${b} доступных`,
    costIncluded: 'генерации не спишутся, ролик входит в ваш доступ',
    presenterGrok: 'без ведущего в кадре',
    presenterPersona: 'вы в кадре',
  },
  uk: {
    videoReady: 'Ролик готовий. Його можна переглянути й надіслати.',
    tone: (a) => `Цей тон не підходить до приводу. Підійдуть: ${a.join(', ')}.`,
    toneGeneric: 'Цей тон не підходить до приводу. Оберіть інший.',
    quota:
      'Добовий ліміт витрат вичерпано, запустити ролик зараз не можна. Усе, що ви заповнили, збережено.',
    locked:
      'Щоб запустити ролик, потрібен доступ. Чим він відкривається, написано на екрані.',
    summary: (p) =>
      `Перевірте: ${p.recipient}, ${p.occasion}, ${p.quality}. Спишеться: ${p.cost}. Щоб запустити, скажіть «${p.phrase}» ще раз.`,
    costCredit: (b) => `одна генерація з ${b} доступних`,
    costIncluded: 'генерації не спишуться, ролик входить у ваш доступ',
    presenterGrok: 'без ведучого в кадрі',
    presenterPersona: 'ви в кадрі',
  },
  en: {
    videoReady: 'The video is ready. You can watch and send it.',
    tone: (a) =>
      `This tone does not suit the occasion. These fit: ${a.join(', ')}.`,
    toneGeneric: 'This tone does not suit the occasion. Please choose another.',
    quota:
      'The daily spending limit is used up, so the video cannot start now. Everything you filled in is saved.',
    locked:
      'You need access to start the video. The screen shows how to unlock it.',
    summary: (p) =>
      `Please check: ${p.recipient}, ${p.occasion}, ${p.quality}. Will use: ${p.cost}. To start, say "${p.phrase}" again.`,
    costCredit: (b) => `one generation of ${b} available`,
    costIncluded: 'no generations used, the video is included in your access',
    presenterGrok: 'no on-screen presenter',
    presenterPersona: 'you on screen',
  },
  de: {
    videoReady: 'Das Video ist fertig. Sie können es ansehen und versenden.',
    tone: (a) =>
      `Dieser Ton passt nicht zum Anlass. Passend sind: ${a.join(', ')}.`,
    toneGeneric:
      'Dieser Ton passt nicht zum Anlass. Bitte wählen Sie einen anderen.',
    quota:
      'Das Tageslimit ist ausgeschöpft, das Video kann jetzt nicht starten. Alles, was Sie ausgefüllt haben, ist gespeichert.',
    locked:
      'Zum Starten des Videos brauchen Sie Zugang. Wie er freigeschaltet wird, steht auf dem Bildschirm.',
    summary: (p) =>
      `Bitte prüfen: ${p.recipient}, ${p.occasion}, ${p.quality}. Verbrauch: ${p.cost}. Zum Starten sagen Sie noch einmal „${p.phrase}“.`,
    costCredit: (b) => `eine Generierung von ${b} verfügbaren`,
    costIncluded:
      'keine Generierung wird abgezogen, das Video ist in Ihrem Zugang enthalten',
    presenterGrok: 'ohne Moderator im Bild',
    presenterPersona: 'Sie im Bild',
  },
  es: {
    videoReady: 'El vídeo está listo. Puedes verlo y enviarlo.',
    tone: (a) =>
      `Este tono no encaja con la ocasión. Encajan: ${a.join(', ')}.`,
    toneGeneric: 'Este tono no encaja con la ocasión. Elige otro.',
    quota:
      'Se ha agotado el límite diario de gasto, el vídeo no puede empezar ahora. Todo lo que rellenaste está guardado.',
    locked:
      'Para empezar el vídeo necesitas acceso. En pantalla se explica cómo desbloquearlo.',
    summary: (p) =>
      `Revisa: ${p.recipient}, ${p.occasion}, ${p.quality}. Se usará: ${p.cost}. Para empezar, di «${p.phrase}» otra vez.`,
    costCredit: (b) => `una generación de ${b} disponibles`,
    costIncluded:
      'no se usa ninguna generación, el vídeo está incluido en tu acceso',
    presenterGrok: 'sin presentador en pantalla',
    presenterPersona: 'tú en pantalla',
  },
};

export function videoReadySpeech(locale: SupportedLocale): string {
  return SPEECH[locale].videoReady;
}

/**
 * Отказ по тону: доступные тоны — подписями, как на экране. Списка нет
 * (брифа нет) — общая фраза без перечня: называть варианты наугад нельзя.
 */
export function toneRefusalSpeech(
  locale: SupportedLocale,
  allowedTones: readonly string[] | null,
): string {
  const t = SPEECH[locale];
  const labels = (allowedTones ?? [])
    .map((tone) => TONE_LABELS[locale][tone])
    .filter((l): l is string => !!l)
    .map((l) => `«${l}»`);
  return labels.length ? t.tone(labels) : t.toneGeneric;
}

export function quotaSpeech(locale: SupportedLocale): string {
  return SPEECH[locale].quota;
}

export function lockedSpeech(locale: SupportedLocale): string {
  return SPEECH[locale].locked;
}

/** Что спишет старт — словами; `null` — цену назвать нельзя. */
export function chargeSpeech(
  locale: SupportedLocale,
  charge: RenderCharge,
): string | null {
  const t = SPEECH[locale];
  switch (charge.kind) {
    case 'credit':
      return t.costCredit(charge.balance);
    case 'included':
      return t.costIncluded;
    case 'unknown':
      return null;
  }
}

/**
 * Сколько знаков ЧУЖОГО текста (имя получателя, свой повод) помощник
 * произносит в сводке (CONTRACT5, принято явно). Имя в 300 знаков вслух —
 * минута речи, а полный текст всё равно на карточке сводки у кнопки.
 */
export const SPEECH_USER_TEXT_MAX = 60;

/**
 * Пользовательский текст для речи: одной строкой и не длиннее
 * `SPEECH_USER_TEXT_MAX` — по границе слова, с многоточием.
 */
export function speakUserText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= SPEECH_USER_TEXT_MAX) return flat;
  const cut = flat.slice(0, SPEECH_USER_TEXT_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > SPEECH_USER_TEXT_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Сводка перед согласием (§4А.7.4, K7 → K4): кому, повод, качество и
 * СКОЛЬКО спишет. Те же четыре пункта и тот же порядок, что у карточки
 * сводки на экране (`voiceConsent.summaryLine` клиента). Без цены
 * сводки нет (`null`): «согласие без названной цены — не согласие», и
 * голосом его тоже не предлагают.
 */
export function consentSummarySpeech(
  locale: SupportedLocale,
  input: {
    recipient: string;
    occasion: string;
    customOccasion: string | null;
    resolution: string;
    presenter: string;
    /** Ведущий — образ персоны автора (снимок `presenter`, этап G). */
    persona?: boolean;
    charge: RenderCharge;
  },
): string | null {
  const t = SPEECH[locale];
  const cost = chargeSpeech(locale, input.charge);
  if (!cost) return null;
  const recipient = speakUserText(input.recipient);
  if (!recipient) return null;
  const occasion =
    input.occasion === 'OTHER' && input.customOccasion?.trim()
      ? speakUserText(input.customOccasion)
      : (OCCASION_LABELS[locale][input.occasion] ?? input.occasion);
  const presenter = input.persona
    ? t.presenterPersona
    : input.presenter === 'hedra'
      ? PRESENTER_HEDRA_LABEL[locale]
      : t.presenterGrok;
  return t.summary({
    recipient,
    occasion,
    quality: `${input.resolution}, ${presenter}`,
    cost,
    phrase: consentHint(locale),
  });
}
