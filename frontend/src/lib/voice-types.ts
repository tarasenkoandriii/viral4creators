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

export type VoiceStatus =
  | 'ok'
  | 'not-heard'
  | 'unavailable'
  | 'budget-exhausted';

export interface VoiceField {
  /** `data-qa` хук поля — тот же, по которому поле находит обучалка. */
  target: string;
  /** Список — код варианта, дата — ISO `YYYY-MM-DD`, текст — строка. */
  value: string | boolean;
  /** Подпись поля для карточки — на языке интерфейса. */
  label: string;
}

export type VoiceCommand =
  | 'tone-serious'
  | 'tone-lighter'
  | 'no-jokes'
  | 'shorter'
  | 'regenerate-script'
  | 'other-music';

export type VoiceStepId = 'brief' | 'references' | 'script' | 'video';

export type VoiceIntent =
  | { kind: 'fill'; fields: VoiceField[] }
  | { kind: 'command'; command: VoiceCommand; args?: Record<string, string> }
  | {
      kind: 'navigate';
      to: 'next' | 'back' | 'brief' | 'references' | 'script' | 'video';
    }
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
}

/** Тело запроса understand (без `pathname` — его ставит клиент API). */
export interface VoiceUnderstandContext {
  screen: { step: VoiceStepId; card?: string };
  /**
   * Карточка «я понял так» на экране — чтобы сервер понял «да», «нет» и
   * «исправь имя» как ответ на неё, а не как новую реплику.
   */
  pending?: { kind: 'fill'; fields: VoiceField[] };
}
