/**
 * Валидация query-параметров истории и сводки кронов.
 */

import { BadRequestException } from '@nestjs/common';
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  parseHistoryQuery,
  parseIsoParam,
  parseSummaryQuery,
  SUMMARY_MAX_SPAN_DAYS,
} from './cron-history-query';
import { CRON_LOG_RETENTION_DAYS } from './cron-retention';

describe('parseIsoParam', () => {
  it('дата без времени — полночь UTC', () => {
    expect(parseIsoParam('since', '2026-09-29')?.toISOString()).toBe(
      '2026-09-29T00:00:00.000Z',
    );
  });

  it('дата-время с Z и со смещением', () => {
    expect(
      parseIsoParam('since', '2026-09-29T10:15:30.5Z')?.toISOString(),
    ).toBe('2026-09-29T10:15:30.500Z');
    expect(
      parseIsoParam('since', '2026-09-29T00:00:00+03:00')?.toISOString(),
    ).toBe('2026-09-28T21:00:00.000Z');
  });

  it('пусто — undefined', () => {
    expect(parseIsoParam('since', undefined)).toBeUndefined();
    expect(parseIsoParam('since', '')).toBeUndefined();
  });

  it.each([
    'вчера',
    '1727568000000',
    '2026-9-29',
    '2026-09-29T10:00:00', // без зоны — неоднозначно
    '2026-02-31', // Date.parse молча дал бы 3 марта
    '2026-13-01',
    '2026-09-29T25:00:00Z',
    '2026-09-29T10:61:00Z',
  ])('отклоняет "%s"', (v) => {
    expect(() => parseIsoParam('since', v)).toThrow(BadRequestException);
  });
});

describe('parseHistoryQuery', () => {
  it('по умолчанию — limit 50, без периода и курсора', () => {
    expect(parseHistoryQuery({})).toEqual({
      jobKey: undefined,
      since: undefined,
      until: undefined,
      limit: HISTORY_DEFAULT_LIMIT,
      before: undefined,
    });
  });

  it('limit обрезается потолком, мусор — 400', () => {
    expect(parseHistoryQuery({ limit: '100000' }).limit).toBe(
      HISTORY_MAX_LIMIT,
    );
    expect(parseHistoryQuery({ limit: '120' }).limit).toBe(120);
    for (const bad of ['0', '-5', '1.5', 'abc']) {
      expect(() => parseHistoryQuery({ limit: bad })).toThrow(
        BadRequestException,
      );
    }
  });

  it('since ≥ until — 400', () => {
    expect(() =>
      parseHistoryQuery({ since: '2026-09-30', until: '2026-09-29' }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseHistoryQuery({ since: '2026-09-30', until: '2026-09-30' }),
    ).toThrow(BadRequestException);
  });

  it('курсор: id принимается, спецсимволы — 400', () => {
    expect(parseHistoryQuery({ before: 'cmabc123xyz' }).before).toBe(
      'cmabc123xyz',
    );
    expect(() => parseHistoryQuery({ before: "x' OR 1=1" })).toThrow(
      BadRequestException,
    );
  });
});

describe('parseSummaryQuery', () => {
  const now = new Date('2026-09-30T12:00:00Z');

  it('без параметров — последние 24 часа', () => {
    const q = parseSummaryQuery({}, now);
    expect(q.until).toEqual(now);
    expect(q.since.toISOString()).toBe('2026-09-29T12:00:00.000Z');
  });

  it('только since — сутки от него; только until — сутки до него', () => {
    expect(
      parseSummaryQuery({ since: '2026-09-29' }, now).until.toISOString(),
    ).toBe('2026-09-30T00:00:00.000Z');
    expect(
      parseSummaryQuery({ until: '2026-09-29' }, now).since.toISOString(),
    ).toBe('2026-09-28T00:00:00.000Z');
  });

  it('период длиннее срока хранения журнала и обратный — 400', () => {
    expect(SUMMARY_MAX_SPAN_DAYS).toBe(CRON_LOG_RETENTION_DAYS);
    expect(() =>
      parseSummaryQuery({ since: '2026-08-30', until: '2026-09-30' }, now),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSummaryQuery({ since: '2026-09-30', until: '2026-09-29' }, now),
    ).toThrow(BadRequestException);
    expect(() =>
      parseSummaryQuery({ since: '2026-09-30', until: '2026-09-30' }, now),
    ).toThrow(BadRequestException);
    expect(
      parseSummaryQuery({ since: '2026-08-31', until: '2026-09-30' }, now)
        .since,
    ).toBeInstanceOf(Date);
  });
});
