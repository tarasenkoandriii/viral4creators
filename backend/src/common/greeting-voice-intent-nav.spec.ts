/**
 * K6 (§4А.7.2, §4А.7.3): навигация и справка голосом без платного
 * разбора — закрытые списки на пяти языках.
 */
import {
  CANCEL_PHRASES,
  CONFIRM_PHRASES,
  CONSENT_PHRASES,
  HELP_PHRASES,
  NAV_STEP_PHRASES,
  NAV_STEP_PREFIXES,
  NAV_STEP_WORDS,
  VOICE_NAVIGATE_TARGETS,
  normalizeModelAnswer,
  normalizeUtterance,
  quickNavigationAnswer,
  quickPendingAnswer,
} from './greeting-voice-intent';
import { SUPPORTED_LOCALES } from './locale';

describe('quickNavigationAnswer — справка', () => {
  it.each([
    ['Помощь!', 'ru'],
    ['Что здесь?', 'ru'],
    ['Как это работает?', 'ru'],
    ['Информация, пожалуйста', 'ru'],
    ['Як це працює?', 'uk'],
    ['Що тут?', 'uk'],
    ["What's this?", 'en'],
    ['How does this work?', 'en'],
    ['Wie funktioniert das?', 'de'],
    ['Hilfe, bitte!', 'de'],
    ['¿Cómo funciona?', 'es'],
    ['Ayuda, por favor', 'es'],
  ])('«%s» (%s) → help', (text) => {
    expect(quickNavigationAnswer(text)).toEqual({ kind: 'help' });
  });

  it('в каждом языке есть «помощь», «информация», «что здесь», «как это работает»', () => {
    const must: Record<string, string[]> = {
      ru: ['помощь', 'информация', 'что здесь', 'как это работает'],
      uk: ['допомога', 'інформація', 'що тут', 'як це працює'],
      en: ['help', 'information', 'whats here', 'how does this work'],
      de: ['hilfe', 'information', 'was ist hier', 'wie funktioniert das'],
      es: ['ayuda', 'información', 'qué hay aquí', 'cómo funciona'],
    };
    for (const l of SUPPORTED_LOCALES) {
      for (const p of must[l]) expect(HELP_PHRASES[l]).toContain(p);
    }
  });
});

describe('quickNavigationAnswer — шаги', () => {
  it.each([
    ['Дальше', 'next'],
    ['Вперёд!', 'next'],
    ['Назад', 'back'],
    ['Далі', 'next'],
    ['Next step, please', 'next'],
    ['Go back', 'back'],
    ['Weiter', 'next'],
    ['Zurück', 'back'],
    ['Siguiente', 'next'],
    ['Atrás', 'back'],
    ['К сценарию', 'script'],
    ['Перейди к брифу', 'brief'],
    ['Покажи фото', 'references'],
    ['Открой видео', 'video'],
    ['До сценарію', 'script'],
    ['Go to the script', 'script'],
    ['Zum Video', 'video'],
    ['Zeig mir die Fotos', 'references'],
    ['Ir al guion', 'script'],
    ['Llévame al vídeo', 'video'],
  ])('«%s» → navigate %s', (text, to) => {
    expect(quickNavigationAnswer(text)).toEqual({ kind: 'navigate', to });
  });

  it('только ЦЕЛАЯ реплика: диктовка с «дальше» уходит модели', () => {
    expect(quickNavigationAnswer('дальше напиши что она любит море')).toBe(
      null,
    );
    expect(quickNavigationAnswer('не надо назад')).toBe(null);
    expect(quickNavigationAnswer('')).toBe(null);
    expect(quickNavigationAnswer(null)).toBe(null);
  });

  it('цель — всегда из закрытого набора', () => {
    for (const l of SUPPORTED_LOCALES) {
      const phrases = [
        ...NAV_STEP_PHRASES[l].next,
        ...NAV_STEP_PHRASES[l].back,
        ...Object.values(NAV_STEP_WORDS[l]).flat(),
      ];
      for (const p of phrases) {
        const a = quickNavigationAnswer(p);
        expect(a?.kind).toBe('navigate');
        const to = a?.kind === 'navigate' ? a.to : null;
        expect(VOICE_NAVIGATE_TARGETS).toContain(to);
      }
    }
  });

  it('каждое имя шага работает с каждым глаголом своего языка', () => {
    for (const l of SUPPORTED_LOCALES) {
      for (const [to, words] of Object.entries(NAV_STEP_WORDS[l])) {
        for (const w of words) {
          for (const p of NAV_STEP_PREFIXES[l]) {
            expect(quickNavigationAnswer(p ? `${p} ${w}` : w)).toEqual({
              kind: 'navigate',
              to,
            });
          }
        }
      }
    }
  });
});

describe('списки K6 — непротиворечивы', () => {
  const all = (): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const l of SUPPORTED_LOCALES) {
      for (const p of HELP_PHRASES[l]) out.push([p, 'help']);
      for (const p of NAV_STEP_PHRASES[l].next) out.push([p, 'next']);
      for (const p of NAV_STEP_PHRASES[l].back) out.push([p, 'back']);
      for (const [to, words] of Object.entries(NAV_STEP_WORDS[l])) {
        for (const w of words) {
          for (const p of NAV_STEP_PREFIXES[l]) {
            out.push([p ? `${p} ${w}` : w, to]);
          }
        }
      }
    }
    return out;
  };

  it('одна фраза — одно значение во всех языках', () => {
    const seen = new Map<string, string>();
    for (const [p, meaning] of all()) {
      const prev = seen.get(p);
      if (prev !== undefined && prev !== meaning) {
        throw new Error(`«${p}»: ${prev} и ${meaning}`);
      }
      seen.set(p, meaning);
    }
  });

  it('фразы — в нормализованной форме (иначе никогда не совпадут)', () => {
    for (const [p] of all()) expect(normalizeUtterance(p)).toBe(p);
  });

  it('ни одна не пересекается с «да»/«нет»/согласием', () => {
    // «Назад» не должно становиться отменой карточки, а «дальше» —
    // согласием на платный рендер.
    const consent = SUPPORTED_LOCALES.flatMap((l) => CONSENT_PHRASES[l]);
    for (const [p] of all()) {
      expect(CONFIRM_PHRASES).not.toContain(p);
      expect(CANCEL_PHRASES).not.toContain(p);
      expect(consent).not.toContain(p);
      expect(quickPendingAnswer(p)).toBe(null);
    }
  });
});

describe('цель навигации от модели — закрытый набор', () => {
  it('чужая цель отбрасывается', () => {
    expect(
      normalizeModelAnswer({ kind: 'navigate', to: 'settings', confidence: 1 })
        .to,
    ).toBe(null);
    expect(
      normalizeModelAnswer({ kind: 'navigate', to: 'script', confidence: 1 })
        .to,
    ).toBe('script');
  });
});
