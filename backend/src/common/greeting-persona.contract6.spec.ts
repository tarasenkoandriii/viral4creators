/**
 * «Я в кадре» — волна CONTRACT6 (G-B2): голос персоны на Hedra без
 * образа (п.3), сцены бренд-бука при выключенном режиме (п.8), витрина
 * со стёртой сессией при выключенном режиме (п.7) и запрет правки
 * карточек во время рендера (п.2, `greeting-render-lock.ts`).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
  SHOWCASE_NEEDS_AUTHOR_CONSENT,
  SHOWCASE_SESSION_UNKNOWN,
  assertGreetingReferencesAllowed,
  brandPersonaVoiceNeedsPresenter,
  brandSceneImageAllowed,
  greetingVideoReferences,
  personaVoiceNeedsPresenter,
  showcaseRefusal,
} from './greeting-persona';
import {
  GREETING_CHANGE_DURING_RENDER_MESSAGE,
  assertGreetingNotRendering,
} from './greeting-render-lock';
import { GenerationStatus } from './types/generation.types';
import type {
  GreetingBriefSnapshot,
  GreetingPresenterSnapshot,
} from './types/greeting.types';

const PRESENTER: GreetingPresenterSnapshot = {
  lookId: 'l1',
  label: 'Деловой',
  url: 'https://blob/look.png',
  pathname: 'users/u1/personas/p1/looks/l1.png',
  variant: 'photo',
};
const PERSONA_VOICE = {
  userVoiceId: 'uv1',
  resembleVoiceId: 'rv1',
  label: 'Мой',
  personaVoice: true,
};
const PLAIN_VOICE = {
  userVoiceId: 'uv2',
  resembleVoiceId: 'rv2',
  label: 'Дед',
  personaVoice: false,
};

const brief = (over: Partial<GreetingBriefSnapshot> = {}) =>
  ({
    resolvedPresenterProvider: 'grok',
    presenter: null,
    ...over,
  }) as GreetingBriefSnapshot;

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterEach(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

function thrown(fn: () => void): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
}

describe('голос персоны на Hedra без образа-ведущего (CONTRACT6 п.3)', () => {
  it('personaVoiceNeedsPresenter — только Hedra + голос персоны + нет образа', () => {
    expect(
      personaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra' }),
        PERSONA_VOICE,
      ),
    ).toBe(true);
    // Образ есть — лицо своё.
    expect(
      personaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra', presenter: PRESENTER }),
        PERSONA_VOICE,
      ),
    ).toBe(false);
    // Grok: при своём голосе лицо голосом не движется — оставлено.
    expect(personaVoiceNeedsPresenter(brief(), PERSONA_VOICE)).toBe(false);
    // Обычный клон (дед записал) — не персона.
    expect(
      personaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra' }),
        PLAIN_VOICE,
      ),
    ).toBe(false);
    expect(
      personaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra' }),
        null,
      ),
    ).toBe(false);
  });

  it('assertGreetingReferencesAllowed — отказ с кодом до денег', () => {
    const err = thrown(() =>
      assertGreetingReferencesAllowed(
        brief({
          resolvedPresenterProvider: 'hedra',
          senderVoice: PERSONA_VOICE,
        }),
        [],
      ),
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'GREETING_PERSONA_VOICE_NEEDS_PRESENTER',
      message: PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
    });
  });

  it('с образом на Hedra и на Grok без образа — проходит', () => {
    expect(() =>
      assertGreetingReferencesAllowed(
        brief({
          resolvedPresenterProvider: 'hedra',
          presenter: PRESENTER,
          senderVoice: PERSONA_VOICE,
        }),
        [],
      ),
    ).not.toThrow();
    expect(() =>
      assertGreetingReferencesAllowed(
        brief({ senderVoice: PERSONA_VOICE }),
        [],
      ),
    ).not.toThrow();
  });
});

describe('голос персоны из бренд-бука на Hedra без образа (CONTRACT6 п.3)', () => {
  it('условие зеркалит avatarVoiceChoice: клон отправителя перебивает голос бренда', () => {
    const hedra = brief({ resolvedPresenterProvider: 'hedra' });
    expect(brandPersonaVoiceNeedsPresenter(hedra, true)).toBe(true);
    expect(brandPersonaVoiceNeedsPresenter(hedra, false)).toBe(false);
    expect(
      brandPersonaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra', presenter: PRESENTER }),
        true,
      ),
    ).toBe(false);
    expect(brandPersonaVoiceNeedsPresenter(brief(), true)).toBe(false);
    expect(
      brandPersonaVoiceNeedsPresenter(
        brief({ resolvedPresenterProvider: 'hedra', senderVoice: PLAIN_VOICE }),
        true,
      ),
    ).toBe(false);
  });

  it('assertGreetingReferencesAllowed — отказ с кодом при голосе персоны бренда', () => {
    const err = thrown(() =>
      assertGreetingReferencesAllowed(
        brief({ resolvedPresenterProvider: 'hedra' }),
        [],
        true,
      ),
    );
    expect((err as BadRequestException).getResponse()).toEqual({
      code: 'GREETING_PERSONA_VOICE_NEEDS_PRESENTER',
      message: PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
    });
    expect(() =>
      assertGreetingReferencesAllowed(
        brief({ resolvedPresenterProvider: 'hedra' }),
        [],
      ),
    ).not.toThrow();
  });
});

describe('сцены бренд-бука при выключенном режиме (CONTRACT6 п.8)', () => {
  const scene = (photoUrl: string | null, sketch: unknown = null) =>
    ({ photoUrl, sketch }) as never;
  const checked = 'https://x/brand-manifests/m/scenes/s1/checked-0a1b.png';
  const legacy = 'https://x/brand-manifests/m/scenes/s1/photo.jpg';

  it('фото — никогда изображением (даже проверенное); скетч — можно', () => {
    expect(brandSceneImageAllowed(scene(legacy), false)).toBe(false);
    expect(brandSceneImageAllowed(scene(checked), false)).toBe(false);
    expect(brandSceneImageAllowed(scene(legacy, { url: 'u' }), false)).toBe(
      true,
    );
    // Включённый режим — как было: проверенное фото изображением.
    expect(brandSceneImageAllowed(scene(checked), true)).toBe(true);
  });

  it('в плане рендера сцена-фото при выключенном режиме уходит словами', () => {
    process.env.PERSONA_ENABLED = 'false';
    const plan = greetingVideoReferences({
      images: [],
      brandScenes: [
        {
          sourceSceneId: 's',
          label: 'Офис',
          photoUrl: checked,
          description: 'светлый офис',
        },
        {
          sourceSceneId: 's2',
          label: 'Сад',
          photoUrl: legacy,
          description: null,
          sketch: {
            url: 'https://blob/sk.png',
            pathname: 'sk.png',
            mimeType: 'image/png',
          },
        } as never,
      ],
      max: 7,
    });
    expect(plan.refs).toEqual([
      { role: 'brand-scene', url: 'https://blob/sk.png', caption: 'Сад' },
    ]);
    expect(plan.textScenes).toEqual(['светлый офис']);
  });
});

describe('витрина: стёртая сессия поздравления (CONTRACT6 п.7)', () => {
  it('режим выключен — не отказ; включён — отказ как раньше', () => {
    expect(showcaseRefusal('GREETING_VIDEO', null, false)).toBeNull();
    expect(showcaseRefusal('GREETING_VIDEO', undefined, false)).toBeNull();
    expect(showcaseRefusal('GREETING_VIDEO', null, true)).toBe(
      SHOWCASE_SESSION_UNKNOWN,
    );
  });

  it('уцелевшая сессия с персоной без галочки — отказ и при выключенном режиме', () => {
    expect(
      showcaseRefusal(
        'GREETING_VIDEO',
        { greetingBriefSnapshot: { usesPersona: true } },
        false,
      ),
    ).toBe(SHOWCASE_NEEDS_AUTHOR_CONSENT);
  });
});

describe('assertGreetingNotRendering (CONTRACT6 п.2)', () => {
  it.each([GenerationStatus.PENDING, GenerationStatus.PROCESSING])(
    '%s — 409 с кодом',
    (status) => {
      const err = thrown(() =>
        assertGreetingNotRendering({ generatedVideo: { status } }),
      );
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toEqual({
        code: 'GREETING_CHANGE_DURING_RENDER',
        message: GREETING_CHANGE_DURING_RENDER_MESSAGE,
      });
    },
  );

  it.each([GenerationStatus.COMPLETE, GenerationStatus.FAILED])(
    '%s — правка разрешена',
    (status) => {
      expect(() =>
        assertGreetingNotRendering({ generatedVideo: { status } }),
      ).not.toThrow();
    },
  );

  it('ролика нет — правка разрешена', () => {
    expect(() => assertGreetingNotRendering({})).not.toThrow();
    expect(() =>
      assertGreetingNotRendering({ generatedVideo: null }),
    ).not.toThrow();
  });
});
