import {
  checkSourceUrl,
  hostAllowed,
  isPublicAddress,
} from '../../src/download/url-policy';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:8.8.8.8',
    'fe80::1',
    'fc00::1',
    'fd00:ec2::254',
    'ff02::1',
    '2001:db8::1',
    '2002:c0a8:1::1',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('%s — не публичный', (a) => {
    expect(isPublicAddress(a)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '151.101.1.69',
    '2606:4700::1111',
    '2a00:1450:4001::200e',
  ])('%s — публичный', (a) => {
    expect(isPublicAddress(a)).toBe(true);
  });
});

describe('checkSourceUrl', () => {
  const allow = ['store.example.com', '*.public.blob.vercel-storage.com'];

  it('пропускает https-хост из allowlist', () => {
    expect(
      checkSourceUrl('https://store.example.com/a.mp4?sig=1', allow),
    ).toMatchObject({
      ok: true,
      host: 'store.example.com',
    });
    expect(
      checkSourceUrl('https://abc.public.blob.vercel-storage.com/x.png', allow)
        .ok,
    ).toBe(true);
  });

  it.each([
    'http://store.example.com/a',
    'ftp://store.example.com/a',
    'file:///etc/passwd',
    'https://user:pw@store.example.com/a',
    'https://store.example.com:8443/a',
    'https://public.blob.vercel-storage.com/a',
    'https://evil.com/a',
    'https://store.example.com.evil.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://[::ffff:127.0.0.1]/a',
    'https://2130706433/a',
    'https://169.254.169.254/latest/meta-data',
    'not a url',
  ])('отвергает %s без утечки пути и query', (u) => {
    const r = checkSourceUrl(`${u}?token=SECRET`, allow);
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN_SOURCE' });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|meta-data|passwd/);
  });

  it('hostAllowed: точное совпадение и *.suffix', () => {
    expect(hostAllowed('A.Store.Example.com.', ['*.store.example.com'])).toBe(
      true,
    );
    expect(hostAllowed('store.example.com', ['*.store.example.com'])).toBe(
      false,
    );
    expect(hostAllowed('xstore.example.com', ['store.example.com'])).toBe(
      false,
    );
  });
});
