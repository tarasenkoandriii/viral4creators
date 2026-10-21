import * as https from 'node:https';
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync as rf,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  DownloadError,
  DownloadOptions,
  ResolvedAddress,
  downloadInput,
} from '../../src/download/download';
import { isPublicAddress } from '../../src/download/url-policy';

const TLS = join(__dirname, '..', 'fixtures', 'tls');
const CA = readFileSync(join(TLS, 'ca.crt'));
const BODY = Buffer.alloc(100_000, 7);

let server: https.Server;
let port: number;
let dir: string;
const openSockets = new Set<import('node:net').Socket>();

beforeAll(async () => {
  server = https.createServer(
    {
      key: readFileSync(join(TLS, 'server.key')),
      cert: readFileSync(join(TLS, 'server.crt')),
    },
    (req, res) => {
      const u = new URL(req.url ?? '/', 'https://x');
      const p = u.pathname;
      const base = `https://inputs.test:${port}`;
      if (p === '/ok') {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': BODY.length,
        });
        res.end(BODY);
      } else if (p === '/chunked-big') {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        let n = 0;
        const write = () => {
          while (n < 40) {
            n++;
            if (!res.write(Buffer.alloc(64 * 1024, 1)))
              return res.once('drain', write);
          }
          res.end();
        };
        write();
      } else if (p === '/declared-big') {
        res.writeHead(200, { 'content-length': 50_000_000 });
        res.write(Buffer.alloc(1000));
      } else if (p.startsWith('/redirect/')) {
        const n = Number(p.split('/')[2]);
        res.writeHead(302, {
          location: n > 1 ? `/redirect/${n - 1}` : `${base}/ok`,
        });
        res.end();
      } else if (p === '/to-private') {
        res.writeHead(302, { location: `https://10.0.0.1:${port}/ok` });
        res.end();
      } else if (p === '/to-metadata') {
        res.writeHead(301, {
          location: `https://169.254.169.254/latest/meta-data/`,
        });
        res.end();
      } else if (p === '/to-http') {
        res.writeHead(302, { location: `http://inputs.test:${port}/ok` });
        res.end();
      } else if (p === '/to-evil') {
        res.writeHead(307, { location: `https://evil.test:${port}/ok` });
        res.end();
      } else if (p === '/to-rebind') {
        res.writeHead(302, { location: `https://rebind.test:${port}/ok` });
        res.end();
      } else if (p === '/expired') {
        res.writeHead(403).end('expired');
      } else if (p === '/gone') {
        res.writeHead(410).end();
      } else if (p === '/unauth') {
        res.writeHead(401).end();
      } else if (p === '/boom') {
        res.writeHead(500).end();
      } else if (p === '/cut') {
        res.writeHead(200, { 'content-length': 100_000 });
        res.write(Buffer.alloc(10_000));
        setTimeout(() => res.socket?.destroy(), 20);
      } else if (p === '/stall') {
        res.writeHead(200, { 'content-length': 100_000 });
        res.write(Buffer.alloc(1000));
      } else if (p === '/no-headers') {
        // ничего не отвечаем
      } else {
        res.writeHead(404).end();
      }
    },
  );
  server.on('secureConnection', (s) => {
    openSockets.add(s);
    s.on('close', () => openSockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  dir = mkdtempSync(join(tmpdir(), 'ffdl-'));
});

afterAll(async () => {
  openSockets.forEach((s) => s.destroy());
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

function resolver(): {
  lookup: (h: string) => Promise<ResolvedAddress[]>;
  calls: string[];
} {
  const calls: string[] = [];
  let rebindCalls = 0;
  return {
    calls,
    lookup: async (h: string) => {
      calls.push(h);
      const local: ResolvedAddress = { address: '127.0.0.1', family: 4 };
      if (h === 'inputs.test' || h === 'other.test' || h === 'evil.test')
        return [local];
      if (h === 'nomatch.test') return [local];
      if (h === 'rebind.test') {
        rebindCalls++;
        // Первый ответ «хороший», следующие — внутренний адрес.
        return rebindCalls === 1
          ? [local]
          : [{ address: '10.0.0.5', family: 4 }];
      }
      if (h === 'mixed.test')
        return [local, { address: '192.168.1.10', family: 4 }];
      if (h === 'v6private.test')
        return [{ address: 'fd00:ec2::254', family: 6 }];
      if (h === 'loop.test') return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('ENOTFOUND');
    },
  };
}

let seq = 0;
function opts(over: Partial<DownloadOptions> = {}): DownloadOptions {
  const r = resolver();
  return {
    allowedHosts: [
      'inputs.test',
      'other.test',
      'rebind.test',
      'mixed.test',
      'nomatch.test',
      'v6private.test',
      'loop.test',
    ],
    maxBytes: 1_000_000,
    ca: CA,
    lookup: r.lookup,
    allowedPorts: [port],
    // Тестовый сервер живёт на 127.0.0.1: разрешаем ровно его, всё
    // остальное — политикой по умолчанию.
    addressAllowed: (a) => a === '127.0.0.1' || isPublicAddress(a),
    connectTimeoutMs: 2000,
    stallTimeoutMs: 300,
    fileTimeoutMs: 5000,
    ...over,
  };
}

const dest = () => join(dir, `f${++seq}`);

async function expectCode(
  p: Promise<unknown>,
  code: string,
): Promise<DownloadError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DownloadError);
    expect((e as DownloadError).code).toBe(code);
    return e as DownloadError;
  }
  throw new Error(`expected ${code}`);
}

