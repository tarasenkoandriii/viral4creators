import { expandIPv6, ipLimitKey } from './ip-limit-key';
import * as sandbox from '../modules/assist-sandbox/sandbox-limits';

/** Р-PUB-12 (P-A0): ключ лимита по IP — в common/, песочница реэкспортирует. */
describe('ipLimitKey (common/ip-limit-key.ts)', () => {
  it('IPv4 — как есть; IPv4-mapped — как IPv4; IPv6 — по /64; мусор — с пометкой', () => {
    expect(ipLimitKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(ipLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipLimitKey('[2001:db8:1:2:aaaa::1]')).toBe(
      ipLimitKey('2001:db8:1:2::ffff'),
    );
    expect(ipLimitKey('2001:db8:1:3::1')).not.toBe(
      ipLimitKey('2001:db8:1:2::1'),
    );
    expect(ipLimitKey('not-an-ip')).toBe('raw:not-an-ip');
    expect(expandIPv6('::1')).toEqual([
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0000',
      '0001',
    ]);
  });

  it('прежний импорт из assist-sandbox — та же функция (реэкспорт, не копия)', () => {
    expect(sandbox.ipLimitKey).toBe(ipLimitKey);
    expect(sandbox.expandIPv6).toBe(expandIPv6);
  });
});
