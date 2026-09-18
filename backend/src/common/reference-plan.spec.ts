import {
  brandBriefText,
  buildReferencePlan,
  characterBriefText,
  grokReferencePromptText,
  referenceMappingText,
  sceneBriefText,
} from './reference-plan';
import type { CharacterCast } from './types/casting.types';
import type { AnalysisCharacter } from './types/analysis.types';

const ch = (id: string, label: string): AnalysisCharacter => ({
  id,
  label,
  role: null,
  appearance: `look of ${label}`,
  prominence: 'main',
});
const none = {
  kind: 'none' as const,
  photoUrl: null,
  photoPathname: null,
  description: null,
  brandCharacterId: null,
  label: null,
};
const cast = (
  id: string,
  order: number,
  repl: Partial<CharacterCast['replacement']> = {},
  active = true,
): CharacterCast => ({
  characterId: id,
  active,
  order,
  replacement: { ...none, ...repl },
});
const analysed = [
  ch('c1', 'Аня'),
  ch('c2', 'Лис'),
  ch('c3', 'Бариста'),
  ch('c4', 'Курьер'),
  ch('c5', 'Прохожий'),
];
const product = {
  productName: 'Кружка',
  productDescription: 'стальная',
  addedAt: new Date(),
  productImagePathname: 'projects/p/items/i/photo.jpg',
  productImageMimeType: 'image/jpeg',
  productImageUrl: 'https://blob.test/projects/p/items/i/photo.jpg',
};
const session = (casts: CharacterCast[] | undefined) => ({
  videoAnalysis: { characters: analysed } as never,
  characterCasting: casts ? { casts, updatedAt: '' } : undefined,
  productInformation: product,
});

describe('buildReferencePlan', () => {
  it('no casting → everyone stays as Gemini saw them, legacy first frame, nothing omitted', () => {
    const plan = buildReferencePlan(session(undefined));
    expect(plan.legacyFirstFrame).toBe(true);
    expect(plan.images).toEqual([]);
    expect(plan.omitted).toEqual([]);
    expect(
      plan.characters.map((c) => [c.label, c.source, c.appearance]),
    ).toEqual(analysed.map((a) => [a.label, 'gemini', a.appearance]));
  });

  it('no photos anywhere → legacy first frame even with a casting; dropped characters are omitted', () => {
    const plan = buildReferencePlan(
      session([
        cast('c1', 1),
        cast('c2', 0, {}, false),
        cast('c3', 2, { kind: 'text', description: 'в фартуке' }),
      ]),
    );
    expect(plan.legacyFirstFrame).toBe(true);
    expect(plan.omitted.map((c) => c.id)).toEqual(['c2', 'c4', 'c5']);
    expect(
      plan.characters.map((c) => [c.characterId, c.source, c.appearance]),
    ).toEqual([
      ['c1', 'gemini', 'look of Аня'],
      ['c3', 'text', 'в фартуке'],
    ]);
  });

  it('photo casts take slots by activation order, product photo takes the last free slot', () => {
    const plan = buildReferencePlan(
      session([
        cast('c2', 1, {
          kind: 'photo',
          photoUrl: 'https://blob.test/s/c2.png',
          photoPathname: 'sessions/s/characters/c2/photo.png',
        }),
        cast('c1', 2, {
          kind: 'brand',
          photoUrl: 'https://blob.test/bm/a.jpg',
          label: 'Бренд-Аня',
          brandCharacterId: 'bc1',
        }),
        cast('c3', 3),
      ]),
    );
    expect(plan.legacyFirstFrame).toBe(false);
    expect(
      plan.images.map((i) => [
        i.index,
        i.kind,
        i.label,
        i.pathname,
        i.mimeType,
      ]),
    ).toEqual([
      [
        1,
        'character',
        'Лис',
        'sessions/s/characters/c2/photo.png',
        'image/png',
      ],
      [2, 'character', 'Бренд-Аня', null, 'image/jpeg'],
      [3, 'product', 'Кружка', 'projects/p/items/i/photo.jpg', 'image/jpeg'],
    ]);
    expect(
      plan.characters.map((c) => [
        c.label,
        c.referenceIndex,
        c.source,
        c.appearance,
      ]),
    ).toEqual([
      ['Лис', 1, 'photo', 'look of Лис'],
      [
        'Бренд-Аня',
        2,
        'brand',
        'Бренд-Аня — brand character (see reference image)',
      ],
      ['Бариста', null, 'gemini', 'look of Бариста'],
    ]);
  });

  it('caps at 3: the 4th photo-character falls back to text, product photo gets no slot (§10.3)', () => {
    const photo = (id: string, order: number) =>
      cast(id, order, {
        kind: 'photo',
        photoUrl: `https://blob.test/${id}.jpg`,
        photoPathname: `sessions/s/characters/${id}/photo.jpg`,
        description: `words for ${id}`,
      });
    const plan = buildReferencePlan(
      session([photo('c4', 4), photo('c1', 1), photo('c2', 2), photo('c3', 3)]),
    );
    expect(plan.images.map((i) => i.characterId)).toEqual(['c1', 'c2', 'c3']);
    expect(plan.images.some((i) => i.kind === 'product')).toBe(false);
    const fourth = plan.characters.find((c) => c.characterId === 'c4')!;
    expect(fourth.referenceIndex).toBeNull();
    expect(fourth.appearance).toBe('words for c4');
    expect(fourth.source).toBe('photo');
  });

  it('ignores casts for characters the analysis does not know', () => {
    const plan = buildReferencePlan(
      session([cast('c9', 1, { kind: 'photo', photoUrl: 'https://x/y.png' })]),
    );
    expect(plan.images).toEqual([]);
    // an all-unknown casting counts as "no casting" → defaults
    expect(plan.characters).toHaveLength(5);
  });
});

