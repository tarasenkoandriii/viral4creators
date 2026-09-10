import {
  MAX_CHARACTERS,
  parseAnalysisResponse,
  parseAudience,
  parseCharacters,
  parseExtras,
  parseFrame,
  parsePromotedProduct,
  parseScenes,
  seconds,
} from './analysis-response';

const full = {
  sceneBreakdown: 'SCENE BREAKDOWN:\n[0:00-0:02] hook…',
  characters: [
    {
      label: 'Woman in red jacket',
      role: 'presenter',
      appearance: 'Late 20s, dark hair, red puffer jacket, speaks to camera',
      prominence: 'main',
    },
    {
      label: 'Barista',
      appearance: 'Man ~35, beard, black apron',
      prominence: 'BACKGROUND',
    },
  ],
};

describe('parseAnalysisResponse — sceneBreakdown keeps its old behaviour', () => {
  it('reads a plain JSON string breakdown', () => {
    const r = parseAnalysisResponse(JSON.stringify(full));
    expect(r.sceneBreakdown).toBe(full.sceneBreakdown);
  });

  it('strips markdown fences and text around the JSON', () => {
    const r = parseAnalysisResponse(
      'Sure! Here you go:\n```json\n' + JSON.stringify(full) + '\n```\nDone.',
    );
    expect(r.sceneBreakdown).toBe(full.sceneBreakdown);
    expect(r.characters).toHaveLength(2);
  });

  it('pretty-prints an array breakdown', () => {
    const r = parseAnalysisResponse(
      JSON.stringify({ sceneBreakdown: [{ t: '0:00' }], characters: [] }),
    );
    expect(r.sceneBreakdown).toBe(JSON.stringify([{ t: '0:00' }], null, 2));
    expect(r.characters).toEqual([]);
  });

  it('falls back to the raw text when the answer is not JSON', () => {
    const r = parseAnalysisResponse('just prose, no json');
    expect(r.sceneBreakdown).toBe('just prose, no json');
    expect(r.characters).toBeUndefined();
  });

  it('keeps the cleaned JSON when sceneBreakdown has an unexpected shape', () => {
    const r = parseAnalysisResponse('```json\n{"sceneBreakdown": 42}\n```');
    expect(r.sceneBreakdown).toBe('{"sceneBreakdown": 42}');
    expect(r.characters).toBeUndefined();
  });

  it('survives broken JSON', () => {
    const txt = '{"sceneBreakdown": "x", "characters": [';
    const r = parseAnalysisResponse(txt);
    expect(r.sceneBreakdown).toBe(txt);
    expect(r.characters).toBeUndefined();
  });
});

describe('parseCharacters — spec §10 character list', () => {
  it('normalises rows: stable ids, default prominence, null role, case-insensitive prominence', () => {
    expect(parseCharacters(full.characters)).toEqual([
      {
        id: 'c1',
        label: 'Woman in red jacket',
        role: 'presenter',
        appearance: 'Late 20s, dark hair, red puffer jacket, speaks to camera',
        prominence: 'main',
        previewAt: null,
        previewUrl: null,
      },
      {
        id: 'c2',
        label: 'Barista',
        role: null,
        appearance: 'Man ~35, beard, black apron',
        prominence: 'background',
        previewAt: null,
        previewUrl: null,
      },
    ]);
  });

  it('accepts name/description synonyms and invents a label when missing', () => {
    const rows = parseCharacters([
      { name: 'Kid', description: 'Boy ~8, striped tee' },
      { appearance: 'Elderly woman with a cane' },
    ]);
    expect(rows?.map((c) => c.label)).toEqual(['Kid', 'Персонаж 2']);
    expect(rows?.[1].prominence).toBe('secondary');
  });

  it('drops entries without an appearance, non-objects, and unknown prominence values', () => {
    const rows = parseCharacters([
      { label: 'Ghost' },
      'string',
      null,
      { label: 'Ok', appearance: 'fine', prominence: 'hero' },
    ]);
    expect(rows).toEqual([
      {
        id: 'c1',
        label: 'Ok',
        role: null,
        appearance: 'fine',
        prominence: 'secondary',
        previewAt: null,
        previewUrl: null,
      },
    ]);
  });

  it('returns undefined for a missing / non-array key, [] for an empty one', () => {
    expect(parseCharacters(undefined)).toBeUndefined();
    expect(parseCharacters('none')).toBeUndefined();
    expect(parseCharacters({})).toBeUndefined();
    expect(parseCharacters([])).toEqual([]);
  });

  it('caps the list and trims long text', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      label: `p${i}`,
      appearance: 'x'.repeat(1000),
    }));
    const rows = parseCharacters(many);
    expect(rows).toHaveLength(MAX_CHARACTERS);
    expect(rows?.[0].appearance).toHaveLength(600);
  });
});

describe('parseFrame — spec §16 picture format', () => {
  it('normalises the ratio, falls back to orientation, ignores junk', () => {
    expect(parseFrame({ orientation: 'vertical', aspectRatio: '9:16' })).toBe(
      '9:16',
    );
    expect(parseFrame({ aspectRatio: '1080x1920' })).toBe('9:16');
    expect(parseFrame({ orientation: 'horizontal' })).toBe('16:9');
    expect(parseFrame({ orientation: 'square' })).toBe('1:1');
    expect(parseFrame({ orientation: 'diagonal' })).toBeNull();
    expect(parseFrame('9:16')).toBeNull();
    expect(parseFrame(undefined)).toBeNull();
  });
  it('rides along in parseAnalysisResponse', () => {
    const r = parseAnalysisResponse(
      JSON.stringify({
        sceneBreakdown: 'x',
        frame: { orientation: 'vertical', aspectRatio: '3:4' },
        characters: [],
      }),
    );
    expect(r.frame).toBe('3:4');
    expect(parseAnalysisResponse('prose').frame).toBeNull();
  });
});

