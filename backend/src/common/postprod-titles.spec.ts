import { buildPostprodTitlesAss } from './postprod-titles';

const layout = {
  width: 1280,
  height: 720,
  box: { x: 80, y: 140, width: 1120, height: 120 },
  fontSize: 28,
};
const cue = { startSeconds: 2, endSeconds: 8, text: 'Тест титров' };

describe('postprod editorial titles', () => {
  it('uses the actual pixel canvas and an explicit safe anchor', () => {
    const ass = buildPostprodTitlesAss(layout, [cue], 55.76);
    expect(ass).toContain('PlayResX: 1280\nPlayResY: 720');
    expect(ass).toContain('{\\an8\\pos(640,142)}Тест титров');
    expect(ass).toContain('0:00:02.00,0:00:08.00');
  });
  it('neutralizes ASS overrides and event injection', () => {
    const ass = buildPostprodTitlesAss(
      layout,
      [{ ...cue, text: '{\\pos(0,0)}\nX' }],
      56,
    );
    expect(ass).not.toContain('{\\pos(0,0)}');
    expect(ass.match(/^Dialogue:/gm)).toHaveLength(1);
  });
  it.each([NaN, Infinity, -1, 1921])(
    'rejects invalid canvas width %s',
    (width) => {
      expect(() =>
        buildPostprodTitlesAss({ ...layout, width }, [cue], 56),
      ).toThrow();
    },
  );
  it('rejects rectangles outside the frame', () => {
    expect(() =>
      buildPostprodTitlesAss(
        { ...layout, box: { ...layout.box, x: 500 } },
        [cue],
        56,
      ),
    ).toThrow();
  });
  it('rejects overflowing text instead of hiding it with clip', () => {
    expect(() =>
      buildPostprodTitlesAss(layout, [{ ...cue, text: 'W'.repeat(100) }], 56),
    ).toThrow(/fit/);
  });
  it.each([-1, NaN, 56])('rejects invalid cue start %s', (startSeconds) => {
    expect(() =>
      buildPostprodTitlesAss(layout, [{ ...cue, startSeconds }], 56),
    ).toThrow();
  });
  it('rejects time overflow, overlapping cues and empty text', () => {
    expect(() =>
      buildPostprodTitlesAss(layout, [{ ...cue, endSeconds: 57 }], 56),
    ).toThrow();
    expect(() => buildPostprodTitlesAss(layout, [cue, cue], 56)).toThrow();
    expect(() =>
      buildPostprodTitlesAss(layout, [{ ...cue, text: '\n' }], 56),
    ).toThrow();
  });
});
