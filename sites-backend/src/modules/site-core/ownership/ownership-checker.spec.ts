import { FakeNet } from '../testing/fake-net.testing';
import { DohClient, parseTxtData } from './doh.client';
import { firstLine, metaContents } from './ownership-checker';
import type { HostAddress } from '../hosts/host-normalize';

const TOKEN = 'tok_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'tok_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const apex: HostAddress = { scheme: 'https', host: 'example.com', port: 443 };
const shop: HostAddress = {
  scheme: 'https',
  host: 'shop.example.com',
  port: 443,
};

describe('DoH', () => {
  it('куски TXT склеиваются, экранирование снимается', () => {
    expect(parseTxtData('"v4c-verify=ab" "cd"')).toBe('v4c-verify=abcd');
    expect(parseTxtData('"a\\"b"')).toBe('a"b');
  });

  it('один резолвер — не «два независимых»: конструктор бросает', () => {
    expect(() => new DohClient([{ name: 'x', url: (n) => n }])).toThrow(/два/);
  });

  it('NXDOMAIN — ответ (пусто), 503 — сбой', async () => {
    const net = new FakeNet();
    net.down.add('r2');
    const answers = await net.doh().resolveTxtAll('_v4c-verify.example.com');
    expect(answers).toEqual([
      { ok: true, resolver: 'r1', values: [] },
      { ok: false, resolver: 'r2', error: 'HTTP 503' },
    ]);
  });
});

describe('проверка DNS', () => {
  it('оба резолвера видят запись кабинета — подтверждено', async () => {
    const net = new FakeNet().txt(
      '_v4c-verify.example.com',
      'google-site-verification=x',
      `v4c-verify=${TOKEN}`,
    );
    const r = await net.checker().check('dns', apex, TOKEN);
    expect(r).toMatchObject({ ok: true, code: 'VERIFIED', method: 'dns' });
  });

  it('резолверы не совпали — НЕ подтверждено и не повод отзывать', async () => {
    const net = new FakeNet();
    net.zones.r1.set('_v4c-verify.example.com', [`v4c-verify=${TOKEN}`]);
    net.zones.r2.set('_v4c-verify.example.com', []);
    const r = await net.checker().check('dns', apex, TOKEN);
    expect(r).toMatchObject({
      ok: false,
      code: 'DNS_RESOLVERS_DISAGREE',
      definitive: false,
    });
  });

  it('один резолвер лежит — НЕ подтверждено (нет совпадения двух)', async () => {
    const net = new FakeNet().txt(
      '_v4c-verify.example.com',
      `v4c-verify=${TOKEN}`,
    );
    net.down.add('r1');
    const r = await net.checker().check('dns', apex, TOKEN);
    expect(r).toMatchObject({
      ok: false,
      code: 'DNS_UNAVAILABLE',
      definitive: false,
    });
  });

  it('токен ЧУЖОГО кабинета не подтверждает', async () => {
    const net = new FakeNet().txt(
      '_v4c-verify.example.com',
      `v4c-verify=${OTHER}`,
    );
    const r = await net.checker().check('dns', apex, TOKEN);
    expect(r).toMatchObject({
      ok: false,
      code: 'DNS_NOT_FOUND',
      definitive: true,
    });
  });

  it('голый токен без префикса v4c-verify= — не формат QA §2.4', async () => {
    const net = new FakeNet().txt('_v4c-verify.example.com', TOKEN);
    expect((await net.checker().check('dns', apex, TOKEN)).ok).toBe(false);
  });

  it('TXT на apex НЕ подтверждает поддомен', async () => {
    const net = new FakeNet().txt(
      '_v4c-verify.example.com',
      `v4c-verify=${TOKEN}`,
    );
    const r = await net.checker().check('dns', shop, TOKEN);
    expect(r.ok).toBe(false);
  });
});

