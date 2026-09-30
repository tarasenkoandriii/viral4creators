/**
 * Контракт разбора голосовой реплики мастера поздравления — этап K3 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.2, §4А.7.
 *
 * Зеркало ответа `POST …/understand` (сервер —
 * `backend/src/common/greeting-voice-intent.ts`). Отдельным файлом без
 * зависимостей, а не в `services/`: чистая логика (`voice-intents.ts`,
 * `voice-confirm.ts`, `voice-brief.ts`) проверяется скриптами без
 * браузера и не должна тянуть за собой axios.
 */

// Закрытые списки — массивами, а не только союзами типов: тест
// `scripts/voice-sync.test.ts` сверяет их с серверными перебором (тип при
// сборке исчезает, массив — нет), и расхождение видно до выкладки.

export const VOICE_STATUSES = [
  'ok',
  'not-heard',
  'unavailable',
  'budget-exhausted',
] as const;
export type VoiceStatus = (typeof VOICE_STATUSES)[number];

/**
 * Причина отказа (изменение контракта 2, финальный аудит): `status`
 * говорит, что делать с репликой, `reason` — что делать с микрофоном.
 */
export const VOICE_REASONS = [
  'operator-off',
  'login-required',
  'account-limit',
  'too-long',
] as const;
export type VoiceReason = (typeof VOICE_REASONS)[number];

export interface VoiceField {
  /** `data-qa` хук поля — тот же, по которому поле находит обучалка. */
  target: string;
  /** Список — код варианта, дата — ISO `YYYY-MM-DD`, текст — строка. */
  value: string | boolean;
  /** Подпись поля для карточки — на языке интерфейса. */
  label: string;
}

export const VOICE_COMMANDS = [
  'tone-serious',
  'tone-lighter',
  'no-jokes',
  'shorter',
  'regenerate-script',
  'other-music',
] as const;
export type VoiceCommand = (typeof VOICE_COMMANDS)[number];

export const VOICE_STEP_IDS = [
  'brief',
  'references',
  'script',
  'video',
] as const;
export type VoiceStepId = (typeof VOICE_STEP_IDS)[number];

export const VOICE_NAVIGATE_TARGETS = [
  'next',
  'back',
  ...VOICE_STEP_IDS,
] as const;
export type VoiceNavigateTarget = (typeof VOICE_NAVIGATE_TARGETS)[number];

export type VoiceIntent =
  | { kind: 'fill'; fields: VoiceField[] }
  | { kind: 'command'; command: VoiceCommand; args?: Record<string, string> }
  | { kind: 'navigate'; to: VoiceNavigateTarget }
  | { kind: 'help' }
  | { kind: 'consent'; phrase: string }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'unknown' };

export interface VoiceUnderstandResult {
  status: VoiceStatus;
  transcript: string | null;
  language: string | null;
  intent: VoiceIntent | null;
  confidence: number;
  reply: string | null;
  scriptMismatch: boolean;
  /** Причина отказа; нет поля или `null` — отказа нет (старый сервер). */
  reason?: VoiceReason | null;
}

/**
 * Значения брифа НА ЭКРАНЕ, ещё не сохранённые (изменение контракта 1):
 * сервер сверяет сказанное с тем, что человек видит, а не с тем, что
 * успело сохраниться. Ключи — поля DTO брифа; сервер проверяет их теми
 * же ограничениями и неверное молча игнорирует.
 */
export const VOICE_CURRENT_FIELDS = [
  'occasion',
  'customOccasionText',
  'mood',
  'tone',
  'recipientName',
  'senderName',
  'personalMessage',
  'scriptLanguage',
  'presenterProvider',
  'resolution',
  'occasionDate',
] as const;
export type VoiceCurrentField = (typeof VOICE_CURRENT_FIELDS)[number];
export type VoiceScreenCurrent = {
  [K in VoiceCurrentField]?: string | null;
};

/** Тело запроса understand (без `pathname` — его ставит клиент API). */
export interface VoiceUnderstandContext {
  screen: { step: VoiceStepId; card?: string };
  /**
   * Карточка «я понял так» на экране — чтобы сервер понял «да», «нет» и
   * «исправь имя» как ответ на неё, а не как новую реплику.
   */
  pending?: { kind: 'fill'; fields: VoiceField[] };
  /** Бриф на экране — его текущие значения (`VoiceScreenCurrent`). */
  current?: VoiceScreenCurrent;
}