describe('downloadInput', () => {
  it('скачивает через подставной резолвер, проверяя TLS по hostname', async () => {
    const d = dest();
    const out = await downloadInput(
      `https://inputs.test:${port}/ok?sig=SECRET`,
      d,
      opts(),
    );
    expect(out.bytes).toBe(BODY.length);
    expect(out.sha256).toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(out.contentType).toBe('video/mp4');
    expect(rf(d).equals(BODY)).toBe(true);
    expect(existsSync(`${d}.part`)).toBe(false);
  });

  it('не больше 3 redirect; каждый проверяется', async () => {
    const ok = await downloadInput(
      `https://inputs.test:${port}/redirect/3`,
      dest(),
      opts(),
    );
    expect(ok.bytes).toBe(BODY.length);
    await expectCode(
      downloadInput(`https://inputs.test:${port}/redirect/4`, dest(), opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
  });

  it.each([
    ['/to-private', 'FORBIDDEN_SOURCE'],
    ['/to-metadata', 'FORBIDDEN_SOURCE'],
    ['/to-http', 'FORBIDDEN_SOURCE'],
    ['/to-evil', 'FORBIDDEN_SOURCE'],
  ])('redirect %s → %s', async (path, code) => {
    await expectCode(
      downloadInput(`https://inputs.test:${port}${path}`, dest(), opts()),
      code,
    );
  });

  it('DNS rebinding: второй переход на тот же хост резолвится заново и отклоняется', async () => {
    const r = resolver();
    await expectCode(
      downloadInput(
        `https://rebind.test:${port}/to-rebind`,
        dest(),
        opts({ lookup: r.lookup }),
      ),
      'FORBIDDEN_SOURCE',
    );
    expect(r.calls).toEqual(['rebind.test', 'rebind.test']);
  });

  it('любой непубличный адрес среди A/AAAA — отказ', async () => {
    await expectCode(
      downloadInput(`https://mixed.test:${port}/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
    await expectCode(
      downloadInput(`https://v6private.test:${port}/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
    // Политика по умолчанию не пускает loopback.
    await expectCode(
      downloadInput(
        `https://loop.test:${port}/ok`,
        dest(),
        opts({ addressAllowed: undefined }),
      ),
      'FORBIDDEN_SOURCE',
    );
  });

  it('хост вне allowlist, http, userinfo, чужой порт — FORBIDDEN_SOURCE', async () => {
    await expectCode(
      downloadInput(`https://evil.test:${port}/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
    await expectCode(
      downloadInput(`http://inputs.test:${port}/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
    await expectCode(
      downloadInput(`https://u:p@inputs.test:${port}/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
    await expectCode(
      downloadInput(`https://inputs.test:1/ok`, dest(), opts()),
      'FORBIDDEN_SOURCE',
    );
  });

  it('сертификат не на этот hostname — отказ (SNI/hostname проверяются)', async () => {
    const e = await expectCode(
      downloadInput(`https://nomatch.test:${port}/ok`, dest(), opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
    expect(e.message).toMatch(/TLS/);
    await expectCode(
      downloadInput(
        `https://inputs.test:${port}/ok`,
        dest(),
        opts({ ca: undefined }),
      ),
      'INPUT_DOWNLOAD_FAILED',
    );
  });

  it('401/403/410 → INPUT_EXPIRED; 500 → INPUT_DOWNLOAD_FAILED', async () => {
    for (const p of ['/expired', '/gone', '/unauth']) {
      await expectCode(
        downloadInput(`https://inputs.test:${port}${p}`, dest(), opts()),
        'INPUT_EXPIRED',
      );
    }
    await expectCode(
      downloadInput(`https://inputs.test:${port}/boom`, dest(), opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
  });

  it('лимит по реальным байтам без Content-Length и по заявленному', async () => {
    const d = dest();
    await expectCode(
      downloadInput(`https://inputs.test:${port}/chunked-big`, d, opts()),
      'INPUT_TOO_LARGE',
    );
    expect(existsSync(d) || existsSync(`${d}.part`)).toBe(false);
    await expectCode(
      downloadInput(`https://inputs.test:${port}/declared-big`, dest(), opts()),
      'INPUT_TOO_LARGE',
    );
  });

  it('обрыв соединения и зависание → INPUT_DOWNLOAD_FAILED, частичный файл удалён', async () => {
    const d = dest();
    await expectCode(
      downloadInput(`https://inputs.test:${port}/cut`, d, opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
    expect(existsSync(`${d}.part`)).toBe(false);
    await expectCode(
      downloadInput(`https://inputs.test:${port}/stall`, dest(), opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
    await expectCode(
      downloadInput(`https://inputs.test:${port}/no-headers`, dest(), opts()),
      'INPUT_DOWNLOAD_FAILED',
    );
  });

  it('общий дедлайн → TIMEOUT; AbortSignal → CANCELED', async () => {
    await expectCode(
      downloadInput(
        `https://inputs.test:${port}/no-headers`,
        dest(),
        opts({ deadlineAt: Date.now() + 150, stallTimeoutMs: 5000 }),
      ),
      'TIMEOUT',
    );
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await expectCode(
      downloadInput(
        `https://inputs.test:${port}/stall`,
        dest(),
        opts({ signal: ac.signal, stallTimeoutMs: 5000 }),
      ),
      'CANCELED',
    );
  });

  it('query и путь URL не попадают в сообщения', async () => {
    const msgs: string[] = [];
    for (const p of ['/expired', '/boom', '/cut', '/to-evil', '/chunked-big']) {
      try {
        await downloadInput(
          `https://inputs.test:${port}${p}?token=SECRET123`,
          dest(),
          opts(),
        );
      } catch (e) {
        msgs.push((e as Error).message);
      }
    }
    try {
      await downloadInput(
        `https://evil.test:${port}/SECRETPATH?token=SECRET123`,
        dest(),
        opts(),
      );
    } catch (e) {
      msgs.push((e as Error).message);
    }
    expect(msgs).toHaveLength(6);
    for (const m of msgs) {
      expect(m).not.toMatch(/SECRET|token=|expired|boom|chunked/);
    }
  });
});
