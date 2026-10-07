/**
 * Ш3-хвост (9): потолок байтов. Прослойка-счётчик между Chromium и
 * фильтрующим прокси (на локальных сокетах, без браузера) и потолок тела
 * ответа по событиям CDP (`JobBrowser.watchResponses`, фейковая сессия).
 */
import { EventEmitter } from 'events';
import { connect, createServer, type Server, type Socket } from 'net';
import type { AddressInfo } from 'net';
import { JobBrowser } from '../../src/browser/context';
import {
  authorityOfRequestLine,
  startTrafficMeter,
  type TrafficMeter,
} from '../../src/browser/traffic-meter';

/** «Фильтрующий прокси»: на CONNECT host:port отдаёт bodies[host:port] байт. */
async function fakeProxy(bodies: Record<string, number>) {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on('error', () => undefined);
    s.on('close', () => sockets.delete(s));
    s.once('data', (chunk: Buffer) => {
      const m = /^CONNECT (\S+) /.exec(chunk.toString('latin1'));
      const n = m ? (bodies[m[1]] ?? 0) : 0;
      s.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Кусками по 64 КБ, соединение остаётся открытым (как тоннель).
      let left = n;
      const push = () => {
        while (left > 0) {
          const k = Math.min(left, 65_536);
          left -= k;
          if (!s.write(Buffer.alloc(k, 0x61))) {
            s.once('drain', push);
            return;
          }
        }
      };
      push();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Соединение «браузера» через счётчик: сколько байт пришло до закрытия. */
function tunnel(meter: TrafficMeter, authority: string, waitMs = 300) {
  return new Promise<{ bytes: number; closed: boolean; sock: Socket }>(
    (resolve) => {
      let bytes = 0;
      let closed = false;
      const sock = connect(meter.port, '127.0.0.1', () => {
        sock.write(
          `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
        );
      });
      sock.on('data', (c: Buffer) => (bytes += c.length));
      sock.on('error', () => undefined);
      sock.on('close', () => {
        closed = true;
      });
      setTimeout(() => resolve({ bytes, closed, sock }), waitMs);
    },
  );
}

describe('счётчик трафика задания', () => {
  it('первая строка запроса браузера → host:port', () => {
    expect(authorityOfRequestLine('CONNECT Shop.test:443 HTTP/1.1\r\n')).toBe(
      'shop.test:443',
    );
    expect(
      authorityOfRequestLine('GET http://shop.test/a?b=1 HTTP/1.1\r\n'),
    ).toBe('shop.test:80');
    expect(authorityOfRequestLine('GET http://[::1]:8080/ HTTP/1.1\r\n')).toBe(
      '[::1]:8080',
    );
    expect(authorityOfRequestLine('garbage\r\n')).toBeNull();
    expect(authorityOfRequestLine('CONNECT a/b:443 HTTP/1.1\r\n')).toBeNull();
  });

  it('считает байты; под потолком задание не трогает', async () => {
    const proxy = await fakeProxy({ 'small.test:443': 100_000 });
    const onJobLimit = jest.fn();
    const meter = await startTrafficMeter({
      targetPort: proxy.port,
      jobBytes: 1_000_000,
      onJobLimit,
    });
    const t = await tunnel(meter, 'small.test:443');
    expect(t.closed).toBe(false);
    expect(t.bytes).toBeGreaterThan(100_000);
    const s = meter.stats();
    expect(s.bytesIn).toBe(t.bytes);
    expect(s.bytesOut).toBeGreaterThan(20);
    expect(s.connections).toBe(1);
    expect(s.cutJob).toBe(false);
    expect(onJobLimit).not.toHaveBeenCalled();
    t.sock.destroy();
    await meter.close();
    await proxy.close();
  });

  it('потолок задания: все соединения рвутся, новые отклоняются, колбэк один раз', async () => {
    const proxy = await fakeProxy({
      'quiet.test:443': 10,
      'flood.test:443': 5_000_000,
    });
    const onJobLimit = jest.fn();
    const meter = await startTrafficMeter({
      targetPort: proxy.port,
      jobBytes: 1_000_000,
      onJobLimit,
    });
    const quiet = tunnel(meter, 'quiet.test:443', 500);
    const flood = await tunnel(meter, 'flood.test:443', 500);
    const q = await quiet;
    expect(flood.closed).toBe(true);
    expect(q.closed).toBe(true); // соседнее соединение задания — тоже
    // Сверх потолка браузер получил не больше одного куска.
    expect(flood.bytes).toBeLessThanOrEqual(1_000_000 + 65_536 + 100);
    expect(onJobLimit).toHaveBeenCalledTimes(1);
    expect(meter.exceeded).toBe(true);
    const late = await tunnel(meter, 'quiet.test:443', 200);
    expect(late.closed).toBe(true);
    expect(late.bytes).toBe(0);
    expect(meter.stats()).toMatchObject({ cutJob: true, refused: 1 });
    await meter.close();
    await proxy.close();
  });

  it('cutAuthority рвёт соединения только этого хоста', async () => {
    const proxy = await fakeProxy({ 'a.test:443': 10, 'b.test:443': 10 });
    const meter = await startTrafficMeter({
      targetPort: proxy.port,
      jobBytes: 1_000_000,
    });
    const a = tunnel(meter, 'a.test:443', 400);
    const b = tunnel(meter, 'b.test:443', 400);
    await new Promise((r) => setTimeout(r, 150));
    expect(meter.cutAuthority('A.test:443')).toBe(1);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.closed).toBe(true);
    expect(rb.closed).toBe(false);
    expect(meter.stats().cutResponses).toBe(1);
    rb.sock.destroy();
    await meter.close();
    await proxy.close();
  });
});

type Cdp = Parameters<JobBrowser['watchResponses']>[0];

describe('потолок тела ответа по CDP', () => {
  function harness(responseBytes: number) {
    const cuts: string[] = [];
    const jb = Object.create(JobBrowser.prototype) as JobBrowser;
    Object.assign(jb, {
      limits: { responseBytes, jobBytes: responseBytes * 10 },
      docCut: new Set<string>(),
      meter: {
        cutAuthority: (a: string) => {
          cuts.push(a);
          return 1;
        },
      },
    });
    const cdp = new EventEmitter() as EventEmitter & {
      send: jest.Mock;
    };
    cdp.send = jest.fn(async (method: string) =>
      method === 'Page.getFrameTree'
        ? { frameTree: { frame: { id: 'MAIN' } } }
        : undefined,
    );
    return { jb, cdp, cuts };
  }

  const resp = (
    requestId: string,
    url: string,
    type = 'Image',
    headers: Record<string, string> = {},
  ) => ({ requestId, type, response: { url, headers } });

  it('Content-Length больше потолка — обрыв сразу; меньше — нет', async () => {
    const { jb, cdp, cuts } = harness(1_000);
    await jb.watchResponses(cdp as unknown as Cdp);
    expect(cdp.send).toHaveBeenCalledWith('Network.enable', {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
    });
    cdp.emit(
      'Network.responseReceived',
      resp('1', 'https://cdn.shop.test/big.mp4', 'Media', {
        'Content-Length': '5000',
      }),
    );
    cdp.emit(
      'Network.responseReceived',
      resp('2', 'http://shop.test:8080/ok.png', 'Image', {
        'content-length': '999',
      }),
    );
    expect(cuts).toEqual(['cdn.shop.test:443']);
  });

  it('без длины: по приходу данных; «gzip-бомба» — по распакованным байтам', async () => {
    const { jb, cdp, cuts } = harness(1_000);
    await jb.watchResponses(cdp as unknown as Cdp);
    cdp.emit('Network.responseReceived', resp('s', 'https://a.test/stream'));
    cdp.emit('Network.dataReceived', {
      requestId: 's',
      dataLength: 600,
      encodedDataLength: 600,
    });
    expect(cuts).toEqual([]);
    cdp.emit('Network.dataReceived', {
      requestId: 's',
      dataLength: 600,
      encodedDataLength: 600,
    });
    expect(cuts).toEqual(['a.test:443']);
    // Тот же ответ дальше не считается (уже оборван).
    cdp.emit('Network.dataReceived', { requestId: 's', dataLength: 5_000 });
    expect(cuts).toHaveLength(1);
    cdp.emit('Network.responseReceived', resp('z', 'https://bomb.test/x.js'));
    cdp.emit('Network.dataReceived', {
      requestId: 'z',
      dataLength: 50_000,
      encodedDataLength: 120,
    });
    expect(cuts).toEqual(['a.test:443', 'bomb.test:443']);
  });

  it('законченный ответ забывается; документ перехода помечается для goto', async () => {
    const { jb, cdp, cuts } = harness(1_000);
    await jb.watchResponses(cdp as unknown as Cdp);
    cdp.emit('Network.responseReceived', resp('d', 'https://a.test/'));
    cdp.emit('Network.loadingFinished', { requestId: 'd' });
    cdp.emit('Network.dataReceived', { requestId: 'd', dataLength: 9_999 });
    expect(cuts).toEqual([]);
    cdp.emit('Network.responseReceived', {
      ...resp('doc', 'https://a.test/page#top', 'Document'),
      frameId: 'MAIN',
    });
    cdp.emit('Network.dataReceived', { requestId: 'doc', dataLength: 2_000 });
    expect(cuts).toEqual(['a.test:443']);
    expect(
      (jb as unknown as { docCut: Set<string> }).docCut.has(
        'https://a.test/page',
      ),
    ).toBe(true);
  });

  it('документ iframe сверх потолка — обрыв, но переход главной страницы он не роняет', async () => {
    const { jb, cdp, cuts } = harness(1_000);
    await jb.watchResponses(cdp as unknown as Cdp);
    const docCut = (jb as unknown as { docCut: Set<string> }).docCut;
    cdp.emit('Network.responseReceived', {
      ...resp('f', 'https://ads.test/frame', 'Document'),
      frameId: 'CHILD',
    });
    cdp.emit('Network.dataReceived', { requestId: 'f', dataLength: 2_000 });
    expect(cuts).toEqual(['ads.test:443']);
    expect(docCut.size).toBe(0);
    // Главный фрейм — помечается, и идущий goto узнаёт сразу.
    const onDocCut = jest.fn();
    Object.assign(jb, { onDocCut });
    cdp.emit('Network.responseReceived', {
      ...resp('m', 'https://a.test/huge', 'Document', {
        'content-length': '99999',
      }),
      frameId: 'MAIN',
    });
    expect(docCut.has('https://a.test/huge')).toBe(true);
    expect(onDocCut).toHaveBeenCalledTimes(1);
  });
});
