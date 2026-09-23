import {
  MAX_GREETING_SCENES,
  buildStoryboard,
  normalizeSceneCount,
  splitSceneDurations,
  withStoryboard,
} from './greeting-scenes';

describe('normalizeSceneCount', () => {
  it('держится в границах и не падает на мусоре', () => {
    expect(normalizeSceneCount(3)).toBe(3);
    expect(normalizeSceneCount(0)).toBe(1);
    expect(normalizeSceneCount(99)).toBe(MAX_GREETING_SCENES);
    for (const bad of [null, undefined, 'три', NaN, {}]) {
      expect(normalizeSceneCount(bad)).toBe(1);
    }
  });
});

describe('splitSceneDurations', () => {
  it('сумма равна общей длительности', () => {
    for (const n of [1, 2, 3, 4]) {
      const parts = splitSceneDurations(15, n);
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(15);
    }
  });

  it('остаток достаётся первым сценам, а не последней', () => {
    // Последняя сцена — прощание: лишняя секунда там читается паузой.
    expect(splitSceneDurations(15, 2)).toEqual([8, 7]);
    expect(splitSceneDurations(15, 4)).toEqual([4, 4, 4, 3]);
  });

  it('ни одна сцена не короче секунды — нижняя граница Grok', () => {
    for (const parts of [
      splitSceneDurations(2, 4),
      splitSceneDurations(0, 3),
      splitSceneDurations(1, 4),
    ]) {
      expect(Math.min(...parts)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('buildStoryboard / withStoryboard', () => {
  it('одна сцена — раскадровки нет вовсе', () => {
    // Иначе фича молча изменила бы промпт всех существующих роликов.
    expect(buildStoryboard(1)).toBe('');
    expect(withStoryboard('сцена', 1)).toBe('сцена');
  });

  it('несколько сцен — список кадров по порядку с длительностями', () => {
    const sb = buildStoryboard(3, 15);
    expect(sb).toContain('3 consecutive shots');
    expect(sb).toContain('Shot 1 (~5s)');
    expect(sb).toContain('Shot 2 (~5s)');
    expect(sb).toContain('Shot 3 (~5s)');
  });

  it('склейки просим жёсткие, а единство — явно', () => {
    // Без этого модель охотно меняет ведущего и свет между кадрами, и
    // поздравление рассыпается на нарезку разных людей.
    const sb = buildStoryboard(3);
    expect(sb).toContain('hard cuts');
    expect(sb).toMatch(/same presenter, wardrobe, setting and lighting/);
  });

  it('у каждого кадра своя роль, а не один текст трижды', () => {
    for (const n of [2, 3, 4]) {
      const lines = buildStoryboard(n)
        .split('\n')
        .filter((l) => l.startsWith('- Shot '));
      expect(lines).toHaveLength(n);
      expect(new Set(lines).size).toBe(n);
    }
  });

  it('раскадровка приписывается к описанию, а не заменяет его', () => {
    const p = withStoryboard('описание сцены', 3);
    expect(p).toContain('описание сцены');
    expect(p).toContain('Shot 2');
  });

  it('сумма длительностей в раскадровке равна длине ролика', () => {
    const sb = buildStoryboard(4, 15);
    const seconds = [...sb.matchAll(/~(\d+)s/g)].map((m) => Number(m[1]));
    expect(seconds.reduce((a, b) => a + b, 0)).toBe(15);
  });
});
