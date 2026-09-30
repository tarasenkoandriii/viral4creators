/**
 * Клонирование голоса пользователем (этап 73, TODO п.32,
 * doc/AI-ACTORS-NO-REFERENCE-SPEC.md §3, doc/TTS-PROVIDER-ALTERNATIVES-SPEC.md
 * §4.3) — mirrors backend/prisma/schema.prisma `UserVoice`. Асинхронный
 * поток Resemble: TRAINING сразу после отправки образца, READY/FAILED —
 * по вебхуку или poll-фоллбеку (§5.4 TTS-спека).
 */

export type UserVoiceStatus = 'training' | 'ready' | 'failed';

export interface UserVoiceView {
  id: string;
  label: string;
  status: UserVoiceStatus;
  /** Resemble voice_uuid — то, что подставляется как ttsVoiceId после READY. */
  resembleVoiceId: string | null;
  error: string | null;
  /**
   * Голос персоны «Я в кадре» (ТЗ TZ-Greeting-2.0 §4.6): один на персону
   * и вне лимита клонов. `null` — обычный клон.
   */
  personaId?: string | null;
  createdAt: string;
  updatedAt: string;
}