describe('prompt brief texts', () => {
  it('characterBriefText marks photo-backed characters WITHOUT numbers and lists removals', () => {
    const plan = buildReferencePlan(
      session([
        cast('c1', 1, {
          kind: 'photo',
          photoUrl: 'https://blob.test/c1.png',
          photoPathname: 'sessions/s/characters/c1/photo.png',
        }),
        cast('c2', 0, {}, false),
        cast('c3', 2),
      ]),
    );
    const text = characterBriefText(plan);
    expect(text).toContain('- Аня: look of Аня [the video model also receives');
    expect(text).not.toMatch(/REFERENCE IMAGE \d/);
    expect(text).toContain('- Бариста: look of Бариста');
    expect(text).not.toContain('- Бариста: look of Бариста [');
    expect(text).toContain(
      'CHARACTERS TO REMOVE (must not appear in the new video): Лис; Курьер; Прохожий.',
    );
    // Numbering lives in the Veo mapping, computed at generation time.
    expect(referenceMappingText(plan)).toBe(
      'Reference image 1 shows the person "Аня" — match their appearance exactly. Reference image 2 shows the actual product "Кружка" — it must look exactly like this. Not shown as images, described in the text above: Бариста.',
    );
  });

  it('characterBriefText is empty without characters', () => {
    expect(
      characterBriefText(
        buildReferencePlan({
          videoAnalysis: { characters: [] } as never,
          characterCasting: undefined,
          productInformation: product,
        }),
      ),
    ).toBe('');
  });

  it('brandBriefText renders notes + non-empty JSON, nothing for an empty snapshot', () => {
    expect(brandBriefText(undefined)).toBe('');
    expect(
      brandBriefText({
        brandManifestId: 'b',
        title: 't',
        styleNotes: null,
        voiceNotes: null,
        filters: {},
        effects: null,
        characters: [],
        snapshotAt: '',
        editedAt: null,
      }),
    ).toBe('');
    const text = brandBriefText({
      brandManifestId: 'b',
      title: 't',
      styleNotes: ' тёплые тона ',
      voiceNotes: null,
      filters: { preset: 'warm' },
      effects: null,
      characters: [],
      snapshotAt: '',
      editedAt: null,
    });
    expect(text).toContain('BRAND STYLE GUIDE');
    expect(text).toContain('тёплые тона');
    expect(text).toContain('Filters / colour treatment: {"preset":"warm"}');
    expect(text).not.toContain('Effects');
  });
});

