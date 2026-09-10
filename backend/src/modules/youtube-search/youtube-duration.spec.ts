import { formatDuration, parseIsoDuration } from './youtube-duration';

describe('parseIsoDuration', () => {
  it.each([
    ['PT4M13S', 253],
    ['PT1H2M', 3720],
    ['PT59S', 59],
    ['PT0S', 0],
    ['P1DT2H', 93600],
    ['PT10M', 600],
    [' PT7S ', 7],
  ])('%s → %d seconds', (input, expected) => {
    expect(parseIsoDuration(input)).toBe(expected);
  });

  it('returns null for missing or malformed values', () => {
    expect(parseIsoDuration(undefined)).toBeNull();
    expect(parseIsoDuration(null)).toBeNull();
    expect(parseIsoDuration('')).toBeNull();
    expect(parseIsoDuration('P')).toBeNull();
    expect(parseIsoDuration('PT')).toBeNull();
    expect(parseIsoDuration('4:13')).toBeNull();
    expect(parseIsoDuration('PT4M13')).toBeNull();
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [7, '0:07'],
    [75, '1:15'],
    [600, '10:00'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [93600, '26:00:00'],
  ])('%d → %s', (seconds, label) => {
    expect(formatDuration(seconds)).toBe(label);
  });

  it('clamps negatives and floors fractions', () => {
    expect(formatDuration(-5)).toBe('0:00');
    expect(formatDuration(61.9)).toBe('1:01');
  });
});
