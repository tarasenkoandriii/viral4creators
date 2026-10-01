/**
 * Что переозвучка должна записать в снимок брендбука ДО платного синтеза
 * (`RevoicePanel`). Вынесено из панели, чтобы правило проверялось тестом:
 * ошибка здесь стоит денег — синтез уходит со старым голосом или старым
 * режимом звука.
 *
 * Режим звука добавлен 01.10.2026: ролик Grok в режиме `voiceover` вышел
 * с двумя голосами (модель заговорила своим, наш лёг поверх приглушённой
 * дорожки), а сменить режим у готового ролика было негде.
 */
import type { BrandSnapshotInput } from '../services/projects-api';
import type { ExplicitTtsProvider } from './tts-provider-choice';
import type { VoiceMode } from '../types';

export function revoiceSnapshotPatch(input: {
  /** Поздравление — снимка брендбука нет, править нечего. */
  isGreeting: boolean;
  snapshot: {
    ttsVoiceId?: string | null;
    ttsProvider?: string | null;
    voiceMode?: VoiceMode | null;
  } | null;
  ttsVoiceId: string;
  providerOverride: ExplicitTtsProvider | null;
  voiceMode: VoiceMode;
}): BrandSnapshotInput | null {
  if (input.isGreeting) return null;
  const snap = input.snapshot;
  const voiceChanged =
    input.ttsVoiceId.trim() !== (snap?.ttsVoiceId ?? '').trim() ||
    (!!input.providerOverride &&
      input.providerOverride !== (snap?.ttsProvider ?? null));
  // Сравниваем с тем же значением, с которого селектор стартует: `veo`
  // переозвучку не проходит вовсе, всё прочее — `voiceover`.
  const currentMode: VoiceMode =
    snap?.voiceMode === 'dub' ? 'dub' : 'voiceover';
  const modeChanged = input.voiceMode !== currentMode;
  if (!voiceChanged && !modeChanged) return null;
  return {
    ...(voiceChanged
      ? {
          ttsVoiceId: input.ttsVoiceId.trim() || null,
          ...(input.providerOverride
            ? { ttsProvider: input.providerOverride }
            : {}),
        }
      : {}),
    ...(modeChanged ? { voiceMode: input.voiceMode } : {}),
  };
}
