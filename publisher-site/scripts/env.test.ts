/**
 * Окружение сборки (§13.3, §13.7): правила `SITE_URL` одинаковы в
 * `next.config.js` и `src/lib/site-url.ts`; связь с API и ПЕРВЫЙ ключ
 * индексации (`PUBLISHER_INDEXING=on` — только production, превью — нет);
 * второй ключ (`site-config.indexable`) — `buildIndexable`, любой сбой →
 * noindex; итог `isIndexable` — только при обоих ключах.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { siteUrl, validateSiteUrl } from '../src/lib/site-url';
import { isIndexable } from '../src/lib/indexing';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cfg = require(path.join(__dirname, '..', 'next.config.js')) as {
  validateSiteUrl: (raw: string | undefined, o?: { production?: boolean }) => string;
  validatePublisherEnv: (env: Record<string, string | undefined>) => Record<string, string>;
  isNextBuild: (phase: string, argv: string[]) => boolean;
  buildIndexable: (pub: Record<string, string>, site: string) => Promise<boolean>;
  resolveSiteUrl: (env: Record<string, string | undefined>) => string | undefined;
  contentSecurityPolicy: (api: string) => string;
};
let n = 0;
const outcome = (f: () => string) => {
  try {
    return f();
  } catch {
    return 'THROW';
  }
};

async function main() {
  const urls = [
    undefined,
    '',
    '  ',
    'https://ai-publisher.org',
    'https://AI-Publisher.org/',
    'http://ai-publisher.org',
    'https://localhost',
    'https://127.0.0.1',
    'https://x.localhost',
    'https://ai-publisher.org/path',
    'https://ai-publisher.org?x=1',
    'https://ai-publisher.org:8443',
    'https://u@ai-publisher.org',
    'https://example.invalid',
    'не url',
  ];
  for (const u of urls) {
    for (const production of [false, true]) {
      n++;
      assert.equal(
        outcome(() => validateSiteUrl(u, { production })),
        outcome(() => cfg.validateSiteUrl(u, { production })),
        `SITE_URL ${u} (production=${production})`,
      );
    }
  }
  assert.equal(cfg.validateSiteUrl('https://AI-Publisher.org/'), 'https://ai-publisher.org');
  assert.equal(
    outcome(() => cfg.validateSiteUrl('https://example.invalid', { production: true })),
    'THROW',
    '.invalid в production',
  );
  assert.equal(siteUrl({ NODE_ENV: 'development' } as NodeJS.ProcessEnv), 'http://localhost:3020', 'dev без SITE_URL');
  assert.equal(
    outcome(() => siteUrl({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)),
    'THROW',
    'prod без SITE_URL — ошибка',
  );

  const key = 'pp_standPublisherKey0000001';
  const env = (o: Record<string, string>) =>
    outcome(() => JSON.stringify(cfg.validatePublisherEnv({ PUBLISHER_PUBLIC_KEY: key, ...o })));
  const cases: Array<[Record<string, string>, string | 'THROW', string]> = [
    [
      { PUBLISHER_API_ORIGIN: 'https://api.example.org' },
      JSON.stringify({
        PUBLISHER_API_ORIGIN: 'https://api.example.org',
        PUBLISHER_PUBLIC_KEY: key,
        PUBLISHER_INDEXING: '',
      }),
      'https',
    ],
    [
      { PUBLISHER_API_ORIGIN: 'http://localhost:3021' },
      JSON.stringify({
        PUBLISHER_API_ORIGIN: 'http://localhost:3021',
        PUBLISHER_PUBLIC_KEY: key,
        PUBLISHER_INDEXING: '',
      }),
      'стенд вне Vercel',
    ],
    [{ PUBLISHER_API_ORIGIN: 'http://localhost:3021', VERCEL: '1' }, 'THROW', 'localhost на Vercel'],
    [{ PUBLISHER_API_ORIGIN: 'http://api.example.org' }, 'THROW', 'http'],
    [{ PUBLISHER_API_ORIGIN: 'https://api.example.org/v1' }, 'THROW', 'путь'],
    [{ PUBLISHER_API_ORIGIN: 'https://api.example.org:444' }, 'THROW', 'порт'],
    [{ PUBLISHER_API_ORIGIN: '' }, 'THROW', 'не задан'],
    [{ PUBLISHER_API_ORIGIN: 'https://api.example.org', PUBLISHER_PUBLIC_KEY: 'pk_live_x' }, 'THROW', 'ключ не pp_'],
    [{ PUBLISHER_API_ORIGIN: 'https://api.example.org', PUBLISHER_INDEXING: 'yes' }, 'THROW', 'INDEXING не on/off'],
  ];
  for (const [o, want, name] of cases) {
    n++;
    assert.equal(env(o), want, `PUBLISHER_* ${name}`);
  }
  const idx = (o: Record<string, string>) =>
    cfg.validatePublisherEnv({ PUBLISHER_PUBLIC_KEY: key, PUBLISHER_API_ORIGIN: 'https://api.example.org', ...o })
      .PUBLISHER_INDEXING;
  assert.equal(idx({ PUBLISHER_INDEXING: 'on' }), 'on', 'on вне Vercel (сборка CI с двумя ключами)');
  assert.equal(idx({ PUBLISHER_INDEXING: 'ON', VERCEL_ENV: 'production' }), 'on', 'on в production');
  assert.equal(idx({ PUBLISHER_INDEXING: 'on', VERCEL_ENV: 'preview' }), '', 'превью Vercel — всегда noindex');
  assert.equal(idx({ PUBLISHER_INDEXING: 'off' }), '', 'off');
  n += 4;
  // SITE_URL превью Vercel (аудит S3-9): без SITE_URL — постоянный адрес ветки; иначе — как было.
  assert.equal(
    cfg.resolveSiteUrl({ VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'publisher-site-git-x.vercel.app' }),
    'https://publisher-site-git-x.vercel.app',
  );
  assert.equal(
    cfg.resolveSiteUrl({ SITE_URL: 'https://a.org', VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'b.vercel.app' }),
    'https://a.org',
  );
  assert.equal(
    cfg.resolveSiteUrl({ VERCEL_ENV: 'production', VERCEL_BRANCH_URL: 'b.vercel.app' }),
    undefined,
    'production без SITE_URL — ошибка сборки',
  );
  assert.equal(cfg.resolveSiteUrl({ VERCEL_BRANCH_URL: 'b.vercel.app' }), undefined, 'вне превью — ошибка сборки');
  const csp = cfg.contentSecurityPolicy('https://api.example.org');
  for (const d of [
    "default-src 'self'",
    "connect-src 'self' https://api.example.org",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ])
    assert.ok(csp.includes(d), `CSP: ${d}`);
  assert.ok(!/unsafe-eval/.test(csp), 'CSP без unsafe-eval');
  n += 11;
  assert.equal(cfg.isNextBuild('phase-production-build', ['node', 'next', 'build']), true);
  assert.equal(cfg.isNextBuild('phase-production-build', ['node', 'eslint', '.']), false);

  // Второй ключ — site-config.indexable; любой сбой — noindex.
  const realFetch = globalThis.fetch;
  const pub = { PUBLISHER_API_ORIGIN: 'https://api.example.org', PUBLISHER_PUBLIC_KEY: key, PUBLISHER_INDEXING: 'on' };
  const urlsSeen: string[] = [];
  const stub = (status: number, body: unknown) =>
    (async (u: string) => (
      urlsSeen.push(String(u)),
      new Response(JSON.stringify(body), { status })
    )) as unknown as typeof fetch;
  try {
    globalThis.fetch = stub(200, { success: true, data: { indexable: true } });
    assert.equal(await cfg.buildIndexable(pub, 'https://ai-publisher.org'), true, 'оба ключа');
    assert.ok(
      urlsSeen[0].includes('host=ai-publisher.org') && urlsSeen[0].includes(`key=${key}`),
      'site-config с хостом сборки',
    );
    globalThis.fetch = stub(200, { success: true, data: { indexable: false } });
    assert.equal(await cfg.buildIndexable(pub, 'https://ai-publisher.org'), false, 'гейт закрыт');
    globalThis.fetch = stub(503, { success: false });
    assert.equal(await cfg.buildIndexable(pub, 'https://ai-publisher.org'), false, 'API недоступен — noindex');
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    assert.equal(await cfg.buildIndexable(pub, 'https://ai-publisher.org'), false, 'сеть — noindex');
    globalThis.fetch = (async () => {
      throw new Error('не должен ходить в API без первого ключа');
    }) as unknown as typeof fetch;
    assert.equal(
      await cfg.buildIndexable({ ...pub, PUBLISHER_INDEXING: '' }, 'https://ai-publisher.org'),
      false,
      'без первого ключа API не спрашивается',
    );
    n += 5;
  } finally {
    globalThis.fetch = realFetch;
  }
  for (const [on, ix, want] of [
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ] as const) {
    n++;
    assert.equal(isIndexable({ indexable: ix }, on), want, `isIndexable(${on}, ${ix})`);
  }
  console.log(
    `ok   env: ${n} проверок — SITE_URL ≡ next.config, PUBLISHER_* (https/стенд, ключ, превью → noindex), второй ключ из site-config (сбой → noindex), два ключа`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