describe('проверка файлом', () => {
  const FILE = 'https://example.com/.well-known/v4c-verify.txt';

  it('токен в первой строке — подтверждено; каждый хоп через SSRF-ворота', async () => {
    const net = new FakeNet().page(FILE, {
      status: 200,
      body: `${TOKEN}\nкомментарий`,
    });
    const r = await net.checker().check('file', apex, TOKEN);
    expect(r).toMatchObject({ ok: true, method: 'file' });
    expect(net.asserted).toEqual([FILE]);
  });

  it('редирект на ДРУГОЙ хост — отказ, по редиректу не идём', async () => {
    const net = new FakeNet()
      .page(FILE, {
        status: 302,
        location: 'https://evil.test/.well-known/v4c-verify.txt',
      })
      .page('https://evil.test/.well-known/v4c-verify.txt', {
        status: 200,
        body: TOKEN,
      });
    const r = await net.checker().check('file', apex, TOKEN);
    expect(r).toMatchObject({ ok: false, code: 'REDIRECT_OTHER_HOST' });
    expect(net.fetched).toEqual([FILE]);
  });

  it('редирект apex → www — тоже другой хост', async () => {
    const net = new FakeNet()
      .page(FILE, {
        status: 301,
        location: 'https://www.example.com/.well-known/v4c-verify.txt',
      })
      .page('https://www.example.com/.well-known/v4c-verify.txt', {
        status: 200,
        body: TOKEN,
      });
    const r = await net.checker().check('file', apex, TOKEN);
    expect(r.code).toBe('REDIRECT_OTHER_HOST');
  });

  it('редирект на http того же хоста — другая схема, отказ', async () => {
    const net = new FakeNet().page(FILE, {
      status: 301,
      location: 'http://example.com/.well-known/v4c-verify.txt',
    });
    expect((await net.checker().check('file', apex, TOKEN)).code).toBe(
      'REDIRECT_OTHER_HOST',
    );
  });

  it('редирект в пределах хоста — допустим, второй хоп тоже через ворота', async () => {
    const net = new FakeNet()
      .page(FILE, { status: 301, location: '/.well-known/v4c-verify.txt?x=1' })
      .page(`${FILE}?x=1`, { status: 200, body: TOKEN });
    const r = await net.checker().check('file', apex, TOKEN);
    expect(r.ok).toBe(true);
    expect(net.asserted).toEqual([FILE, `${FILE}?x=1`]);
  });

  it('SSRF: хост в приватной сети — не подтверждено, запроса нет', async () => {
    const net = new FakeNet().page(FILE, { status: 200, body: TOKEN });
    net.privateHosts.add('example.com');
    const r = await net.checker().check('file', apex, TOKEN);
    expect(r).toMatchObject({ ok: false, code: 'UNSAFE_URL' });
    expect(net.fetched).toEqual([]);
  });

  it('файл больше 64 КБ — не маркер', async () => {
    const net = new FakeNet().page(FILE, {
      status: 200,
      body: `${TOKEN}\n${'x'.repeat(70 * 1024)}`,
    });
    expect((await net.checker().check('file', apex, TOKEN)).code).toBe(
      'BODY_TOO_LARGE',
    );
  });

  it('404 — файла точно нет; 503 — не смогли проверить', async () => {
    const net = new FakeNet();
    expect(await net.checker().check('file', apex, TOKEN)).toMatchObject({
      code: 'FILE_NOT_FOUND',
      definitive: true,
    });
    net.page(FILE, { status: 503 });
    expect(await net.checker().check('file', apex, TOKEN)).toMatchObject({
      code: 'HTTP_ERROR',
      definitive: false,
    });
  });

  it('чужой токен в файле — не подтверждает', async () => {
    const net = new FakeNet().page(FILE, { status: 200, body: OTHER });
    expect((await net.checker().check('file', apex, TOKEN)).code).toBe(
      'TOKEN_MISMATCH',
    );
  });

  it('первая строка: BOM и \\r\\n не мешают', () => {
    expect(firstLine(`﻿  ${TOKEN}  \r\nx`)).toBe(TOKEN);
  });
});

describe('проверка мета-тегом', () => {
  const HOME = 'https://example.com/';

  it('мета в любом порядке атрибутов и регистре имени', async () => {
    const net = new FakeNet().page(HOME, {
      status: 200,
      body: `<html><head><META content='${TOKEN}' NAME="V4C-Verify"></head>`,
    });
    expect((await net.checker().check('meta', apex, TOKEN)).ok).toBe(true);
  });

  it('мета с чужим токеном — нет', async () => {
    const net = new FakeNet().page(HOME, {
      status: 200,
      body: `<meta name="v4c-verify" content="${OTHER}">`,
    });
    expect(await net.checker().check('meta', apex, TOKEN)).toMatchObject({
      ok: false,
      code: 'META_NOT_FOUND',
      definitive: true,
    });
  });

  it('большая главная: мета в первых 64 КБ находится, тело дальше не читается', async () => {
    const net = new FakeNet().page(HOME, {
      status: 200,
      body: `<head><meta name="v4c-verify" content="${TOKEN}"></head>${'x'.repeat(500 * 1024)}`,
    });
    expect((await net.checker().check('meta', apex, TOKEN)).ok).toBe(true);
  });

  it('мета за пределами 64 КБ не засчитывается', async () => {
    const net = new FakeNet().page(HOME, {
      status: 200,
      body: `${'x'.repeat(65 * 1024)}<meta name="v4c-verify" content="${TOKEN}">`,
    });
    expect((await net.checker().check('meta', apex, TOKEN)).ok).toBe(false);
  });

  it('редирект главной на другой хост — отказ', async () => {
    const net = new FakeNet().page(HOME, {
      status: 302,
      location: 'https://other.test/',
    });
    expect((await net.checker().check('meta', apex, TOKEN)).code).toBe(
      'REDIRECT_OTHER_HOST',
    );
  });

  it('metaContents: несколько кабинетов — несколько тегов', () => {
    expect(
      metaContents(
        `<meta name="v4c-verify" content="a"><meta name=v4c-verify content=b><meta name="x" content="c">`,
        'v4c-verify',
      ),
    ).toEqual(['a', 'b']);
  });
});
