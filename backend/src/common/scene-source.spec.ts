import { ANALYSIS_FRAMING, hasSceneSource, sceneSource } from './scene-source';

/**
 * Этап 152. Одно решение об источнике сцены на обе точки сборки
 * промпта: обычную и A/B-варианты. Разводить их значило бы держать
 * восемь мест, где можно забыть одно из четырёх, — а на четырёх аудит
 * этапа 149 уже поймал пропуск.
 */
const analysed = {
  videoAnalysis: { status: 'complete', sceneBreakdown: 'РАЗБОР' },
  originalVideo: { frame: { aspectRatio: '16:9' } },
};
const onTemplate = {
  sceneTemplate: { templateId: 'before-after' },
};

describe('что считается источником сцены', () => {
  it('разбор — источник, даже пока он идёт', () => {
    expect(hasSceneSource(analysed)).toBe(true);
    expect(hasSceneSource({ videoAnalysis: { status: 'pending' } })).toBe(true);
  });

  it('приём — тоже источник', () => {
    expect(hasSceneSource(onTemplate)).toBe(true);
  });

  it('ни того, ни другого — не источник', () => {
    expect(hasSceneSource({})).toBe(false);
    expect(hasSceneSource({ sceneTemplate: { templateId: 'нечто' } })).toBe(
      false,
    );
    expect(hasSceneSource({ sceneTemplate: null })).toBe(false);
  });
});

describe('разбор', () => {
  it('правки человека сильнее исходного разбора', () => {
    const src = sceneSource({
      ...analysed,
      videoAnalysis: { ...analysed.videoAnalysis, userEdits: 'ПРАВКА' },
    });
    expect(src.text).toBe('ПРАВКА');
    expect(src.fromTemplate).toBe(false);
  });

  it('формат берётся у референса, вводная — прежняя', () => {
    const src = sceneSource(analysed);
    expect(src.text).toBe('РАЗБОР');
    expect(src.frame).toBe('16:9');
    expect(src.framing).toBe(ANALYSIS_FRAMING);
    expect(src.spec).toBeNull();
  });
});

describe('приём', () => {
  it('текст — раскадровка и правила формата', () => {
    const src = sceneSource(onTemplate);
    expect(src.fromTemplate).toBe(true);
    expect(src.text).toContain('IDENTICAL framing');
    expect(src.spec?.id).toBe('before-after');
  });

  it('вводная не выдаёт приём за существующий ролик', () => {
    // Рядом в промпте стоят «recreate» и «the reference rhythm».
    const src = sceneSource(onTemplate);
    expect(src.framing).toContain('no reference video');
    expect(src.framing).not.toBe(ANALYSIS_FRAMING);
  });

  it('формат кадра — свой, а не пустой', () => {
    // Пустой формат не «нет данных»: `cameraBriefText` считает
    // неизвестный формат неродным и срезает амплитуду наезда вдвое.
    expect(sceneSource(onTemplate).frame).toBe('9:16');
  });

  it('завершённый разбор сильнее приёма', () => {
    const src = sceneSource({ ...analysed, ...onTemplate });
    expect(src.fromTemplate).toBe(false);
    expect(src.text).toBe('РАЗБОР');
  });

  it('провалившийся разбор приём не отменяет', () => {
    // Аудит этапа 149 (А-5): иначе промпт уходил в модель с пустым
    // описанием сцены, а следом шёл платный рендер.
    const src = sceneSource({
      ...onTemplate,
      videoAnalysis: { status: 'failed', sceneBreakdown: '' },
    });
    expect(src.fromTemplate).toBe(true);
    expect(src.text).toContain('IDENTICAL framing');
  });
});

describe('пустая сессия', () => {
  it('текст пустой, но не undefined — промпт собирается из строк', () => {
    const src = sceneSource({});
    expect(src.text).toBe('');
    expect(src.frame).toBeUndefined();
  });
});