describe('scenes and explicit slot selection (§17)', () => {
  const scenes = [
    {
      id: 'sc_a',
      label: 'Кухня',
      description: 'светлая кухня с деревянным столом',
      photoUrl: 'https://blob.test/sessions/s/scenes/sc_a/photo.jpg',
      photoPathname: 'sessions/s/scenes/sc_a/photo.jpg',
      createdAt: '',
    },
    {
      id: 'sc_b',
      label: 'Улица',
      description: null,
      photoUrl: 'https://blob.test/sessions/s/scenes/sc_b/photo.png',
      photoPathname: 'sessions/s/scenes/sc_b/photo.png',
      createdAt: '',
    },
  ];
  const photo = (id: string, order: number) =>
    cast(id, order, {
      kind: 'photo',
      photoUrl: `https://blob.test/${id}.jpg`,
      photoPathname: `sessions/s/characters/${id}/photo.jpg`,
    });

  it('default rule: characters → scenes → product, cap 3; scenes alone open reference mode', () => {
    const plan = buildReferencePlan({ ...session([photo('c1', 1)]), scenes });
    expect(plan.isDefaultSelection).toBe(true);
    expect(plan.slots).toEqual(['character:c1', 'scene:sc_a', 'scene:sc_b']);
    expect(plan.productReferenceIndex).toBeNull();
    expect(plan.scenes.map((s) => [s.label, s.referenceIndex])).toEqual([
      ['Кухня', 2],
      ['Улица', 3],
    ]);
    expect(plan.candidates.map((c) => c.id)).toEqual([
      'character:c1',
      'scene:sc_a',
      'scene:sc_b',
      'product',
    ]);

    const onlyScene = buildReferencePlan({
      ...session([cast('c1', 1)]),
      scenes: [scenes[0]],
    });
    expect(onlyScene.legacyFirstFrame).toBe(false);
    expect(onlyScene.slots).toEqual(['scene:sc_a', 'product']);
  });

  it('explicit selection wins, keeps order, drops unknown ids, may be empty (→ legacy)', () => {
    const base = { ...session([photo('c1', 1), photo('c2', 2)]), scenes };
    const plan = buildReferencePlan({
      ...base,
      referenceSelection: {
        slots: ['product', 'scene:sc_b', 'character:c2', 'character:zzz'],
        updatedAt: '',
      },
    });
    expect(plan.isDefaultSelection).toBe(false);
    expect(plan.images.map((i) => [i.index, i.kind, i.label])).toEqual([
      [1, 'product', 'Кружка'],
      [2, 'scene', 'Улица'],
      [3, 'character', 'Лис'],
    ]);
    expect(
      plan.characters.find((c) => c.characterId === 'c1')?.referenceIndex,
    ).toBeNull();
    expect(plan.productReferenceIndex).toBe(1);

    const none = buildReferencePlan({
      ...base,
      referenceSelection: { slots: [], updatedAt: '' },
    });
    expect(none.images).toEqual([]);
    expect(none.legacyFirstFrame).toBe(true);
  });

  it('sceneBriefText and referenceMappingText describe chosen vs text-only', () => {
    const plan = buildReferencePlan({
      ...session([photo('c1', 1)]),
      scenes,
      referenceSelection: { slots: ['scene:sc_a'], updatedAt: '' },
    });
    const brief = sceneBriefText(plan);
    expect(brief).toContain(
      '- Кухня: светлая кухня с деревянным столом [the video model receives a photo',
    );
    expect(brief).toContain('- Улица [described in words only]');
    const map = referenceMappingText(plan);
    expect(map).toContain('Reference image 1 shows the location/set "Кухня"');
    expect(map).toContain('described in the text above: Аня; Улица; Кружка.');
    expect(sceneBriefText(buildReferencePlan(session(undefined)))).toBe('');
  });
});

