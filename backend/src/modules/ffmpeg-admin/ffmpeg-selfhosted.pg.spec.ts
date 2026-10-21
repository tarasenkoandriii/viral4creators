/**
 * Миграция 20270126090000_ffmpeg_selfhosted на настоящем PostgreSQL в
 * изолированной схеме (не на production-записях): маршрутизация по
 * умолчанию hosted, ограничения, append-only журнал, RLS/REVOKE.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl =
  process.env.FFMPEG_ADMIN_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('FFmpeg selfhosted PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;

db('ffmpeg_routing / ffmpeg_operator_actions on PostgreSQL', () => {
  const schema = `ffmpeg_selfhosted_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const insert = (over: Record<string, unknown> = {}) => {
    const row = {
      id: randomUUID(),
      operationId: randomUUID(),
      phase: 'requested',
      actorUserId: 'usr_owner',
      action: 'pause',
      jobId: null,
      reason: 'обслуживание',
      correlationId: randomUUID(),
      result: null,
      ...over,
    };
    return client.query(
      `INSERT INTO "ffmpeg_operator_actions" (id,"operationId",phase,"actorUserId",action,"jobId",reason,"correlationId",result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        row.id,
        row.operationId,
        row.phase,
        row.actorUserId,
        row.action,
        row.jobId,
        row.reason,
        row.correlationId,
        row.result,
      ],
    );
  };

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";`,
    );
    // Таблицы, на которые миграция вешает индексы владельца задачи.
    await client.query(`
      CREATE TABLE "tutorial_video_assets" ("id" TEXT PRIMARY KEY, "assemblyJobId" TEXT);
      CREATE TABLE "tutorial_video_versions" ("id" TEXT PRIMARY KEY, "jobId" TEXT);
      CREATE TABLE "tutorial_demo_quality_checks" ("id" TEXT PRIMARY KEY, "signalsJobId" TEXT);
      CREATE TABLE "portfolio_items" ("id" TEXT PRIMARY KEY, "watermarkJobId" TEXT);
      CREATE TABLE "video_audio_tracks" ("id" TEXT PRIMARY KEY, "mixJobId" TEXT);
    `);
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../prisma/migrations/20270126090000_ffmpeg_selfhosted/migration.sql',
        ),
        'utf8',
      ),
    );
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  it('маршрутизация по умолчанию: одна строка, selfhosted (решение владельца; без env-гейта — hosted), ревизия 1, пустой canary, breaker закрыт', async () => {
    const { rows } = await client.query(`SELECT * FROM "ffmpeg_routing"`);
    expect(rows).toEqual([
      expect.objectContaining({
        id: 'default',
        revision: 1,
        defaultProvider: 'selfhosted',
        canaryProducts: [],
        breakerFailures: 0,
        breakerLastFailureAt: null,
        breakerOpenUntil: null,
        breakerProbeUntil: null,
        breakerProbeJobId: null,
      }),
    ]);
  });

  it('маршрутизация: вторая строка, неизвестный провайдер и продукт отвергаются', async () => {
    await expect(
      client.query(`INSERT INTO "ffmpeg_routing" (id) VALUES ('other')`),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `UPDATE "ffmpeg_routing" SET "defaultProvider" = 'gpu-farm' WHERE id = 'default'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      client.query(
        `UPDATE "ffmpeg_routing" SET "canaryProducts" = ARRAY['nova'] WHERE id = 'default'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('breaker: счётчик не отрицательный; 60 одновременных отказов учтены атомарно, без CHECK (FF-INT-08)', async () => {
    await expect(
      client.query(
        `UPDATE "ffmpeg_routing" SET "breakerFailures" = -1 WHERE id = 'default'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    const pool = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const c = new Client({ connectionString: dbUrl });
        await c.connect();
        await c.query(`SET search_path TO "${schema}"`);
        return c;
      }),
    );
    try {
      await Promise.all(
        Array.from({ length: 60 }, (_, i) =>
          pool[i % pool.length].query(
            `UPDATE "ffmpeg_routing" SET "breakerFailures" = "breakerFailures" + 1, "breakerLastFailureAt" = now() WHERE id = 'default'`,
          ),
        ),
      );
    } finally {
      await Promise.all(pool.map((c) => c.end()));
    }
    const { rows } = await client.query(
      `SELECT "breakerFailures" AS n FROM "ffmpeg_routing" WHERE id = 'default'`,
    );
    expect(rows[0].n).toBe(60);
    await client.query(
      `UPDATE "ffmpeg_routing" SET "breakerFailures" = 0 WHERE id = 'default'`,
    );
  });

  it('учтённые задачи breaker: одна задача — одна строка (повторный опрос — unique violation)', async () => {
    await client.query(
      `INSERT INTO "ffmpeg_breaker_jobs" ("jobId") VALUES ('selfhosted:j1')`,
    );
    await expect(
      client.query(
        `INSERT INTO "ffmpeg_breaker_jobs" ("jobId") VALUES ('selfhosted:j1')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('ffmpeg_submissions: ключ уникален, состояния и провайдеры — из списка, accepted только с jobId', async () => {
    const ins = (over: Record<string, unknown> = {}) => {
      const r = {
        id: randomUUID(),
        idempotencyKey: `story-video:${randomUUID()}`,
        bodyHash: 'a'.repeat(64),
        provider: 'selfhosted',
        state: 'sending',
        jobId: null,
        fallbackReason: null,
        ...over,
      };
      return client.query(
        `INSERT INTO "ffmpeg_submissions" (id,"idempotencyKey","bodyHash",provider,state,"jobId","fallbackReason")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          r.id,
          r.idempotencyKey,
          r.bodyHash,
          r.provider,
          r.state,
          r.jobId,
          r.fallbackReason,
        ],
      );
    };
    await ins({ idempotencyKey: 'op-1' });
    await expect(ins({ idempotencyKey: 'op-1' })).rejects.toMatchObject({
      code: '23505',
    });
    await ins({ state: 'accepted', jobId: 'selfhosted:u1' });
    await ins({
      provider: 'hosted',
      state: 'accepted',
      jobId: 'h1',
      fallbackReason: 'refused',
    });
    for (const bad of [
      { state: 'done' },
      { provider: 'gpu' },
      { state: 'accepted', jobId: null },
      { fallbackReason: 'retry' },
      { bodyHash: 'nothex' },
      { idempotencyKey: 'с пробелом' },
      { idempotencyKey: 'x'.repeat(129) },
    ])
      await expect(ins(bad)).rejects.toMatchObject({ code: '23514' });
    // Номер попытки (FF-INT-14): 0…1000.
    await expect(
      client.query(
        `UPDATE "ffmpeg_submissions" SET attempt = 1001 WHERE "idempotencyKey" = 'op-1'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await client.query(
      `UPDATE "ffmpeg_submissions" SET attempt = attempt + 1 WHERE "idempotencyKey" = 'op-1'`,
    );
    // Fallback фиксируется в той же строке.
    const upd = await client.query(
      `UPDATE "ffmpeg_submissions" SET provider = 'hosted', state = 'accepted', "jobId" = 'h2', "fallbackReason" = 'not-found'
       WHERE "idempotencyKey" = 'op-1'`,
    );
    expect(upd.rowCount).toBe(1);
  });

  it('события fallback: известные причины, без произвольного текста в коде', async () => {
    await client.query(
      `INSERT INTO "ffmpeg_fallback_events" (id, reason, code, product) VALUES ($1, 'refused', 'QUEUE_FULL', 'story')`,
      [randomUUID()],
    );
    for (const [reason, code] of [
      ['retry', null],
      ['refused', 'has space'],
    ])
      await expect(
        client.query(
          `INSERT INTO "ffmpeg_fallback_events" (id, reason, code) VALUES ($1, $2, $3)`,
          [randomUUID(), reason, code],
        ),
      ).rejects.toMatchObject({ code: '23514' });
  });

  it('CAS по ревизии: устаревшая ревизия не обновляет строку', async () => {
    const ok = await client.query(
      `UPDATE "ffmpeg_routing" SET revision = revision + 1, "canaryProducts" = ARRAY['story','tutorial-quality']
       WHERE id = 'default' AND revision = 1`,
    );
    expect(ok.rowCount).toBe(1);
    const stale = await client.query(
      `UPDATE "ffmpeg_routing" SET revision = revision + 1 WHERE id = 'default' AND revision = 1`,
    );
    expect(stale.rowCount).toBe(0);
  });

  it('журнал принимает запрос и исход одной операции; повтор фазы — unique violation', async () => {
    const operationId = randomUUID();
    await insert({ operationId });
    await insert({
      operationId,
      phase: 'succeeded',
      result: { worker: 'paused' },
    });
    await expect(insert({ operationId })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('журнал отвергает неизвестные действие/фазу, не-UUID операции и длинную причину', async () => {
    for (const bad of [
      { action: 'job.rerender' },
      { phase: 'done' },
      { operationId: 'NOT-A-UUID' },
      { reason: 'x'.repeat(501) },
      { correlationId: '' },
    ])
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
  });

  it('id selfhosted:<uuid> помещается в колонки jobId (text, без обрезки)', async () => {
    const jobId = `selfhosted:${randomUUID()}`;
    await insert({ jobId, action: 'job.cancel' });
    await client.query(
      `INSERT INTO "tutorial_video_assets" (id, "assemblyJobId") VALUES ('a1', $1)`,
      [jobId],
    );
    const { rows } = await client.query(
      `SELECT "assemblyJobId" FROM "tutorial_video_assets" WHERE "assemblyJobId" = $1`,
      [jobId],
    );
    expect(rows[0].assemblyJobId).toBe(jobId);
  });

  it('append-only: UPDATE запрещён, DELETE (уборка 90 дней) возможен', async () => {
    const id = randomUUID();
    await insert({ id });
    await expect(
      client.query(
        `UPDATE "ffmpeg_operator_actions" SET reason = 'подмена' WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const del = await client.query(
      `DELETE FROM "ffmpeg_operator_actions" WHERE id = $1`,
      [id],
    );
    expect(del.rowCount).toBe(1);
  });

  it('RLS включён на обеих таблицах, PUBLIC прав не имеет; индексы владельца созданы', async () => {
    const { rows } = await client.query(
      `SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND relname IN ('ffmpeg_routing','ffmpeg_operator_actions','ffmpeg_fallback_events','ffmpeg_breaker_jobs','ffmpeg_submissions') ORDER BY relname`,
      [schema],
    );
    expect(rows).toEqual([
      { relname: 'ffmpeg_breaker_jobs', relrowsecurity: true },
      { relname: 'ffmpeg_fallback_events', relrowsecurity: true },
      { relname: 'ffmpeg_operator_actions', relrowsecurity: true },
      { relname: 'ffmpeg_routing', relrowsecurity: true },
      { relname: 'ffmpeg_submissions', relrowsecurity: true },
    ]);
    const grants = await client.query(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
       WHERE table_schema = $1 AND grantee = 'PUBLIC'
         AND table_name IN ('ffmpeg_routing','ffmpeg_operator_actions','ffmpeg_fallback_events','ffmpeg_breaker_jobs','ffmpeg_submissions')`,
      [schema],
    );
    expect(grants.rows[0].n).toBe(0);
    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname ILIKE '%jobid_idx' ORDER BY indexname`,
      [schema],
    );
    expect(idx.rows.map((r: { indexname: string }) => r.indexname)).toEqual([
      'portfolio_items_watermarkJobId_idx',
      'tutorial_demo_quality_checks_signalsJobId_idx',
      'tutorial_video_assets_assemblyJobId_idx',
      'tutorial_video_versions_jobId_idx',
      'video_audio_tracks_mixJobId_idx',
    ]);
  });
});
