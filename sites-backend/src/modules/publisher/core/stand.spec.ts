/**
 * Стенд E2E (Р-PUB-Z2-21/22): часы стенда и локальное хранилище копий
 * физически не включаются вне стенда. Флаги действуют только при
 * `NODE_ENV=development|test` и не на Vercel; в production запрос
 * игнорируется с предупреждением, маршрута часов нет (404), `Date` —
 * настоящий, копии — Vercel Blob.
 */
import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as request from 'supertest';
import {
  publisherStandBackupDir,
  publisherStandClock,
} from '../../../config/publisher-env';
import {
  backupStorageFromEnv,
  LocalFileBackupStorage,
  VercelBlobBackupStorage,
} from '../reports/backup-storage';
import {
  applyStandDbClock,
  pubClock,
  standClock,
  uninstallStandClock,
} from './clock';
import { PUB_STAND_CLOCK_PATH, PublisherStandModule } from './stand.module';

const RealDate = Date;
const SECRET = 'stand-secret-0123456789';

async function appWith(env: NodeJS.ProcessEnv): Promise<INestApplication> {
  const mod = await Test.createTestingModule({
    imports: [PublisherStandModule.forRoot(env)],
  }).compile();
  const app = mod.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('стенд E2E: часы и копии только вне production (Р-PUB-Z2-21/22)', () => {
  let warn: jest.SpyInstance;
  const prevSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    process.env.CRON_SECRET = SECRET;
  });
  afterEach(() => {
    uninstallStandClock();
    warn.mockRestore();
    if (prevSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prevSecret;
  });

  it('флаги: только NODE_ENV=development|test и не Vercel; иначе — не действует, с причиной', () => {
    const on = { PUBLISHER_STAND_CLOCK: 'true' };
    expect(publisherStandClock({ ...on, NODE_ENV: 'development' })).toEqual({
      enabled: true,
      problem: null,
    });
    expect(publisherStandClock({ ...on, NODE_ENV: 'test' }).enabled).toBe(true);
    for (const env of [
      { ...on, NODE_ENV: 'production' },
      { ...on, NODE_ENV: 'staging' },
      { ...on },
      { ...on, NODE_ENV: 'development', VERCEL: '1' },
      { ...on, NODE_ENV: 'test', VERCEL: '1' },
    ]) {
      const s = publisherStandClock(env);
      expect(s.enabled).toBe(false);
      expect(s.problem).toMatch(/PUBLISHER_STAND_CLOCK проигнорирована/);
    }
    expect(publisherStandClock({ NODE_ENV: 'production' })).toEqual({
      enabled: false,
      problem: null,
    });
    const dir = { PUBLISHER_STAND_BACKUP_DIR: '/tmp/x' };
    expect(publisherStandBackupDir({ ...dir, NODE_ENV: 'test' })).toEqual({
      enabled: true,
      problem: null,
      dir: '/tmp/x',
    });
    expect(
      publisherStandBackupDir({ ...dir, NODE_ENV: 'production' }),
    ).toMatchObject({ enabled: false, dir: null });
    expect(
      publisherStandBackupDir({
        PUBLISHER_STAND_BACKUP_DIR: 'rel/dir',
        NODE_ENV: 'test',
      }),
    ).toMatchObject({ enabled: false, dir: null });
  });

  it('NODE_ENV=production + PUBLISHER_STAND_CLOCK=true: маршрута нет (404), Date настоящий, предупреждение в журнале', async () => {
    const app = await appWith({
      NODE_ENV: 'production',
      PUBLISHER_STAND_CLOCK: 'true',
    });
    try {
      const auth = { authorization: `Bearer ${SECRET}` };
      await request(app.getHttpServer())
        .get(PUB_STAND_CLOCK_PATH)
        .set(auth)
        .expect(404);
      await request(app.getHttpServer())
        .post(PUB_STAND_CLOCK_PATH)
        .set(auth)
        .send({ at: '2030-01-01T00:00:00.000Z' })
        .expect(404);
      expect(standClock()).toBeNull();
      expect(pubClock().stand).toBe(false);
      expect(globalThis.Date).toBe(RealDate);
      expect(Math.abs(Date.now() - RealDate.now())).toBeLessThan(1000);
      expect(
        warn.mock.calls.some((c) =>
          /PUBLISHER_STAND_CLOCK проигнорирована.*NODE_ENV=production/.test(
            String(c[0]),
          ),
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('Vercel (VERCEL=1) при NODE_ENV=development — тоже 404 и системные часы', async () => {
    const app = await appWith({
      NODE_ENV: 'development',
      VERCEL: '1',
      PUBLISHER_STAND_CLOCK: 'true',
    });
    try {
      await request(app.getHttpServer())
        .get(PUB_STAND_CLOCK_PATH)
        .set({ authorization: `Bearer ${SECRET}` })
        .expect(404);
      expect(standClock()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('без флага в test — маршрута нет', async () => {
    const app = await appWith({ NODE_ENV: 'test' });
    try {
      await request(app.getHttpServer()).get(PUB_STAND_CLOCK_PATH).expect(404);
      expect(standClock()).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('стенд: часы процесса подменяются (new Date(), Date.now, Prisma-подобные значения), только вперёд, по секрету крона', async () => {
    const app = await appWith({
      NODE_ENV: 'test',
      PUBLISHER_STAND_CLOCK: 'true',
    });
    try {
      const http = () => request(app.getHttpServer());
      await http().get(PUB_STAND_CLOCK_PATH).expect(401);
      await http()
        .get(PUB_STAND_CLOCK_PATH)
        .set({ authorization: 'Bearer wrong' })
        .expect(401);
      const auth = { authorization: `Bearer ${SECRET}` };
      const at = new RealDate(RealDate.now() + 42 * 86_400_000);
      const r = await http()
        .post(PUB_STAND_CLOCK_PATH)
        .set(auth)
        .send({ at: at.toISOString(), freeze: true })
        .expect(200);
      expect(r.body).toMatchObject({ now: at.toISOString(), frozen: true });
      expect(Date.now()).toBe(at.getTime());
      expect(new Date().toISOString()).toBe(at.toISOString());
      expect(new Date() instanceof RealDate).toBe(true);
      expect(new Date(0).getTime()).toBe(0);
      expect(typeof Date()).toBe('string');
      expect(Date.UTC(2026, 0, 1)).toBe(RealDate.UTC(2026, 0, 1));
      expect(pubClock().now().getTime()).toBe(at.getTime());
      // Назад — нельзя.
      await http()
        .post(PUB_STAND_CLOCK_PATH)
        .set(auth)
        .send({ at: new RealDate(at.getTime() - 1).toISOString() })
        .expect(400);
      await http().post(PUB_STAND_CLOCK_PATH).set(auth).send({}).expect(400);
      // Вперёд на час, часы идут.
      const r2 = await http()
        .post(PUB_STAND_CLOCK_PATH)
        .set(auth)
        .send({ advanceMs: 3_600_000 })
        .expect(200);
      expect(r2.body.frozen).toBe(false);
      expect(Date.now() - at.getTime()).toBeGreaterThanOrEqual(3_600_000);
      expect(Date.now() - at.getTime()).toBeLessThan(3_600_000 + 5_000);
      // Время сервера БД строк приёма: настройка транзакции pub.stand_now.
      const calls: unknown[][] = [];
      await applyStandDbClock({
        $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => {
          calls.push([q.join('?'), ...v]);
          return Promise.resolve(1);
        },
      });
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain("set_config('pub.stand_now'");
    } finally {
      await app.close();
    }
    uninstallStandClock();
    expect(globalThis.Date).toBe(RealDate);
    // Без часов стенда настройка БД не ставится (прод).
    const calls: unknown[] = [];
    await applyStandDbClock({
      $executeRaw: (...a: unknown[]) => {
        calls.push(a);
        return Promise.resolve(1);
      },
    });
    expect(calls).toHaveLength(0);
  });

  it('хранилище копий: каталог стенда только вне production; файловый адаптер — тот же порт, без выхода за корень', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pub-stand-backup-'));
    try {
      expect(
        backupStorageFromEnv({
          NODE_ENV: 'production',
          PUBLISHER_STAND_BACKUP_DIR: root,
        }),
      ).toBeInstanceOf(VercelBlobBackupStorage);
      expect(
        warn.mock.calls.some((c) =>
          /PUBLISHER_STAND_BACKUP_DIR проигнорирована/.test(String(c[0])),
        ),
      ).toBe(true);
      expect(
        backupStorageFromEnv({
          NODE_ENV: 'development',
          VERCEL: '1',
          PUBLISHER_STAND_BACKUP_DIR: root,
        }),
      ).toBeInstanceOf(VercelBlobBackupStorage);
      const s = backupStorageFromEnv({
        NODE_ENV: 'test',
        PUBLISHER_STAND_BACKUP_DIR: root,
      });
      expect(s).toBeInstanceOf(LocalFileBackupStorage);
      const p = await s.put(
        'publisher/acc/prod/backups/b1.bin',
        Buffer.from('x'),
      );
      expect(p).toMatch(
        /^publisher\/acc\/prod\/backups\/b1-[0-9a-f]{12}\.bin$/,
      );
      expect((await s.get(p)).toString()).toBe('x');
      await s.remove(p);
      await expect(s.get(p)).rejects.toThrow();
      await expect(s.put('../escape.bin', Buffer.from('x'))).rejects.toThrow(
        /недопустимый путь/,
      );
      await expect(s.get('/etc/passwd')).rejects.toThrow();
      expect(readdirSync(root)).toEqual(['publisher']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
