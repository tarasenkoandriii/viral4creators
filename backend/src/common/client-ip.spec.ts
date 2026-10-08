/**
 * Адрес клиента за прокси (Ш0.7, П-С1 захода 10). Спек копируется в
 * sites-backend вместе с модулем (`scripts/sync-sites-shared.mjs`) —
 * одно правило доверия `X-Forwarded-For` проверяется у обеих сторон.
 */
import {
  clientIp,
  ipInTrustedCidr,
  parseTrustedCidr,
  type ClientIpRequest,
} from './client-ip';

const req = (
  xff: string | string[] | undefined,
  peer?: string,
  ip?: string,
): ClientIpRequest => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  ...(peer === undefined ? {} : { socket: { remoteAddress: peer } }),
  ...(ip === undefined ? {} : { ip }),
});

describe('clientIp — на Vercel (VERCEL задан платформой)', () => {
  const env = { VERCEL: '1' };

  it('первый адрес XFF; без заголовка — адрес сокета, затем req.ip', () => {
    expect(clientIp(req('198.51.100.2, 10.0.0.9', '10.0.0.9'), env)).toBe(
      '198.51.100.2',
    );
    expect(clientIp(req(undefined, '::1'), env)).toBe('::1');
    expect(clientIp(req(undefined, undefined, '127.0.0.1'), env)).toBe(
      '127.0.0.1',
    );
    expect(clientIp(req(undefined), env)).toBe('unknown');
  });

  it('массив заголовков склеивается; ::ffff:-адрес приводится к IPv4', () => {
    expect(clientIp(req(['::ffff:203.0.113.7', '10.0.0.1']), env)).toBe(
      '203.0.113.7',
    );
  });

  it('TRUSTED_PROXY_CIDRS на Vercel не нужен и ничего не меняет', () => {
    expect(
      clientIp(req('198.51.100.2', '8.8.8.8'), {
        ...env,
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8',
      }),
    ).toBe('198.51.100.2');
  });
});

describe('clientIp — вне Vercel (Docker за прокси, локальный запуск)', () => {
  it('без доверенных прокси XFF игнорируется — адрес сокета', () => {
    expect(clientIp(req('1.2.3.4', '203.0.113.9'), {})).toBe('203.0.113.9');
    expect(clientIp(req('1.2.3.4', '::ffff:203.0.113.9'), {})).toBe(
      '203.0.113.9',
    );
  });

  it('недоверенный пир — XFF не читается, даже если список задан', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' };
    expect(clientIp(req('198.51.100.7', '203.0.113.9'), env)).toBe(
      '203.0.113.9',
    );
  });

  it('подмена XFF клиентом не меняет адрес: берётся дописанный прокси', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' };
    expect(clientIp(req('1.2.3.4, 198.51.100.7', '10.0.1.2'), env)).toBe(
      '198.51.100.7',
    );
    expect(clientIp(req('5.6.7.8, 198.51.100.7', '10.0.1.2'), env)).toBe(
      '198.51.100.7',
    );
  });

  it('доверенная цепочка пропускается справа налево (IPv4 и IPv6)', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12, fd00::/8' };
    expect(
      clientIp(req('198.51.100.7, 172.18.0.5', '::ffff:10.0.1.2'), env),
    ).toBe('198.51.100.7');
    expect(clientIp(req('2001:db8::5, fd00::1', 'fd00::2'), env)).toBe(
      '2001:db8::5',
    );
  });

  it('вся цепочка доверенная — самый левый доверенный адрес', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8' };
    expect(clientIp(req('10.0.0.5, 10.0.0.6', '10.0.1.2'), env)).toBe(
      '10.0.0.5',
    );
    expect(clientIp(req(undefined, '10.0.1.2'), env)).toBe('10.0.1.2');
  });

  it('мусор в XFF — дальше не верим; адрес левее мусора не берётся', () => {
    const env = { TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.0/12' };
    expect(clientIp(req('not-an-ip', '10.0.1.2'), env)).toBe('10.0.1.2');
    expect(clientIp(req('6.6.6.6, garbage, 172.18.0.5', '10.0.1.2'), env)).toBe(
      '172.18.0.5',
    );
    expect(clientIp(req('6.6.6.6, garbage', '10.0.1.2'), env)).toBe('10.0.1.2');
  });

  it('кривые записи списка пропускаются (не доверяем), остальные работают', () => {
    const env = { TRUSTED_PROXY_CIDRS: 'junk, 10.0.0.0/33, , 10.0.0.0/8' };
    expect(clientIp(req('198.51.100.7', '10.0.1.2'), env)).toBe('198.51.100.7');
    expect(
      clientIp(req('198.51.100.7', '10.0.1.2'), {
        TRUSTED_PROXY_CIDRS: 'junk',
      }),
    ).toBe('10.0.1.2');
  });

  it('без адреса сокета — unknown (XFF не спасает)', () => {
    expect(clientIp(req('198.51.100.7'), {})).toBe('unknown');
  });
});

describe('parseTrustedCidr / ipInTrustedCidr', () => {
  it('адрес без префикса — ровно он; /0 — всё семейство', () => {
    const one = parseTrustedCidr('203.0.113.7');
    expect(ipInTrustedCidr('203.0.113.7', one)).toBe(true);
    expect(ipInTrustedCidr('203.0.113.8', one)).toBe(false);
    expect(ipInTrustedCidr('1.2.3.4', parseTrustedCidr('0.0.0.0/0'))).toBe(
      true,
    );
  });

  it('IPv4-подсеть ловит ::ffff:-адрес, но не чужое семейство', () => {
    const net = parseTrustedCidr('10.0.0.0/8');
    expect(ipInTrustedCidr('::ffff:10.1.2.3', net)).toBe(true);
    expect(ipInTrustedCidr('::1', net)).toBe(false);
    expect(
      ipInTrustedCidr('2001:db8::1', parseTrustedCidr('2001:db8::/32')),
    ).toBe(true);
    expect(
      ipInTrustedCidr('2001:db9::1', parseTrustedCidr('2001:db8::/32')),
    ).toBe(false);
  });

  it('кривое — исключение', () => {
    for (const bad of [
      '',
      'x',
      '10.0.0.0/33',
      '10.0.0.0/8x',
      '::/129',
      '1.2.3',
    ]) {
      expect(() => parseTrustedCidr(bad)).toThrow();
    }
  });
});
