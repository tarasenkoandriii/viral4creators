import { BadRequestException } from '@nestjs/common';
import {
  HEDRA_SKETCH_PRESENTER_REFUSAL,
  PRESENTER_LOOK_NOT_FOUND,
  PRESENTER_LOOK_NOT_READY,
  PRESENTER_SKETCH_MISSING,
  SHOWCASE_NEEDS_AUTHOR_CONSENT,
  SHOWCASE_SESSION_UNKNOWN,
  assertGreetingReferencesAllowed,
  brandSceneImageAllowed,
  faceConsentRefusal,
  isFaceCheckedScenePhoto,
  nextUsesPersona,
  personaUsable,
  greetingVideoReferences,
  hedraPortrait,
  personaEnabled,
  presenterLookProblem,
  presenterProviderProblem,
  presenterSnapshotFrom,
  referenceNeedsFaceConsent,
  sessionDataUsesPersona,
  showcaseRefusal,
  snapshotUsesPersona,
} from './greeting-persona';
import type {
  GreetingBriefSnapshot,
  GreetingPresenterSnapshot,
} from './types/greeting.types';
import type { SceneAsset } from './types/reference.types';

const look = (over: Record<string, unknown> = {}) => ({
  id: 'l1',
  label: 'Деловой',
  status: 'ready',
  deletedAt: null,
  photoUrl: 'https://blob/users/u1/personas/p1/looks/l1.png',
  photoPathname: 'users/u1/personas/p1/looks/l1.png',
  activeSketch: {
    url: 'https://blob/sketches/u1/s1.png',
    pathname: 'sketches/u1/s1.png',
  },
  persona: { userId: 'u1', revokedAt: null },
  ...over,
});

