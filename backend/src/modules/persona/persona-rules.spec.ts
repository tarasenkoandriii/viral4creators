import {
  dropSourcesAfterRefusal,
  keepAgeEstimate,
  livenessPathname,
  mimeOfPathname,
  personaAbandonedCutoff,
  personaBlobPrefix,
  personaDisabledError,
  personaEnabled,
  personaRefusals,
  personaSourcesDue,
  PERSONA_LIVENESS_MAX_BYTES,
  PERSONA_SELFIE_MAX_BYTES,
  selfiePathname,
} from './persona-rules';
import { FACE_CHECK_MAX_INLINE_BYTES, FaceCheckResult } from './face-check';
import { PERSONA_CONSENT_VERSION, personaConsentText } from './persona-consent';
import { SUPPORTED_LOCALES } from '../../common/locale';

const PASS: FaceCheckResult = {
  faces: 1,
  frontal: true,
  quality: 'good',
  screenOrPrint: false,
  sameAsSelfie: true,
  liveMotion: true,
  ageMin: 25,
  ageMax: 31,
};

describe('personaEnabled — рубильник §4.10', () => {
  it('включён только строкой true; по умолчанию выключен', () => {
    expect(personaEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(personaEnabled({ PERSONA_ENABLED: '1' } as never)).toBe(false);
    expect(personaEnabled({ PERSONA_ENABLED: 'true' } as never)).toBe(true);
  });

  it('выключен — 404 с кодом PERSONA_DISABLED', () => {
    const e = personaDisabledError();
    expect(e.getStatus()).toBe(404);
    expect(e.getResponse()).toMatchObject({ code: 'PERSONA_DISABLED' });
  });
});

describe('personaRefusals', () => {
  it('всё хорошо — пусто', () => {
    expect(personaRefusals(PASS)).toEqual([]);
  });

  it('нет проверки — check-unavailable', () => {
    expect(personaRefusals(null)).toEqual(['check-unavailable']);
  });

  it('ageMin < 18 — under-18 (В-4); ровно 18 — допуск', () => {
    expect(personaRefusals({ ...PASS, ageMin: 17, ageMax: 22 })).toEqual([
      'under-18',
    ]);
    expect(personaRefusals({ ...PASS, ageMin: 18, ageMax: 22 })).toEqual([]);
  });

  it('возраст не оценён — отказ, не допуск', () => {
    const { ageMin: _a, ageMax: _b, ...noAge } = PASS;
    expect(personaRefusals(noAge)).toEqual(['age-unknown']);
  });

  it('все причины сразу', () => {
    expect(
      personaRefusals({
        faces: 2,
        frontal: false,
        quality: 'dark',
        screenOrPrint: true,
        sameAsSelfie: false,
        liveMotion: false,
        ageMin: 15,
        ageMax: 19,
      }),
    ).toEqual([
      'multiple-faces',
      'poor-quality',
      'screen-or-print',
      'not-same-person',
      'no-live-motion',
      'under-18',
    ]);
    expect(personaRefusals({ ...PASS, faces: 0 })).toContain('no-face');
    expect(personaRefusals({ ...PASS, frontal: false })).toEqual([
      'not-frontal',
    ]);
  });

  it('без полей живости — отказ (проверка персоны всегда с роликом)', () => {
    const { sameAsSelfie: _s, liveMotion: _l, ...noLive } = PASS;
    expect(personaRefusals(noLive)).toEqual([
      'not-same-person',
      'no-live-motion',
    ]);
  });
});

describe('keepAgeEstimate / dropSourcesAfterRefusal — приватность §4.4', () => {
  it('оценка хранится при успехе и при отказе по возрасту, иначе нет', () => {
    expect(keepAgeEstimate([])).toBe(true);
    expect(keepAgeEstimate(['under-18'])).toBe(true);
    expect(keepAgeEstimate(['poor-quality'])).toBe(false);
  });

  it('файлы удаляются после отказа, кроме недоступной проверки', () => {
    expect(dropSourcesAfterRefusal([])).toBe(false);
    expect(dropSourcesAfterRefusal(['poor-quality'])).toBe(true);
    expect(dropSourcesAfterRefusal(['under-18'])).toBe(true);
    expect(dropSourcesAfterRefusal(['check-unavailable'])).toBe(false);
  });
});

describe('пути и форматы', () => {
  it('под users/{userId}/personas/{id}/ со случайным хвостом', () => {
    const s = selfiePathname('u1', 'p1', 'image/jpeg', 'abc');
    const l = livenessPathname('u1', 'p1', 'video/mp4', 'abc');
    expect(s).toBe('users/u1/personas/p1/selfie-abc.jpg');
    expect(l).toBe('users/u1/personas/p1/liveness-abc.mp4');
    expect(s.startsWith(personaBlobPrefix('u1', 'p1'))).toBe(true);
    expect(mimeOfPathname(s)).toBe('image/jpeg');
    expect(mimeOfPathname(l)).toBe('video/mp4');
    expect(mimeOfPathname('x.exe')).toBeNull();
  });

  it('оба файла вместе помещаются в один inline-запрос проверки', () => {
    expect(
      PERSONA_SELFIE_MAX_BYTES + PERSONA_LIVENESS_MAX_BYTES,
    ).toBeLessThanOrEqual(FACE_CHECK_MAX_INLINE_BYTES);
  });
});

describe('срок хранения источников (В-3)', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it('30 дней после последнего образа', () => {
    expect(
      personaSourcesDue(
        { livenessCheckedAt: daysAgo(60), lastLookCreatedAt: daysAgo(31) },
        now,
      ),
    ).toBe(true);
    expect(
      personaSourcesDue(
        { livenessCheckedAt: daysAgo(60), lastLookCreatedAt: daysAgo(29) },
        now,
      ),
    ).toBe(false);
  });

  it('без образов — от проверки; без проверки — никогда', () => {
    expect(
      personaSourcesDue(
        { livenessCheckedAt: daysAgo(31), lastLookCreatedAt: null },
        now,
      ),
    ).toBe(true);
    expect(
      personaSourcesDue(
        { livenessCheckedAt: null, lastLookCreatedAt: null },
        now,
      ),
    ).toBe(false);
  });

  it('незавершённая попытка — сутки', () => {
    expect(personaAbandonedCutoff(now).toISOString()).toBe(
      daysAgo(1).toISOString(),
    );
  });
});

