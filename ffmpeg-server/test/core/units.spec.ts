/**
 * Модульные проверки CORE: конфигурация (отказ старта без утечки
 * секретов), каноникализация/AEAD/HMAC, миграции SQLite, метрики, логгер.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  ConfigError,
  SPEC_LIMITS,
  limitEnvName,
  loadConfig,
} from '../../src/config';
import {
  canonicalJson,
  fingerprint,
  openPayload,
  sealPayload,
} from '../../src/crypto/crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { Db } from '../../src/db/database';
import { pruneBackups, runBackup } from '../../src/ops/backup';
import { MIGRATIONS } from '../../src/db/migrations';
import {
  createLogger,
  safeLogPath,
  sanitizeValue,
} from '../../src/metrics/logger';
import { Metrics } from '../../src/metrics/metrics';
import {
  parseRange,
  safeMime,
  contentDisposition,
} from '../../src/files/serve';
import { baseEnv, cleanupDir, tempDir } from './helpers';

describe('config', () => {
  const dir = tempDir();
  afterAll(() => cleanupDir(dir));

  it('значения по умолчанию = ТЗ §9', () => {
    const cfg = loadConfig(baseEnv(dir));
    expect(cfg.limitsCeiling).toEqual(SPEC_LIMITS);
    expect(cfg.queue).toEqual({ maxQueuedTotal: 20, maxQueuedPerClient: 10 });
    expect(cfg.retention).toMatchObject({
      outputTtlSec: 86400,
      downloadTokenTtlSec: 1800,
      historyDays: 90,
      tombstoneDays: 90,
    });
    expect(cfg.maxBodyBytes).toBe(512 * 1024);
    expect(limitEnvName('maxInputBytes')).toBe(
      'FFMPEG_SERVER_LIMIT_MAX_INPUT_BYTES',
    );
  });

  it('верхняя граница лимита из env', () => {
    const cfg = loadConfig(
      baseEnv(dir, { FFMPEG_SERVER_LIMIT_MAX_INPUT_BYTES: '1000' }),
    );
    expect(cfg.limitsCeiling.maxInputBytes).toBe(1000);
    expect(() =>
      loadConfig(baseEnv(dir, { FFMPEG_SERVER_LIMIT_MAX_THREADS: '4' })),
    ).toThrow(ConfigError);
  });

  it.each([
    ['FFMPEG_SERVER_CLIENTS', '[]'],
    ['FFMPEG_SERVER_CLIENTS', '{bad json SECRETVALUE'],
    [
      'FFMPEG_SERVER_CLIENTS',
      JSON.stringify([{ clientId: 'a', role: 'client', keySha256: ['x'] }]),
    ],
    [
      'FFMPEG_SERVER_CLIENTS',
      JSON.stringify([
        { clientId: 'a', role: 'client', keySha256: ['a'.repeat(64)] },
      ]),
    ],
    [
      'FFMPEG_SERVER_CLIENTS',
      JSON.stringify([
        {
          clientId: 'a',
          role: 'ops',
          keySha256: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
        },
      ]),
    ],
    ['FFMPEG_SERVER_PAYLOAD_KEYS', JSON.stringify({ p1: 'c2hvcnQ=' })],
    ['FFMPEG_SERVER_PAYLOAD_KEY_ACTIVE', 'nope'],
    ['FFMPEG_SERVER_HMAC_KEYS', ''],
    ['FFMPEG_SERVER_PUBLIC_BASE_URL', 'http://ffmpeg.test'],
    ['FFMPEG_SERVER_INPUT_ALLOWED_HOSTS', ''],
    ['FFMPEG_SERVER_INPUT_ALLOWED_HOSTS', '*'],
    ['FFMPEG_SERVER_WORKSPACE_ROOT', path.join(dir, 'data', 'ws')],
    ['FFMPEG_SERVER_PORT', 'abc'],
  ])('отказ старта: %s=%s, без значения секрета в сообщении', (name, value) => {
    let err: unknown;
    try {
      loadConfig(baseEnv(dir, { [name]: value }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain('SECRETVALUE');
  });

  it('ключи payload в сообщении об ошибке не выводятся', () => {
    const secret = randomBytes(31).toString('base64');
    let message = '';
    try {
      loadConfig(
        baseEnv(dir, {
          FFMPEG_SERVER_PAYLOAD_KEYS: JSON.stringify({ p1: secret }),
        }),
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/FFMPEG_SERVER_PAYLOAD_KEYS/);
    expect(message).not.toContain(secret);
  });
});

describe('crypto', () => {
  const ring = {
    active: 'k1',
    keys: new Map([
      ['k1', randomBytes(32)],
      ['k0', randomBytes(32)],
    ]),
  };

  it('канонический JSON: ключи сортируются, массивы — нет, типы не смешиваются', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: '1' } })).toBe(
      '{"a":{"c":"1","d":[3,1]},"b":1}',
    );
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson(['b', 'a'])).not.toBe(canonicalJson(['a', 'b']));
    expect(() => canonicalJson({ a: NaN })).toThrow();
  });

  it('HMAC fingerprint не зависит от порядка ключей и зависит от ключа HMAC', () => {
    const a = fingerprint(ring, { x: 1, y: [1, 2] });
    const b = fingerprint(ring, { y: [1, 2], x: 1 });
    expect(a).toEqual(b);
    expect(fingerprint(ring, { x: 1, y: [1, 2] }, 'k0').value).not.toBe(
      a.value,
    );
    expect(fingerprint(ring, { x: 1, y: [2, 1] }).value).not.toBe(a.value);
  });

  it('AEAD: расшифровка с тем же AAD, подмена AAD/шифротекста — отказ, ротация ключей', () => {
    const s = sealPayload(ring, 'secret body', 'job-1');
    expect(s.sealed).not.toContain('secret');
    expect(openPayload(ring, s.keyId, s.sealed, 'job-1')).toBe('secret body');
    expect(() => openPayload(ring, s.keyId, s.sealed, 'job-2')).toThrow();
    const tampered =
      s.sealed.slice(0, -4) + (s.sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => openPayload(ring, s.keyId, tampered, 'job-1')).toThrow();
    const rotated = { active: 'k0', keys: ring.keys };
    expect(openPayload(rotated, s.keyId, s.sealed, 'job-1')).toBe(
      'secret body',
    );
  });
});

describe('db', () => {
  it('миграции по user_version, WAL, повторное открытие без изменений', () => {
    const dir = tempDir();
    const file = path.join(dir, 'x.db');
    const db = new Db(file);
    expect(db.wasFresh).toBe(true);
    expect(db.userVersion()).toBe(MIGRATIONS.length);
    expect(
      db.get<{ journal_mode: string }>('PRAGMA journal_mode')!.journal_mode,
    ).toBe('wal');
    expect(
      Number(db.get<{ timeout: number }>('PRAGMA busy_timeout')!.timeout),
    ).toBe(5000);
    db.close();
    const again = new Db(file);
    expect(again.wasFresh).toBe(false);
    expect(again.migrationsApplied()).toBe(true);
    again.raw.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    again.close();
    expect(() => new Db(file)).toThrow(/новее кода/);
    cleanupDir(dir);
  });
});

describe('metrics и логи', () => {
  it('Prometheus text: counter, gauge, histogram', () => {
    const m = new Metrics();
    m.inc('x_total', 'X', { code: 'OOM' });
    m.inc('x_total', 'X', { code: 'OOM' });
    m.gauge('g', 'G', () => [[{ kind: 'free' }, 5]]);
    m.observe('h_seconds', 'H', 3, {}, [1, 5]);
    const out = m.render();
    expect(out).toContain('# TYPE x_total counter\nx_total{code="OOM"} 2');
    expect(out).toContain('g{kind="free"} 5');
    expect(out).toContain('h_seconds_bucket{le="1"} 0');
    expect(out).toContain('h_seconds_bucket{le="5"} 1');
    expect(out).toContain('h_seconds_bucket{le="+Inf"} 1');
    expect(out).toContain('h_seconds_count 1');
  });

  it('логгер вырезает URL, токены, ключи, команды', () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.info('x', {
      url: 'https://a/b?sig=1',
      token: 't',
      authorization: 'Bearer k',
      idempotencyKey: 'k',
      command: 'ffmpeg -i x',
      note: 'see https://host/path?token=abc',
      job_id: 'j1',
    });
    const l = lines[0];
    expect(l).toContain('"job_id":"j1"');
    expect(l).not.toMatch(/sig=|token=abc|Bearer|ffmpeg -i/);
    expect(sanitizeValue({ nested: { stderr: 'x' } })).toEqual({ nested: {} });
    expect(safeLogPath('/api/files/j/a.mp4?token=x')).toBe(
      '/api/files/j/:name',
    );
    expect(safeLogPath('/api/jobs/by-key/secret-key')).toBe(
      '/api/jobs/by-key/:key',
    );
    expect(safeLogPath('/api/jobs/1?x=y')).toBe('/api/jobs/1');
  });
});

describe('выдача файлов — примитивы', () => {
  it('Range', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=0-100', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=10-', 10)).toBe('invalid');
    expect(parseRange('bytes=0-1,3-4', 10)).toBe('invalid');
    expect(parseRange('items=0-1', 10)).toBe('invalid');
  });

  it('безопасный MIME и Content-Disposition', () => {
    expect(safeMime('video/mp4')).toBe('video/mp4');
    expect(safeMime('text/html')).toBe('application/octet-stream');
    expect(safeMime('image/svg+xml')).toBe('application/octet-stream');
    expect(contentDisposition('мой "файл".mp4')).toBe(
      `attachment; filename="___ ______.mp4"; filename*=UTF-8''${encodeURIComponent('мой "файл".mp4')}`,
    );
  });
});

describe('backup', () => {
  it('online backup проверяется integrity_check, retention 7 дней', async () => {
    const dir = tempDir();
    const db = new Db(path.join(dir, 'x.db'));
    const now = Date.UTC(2026, 9, 21, 12, 0, 0);
    const f1 = await runBackup(db, path.join(dir, 'b'), now - 8 * 86_400_000);
    const f2 = await runBackup(db, path.join(dir, 'b'), now);
    expect(path.basename(f2)).toBe('ffmpeg-server-20261021T120000Z.db');
    writeFileSync(path.join(dir, 'b', 'foreign.db'), 'x');
    expect(await pruneBackups(path.join(dir, 'b'), 7, now)).toBe(1);
    expect(existsSync(f1)).toBe(false);
    expect(existsSync(f2)).toBe(true);
    expect(existsSync(path.join(dir, 'b', 'foreign.db'))).toBe(true);
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(path.join(dir, 'b')).sort()).toEqual([
      'ffmpeg-server-20261021T120000Z.db',
      'foreign.db',
    ]);
    db.close();
    cleanupDir(dir);
  });
});