const img = (over: Partial<SceneAsset> = {}): SceneAsset => ({
  id: 'r1',
  label: 'Мама',
  description: null,
  photoUrl: 'https://blob/sessions/s1/greeting-refs/r1/photo.jpg',
  photoPathname: 'sessions/s1/greeting-refs/r1/photo.jpg',
  // По умолчанию — проверено, лица нет: fail-closed (CONTRACT5 п.4)
  // иначе блокировал бы каждое фото фикстуры.
  hasFace: false,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

const PRESENTER: GreetingPresenterSnapshot = {
  lookId: 'l1',
  label: 'Деловой',
  url: 'https://blob/look.png',
  pathname: 'users/u1/personas/p1/looks/l1.png',
  variant: 'photo',
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

describe('personaEnabled', () => {
  it('только строка "true" включает режим', () => {
    expect(personaEnabled({ PERSONA_ENABLED: 'true' })).toBe(true);
    expect(personaEnabled({ PERSONA_ENABLED: '1' })).toBe(false);
    expect(personaEnabled({})).toBe(false);
  });
});

describe('presenterLookProblem', () => {
  it('годный свой образ — null (фото и скетч)', () => {
    expect(presenterLookProblem(look(), 'photo', 'u1')).toBeNull();
    expect(presenterLookProblem(look(), 'sketch', 'u1')).toBeNull();
  });
  it('нет, чужой, удалён, персона отозвана — «не найден», без подробностей', () => {
    expect(presenterLookProblem(null, 'photo', 'u1')).toBe(
      PRESENTER_LOOK_NOT_FOUND,
    );
    expect(presenterLookProblem(look(), 'photo', 'u2')).toBe(
      PRESENTER_LOOK_NOT_FOUND,
    );
    expect(
      presenterLookProblem(look({ deletedAt: new Date() }), 'photo', 'u1'),
    ).toBe(PRESENTER_LOOK_NOT_FOUND);
    expect(
      presenterLookProblem(
        look({ persona: { userId: 'u1', revokedAt: new Date() } }),
        'photo',
        'u1',
      ),
    ).toBe(PRESENTER_LOOK_NOT_FOUND);
    expect(presenterLookProblem(look({ persona: null }), 'photo', 'u1')).toBe(
      PRESENTER_LOOK_NOT_FOUND,
    );
  });
  it('не готов или без фото — «не готов»; скетч без скетча — отдельный текст', () => {
    expect(
      presenterLookProblem(look({ status: 'pending' }), 'photo', 'u1'),
    ).toBe(PRESENTER_LOOK_NOT_READY);
    expect(presenterLookProblem(look({ photoUrl: null }), 'photo', 'u1')).toBe(
      PRESENTER_LOOK_NOT_READY,
    );
    expect(
      presenterLookProblem(look({ activeSketch: null }), 'sketch', 'u1'),
    ).toBe(PRESENTER_SKETCH_MISSING);
    expect(
      presenterLookProblem(look({ activeSketch: null }), 'photo', 'u1'),
    ).toBeNull();
  });
});

describe('presenterProviderProblem', () => {
  it('скетч на Hedra — отказ; остальные сочетания — можно', () => {
    expect(presenterProviderProblem('hedra', 'sketch')).toBe(
      HEDRA_SKETCH_PRESENTER_REFUSAL,
    );
    expect(presenterProviderProblem('hedra', 'photo')).toBeNull();
    expect(presenterProviderProblem('grok', 'sketch')).toBeNull();
    expect(presenterProviderProblem('hedra', null)).toBeNull();
  });
});

describe('presenterSnapshotFrom', () => {
  it('копирует URL и путь выбранного варианта', () => {
    expect(presenterSnapshotFrom(look(), 'photo')).toEqual({
      lookId: 'l1',
      label: 'Деловой',
      url: 'https://blob/users/u1/personas/p1/looks/l1.png',
      pathname: 'users/u1/personas/p1/looks/l1.png',
      variant: 'photo',
    });
    expect(presenterSnapshotFrom(look(), 'sketch')).toMatchObject({
      url: 'https://blob/sketches/u1/s1.png',
      pathname: 'sketches/u1/s1.png',
      variant: 'sketch',
    });
  });
});

describe('snapshotUsesPersona', () => {
  it('образ-ведущий или личный бренд-бук', () => {
    expect(snapshotUsesPersona({ presenter: PRESENTER })).toBe(true);
    expect(snapshotUsesPersona({ manifestKind: 'PERSONAL' })).toBe(true);
    expect(snapshotUsesPersona({ manifestKind: 'COMPANY' })).toBe(false);
    expect(snapshotUsesPersona({})).toBe(false);
    expect(snapshotUsesPersona({ senderVoice: { personaVoice: true } })).toBe(
      true,
    );
    expect(snapshotUsesPersona({ senderVoice: {} })).toBe(false);
  });
});

describe('referenceNeedsFaceConsent (Г-8)', () => {
  it('лицо без согласия и без скетча — блок; остальное — нет', () => {
    expect(referenceNeedsFaceConsent(img({ hasFace: true }))).toBe(true);
    expect(
      referenceNeedsFaceConsent(
        img({ hasFace: true, faceConsentAt: '2026-09-30T00:00:00Z' }),
      ),
    ).toBe(false);
    expect(
      referenceNeedsFaceConsent(
        img({
          hasFace: true,
          sketch: {
            sketchId: 'sk',
            url: 'https://blob/sk.png',
            pathname: 'sketches/u1/sk.png',
            mimeType: 'image/png',
            style: 'pencil',
            sketchRendering: 'realistic',
            appliedAt: '2026-09-30T00:00:00Z',
          },
        }),
      ),
    ).toBe(false);
    expect(referenceNeedsFaceConsent(img({ hasFace: false }))).toBe(false);
    // CONTRACT5 п.4, fail-closed: не проверялось (старый референс) или
    // проверка не ответила — «лицо может быть», нужна галочка.
    expect(referenceNeedsFaceConsent(img({ hasFace: undefined }))).toBe(true);
    expect(
      referenceNeedsFaceConsent(
        img({ hasFace: undefined, faceCheckFailed: true }),
      ),
    ).toBe(true);
  });
  it('режим выключен — лица не проверяются и не блокируют (CONTRACT5 п.6)', () => {
    expect(referenceNeedsFaceConsent(img({ hasFace: true }), false)).toBe(
      false,
    );
    process.env.PERSONA_ENABLED = 'false';
    expect(referenceNeedsFaceConsent(img({ hasFace: undefined }))).toBe(false);
  });
  it('отказ перечисляет фото по подписи', () => {
    expect(
      faceConsentRefusal([img({ label: 'Мама' }), img({ label: 'Папа' })]),
    ).toContain('«Мама», «Папа»');
  });
});

describe('greetingVideoReferences — один порядок для промпта и рендера', () => {
  it('образ первым, затем свои фото без заблокированных, затем сцены бренда', () => {
    const plan = greetingVideoReferences({
      presenter: PRESENTER,
      images: [
        img({ id: 'a', label: 'дача' }),
        img({ id: 'b', label: 'соседка', hasFace: true }),
        img({
          id: 'c',
          label: 'торт',
          description: 'шоколадный торт',
          photoUrl: 'https://blob/c.jpg',
        }),
      ],
      brandScenes: [
        {
          sourceSceneId: 's1',
          label: 'Офис',
          photoUrl: 'https://blob/brand-manifests/m/scenes/s1/checked-ab12.jpg',
          description: null,
        },
        {
          sourceSceneId: 's2',
          label: 'Пляж',
          photoUrl: null,
          description: 'пляж на закате',
        },
      ],
      max: 7,
    });
    expect(plan.refs.map((r) => [r.role, r.caption])).toEqual([
      ['presenter', 'the presenter'],
      ['reference', 'дача'],
      ['reference', 'шоколадный торт'],
      ['brand-scene', 'Офис'],
    ]);
    expect(plan.refs[0].url).toBe(PRESENTER.url);
    expect(plan.blocked.map((b) => b.id)).toEqual(['b']);
    expect(plan.textScenes).toEqual(['пляж на закате']);
  });

  it('общий потолок: образ занимает слот, лишние сцены бренда — словами', () => {
    const plan = greetingVideoReferences({
      presenter: PRESENTER,
      images: [img({ id: 'a' }), img({ id: 'b' })],
      brandScenes: [
        {
          sourceSceneId: 's1',
          label: 'Офис',
          photoUrl: 'https://blob/brand-manifests/m/scenes/s1/checked-cd34.jpg',
          description: null,
        },
      ],
      max: 3,
    });
    expect(plan.refs).toHaveLength(3);
    expect(plan.refs.map((r) => r.role)).toEqual([
      'presenter',
      'reference',
      'reference',
    ]);
    expect(plan.textScenes).toEqual(['Офис']);
  });

  it('без образа — как раньше: свои фото с первой метки', () => {
    const plan = greetingVideoReferences({
      presenter: null,
      images: [img({ id: 'a', label: 'дача' })],
      max: 7,
    });
    expect(plan.refs.map((r) => r.role)).toEqual(['reference']);
  });
});

describe('hedraPortrait (Г-7)', () => {
  it('портрет — выбранный образ, а не первое фото', () => {
    expect(hedraPortrait({ presenter: PRESENTER }, [img()], 7)).toEqual({
      url: PRESENTER.url,
      fromPresenter: true,
    });
  });
  it('без образа — первое РАЗРЕШЁННОЕ фото; лицо без согласия пропускается', () => {
    expect(
      hedraPortrait(
        { presenter: null },
        [
          img({ id: 'a', hasFace: true, photoUrl: 'https://blob/a.jpg' }),
          img({ id: 'b', photoUrl: 'https://blob/b.jpg' }),
        ],
        7,
      ),
    ).toEqual({ url: 'https://blob/b.jpg', fromPresenter: false });
    expect(
      hedraPortrait({ presenter: null }, [img({ hasFace: true })], 7),
    ).toBeNull();
  });
});

describe('assertGreetingReferencesAllowed', () => {
  it('ведущий-образ при выключенном режиме — отказ с кодом PERSONA_DISABLED', () => {
    process.env.PERSONA_ENABLED = 'false';
    let err: unknown;
    try {
      assertGreetingReferencesAllowed(brief({ presenter: PRESENTER }), []);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'PERSONA_DISABLED',
    });
  });
  it('скетч-ведущий на Hedra — отказ', () => {
    process.env.PERSONA_ENABLED = 'true';
    expect(() =>
      assertGreetingReferencesAllowed(
        brief({
          resolvedPresenterProvider: 'hedra',
          presenter: { ...PRESENTER, variant: 'sketch' },
        }),
        [],
      ),
    ).toThrow(HEDRA_SKETCH_PRESENTER_REFUSAL);
  });
  it('Grok: фото, где лицо может быть, без согласия — отказ; при выключенном режиме — как до волны', () => {
    expect(() =>
      assertGreetingReferencesAllowed(brief(), [img({ hasFace: true })]),
    ).toThrow(/«Мама»/);
    expect(() =>
      assertGreetingReferencesAllowed(brief(), [img({ hasFace: undefined })]),
    ).toThrow(/«Мама»/);
    process.env.PERSONA_ENABLED = 'false';
    expect(() =>
      assertGreetingReferencesAllowed(brief(), [img({ hasFace: true })]),
    ).not.toThrow();
    process.env.PERSONA_ENABLED = 'true';
    expect(() =>
      assertGreetingReferencesAllowed(brief(), [
        img({ hasFace: true, faceConsentAt: '2026-09-30T00:00:00Z' }),
      ]),
    ).not.toThrow();
  });
  it('Hedra: в модель идёт только портрет — заблокированное фото не мешает', () => {
    expect(() =>
      assertGreetingReferencesAllowed(
        brief({ resolvedPresenterProvider: 'hedra' }),
        [img({ hasFace: true })],
      ),
    ).not.toThrow();
  });
});

describe('витрина (§4.9)', () => {
  const data = (b: Record<string, unknown>) => ({ greetingBriefSnapshot: b });
  it('товарный ролик — можно без чтения сессии', () => {
    expect(showcaseRefusal(null, undefined)).toBeNull();
  });
  it('поздравление без данных сессии — отказ', () => {
    expect(showcaseRefusal('GREETING_VIDEO', null)).toBe(
      SHOWCASE_SESSION_UNKNOWN,
    );
  });
  it('с персоной без галочки — отказ; с галочкой или без персоны — можно', () => {
    expect(showcaseRefusal('GREETING_VIDEO', data({ usesPersona: true }))).toBe(
      SHOWCASE_NEEDS_AUTHOR_CONSENT,
    );
    expect(
      showcaseRefusal(
        'GREETING_VIDEO',
        data({ usesPersona: true, personaShowcaseConsentAt: '2026-09-30' }),
      ),
    ).toBeNull();
    expect(showcaseRefusal('GREETING_VIDEO', data({}))).toBeNull();
  });
  it('sessionDataUsesPersona — только явное true', () => {
    expect(sessionDataUsesPersona(data({ usesPersona: true }))).toBe(true);
    expect(sessionDataUsesPersona(data({ usesPersona: 'true' }))).toBe(false);
    expect(sessionDataUsesPersona(null)).toBe(false);
    expect(sessionDataUsesPersona({})).toBe(false);
  });
});

describe('сцены бренд-бука (CONTRACT5 п.10)', () => {
  const scene = (photoUrl: string | null, sketch: unknown = null) =>
    ({ photoUrl, sketch }) as never;
  it('проверенный путь — только с отметкой сервера', () => {
    expect(
      isFaceCheckedScenePhoto(
        'https://x/brand-manifests/m/scenes/s1/checked-0a1b.png',
      ),
    ).toBe(true);
    expect(
      isFaceCheckedScenePhoto(
        'https://x/brand-manifests/m/scenes/s1/photo.jpg',
      ),
    ).toBe(false);
    expect(
      isFaceCheckedScenePhoto(
        'https://x/brand-manifests/m/characters/c/checked-0a.jpg',
      ),
    ).toBe(false);
    expect(isFaceCheckedScenePhoto('не url')).toBe(false);
    expect(isFaceCheckedScenePhoto(null)).toBe(false);
  });
  it('непроверенное фото сцены — только словами; скетч — можно', () => {
    const legacy = 'https://x/brand-manifests/m/scenes/s1/photo.jpg';
    expect(brandSceneImageAllowed(scene(legacy))).toBe(false);
    expect(brandSceneImageAllowed(scene(legacy, { url: 'u' }))).toBe(true);
    const plan = greetingVideoReferences({
      images: [],
      brandScenes: [
        {
          sourceSceneId: 's',
          label: 'Офис',
          photoUrl: legacy,
          description: null,
        },
      ],
      max: 7,
    });
    expect(plan.refs).toHaveLength(0);
    expect(plan.textScenes).toEqual(['Офис']);
  });
});

describe('nextUsesPersona (CONTRACT5 п.5б)', () => {
  it('после старта любого рендера признак не снимается; до рендера — следует за выбором', () => {
    expect(nextUsesPersona(true, false, { status: 'complete' })).toBe(true);
    expect(nextUsesPersona(true, false, { status: 'processing' })).toBe(true);
    expect(nextUsesPersona(true, false, null)).toBe(false);
    // Аудит: готовый ролик с персоной, перезапущенный на месте и упавший, —
    // признак не снимается.
    expect(nextUsesPersona(true, false, { status: 'failed' })).toBe(true);
    expect(nextUsesPersona(false, true, null)).toBe(true);
    expect(nextUsesPersona(undefined, false, { status: 'complete' })).toBe(
      false,
    );
  });
});

describe('personaUsable (CONTRACT5 п.13)', () => {
  const ok = {
    livenessCheckedAt: new Date(),
    revokedAt: null,
    verifyResult: { status: 'ok' },
  };
  it('проверена, не отозвана, без отказа', () => {
    expect(personaUsable(ok)).toBe(true);
    expect(personaUsable(null)).toBe(false);
    expect(personaUsable({ ...ok, livenessCheckedAt: null })).toBe(false);
    expect(personaUsable({ ...ok, revokedAt: new Date() })).toBe(false);
    expect(
      personaUsable({
        ...ok,
        verifyResult: { status: 'refused', refusals: ['under-18'] },
      }),
    ).toBe(false);
  });
});