describe('текст согласия', () => {
  it('пять локалей, у каждой — возраст, удаление, 30 дней, «не проверка личности»', () => {
    const markers: Record<string, RegExp[]> = {
      ru: [/18/, /30 дней/, /удал/i, /не проверка вашей личности/],
      uk: [/18/, /30 днів/, /видал/i, /не перевірка вашої особи/],
      en: [/18/, /30 days/, /delet/i, /not a verification of your identity/],
      de: [/18/, /30 Tage/, /lösch/i, /keine Überprüfung Ihrer Identität/],
      es: [
        /18/,
        /30 días/,
        /elimin/i,
        /no es una verificación de tu identidad/,
      ],
    };
    for (const l of SUPPORTED_LOCALES) {
      const t = personaConsentText(l);
      expect(t.version).toBe(PERSONA_CONSENT_VERSION);
      expect(t.locale).toBe(l);
      for (const re of markers[l]) expect(t.text).toMatch(re);
    }
  });

  it('нигде нет «личность подтверждена» (Т-16)', () => {
    for (const l of SUPPORTED_LOCALES) {
      expect(personaConsentText(l).text).not.toMatch(
        /личность подтвержден|identity (is )?verified|identity confirmed/i,
      );
    }
  });

  it('неизвестная локаль — русская', () => {
    expect(personaConsentText('fr').locale).toBe('ru');
    expect(personaConsentText(undefined).locale).toBe('ru');
  });
});