describe('brand scenes from the manifest snapshot (§17.1, Stage 22)', () => {
  const brandSnapshot = {
    brandManifestId: 'bm1',
    title: 'Бренд',
    styleNotes: null,
    voiceNotes: null,
    filters: null,
    effects: null,
    characters: [],
    scenes: [
      {
        sourceSceneId: 'bs1',
        label: 'Шоурум',
        photoUrl: 'https://blob.test/brand-manifests/bm1/scenes/bs1/photo.png',
        description: 'белые стены, тёплый свет',
      },
      {
        sourceSceneId: 'bs2',
        label: 'Склад',
        photoUrl: null,
        description: 'стеллажи с коробками',
      },
    ],
    snapshotAt: '',
    editedAt: null,
  };
  const sessionScene = {
    id: 'sc_a',
    label: 'Кухня',
    description: null,
    photoUrl: 'https://blob.test/sessions/s/scenes/sc_a/photo.jpg',
    photoPathname: 'sessions/s/scenes/sc_a/photo.jpg',
    createdAt: '',
  };
  const photo = (id: string, order: number) =>
    cast(id, order, {
      kind: 'photo',
      photoUrl: `https://blob.test/${id}.jpg`,
      photoPathname: `sessions/s/characters/${id}/photo.jpg`,
    });

  it('brand scenes with a photo become candidates (origin brand, URL only); without a photo they are text-only briefs', () => {
    const plan = buildReferencePlan({
      ...session([cast('c1', 1)]),
      brandManifestSnapshot: brandSnapshot,
    });
    expect(plan.candidates.map((c) => [c.id, c.origin])).toEqual([
      ['brand-scene:bs1', 'brand'],
      ['product', 'session'],
    ]);
    expect(
      plan.scenes.map((s) => [s.sceneId, s.origin, s.referenceIndex]),
    ).toEqual([
      ['brand-scene:bs1', 'brand', 1],
      ['brand-scene:bs2', 'brand', null],
    ]);
    // A brand scene alone opens reference mode; product takes the last free slot.
    expect(plan.slots).toEqual(['brand-scene:bs1', 'product']);
    expect(plan.legacyFirstFrame).toBe(false);
    const img = plan.images[0];
    expect(img.pathname).toBeNull();
    expect(img.url).toBe(brandSnapshot.scenes[0].photoUrl);
    expect(img.mimeType).toBe('image/png');
  });

  it('default order: characters → session scenes → brand scenes → product', () => {
    const plan = buildReferencePlan({
      ...session([photo('c1', 1)]),
      scenes: [sessionScene],
      brandManifestSnapshot: brandSnapshot,
    });
    expect(plan.candidates.map((c) => c.id)).toEqual([
      'character:c1',
      'scene:sc_a',
      'brand-scene:bs1',
      'product',
    ]);
    expect(plan.slots).toEqual([
      'character:c1',
      'scene:sc_a',
      'brand-scene:bs1',
    ]);
    expect(plan.productReferenceIndex).toBeNull();
  });

  it('brief texts name the brand location and list text-only brand scenes', () => {
    const plan = buildReferencePlan({
      ...session([cast('c1', 1)]),
      brandManifestSnapshot: brandSnapshot,
      referenceSelection: { slots: ['product'], updatedAt: '' },
    });
    const brief = sceneBriefText(plan);
    expect(brief).toContain(
      "- Шоурум (the brand's permanent location): белые стены, тёплый свет [described in words only]",
    );
    expect(brief).toContain(
      "- Склад (the brand's permanent location): стеллажи с коробками",
    );
    expect(referenceMappingText(plan)).toContain(
      'described in the text above: Аня; Шоурум; Склад.',
    );
  });

  it('a snapshot without scenes (pre-Stage-22 session) changes nothing', () => {
    const plan = buildReferencePlan({
      ...session([cast('c1', 1)]),
      brandManifestSnapshot: { ...brandSnapshot, scenes: undefined },
    });
    expect(plan.candidates.map((c) => c.id)).toEqual(['product']);
    expect(plan.legacyFirstFrame).toBe(true);
  });

  // Доп. запрос владельца продукта (ТЗ §20.2/§20.4 п.1) — text-card:
  // референс-изображение с готовым текстом вместо надежды на то, что
  // модель нарисует текст сама.
  describe('text-card (§20)', () => {
    it('момент без cardUrl (ещё не отрендерен) не становится кандидатом', () => {
      const plan = buildReferencePlan({
        ...session([cast('c1', 1)]),
        generationPrompt: {
          onScreenTextMoments: [{ text: 'Купи сейчас', role: 'cta' }],
        } as never,
      });
      expect(plan.candidates.some((c) => c.kind === 'text-card')).toBe(false);
    });

    it('момент с cardUrl становится кандидатом сразу после персонажей, до сцен/товара', () => {
      const plan = buildReferencePlan({
        ...session([
          cast('c1', 1, {
            kind: 'photo',
            photoUrl: 'https://blob.test/c1.png',
          }),
        ]),
        generationPrompt: {
          onScreenTextMoments: [
            {
              text: 'Купи сейчас',
              role: 'cta',
              cardUrl: 'https://blob.test/cta.png',
            },
          ],
        } as never,
      });
      const kinds = plan.candidates.map((c) => c.kind);
      expect(kinds).toEqual(['character', 'text-card', 'product']);
    });

    it('порядок нескольких карточек — по роли (cta > hook > callout), не по порядку в массиве', () => {
      const plan = buildReferencePlan({
        ...session(undefined),
        generationPrompt: {
          onScreenTextMoments: [
            {
              text: 'Скидка 20%',
              role: 'callout',
              cardUrl: 'https://blob.test/callout.png',
            },
            {
              text: 'Смотри сюда',
              role: 'hook',
              cardUrl: 'https://blob.test/hook.png',
            },
            {
              text: 'Купи сейчас',
              role: 'cta',
              cardUrl: 'https://blob.test/cta.png',
            },
          ],
        } as never,
      });
      const textCards = plan.candidates.filter((c) => c.kind === 'text-card');
      expect(textCards.map((c) => c.id)).toEqual([
        'text-card:cta',
        'text-card:hook',
        'text-card:callout',
      ]);
    });

    it('только text-card, без персонажей/сцен — всё равно включает референс-режим, не легаси-первый-кадр', () => {
      const plan = buildReferencePlan({
        ...session(undefined),
        generationPrompt: {
          onScreenTextMoments: [
            {
              text: 'Купи сейчас',
              role: 'cta',
              cardUrl: 'https://blob.test/cta.png',
            },
          ],
        } as never,
      });
      expect(plan.legacyFirstFrame).toBe(false);
      expect(plan.images.some((i) => i.kind === 'text-card')).toBe(true);
    });

    it('referenceMappingText/grokReferencePromptText — требуют копировать текст посимвольно, не переписывать', () => {
      const plan = buildReferencePlan({
        ...session(undefined),
        generationPrompt: {
          onScreenTextMoments: [
            {
              text: 'Купи сейчас',
              role: 'cta',
              cardUrl: 'https://blob.test/cta.png',
            },
          ],
        } as never,
      });
      expect(referenceMappingText(plan)).toContain('character-for-character');
      expect(grokReferencePromptText(plan)).toContain(
        'character-for-character',
      );
    });
  });
});

