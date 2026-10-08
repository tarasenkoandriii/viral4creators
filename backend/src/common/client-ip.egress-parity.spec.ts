/**
 * `client-ip.ts` держит свою копию разбора подсетей (`egress-filter-proxy`
 * копируется в реле живого входа и для sites-backend не чистый). Этот спек
 * — только в backend: две реализации обязаны отвечать одинаково, иначе
 * правило доверия прокси разойдётся с фильтром выхода.
 */
import { ipInTrustedCidr, parseTrustedCidr } from './client-ip';
import { isIpInCidr, parseCidr } from './egress-filter-proxy';

const SPECS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '203.0.113.7',
  '0.0.0.0/0',
  '::1',
  'fd00::/8',
  '2001:db8::/32',
  '::ffff:10.0.0.0/104',
  '::/0',
];
const IPS = [
  '10.1.2.3',
  '::ffff:10.1.2.3',
  '172.31.255.255',
  '172.32.0.1',
  '203.0.113.7',
  '203.0.113.8',
  '::1',
  'fd12::5',
  '2001:db8:1::1',
  '[2001:db8::1]',
  'fe80::1%eth0',
  'not-an-ip',
  '',
];
const BAD = [
  '',
  'x',
  '10.0.0.0/33',
  '10.0.0.0/8x',
  '::/129',
  '1.2.3',
  '1.2.3.4/-1',
];

describe('client-ip — разбор подсетей совпадает с egress-filter-proxy', () => {
  it.each(SPECS)('%s: одна и та же подсеть и одинаковые ответы', (spec) => {
    const mine = parseTrustedCidr(spec);
    const theirs = parseCidr(spec);
    expect(mine).toEqual(theirs);
    for (const ip of IPS) {
      expect([ip, ipInTrustedCidr(ip, mine)]).toEqual([
        ip,
        isIpInCidr(ip, theirs),
      ]);
    }
  });

  it.each(BAD)('кривое %j — исключение у обоих', (spec) => {
    expect(() => parseTrustedCidr(spec)).toThrow();
    expect(() => parseCidr(spec)).toThrow();
  });
});
