import {
  ProtocolError,
  parseJobParams,
  parseJobResult,
} from '../../src/shared/browser-job-protocol';
import {
  generateWorkerSealKeys,
  openSealed,
  sealAad,
  sealForWorker,
} from '../../src/shared/worker-seal';

describe('протокол заданий: параметры без секретов, замок хостов', () => {
  const p = {
    startUrl: 'https://admin.shop.test/admin',
    allowedHosts: ['admin.shop.test'],
    viewport: 'desktop',
    maxPages: 5,
    maxDepth: 1,
    loginMethod: 'password',
  };

  it('лишнее поле (пароль в параметрах) — отказ', () => {
    expect(() =>
      parseJobParams('admin-crawl', { ...p, password: 'x' }),
    ).toThrow(ProtocolError);
    expect(() => parseJobParams('admin-crawl', p)).not.toThrow();
  });

  it('адрес вне замка, логин в адресе, IP-литерал в замке — отказ', () => {
    expect(() =>
      parseJobParams('admin-crawl', { ...p, startUrl: 'https://evil.test/' }),
    ).toThrow(/url.host/);
    expect(() =>
      parseJobParams('admin-crawl', {
        ...p,
        startUrl: 'https://u:p@admin.shop.test/',
      }),
    ).toThrow(/userinfo/);
    expect(() =>
      parseJobParams('admin-crawl', { ...p, allowedHosts: ['10.0.0.1'] }),
    ).toThrow(/allowedHosts/);
    expect(() =>
      parseJobParams('admin-crawl', { ...p, maxPages: 999 }),
    ).toThrow(/maxPages/);
  });

  it('результат: адрес страницы вне замка — отказ; query и фрагмент срезаются', () => {
    const params = parseJobParams('admin-crawl', p);
    expect(() =>
      parseJobResult('admin-crawl', params, {
        loggedIn: true,
        pages: [{ url: 'https://evil.test/x', title: '', text: '' }],
        refusedClicks: 0,
        skippedLinks: 0,
      }),
    ).toThrow(ProtocolError);
    const ok = parseJobResult('admin-crawl', params, {
      loggedIn: true,
      pages: [
        {
          url: 'https://admin.shop.test/admin?token=abc#x',
          title: 'A',
          text: 'B',
        },
      ],
      refusedClicks: 0,
      skippedLinks: 0,
    }) as { pages: Array<{ url: string }> };
    expect(ok.pages[0].url).toBe('https://admin.shop.test/admin');
  });
});

describe('конверт учётки под ключ воркера', () => {
  it('открывается только своим ключом и только для этого задания и попытки', () => {
    const k = generateWorkerSealKeys();
    const other = generateWorkerSealKeys();
    const sealed = sealForWorker(
      k.publicKey,
      Buffer.from('{"password":"x"}'),
      sealAad('j1', 1),
    );
    expect(sealed).not.toContain('password');
    expect(openSealed(k.privateKey, sealed, sealAad('j1', 1)).toString()).toBe(
      '{"password":"x"}',
    );
    expect(() => openSealed(k.privateKey, sealed, sealAad('j1', 2))).toThrow();
    expect(() => openSealed(k.privateKey, sealed, sealAad('j2', 1))).toThrow();
    expect(() =>
      openSealed(other.privateKey, sealed, sealAad('j1', 1)),
    ).toThrow();
    const bad =
      sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => openSealed(k.privateKey, bad, sealAad('j1', 1))).toThrow();
  });
});
