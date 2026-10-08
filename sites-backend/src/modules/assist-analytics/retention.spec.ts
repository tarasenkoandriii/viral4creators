/**
 * Заход 9 (хвост Э3-бис (4)): срок хранения агрегатов по тарифу
 * (§5-тер.17: Pro — 25 мес, остальные — 13).
 */
import { ANALYTICS_DEFAULTS } from '../../config/assist-defaults';
import {
  BASE_AGGREGATES_RETENTION_MS,
  MAX_AGGREGATES_RETENTION_MS,
  aggregatesRetentionMs,
  monthsMs,
} from './retention';

const DAY = 86_400_000;

describe('срок агрегатов по тарифу', () => {
  it('Pro — 25 мес, Business/Start/Trial и без тарифа — 13 (как прежний общий срок)', () => {
    expect(BASE_AGGREGATES_RETENTION_MS).toBe(
      ANALYTICS_DEFAULTS.dailyTotalsRetentionMs,
    );
    expect(aggregatesRetentionMs('pro')).toBe(761 * DAY);
    expect(MAX_AGGREGATES_RETENTION_MS).toBe(761 * DAY);
    for (const p of ['business', 'start', 'trial', null] as const) {
      expect(aggregatesRetentionMs(p)).toBe(396 * DAY);
    }
    expect(monthsMs(1)).toBe(31 * DAY);
  });
});
