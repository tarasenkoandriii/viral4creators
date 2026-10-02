/** Настройки аналитики (A): CIDR офиса — IPv4, IPv6, IPv4-mapped; строгий разбор. */
import {
  defaultAnalyticsConfig,
  effectiveAnalyticsConfig,
  ipInCidrs,
  parseAnalyticsConfig,
} from './analytics-config';

describe('analytics-config (A)', () => {
  it('ipInCidrs: IPv4, IPv6, ::ffff:a.b.c.d, граница маски', () => {
    const cidrs = ['203.0.113.0/24', '2001:db8:abcd::/48', '198.51.100.7'];
    expect(ipInCidrs('203.0.113.77', cidrs)).toBe(true);
    expect(ipInCidrs('203.0.114.1', cidrs)).toBe(false);
    expect(ipInCidrs('::ffff:203.0.113.5', cidrs)).toBe(true);
    expect(ipInCidrs('2001:db8:abcd:12::1', cidrs)).toBe(true);
    expect(ipInCidrs('2001:db8:abce::1', cidrs)).toBe(false);
    expect(ipInCidrs('198.51.100.7', cidrs)).toBe(true);
    expect(ipInCidrs('198.51.100.8', cidrs)).toBe(false);
    expect(ipInCidrs(null, cidrs)).toBe(false);
    expect(ipInCidrs('мусор', cidrs)).toBe(false);
    expect(ipInCidrs('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipInCidrs('10.1.2.3', ['0.0.0.0/0'])).toBe(true);
    expect(ipInCidrs('::1', ['0.0.0.0/0'])).toBe(false);
  });

  it('разбор: лимиты, формат CIDR, неизвестное поле; битое в базе — умолчание', () => {
    const ok = parseAnalyticsConfig({
      minutesPerQuestion: 4.5,
      officeCidrs: ['203.0.113.0/24', '2001:DB8::/32'],
      excludedPaths: ['/admin*'],
    });
    expect(ok).toEqual({
      ok: true,
      config: {
        schema: 1,
        minutesPerQuestion: 4.5,
        officeCidrs: ['203.0.113.0/24', '2001:db8::/32'],
        excludedPaths: ['/admin*'],
      },
    });
    const bad = parseAnalyticsConfig({
      officeCidrs: ['10.0.0.0/33', 'x'],
      minutesPerQuestion: 0,
      nope: true,
    });
    expect(bad.ok ? [] : bad.errors.map((e) => e.path).sort()).toEqual(
      ['minutesPerQuestion', 'nope', 'officeCidrs.0', 'officeCidrs.1'].sort(),
    );
    expect(
      parseAnalyticsConfig({ officeCidrs: Array(21).fill('10.0.0.1') }).ok,
    ).toBe(false);
    expect(effectiveAnalyticsConfig({ officeCidrs: 'x' })).toEqual(
      defaultAnalyticsConfig(),
    );
    expect(defaultAnalyticsConfig().minutesPerQuestion).toBe(3);
  });
});
