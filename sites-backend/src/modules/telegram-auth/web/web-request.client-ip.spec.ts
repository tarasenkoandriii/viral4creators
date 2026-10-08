/**
 * П-С1 захода 10: `clientIp` sites-backend — общее правило backend
 * (`shared/client-ip.ts`), а не «первый X-Forwarded-For без условий».
 * Правило целиком проверяет копия спека `shared/client-ip.spec.ts`; здесь —
 * что обёртка, через которую ходят ВСЕ лимиты и хеши адреса sites-backend,
 * действительно ему следует, и что мимо неё заголовок никто не читает.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AdminEmbedController } from '../../assist-admin-chat/admin-embed.controller';
import { AdminSessionService } from '../../assist-admin-chat/admin-session.service';
import {
  clientIpEnvProblem,
  configurationWarnings,
  loadConfiguration,
} from '../../../config/configuration';
import { clientIp } from './web-request';

const req = (xff: string | undefined, peer: string) => ({
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: peer },
});

describe('clientIp (web-request) — общее правило доверия прокси', () => {
  it('вне Vercel без доверенных прокси подставленный XFF не меняет адрес', () => {
    expect(clientIp(req('1.2.3.4', '::ffff:203.0.113.9'), {})).toBe(
      '203.0.113.9',
    );
    expect(clientIp(req('5.6.7.8', '::ffff:203.0.113.9'), {})).toBe(
      '203.0.113.9',
    );
  });

  it('вне Vercel за доверенным прокси — адрес, дописанный прокси', () => {
    const env = { TRUSTED_PROXY_CIDRS: '127.0.0.1/32' };
    expect(
      clientIp(req('6.6.6.6, 198.51.100.7', '::ffff:127.0.0.1'), env),
    ).toBe('198.51.100.7');
  });

  it('на Vercel — первый адрес XFF, как раньше', () => {
    expect(
      clientIp(req('198.51.100.7, 10.0.0.1', '10.0.0.1'), { VERCEL: '1' }),
    ).toBe('198.51.100.7');
  });

  it('по умолчанию читает process.env', () => {
    const saved = { ...process.env };
    try {
      delete process.env.VERCEL;
      delete process.env.TRUSTED_PROXY_CIDRS;
      expect(clientIp(req('1.2.3.4', '203.0.113.9'))).toBe('203.0.113.9');
      process.env.VERCEL = '1';
      expect(clientIp(req('1.2.3.4', '203.0.113.9'))).toBe('1.2.3.4');
    } finally {
      process.env = saved;
    }
  });
});

describe('адрес клиента читает только общий модуль', () => {
  const SRC = path.resolve(__dirname, '../../..');
  const ALLOWED = new Set(['shared/client-ip.ts']);

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // testing/ — помощники тестов, не прод-код.
        if (e.name !== 'testing') out.push(...walk(full));
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  /** Код без комментариев: пояснение «`req.ip` нельзя» — не нарушение. */
  const code = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /**
   * Сырые источники адреса мимо `clientIp`: заголовки прокси, `req.ip`
   * (`ips`), адрес сокета. Каждый — новый способ подставить или потерять
   * адрес (на Vercel `req.ip` — адрес прокси, вне Vercel XFF пишет клиент).
   */
  const RAW_IP =
    /x-forwarded-for|x-real-ip|cf-connecting-ip|true-client-ip|\breq(?:uest)?\.ips?\b|\.remoteAddress\b|\.connection\.remoteAddress/i;

  it('ни один прод-файл src/ не читает адрес сам', () => {
    const offenders = walk(SRC)
      .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) =>
        RAW_IP.test(code(fs.readFileSync(path.join(SRC, rel), 'utf8'))),
      );
    expect(offenders).toEqual([]);
  });

  it('проверка ловит каждый источник (самотест)', () => {
    for (const bad of [
      "const a = req.headers['x-forwarded-for'];",
      "const a = req.get('X-Real-IP');",
      "const a = req.headers['cf-connecting-ip'];",
      'const a = req.ip ?? null;',
      'const a = request.ips[0];',
      'const a = req.socket.remoteAddress;',
    ]) {
      expect([bad, RAW_IP.test(code(bad))]).toEqual([bad, true]);
    }
    expect(
      RAW_IP.test(code('// `req.ip` без trust proxy — адрес прокси')),
    ).toBe(false);
    expect(RAW_IP.test(code('socket?: { remoteAddress?: string };'))).toBe(
      false,
    );
  });
});

describe('«Админка»: окно admin-session-ip-min — по адресу посетителя (P3-3)', () => {
  it('обмен сессии получает clientIp: разные XFF за одним прокси — разные окна', async () => {
    const seen: Array<string | null> = [];
    const sessions = {
      exchange: (_pk: string, _jwt: string, ip: string | null) => {
        seen.push(ip);
        return Promise.resolve({ ok: true });
      },
    };
    const ctrl = new AdminEmbedController(sessions as never, {} as never);
    const saved = { ...process.env };
    try {
      process.env.VERCEL = '1';
      for (const xff of ['198.51.100.1', '198.51.100.2']) {
        await ctrl.session(
          { pk: 'pk', jwt: 'j' } as never,
          {
            headers: { 'x-forwarded-for': `${xff}, 10.0.0.1` },
            ip: '10.0.0.1',
            socket: { remoteAddress: '10.0.0.1' },
          } as never,
        );
      }
      // Вне Vercel и без доверенных прокси — адрес сокета, XFF не читается.
      delete process.env.VERCEL;
      delete process.env.TRUSTED_PROXY_CIDRS;
      await ctrl.session(
        { pk: 'pk', jwt: 'j' } as never,
        {
          headers: { 'x-forwarded-for': '6.6.6.6' },
          socket: { remoteAddress: '203.0.113.9' },
        } as never,
      );
    } finally {
      process.env = saved;
    }
    expect(seen).toEqual(['198.51.100.1', '198.51.100.2', '203.0.113.9']);
    const svc = Object.create(
      AdminSessionService.prototype,
    ) as AdminSessionService;
    (svc as unknown as { mode: unknown }).mode = {
      env: { ASSIST_SECRETS_KEY: 'k' },
    };
    expect(svc.ipKey(seen[0], 's1')).not.toBe(svc.ipKey(seen[1], 's1'));
  });
});

describe('старт в production вне Vercel без TRUSTED_PROXY_CIDRS (P3-4)', () => {
  it('предупреждение в конфигурации; на Vercel, с подсетями или «none» — нет', () => {
    const prod = { NODE_ENV: 'production', SITES_DATABASE_URL: 'postgres://x' };
    expect(clientIpEnvProblem(prod)).toMatch(/TRUSTED_PROXY_CIDRS/);
    expect(configurationWarnings(loadConfiguration(prod))).toHaveLength(1);
    expect(clientIpEnvProblem({ ...prod, VERCEL: '1' })).toBeNull();
    expect(
      clientIpEnvProblem({ ...prod, TRUSTED_PROXY_CIDRS: '172.16.0.0/12' }),
    ).toBeNull();
    expect(
      clientIpEnvProblem({ ...prod, TRUSTED_PROXY_CIDRS: 'none' }),
    ).toBeNull();
    expect(clientIpEnvProblem({ NODE_ENV: 'development' })).toBeNull();
    // «none» — не подсеть: XFF не читается, адрес — сокет.
    expect(
      clientIp(
        {
          headers: { 'x-forwarded-for': '6.6.6.6' },
          socket: { remoteAddress: '203.0.113.9' },
        },
        { TRUSTED_PROXY_CIDRS: 'none' },
      ),
    ).toBe('203.0.113.9');
  });
});