describe('Stage 23 — previews, scenes, audience, promoted product', () => {
  it('seconds(): numbers, "m:ss", "7s"; junk → null', () => {
    expect(seconds(1.56)).toBe(1.6);
    expect(seconds('0:07')).toBe(7);
    expect(seconds('1:02.5')).toBe(62.5);
    expect(seconds('7s')).toBe(7);
    expect(seconds(-1)).toBeNull();
    expect(seconds('soon')).toBeNull();
    expect(seconds(undefined)).toBeNull();
  });

  it('characters carry previewAt (null when absent) and an empty previewUrl', () => {
    const rows = parseCharacters([
      { label: 'A', appearance: 'x', previewAt: 1.25 },
      { label: 'B', appearance: 'y' },
    ])!;
    expect(rows[0].previewAt).toBe(1.3);
    expect(rows[0].previewUrl).toBeNull();
    expect(rows[1].previewAt).toBeNull();
  });

  it('parseScenes: ids, ordered rows, previewAt defaults to the middle and is clamped to the range', () => {
    const rows = parseScenes([
      { start: 0, end: 2.5, title: 'Hook: unboxing', previewAt: 1.2 },
      { start: '0:03', end: '0:05', purpose: 'Problem', previewAt: 9 },
      { start: 5, end: 4 }, // end < start → dropped
      { from: 6, to: 8 }, // synonyms, no title
      'junk',
    ])!;
    expect(
      rows.map((r) => [r.id, r.start, r.end, r.title, r.previewAt]),
    ).toEqual([
      ['s1', 0, 2.5, 'Hook: unboxing', 1.2],
      ['s2', 3, 5, 'Problem', 4],
      ['s3', 6, 8, 'Сцена 3', 7],
    ]);
    expect(parseScenes(undefined)).toBeUndefined();
    expect(parseScenes([])).toEqual([]);
  });

  it('parseAudience: normalises gender synonyms, caps interests, undefined when empty', () => {
    expect(
      parseAudience({
        ageRange: '25-34',
        gender: 'Female',
        interests: ['running', 'health', '', 3],
        summary: 'Young urban women',
      }),
    ).toEqual({
      ageRange: '25-34',
      gender: 'women',
      interests: ['running', 'health'],
      summary: 'Young urban women',
      source: 'gemini',
    });
    expect(parseAudience({ gender: 'mixed' })?.gender).toBe('any');
    expect(parseAudience({ gender: 'aliens' })?.gender).toBeUndefined();
    expect(parseAudience({})).toBeUndefined();
    expect(parseAudience('x')).toBeUndefined();
  });

  it('parsePromotedProduct: category/description/priceTier, undefined without the first two', () => {
    expect(
      parsePromotedProduct({
        category: 'Running shoes',
        description: 'on foot',
        priceTier: 'MID',
      }),
    ).toEqual({
      category: 'Running shoes',
      description: 'on foot',
      priceTier: 'mid',
    });
    expect(
      parsePromotedProduct({ category: null, description: 'not an ad' }),
    ).toEqual({
      category: null,
      description: 'not an ad',
      priceTier: null,
    });
    expect(parsePromotedProduct({ priceTier: 'mid' })).toBeUndefined();
  });

  it('all new keys ride along in parseAnalysisResponse and default to undefined', () => {
    const r = parseAnalysisResponse(
      JSON.stringify({
        ...full,
        scenes: [{ start: 0, end: 1, title: 'Hook' }],
        audience: { ageRange: '18-24', gender: 'any' },
        promotedProduct: { category: 'coffee' },
      }),
    );
    expect(r.scenes?.[0].id).toBe('s1');
    expect(r.audience?.ageRange).toBe('18-24');
    expect(r.promotedProduct?.category).toBe('coffee');
    const old = parseAnalysisResponse(JSON.stringify(full));
    expect(old.scenes).toBeUndefined();
    expect(old.audience).toBeUndefined();
    expect(old.promotedProduct).toBeUndefined();
    expect(parseAnalysisResponse('plain text').audience).toBeUndefined();
  });
});

describe('parseExtras — background crowd (§19)', () => {
  it('rows with ids, label/description fallbacks, cap 6, undefined without the key', () => {
    const rows = parseExtras([
      { label: 'Прохожие', description: 'размытые', previewAt: '0:04' },
      { description: 'очередь у кассы' },
      { label: 'Только название' },
      {},
      'junk',
    ])!;
    expect(
      rows.map((e) => [e.id, e.label, e.description, e.previewAt]),
    ).toEqual([
      ['e1', 'Прохожие', 'размытые', 4],
      ['e2', 'Массовка 2', 'очередь у кассы', null],
      ['e3', 'Только название', 'Только название', null],
    ]);
    expect(parseExtras(undefined)).toBeUndefined();
    expect(parseExtras([])).toEqual([]);
    expect(
      parseAnalysisResponse(
        JSON.stringify({ ...full, extras: [{ label: 'x' }] }),
      ).extras?.length,
    ).toBe(1);
  });
});
