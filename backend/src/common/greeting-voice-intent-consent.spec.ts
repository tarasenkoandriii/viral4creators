/**
 * Согласие на генерацию голосом — этап K7 ТЗ
 * `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.7.4.
 *
 * Отдельный спек от основного (`greeting-voice-intent.spec.ts`): здесь
 * только то, от чего зависит клиентская сводка перед генерацией
 * (`frontend/src/lib/voice-consent.ts`) — закрытый список на всех пяти
 * языках, порог и «нет» без карточки как отмена сводки.
 */
import {
  CANCEL_PHRASES,
  CONFIRM_PHRASES,
  CONSENT_CONFIDENCE_MIN,
  CONSENT_PHRASES,
  VoiceUnderstandContext,
  isConsentPhrase,
  normalizeModelAnswer,
  resolveIntent,
} from './greeting-voice-intent';
import { SUPPORTED_LOCALES } from './locale';

function ctx(
  over: Partial<VoiceUnderstandContext> = {},
): VoiceUnderstandContext {
  return {
    brief: {
      occasion: 'BIRTHDAY',
      customOccasionText: null,
      occasionRegister: null,
      registerSource: null,
      userOccasionRegister: null,
      scriptLanguage: 'ru',
      recipientName: 'Марина',
      senderName: null,
      tone: 'WARM',
      personalMessage: null,
      presenterProvider: 'grok',
      resolution: '720p',
      occasionDate: null,
    },
    presenters: ['grok'],
    maxResolution: '720p',
    scope: 'session',
    hasScript: true,
    screen: { step: 'video' },
    pending: null,
    uiLocale: 'ru',
    replyLocale: 'ru',
    ...over,
  } as VoiceUnderstandContext;
}

const answer = (kind: string, confidence: number) =>
  normalizeModelAnswer({ kind, confidence });

describe('K7: согласие голосом', () => {
  it('закрытый список есть на всех пяти языках и не пересекается с «да»/«нет»', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(CONSENT_PHRASES[l].length).toBeGreaterThan(0);
      for (const p of CONSENT_PHRASES[l]) {
        expect(CONFIRM_PHRASES).not.toContain(p);
        expect(CANCEL_PHRASES).not.toContain(p);
      }
    }
    for (const w of ['да', 'ага', 'ок', 'yes', 'ja', 'sí', 'так']) {
      expect(isConsentPhrase(w)).toBe(false);
    }
  });

  it('«генерируй видео» и его пары на пяти языках — согласие', () => {
    for (const p of [
      'Генерируй видео',
      'создавай видео',
      'генеруй відео',
      'створюй відео',
      'Generate video, please',
      'generiere Video',
      'genera vídeo',
      'genera video',
    ]) {
      expect(isConsentPhrase(p)).toBe(true);
    }
    // Не «содержит»: отрицание с той же фразой — не согласие.
    expect(isConsentPhrase('не генерируй видео')).toBe(false);
  });

  it('фраза из списка с уверенностью у порога — consent; ниже — переспрос', () => {
    const ok = resolveIntent(
      answer('consent', CONSENT_CONFIDENCE_MIN),
      'Генерируй',
      ctx(),
    );
    expect(ok.intent).toEqual({ kind: 'consent', phrase: 'генерируй' });
    const low = resolveIntent(
      answer('consent', CONSENT_CONFIDENCE_MIN - 0.01),
      'генерируй',
      ctx(),
    );
    expect(low.intent.kind).toBe('unknown');
    expect(low.reply).toContain('генерируй');
  });

  it('«нет»/«отмена» целой репликой без карточки — cancel (закрыть сводку)', () => {
    for (const phrase of ['нет', 'Отмена, пожалуйста', 'cancel', 'nein']) {
      expect(
        resolveIntent(answer('unknown', 0.3), phrase, ctx()).intent,
      ).toEqual({ kind: 'cancel' });
    }
    // «Нет, не генерируй пока» — не целая отмена: к модели, не сюда.
    expect(
      resolveIntent(answer('unknown', 0.9), 'нет не генерируй пока', ctx())
        .intent.kind,
    ).toBe('unknown');
  });

  it('«да» без карточки — не согласие и не отмена', () => {
    const r = resolveIntent(answer('confirm', 0.99), 'да', ctx());
    expect(r.intent.kind).toBe('unknown');
  });
});
