/**
 * external-url-guard.spec.ts — SSRF-защита для ссылки на товарный фид
 * (этап 68, §47). `dns.promises.lookup` замокан: тест не должен зависеть
 * от реальной сети/DNS-инфраструктуры песочницы.
 */

jest.mock('dns', () => ({ promises: { lookup: jest.fn() } }));

import { promises as dns } from 'dns';
import {
  assertPubliclyRoutableUrl,
  fetchPubliclyRoutable,
  readBodyWithLimit,
  BodyTooLargeError,
  UnsafeExternalUrlError,
} from './external-url-guard';

const lookupMock = dns.lookup as jest.Mock;

function addr(address: string, family: 4 | 6 = 4) {
  return { address, family };
}

beforeEach(() => {
  lookupMock.mockReset();
});

describe('assertPubliclyRoutableUrl — схема и синтаксис', () => {
  it('не URL вовсе — отказ без обращения к DNS', async () => {
    await expect(assertPubliclyRoutableUrl('не ссылка')).rejects.toBeInstanceOf(
      UnsafeExternalUrlError,
    );
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('схема ftp:// — отказ без обращения к DNS (разрешены только http/https)', async () => {
    await expect(
      assertPubliclyRoutableUrl('ftp://example.com/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('схема file:// — отказ', async () => {
    await expect(
      assertPubliclyRoutableUrl('file:///etc/passwd'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });
});

describe('assertPubliclyRoutableUrl — резолв DNS', () => {
  it('хост не резолвится — отказ', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertPubliclyRoutableUrl('https://no-such-host.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('DNS вернул пустой список адресов — отказ', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(
      assertPubliclyRoutableUrl('https://empty.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });
});

describe('assertPubliclyRoutableUrl — заблокированные диапазоны IPv4', () => {
  it.each([
    ['10.0.0.5', '10.0.0.0/8'],
    ['127.0.0.1', 'loopback'],
    ['172.16.5.1', '172.16.0.0/12'],
    ['192.168.1.1', '192.168.0.0/16'],
    ['169.254.169.254', 'метаданные облака'],
    ['0.0.0.5', '"эта сеть"'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['224.0.0.1', 'multicast'],
  ])('%s (%s) отклоняется', async (ip) => {
    lookupMock.mockResolvedValue([addr(ip, 4)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });
});

describe('assertPubliclyRoutableUrl — заблокированные диапазоны IPv6', () => {
  it('::1 (loopback) отклоняется', async () => {
    lookupMock.mockResolvedValue([addr('::1', 6)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('fe80::1 (link-local) отклоняется', async () => {
    lookupMock.mockResolvedValue([addr('fe80::1', 6)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('fc00::1 (unique local) отклоняется', async () => {
    lookupMock.mockResolvedValue([addr('fc00::1', 6)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });

  it('IPv4-mapped IPv6 обёртка приватного адреса (::ffff:10.0.0.1) отклоняется', async () => {
    lookupMock.mockResolvedValue([addr('::ffff:10.0.0.1', 6)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });
});

describe('assertPubliclyRoutableUrl — допустимые адреса', () => {
  it('публичный IPv4 — проходит без ошибки', async () => {
    lookupMock.mockResolvedValue([addr('93.184.216.34', 4)]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).resolves.toBeUndefined();
  });

  it('публичный IPv6 — проходит без ошибки', async () => {
    lookupMock.mockResolvedValue([
      addr('2606:2800:220:1:248:1893:25c8:1946', 6),
    ]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).resolves.toBeUndefined();
  });

  it('несколько адресов, все публичные — проходит', async () => {
    lookupMock.mockResolvedValue([
      addr('93.184.216.34', 4),
      addr('93.184.216.35', 4),
    ]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).resolves.toBeUndefined();
  });
});

describe('assertPubliclyRoutableUrl — смешанные адреса', () => {
  it('один из нескольких резолвящихся адресов приватный — отказ, даже если остальные публичные', async () => {
    lookupMock.mockResolvedValue([
      addr('93.184.216.34', 4),
      addr('127.0.0.1', 4),
    ]);
    await expect(
      assertPubliclyRoutableUrl('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
  });
});

describe('fetchPubliclyRoutable — редирект-safe fetch (пятый аудит, Д-3.1)', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    // По умолчанию всё резолвится в публичный адрес — тесты ниже
    // переопределяют это только там, где проверяют именно блокировку.
    lookupMock.mockResolvedValue([addr('93.184.216.34', 4)]);
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('без редиректа — один вызов fetch, ответ отдаётся как есть', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const res = await fetchPubliclyRoutable('https://seller.test/feed.yml');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://seller.test/feed.yml',
      expect.objectContaining({ redirect: 'manual' }),
    );
    expect(lookupMock).toHaveBeenCalledTimes(1);
  });

  it('один безопасный редирект (публичный → публичный) — проходит, DNS перепроверяется на каждом хопе', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.seller.test/feed.yml' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await fetchPubliclyRoutable('https://seller.test/feed.yml');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cdn.seller.test/feed.yml',
      expect.objectContaining({ redirect: 'manual' }),
    );
    // Одна проверка на исходный адрес, вторая — на адрес редиректа.
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('редирект на служебный/приватный адрес (169.254.169.254) — отказ, второй fetch не выполняется', async () => {
    lookupMock
      .mockResolvedValueOnce([addr('93.184.216.34', 4)])
      .mockResolvedValueOnce([addr('169.254.169.254', 4)]);
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      }),
    );
    await expect(
      fetchPubliclyRoutable('https://seller.test/feed.yml'),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('передаваемый init (например, signal) доходит до каждого хопа', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    const signal = AbortSignal.timeout(1000);
    await fetchPubliclyRoutable('https://seller.test/feed.yml', { signal });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://seller.test/feed.yml',
      expect.objectContaining({ signal, redirect: 'manual' }),
    );
  });

  it('больше maxRedirects редиректов подряд — отказ', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://seller.test/feed.yml' },
      }),
    );
    await expect(
      fetchPubliclyRoutable('https://seller.test/feed.yml', {}, 2),
    ).rejects.toBeInstanceOf(UnsafeExternalUrlError);
    // Стартовый запрос + maxRedirects (2) редиректов = 3 вызова fetch,
    // на четвёртой попытке (hop > maxRedirects) — отказ без нового fetch.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('редирект без заголовка Location — отдаёт ответ как есть (вызывающий код увидит !res.ok)', async () => {
    const redirectRes = new Response(null, { status: 302 });
    fetchMock.mockResolvedValueOnce(redirectRes);
    const res = await fetchPubliclyRoutable('https://seller.test/feed.yml');
    expect(res.status).toBe(302);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('readBodyWithLimit — потоковое ограничение размера тела (пятый аудит, Д-3.2)', () => {
  /** Response со «взрослым» потоковым телом — эмулирует настоящий fetch(), а не заглушку с готовым .text(). */
  function streamResponse(chunks: string[], cancelSpy?: jest.Mock): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
      cancel: cancelSpy,
    });
    return new Response(stream);
  }

  it('тело в пределах лимита, несколько чанков — читается и склеивается целиком', async () => {
    const res = streamResponse(['hello ', 'world']);
    const buf = await readBodyWithLimit(res, 100);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('тело РОВНО равно лимиту (граница) — не бросает', async () => {
    const res = streamResponse(['12345']); // 5 байт
    const buf = await readBodyWithLimit(res, 5);
    expect(buf.toString('utf8')).toBe('12345');
  });

  it('сумма чанков превышает лимит — бросает BodyTooLargeError и отменяет поток (reader.cancel), не дочитывая до конца', async () => {
    const cancelSpy = jest.fn();
    // 6 + 4 = 10 байт при лимите 5 — превышение наступает уже на первом чанке.
    const res = streamResponse(['123456', '7890'], cancelSpy);
    await expect(readBodyWithLimit(res, 5)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('Content-Length занижен/отсутствует, но фактическое тело больше — потоковая проверка всё равно ловит превышение (не полагается на заголовок)', async () => {
    // Тело без установленного Content-Length вовсе — источник, отдающий chunked-ответ.
    const res = streamResponse(['x'.repeat(1000)]);
    expect(res.headers.get('content-length')).toBeNull();
    await expect(readBodyWithLimit(res, 10)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });

  it('res.body недоступен — откат на res.arrayBuffer(), тело в пределах лимита проходит', async () => {
    const res = {
      body: null,
      arrayBuffer: () => Promise.resolve(Buffer.from('hello', 'utf8')),
    } as unknown as Response;
    const buf = await readBodyWithLimit(res, 100);
    expect(buf.toString('utf8')).toBe('hello');
  });

  it('res.body недоступен, тело из arrayBuffer() превышает лимит — бросает постфактум', async () => {
    const res = {
      body: null,
      arrayBuffer: () => Promise.resolve(Buffer.from('x'.repeat(20), 'utf8')),
    } as unknown as Response;
    await expect(readBodyWithLimit(res, 5)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});
