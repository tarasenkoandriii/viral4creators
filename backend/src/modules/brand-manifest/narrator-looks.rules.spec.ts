import { buildSketchPrompt, ANONYMISE_LINE } from '../../common/sketch-prompts';
import { LOOK_SAFETY_LINE } from '../persona/persona-looks.rules';
import {
  assetForMode,
  buildNarratorLookPrompt,
  buildNarratorStylePrompt,
  imageConsentActive,
  imageMimeOf,
  NARRATOR_IDENTITY_LINE,
  NARRATOR_LOOK_DAY_LIMIT,
  NARRATOR_LOOK_MONTH_LIMIT,
  NARRATOR_MAKEUPS,
  NARRATOR_OUTFITS,
  narratorLookConfigHash,
  narratorLookPrice,
  narratorLookProblem,
  narratorLookQuota,
  narratorModeOf,
  narratorQuotaExhausted,
  narratorStyleOptions,
  isNarratorMakeup,
  isNarratorOutfit,
  STORY_PARENT_IMAGE_CONSENT_TEXT,
  STORY_PARENT_IMAGE_CONSENT_VERSION,
  UsableLookRow,
} from './narrator-looks.rules';

describe('narrator-looks.rules (WP5)', () => {
  describe('промпт варианта сохраняет личность', () => {
    it('защитный текст запрещает менять лицо, возраст, телосложение, расу и цвет кожи', () => {
      const line = NARRATOR_IDENTITY_LINE.toLowerCase();
      for (const must of [
        'do not change the face',
        'facial features',
        'apparent age',
        'younger or older',
        'body shape',
        'body build',
        'race',
        'ethnicity',
        'skin tone',
        'skin colour',
        'adult',
      ]) {
        expect(line).toContain(must);
      }
    });

    it.each(
      NARRATOR_OUTFITS.flatMap((o) => NARRATOR_MAKEUPS.map((m) => [o, m])),
    )('каждый промпт (%s, %s) несёт защиту и запреты', (outfit, makeup) => {
      const prompt = buildNarratorLookPrompt({
        outfit: outfit as never,
        makeup: makeup as never,
      });
      expect(prompt).toContain(NARRATOR_IDENTITY_LINE);
      expect(prompt).toContain(LOOK_SAFETY_LINE);
      expect(prompt).toContain('Edit only the clothing');
      expect(prompt).toMatch(/never depict them as a minor/);
    });

    it('makeup none — запрет любых изменений макияжа; light — без изменения формы лица', () => {
      expect(
        buildNarratorLookPrompt({ outfit: 'casual', makeup: 'none' }),
      ).toContain('Do not add, remove or change any makeup.');
      expect(
        buildNarratorLookPrompt({ outfit: 'casual', makeup: 'light' }),
      ).toMatch(/must not change the shape of the face/);
      expect(
        buildNarratorLookPrompt({ outfit: 'winter', makeup: 'natural' }),
      ).toMatch(/own skin colour/);
    });

    it('в промпт не попадает свободный текст — только пресеты', () => {
      const a = buildNarratorLookPrompt({ outfit: 'festive', makeup: 'none' });
      const b = buildNarratorLookPrompt({ outfit: 'festive', makeup: 'none' });
      expect(a).toBe(b);
      expect(isNarratorOutfit('evening')).toBe(false);
      expect(isNarratorOutfit('cozy-home')).toBe(true);
      expect(isNarratorMakeup('heavy')).toBe(false);
      expect(isNarratorMakeup('light')).toBe(true);
    });
  });

  describe('режим и стилизация', () => {
    it('нет скетча (или без файла) — фото', () => {
      expect(narratorModeOf(null)).toEqual({ mode: 'photo', options: null });
      expect(
        narratorModeOf({ style: 'cartoon', options: {}, url: null }).mode,
      ).toBe('photo');
      expect(
        narratorModeOf({ style: 'oil', options: {}, url: 'https://x' }).mode,
      ).toBe('photo');
    });

    it('cartoon всегда цветной и stylized, даже если в строке иначе', () => {
      expect(
        narratorModeOf({
          style: 'cartoon',
          options: { keepColors: false, sketchRendering: 'realistic' },
          url: 'https://x',
        }),
      ).toEqual({
        mode: 'cartoon',
        options: {
          anonymizeFace: true,
          keepColors: true,
          sketchRendering: 'stylized',
        },
      });
    });

    it('прочие стили сохраняют keepColors/sketchRendering исходного скетча', () => {
      expect(narratorStyleOptions('pencil', null)).toEqual({
        anonymizeFace: true,
        keepColors: true,
        sketchRendering: 'realistic',
      });
      expect(
        narratorStyleOptions('lineart', {
          keepColors: false,
          sketchRendering: 'stylized',
        }),
      ).toEqual({
        anonymizeFace: true,
        keepColors: false,
        sketchRendering: 'stylized',
      });
    });

    it('стилизация — ровно промпт ИИ-скетча персонажа бренда (с обезличиванием)', () => {
      const options = narratorStyleOptions('cartoon', {});
      const prompt = buildNarratorStylePrompt('cartoon', options);
      expect(prompt).toBe(
        buildSketchPrompt({
          slotKind: 'character',
          mode: 'from-image',
          style: 'cartoon',
          options,
          description: null,
        }),
      );
      expect(prompt).toContain('storybook cartoon');
      expect(prompt).toContain(ANONYMISE_LINE);
      expect(prompt).toMatch(/visibly adult/);
    });

    it('ассет по режиму', () => {
      expect(assetForMode('photo')).toBe('photo');
      expect(assetForMode('watercolor')).toBe('styled');
    });
  });

  describe('квота и цена', () => {
    const now = new Date('2026-10-19T12:00:00Z');
    it('считает вызовы за сутки и месяц UTC', () => {
      const q = narratorLookQuota(
        [
          { createdAt: new Date('2026-10-19T01:00:00Z'), imageCalls: 2 },
          { createdAt: new Date('2026-10-18T23:59:59Z'), imageCalls: 1 },
          { createdAt: new Date('2026-09-30T23:00:00Z'), imageCalls: 2 },
        ],
        now,
      );
      expect(q).toEqual({
        dayUsed: 2,
        dayLimit: NARRATOR_LOOK_DAY_LIMIT,
        monthUsed: 3,
        monthLimit: NARRATOR_LOOK_MONTH_LIMIT,
      });
    });

    it('исчерпание с учётом числа вызовов действия', () => {
      const base = { dayLimit: 6, monthLimit: 40 };
      expect(
        narratorQuotaExhausted({ ...base, dayUsed: 5, monthUsed: 5 }, 1),
      ).toBeNull();
      expect(
        narratorQuotaExhausted({ ...base, dayUsed: 5, monthUsed: 5 }, 2),
      ).toBe('day');
      expect(
        narratorQuotaExhausted({ ...base, dayUsed: 0, monthUsed: 39 }, 2),
      ).toBe('month');
    });

    it('резерв — 2× оценки на вызов; модель без ставки — null', () => {
      const one = narratorLookPrice(['gemini-3.1-flash-image'], {});
      expect(one).toEqual({
        perCall: [
          { model: 'gemini-3.1-flash-image', estimateMicroUsd: 78_000 },
        ],
        estimateMicroUsd: 78_000,
        reserveMicroUsd: 156_000,
      });
      const two = narratorLookPrice(
        ['gemini-3.1-flash-image', 'gemini-3.1-flash-image'],
        {},
      );
      expect(two?.reserveMicroUsd).toBe(312_000);
      expect(narratorLookPrice(['no-such-image-model'], {})).toBeNull();
    });
  });

  describe('хеши и файлы', () => {
    it('конфиг-хеш стабилен и различает пресеты и режим', () => {
      const base = {
        kind: 'create' as const,
        characterId: 'c1',
        sourceHash: 'a'.repeat(64),
        outfit: 'casual' as const,
        makeup: 'none' as const,
        mode: 'photo' as const,
        options: null,
      };
      const h = narratorLookConfigHash(base);
      expect(narratorLookConfigHash({ ...base })).toBe(h);
      expect(narratorLookConfigHash({ ...base, outfit: 'winter' })).not.toBe(h);
      expect(narratorLookConfigHash({ ...base, makeup: 'light' })).not.toBe(h);
      expect(
        narratorLookConfigHash({
          ...base,
          mode: 'cartoon',
          options: narratorStyleOptions('cartoon', {}),
        }),
      ).not.toBe(h);
      expect(
        narratorLookConfigHash({
          ...base,
          kind: 'restyle',
          parentPhotoHash: 'p',
        }),
      ).not.toBe(h);
    });

    it('формат картинки по сигнатуре', () => {
      expect(imageMimeOf(Buffer.from('89504e470d0a1a0a00', 'hex'))).toBe(
        'image/png',
      );
      expect(imageMimeOf(Buffer.from('ffd8ffe000', 'hex'))).toBe('image/jpeg');
      expect(
        imageMimeOf(Buffer.concat([Buffer.from('RIFF0000WEBP', 'latin1')])),
      ).toBe('image/webp');
      expect(imageMimeOf(Buffer.from('GIF89a'))).toBeNull();
      expect(imageMimeOf(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('согласие и пригодность варианта', () => {
    const consentAt = new Date('2026-10-19T10:00:00Z');
    const consent = {
      narratorImageConsentAt: consentAt,
      narratorImageConsentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
      narratorImageConsentRevokedAt: null as Date | null,
    };
    const look: UsableLookRow = {
      status: 'READY',
      characterId: 'c1',
      sourceUrl: 'https://blob/photo.png',
      consentAt,
      consentVersion: STORY_PARENT_IMAGE_CONSENT_VERSION,
      deletedAt: null,
      photoHash: 'p',
      style: 'cartoon',
      styledHash: 's',
    };
    const check = (over: Partial<Parameters<typeof narratorLookProblem>[0]>) =>
      narratorLookProblem({
        look,
        asset: 'styled',
        consent,
        narratorCharacterId: 'c1',
        characterPhotoUrl: 'https://blob/photo.png',
        mode: 'cartoon',
        ...over,
      });

    it('текст согласия: взрослый, свой образ или разрешение, закрытая разработка, отзыв', () => {
      expect(STORY_PARENT_IMAGE_CONSENT_VERSION).toBe('story-parent-image-v1');
      expect(STORY_PARENT_IMAGE_CONSENT_TEXT).toMatch(/18 лет/);
      expect(STORY_PARENT_IMAGE_CONSENT_TEXT).toMatch(/разрешение/);
      expect(STORY_PARENT_IMAGE_CONSENT_TEXT).toMatch(/закрытой разработке/);
      expect(STORY_PARENT_IMAGE_CONSENT_TEXT).toMatch(/собственных подарках/);
      expect(STORY_PARENT_IMAGE_CONSENT_TEXT).toMatch(/отзыва/);
      expect(imageConsentActive(consent)).toBe(true);
      expect(
        imageConsentActive({
          ...consent,
          narratorImageConsentRevokedAt: consentAt,
        }),
      ).toBe(false);
      expect(
        imageConsentActive({
          ...consent,
          narratorImageConsentVersion: 'story-parent-voice-v1',
        }),
      ).toBe(false);
    });

    it('годный вариант — без проблем', () => {
      expect(check({})).toBeNull();
      expect(check({ asset: 'photo', mode: 'photo' })).toBeNull();
    });

    it('отзыв согласия и согласие, данное заново, закрывают старые варианты', () => {
      expect(
        check({
          consent: { ...consent, narratorImageConsentRevokedAt: new Date() },
        }),
      ).toBe('consent');
      expect(
        check({
          consent: {
            ...consent,
            narratorImageConsentAt: new Date('2026-10-19T11:00:00Z'),
          },
        }),
      ).toBe('consent');
      expect(check({ look: { ...look, consentVersion: 'old' } })).toBe(
        'consent',
      );
    });

    it('удалён, другой персонаж, заменённое фото, нет ассета, другой режим', () => {
      expect(check({ look: { ...look, deletedAt: new Date() } })).toBe(
        'deleted',
      );
      expect(check({ narratorCharacterId: 'c2' })).toBe('character-changed');
      expect(check({ characterPhotoUrl: 'https://blob/new.png' })).toBe(
        'source-changed',
      );
      expect(check({ characterPhotoUrl: null })).toBe('source-changed');
      expect(check({ look: { ...look, styledHash: null } })).toBe(
        'asset-missing',
      );
      expect(
        check({
          asset: 'photo',
          mode: 'photo',
          look: { ...look, photoHash: null },
        }),
      ).toBe('asset-missing');
      expect(check({ mode: 'watercolor' })).toBe('mode-mismatch');
      expect(check({ asset: 'photo', mode: 'cartoon' })).toBe('mode-mismatch');
      // Пиннинг одобренного ассета при рендере: режим не сверяется.
      expect(check({ mode: null })).toBeNull();
    });

    it('A-S3-1: применять и рендерить можно только READY; перестилизация берёт готовое фото', () => {
      for (const status of ['PENDING', 'FAILED', 'UNKNOWN', 'DELETED'])
        for (const mode of ['cartoon', null] as const) {
          expect(check({ look: { ...look, status }, mode })).toBe('not-ready');
          expect(
            check({ look: { ...look, status }, asset: 'photo', mode: null }),
          ).toBe('not-ready');
        }
      // Стилизация упала, фото готово: перестилизация (requireReady:false) допустима.
      expect(
        check({
          look: { ...look, status: 'FAILED', style: null, styledHash: null },
          asset: 'photo',
          mode: null,
          requireReady: false,
        }),
      ).toBeNull();
      // Удалённый остаётся удалённым и для перестилизации.
      expect(
        check({
          look: { ...look, status: 'DELETED', deletedAt: new Date() },
          requireReady: false,
        }),
      ).toBe('deleted');
    });
  });
});
