// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/ip-hash.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import { createHash } from 'crypto';
import { hashIpWithDailySalt } from './ip-hash';

describe('hashIpWithDailySalt', () => {
  const day1 = new Date('2026-10-01T10:00:00Z');

  it('sha256 от `ip:YYYY-MM-DD:секрет` (UTC)', () => {
    const expected = createHash('sha256')
      .update('1.2.3.4:2026-10-01:s3cret')
      .digest('hex');
    expect(hashIpWithDailySalt('1.2.3.4', 's3cret', day1)).toBe(expected);
  });

  it('внутри суток UTC хеш стабилен, на следующие сутки — другой', () => {
    const late = new Date('2026-10-01T23:59:59Z');
    const next = new Date('2026-10-02T00:00:00Z');
    const h = hashIpWithDailySalt('1.2.3.4', 's', day1);
    expect(hashIpWithDailySalt('1.2.3.4', 's', late)).toBe(h);
    expect(hashIpWithDailySalt('1.2.3.4', 's', next)).not.toBe(h);
  });

  it('другой секрет — другой хеш (соль сайта у Помощника)', () => {
    expect(hashIpWithDailySalt('1.2.3.4', 'a', day1)).not.toBe(
      hashIpWithDailySalt('1.2.3.4', 'b', day1),
    );
  });

  it('сырой IP в хеш не просачивается', () => {
    expect(hashIpWithDailySalt('1.2.3.4', 's', day1)).toMatch(/^[0-9a-f]{64}$/);
  });
});
