import {
  applyAnalysisTranslation,
  buildAnalysisTranslationPrompt,
} from './analysis-translation';
import {
  AnalysisStatus,
  VideoAnalysis,
} from '../../common/types/analysis.types';

const analysis: VideoAnalysis = {
  analysisId: 'a1',
  analyzedAt: new Date(),
  status: AnalysisStatus.COMPLETE,
  sceneBreakdown: 'SCENE 1: unboxing on the kitchen table',
  characters: [
    {
      id: 'c1',
      label: 'Woman in red jacket',
      role: 'presenter',
      appearance: 'mid-20s, red jacket, blonde hair',
      prominence: 'main',
    },
  ],
  scenes: [
    { id: 's1', start: 0, end: 3, title: 'Hook: unboxing', previewAt: 1 },
  ],
  extras: [{ id: 'e1', label: 'Passers-by', description: 'blurred crowd' }],
  audience: {
    ageRange: '25-34',
    gender: 'women',
    interests: ['fitness'],
    summary: 'Young professionals',
    source: 'gemini',
  },
  promotedProduct: {
    category: 'running shoes',
    description: 'lightweight cushioned trainers',
    priceTier: 'mid',
  },
};

describe('buildAnalysisTranslationPrompt', () => {
  it('asks for the target language and includes only the translatable text fields', () => {
    const prompt = buildAnalysisTranslationPrompt(analysis, 'Ukrainian');
    expect(prompt).toContain('into Ukrainian');
    expect(prompt).toContain('Woman in red jacket');
    expect(prompt).toContain('Hook: unboxing');
    expect(prompt).toContain('Passers-by');
    expect(prompt).toContain('running shoes');
    // Служебные поля не должны попадать в промпт — их не переводим.
    expect(prompt).not.toContain('previewAt');
    expect(prompt).not.toContain('prominence');
    expect(prompt).not.toContain('"main"');
  });

  it('keeps ids in the payload so the response can be matched back', () => {
    const prompt = buildAnalysisTranslationPrompt(analysis, 'German');
    expect(prompt).toContain('"c1"');
    expect(prompt).toContain('"s1"');
    expect(prompt).toContain('"e1"');
  });
});

describe('applyAnalysisTranslation', () => {
  it('overlays translated text onto the original analysis, matched by stable id', () => {
    const response = JSON.stringify({
      sceneBreakdown: 'СЦЕНА 1: розпакування на кухонному столі',
      characters: [
        {
          id: 'c1',
          label: 'Жінка в червоній куртці',
          role: 'ведуча',
          appearance: 'близько 25 років, червона куртка, світле волосся',
        },
      ],
      scenes: [{ id: 's1', title: 'Гачок: розпакування' }],
      extras: [{ id: 'e1', label: 'Перехожі', description: 'розмитий натовп' }],
      audience: {
        ageRange: '25-34',
        interests: ['фітнес'],
        summary: 'Молоді професіонали',
      },
      promotedProduct: {
        category: 'бігові кросівки',
        description: 'легкі кросівки з амортизацією',
      },
    });

    const translated = applyAnalysisTranslation(analysis, response);

    expect(translated.sceneBreakdown).toBe(
      'СЦЕНА 1: розпакування на кухонному столі',
    );
    expect(translated.characters?.[0]).toMatchObject({
      id: 'c1',
      label: 'Жінка в червоній куртці',
      role: 'ведуча',
    });
    // Не текстовые поля не тронуты переводом.
    expect(translated.characters?.[0].prominence).toBe('main');
    expect(translated.scenes?.[0].title).toBe('Гачок: розпакування');
    expect(translated.scenes?.[0].start).toBe(0); // таймкоды нетронуты
    expect(translated.extras?.[0].label).toBe('Перехожі');
    expect(translated.audience?.summary).toBe('Молоді професіонали');
    expect(translated.audience?.gender).toBe('women'); // enum не переводится, сохранён
    expect(translated.promotedProduct?.category).toBe('бігові кросівки');
    expect(translated.promotedProduct?.priceTier).toBe('mid');
  });

  it('falls back to the original text for an id missing from the response, never dropping data', () => {
    const response = JSON.stringify({
      characters: [], // модель не вернула ни одного персонажа
    });
    const translated = applyAnalysisTranslation(analysis, response);
    expect(translated.characters?.[0].label).toBe('Woman in red jacket');
  });

  it('returns the original analysis unchanged when the response has no JSON at all', () => {
    const translated = applyAnalysisTranslation(analysis, 'not json at all');
    expect(translated).toEqual(analysis);
  });

  it('never throws on garbled JSON — silent fallback to the English original', () => {
    expect(() =>
      applyAnalysisTranslation(analysis, '{"sceneBreakdown": '),
    ).not.toThrow();
    const translated = applyAnalysisTranslation(
      analysis,
      '{"sceneBreakdown": ',
    );
    expect(translated).toEqual(analysis);
  });

  it('tolerates a response with unexpected shapes for nested objects', () => {
    const response = JSON.stringify({
      audience: 'not an object',
      promotedProduct: null,
    });
    const translated = applyAnalysisTranslation(analysis, response);
    expect(translated.audience).toEqual(analysis.audience);
    expect(translated.promotedProduct).toEqual(analysis.promotedProduct);
  });
});
