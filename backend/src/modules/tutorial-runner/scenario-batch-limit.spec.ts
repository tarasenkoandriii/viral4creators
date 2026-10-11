import { scenarioRunBatchLimit } from './scenario-batch-limit';

describe('scenario run batch limit', () => {
  it.each([
    undefined,
    '',
    '0',
    '-1',
    '1.5',
    'invalid',
    '31',
    '1e1',
    'Infinity',
  ])('preserves the default for invalid configuration %s', (raw) =>
    expect(scenarioRunBatchLimit(raw)).toBe(30),
  );
  it.each([1, 3, 30])('accepts a bounded cap %s', (value) => {
    expect(scenarioRunBatchLimit(` ${value} `)).toBe(value);
  });
});
