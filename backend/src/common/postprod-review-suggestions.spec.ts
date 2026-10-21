import { screenPostprodSuggestions } from './postprod-review-suggestions';

const suggestion = (parameter: string, value: unknown) => ({
  parameter,
  value,
  reason: 'Observed regression; requires visual verification',
});
const current = {
  subtitlesInputKey: 'titles',
  subtitleForceStyle: 'FontSize=28,Alignment=2,MarginV=70',
};

describe('postprod model suggestion screen', () => {
  it('rejects the no-op recommendations returned by the live model', () => {
    const screened = screenPostprodSuggestions(
      [
        suggestion('subtitleFontSize', '28'),
        suggestion('subtitleAlignment', '2'),
        suggestion('subtitleMarginV', '70'),
      ],
      current,
    );
    expect(screened.candidates).toHaveLength(0);
    expect(screened.rejected).toHaveLength(3);
    expect(screened.requiresHumanReview).toBe(true);
  });
  it('does not apply SRT settings to ASS titles', () => {
    expect(
      screenPostprodSuggestions([suggestion('subtitleFontSize', '24')], {
        cardsInputKey: 'titles',
      }).rejected,
    ).toHaveLength(1);
  });
  it('rejects injected styles, arbitrary commands and unbounded values', () => {
    for (const value of ['28,Alignment=8', '$(whoami)', Infinity, NaN, 500]) {
      expect(
        screenPostprodSuggestions(
          [suggestion('subtitleFontSize', value)],
          current,
        ).candidates,
      ).toHaveLength(0);
    }
    for (const key of [
      'command',
      'sourceUrl',
      'voiceInputKey',
      '__proto__',
      'constructor',
    ]) {
      expect(
        screenPostprodSuggestions([suggestion(key, 'anything')], current)
          .rejected,
      ).toHaveLength(1);
    }
  });
  it('does not switch framing based on unverified vision', () => {
    expect(
      screenPostprodSuggestions([suggestion('targetAspectRatio', '9:16')], {})
        .candidates,
    ).toHaveLength(0);
    expect(
      screenPostprodSuggestions([suggestion('targetAspectRatio', 'native')], {})
        .candidates,
    ).toHaveLength(0);
    expect(
      screenPostprodSuggestions([suggestion('targetAspectRatio', 'native')], {
        targetAspectRatio: '4:5',
      }).candidates,
    ).toHaveLength(1);
  });
  it('rejects conflicting duplicate suggestions', () => {
    expect(() =>
      screenPostprodSuggestions(
        [
          suggestion('subtitleFontSize', 20),
          suggestion('subtitleFontSize', 22),
        ],
        current,
      ),
    ).toThrow(/Duplicate/);
  });
  it('returns a bounded draft, never an executable style', () => {
    expect(
      screenPostprodSuggestions([suggestion('subtitleFontSize', '20')], current)
        .candidates,
    ).toEqual([
      {
        parameter: 'subtitleFontSize',
        value: 20,
        reason: 'Observed regression; requires visual verification',
      },
    ]);
  });
});