describe('ИИ-скетч в плане референсов (doc/AI-SKETCH-SPEC.md)', () => {
  const SKETCH = {
    sketchId: 'sk1',
    url: 'https://blob.test/sketches/u1/sk1.png',
    pathname: 'sketches/u1/sk1.png',
    mimeType: 'image/png',
    style: 'pencil' as const,
    sketchRendering: 'realistic' as const,
    appliedAt: '2026-09-17T10:00:00.000Z',
  };

  it('скетч товара уводит его в референсы: первого кадра больше нет (§5.6)', () => {
    const plain = buildReferencePlan(session(undefined) as never);
    expect(plain.legacyFirstFrame).toBe(true);

    const withSketch = buildReferencePlan({
      ...session(undefined),
      productInformation: { ...product, sketch: SKETCH },
    } as never);
    expect(withSketch.legacyFirstFrame).toBe(false);
    expect(withSketch.images).toHaveLength(1);
    expect(withSketch.images[0]).toMatchObject({
      kind: 'product',
      pathname: 'sketches/u1/sk1.png',
      variant: 'sketch',
    });
  });

  it('оригинал персонажа не попадает в план, когда применён скетч', () => {
    const plan = buildReferencePlan(
      session([
        cast('c1', 1, {
          kind: 'photo',
          photoUrl: 'https://blob.test/sessions/s/characters/c1/photo.jpg',
          photoPathname: 'sessions/s/characters/c1/photo.jpg',
          sketch: SKETCH,
        }),
      ]) as never,
    );
    const paths = plan.images.map((i) => i.pathname);
    expect(paths).toContain('sketches/u1/sk1.png');
    expect(paths).not.toContain('sessions/s/characters/c1/photo.jpg');
    expect(plan.candidates.find((c) => c.kind === 'character')?.variant).toBe(
      'sketch',
    );
  });

  it('в промпт уходит пояснение «это рисунок» — и у Veo, и у Grok', () => {
    const plan = buildReferencePlan(
      session([
        cast('c1', 1, {
          kind: 'photo',
          photoUrl: 'https://blob.test/sessions/s/characters/c1/photo.jpg',
          photoPathname: 'sessions/s/characters/c1/photo.jpg',
          sketch: SKETCH,
        }),
      ]) as never,
    );
    expect(referenceMappingText(plan)).toContain('stylized drawing');
    expect(grokReferencePromptText(plan)).toContain('Reference <IMAGE_1>');
    expect(grokReferencePromptText(plan)).toContain('stylized drawing');
  });

  it('режим «в стиле скетча» пояснения не добавляет', () => {
    const plan = buildReferencePlan(
      session([
        cast('c1', 1, {
          kind: 'photo',
          photoUrl: 'https://blob.test/sessions/s/characters/c1/photo.jpg',
          photoPathname: 'sessions/s/characters/c1/photo.jpg',
          sketch: { ...SKETCH, sketchRendering: 'stylized' as const },
        }),
      ]) as never,
    );
    expect(referenceMappingText(plan)).not.toContain('stylized drawing');
  });
});
