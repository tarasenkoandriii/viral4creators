// Disposable local PostgreSQL. No production DB access or provider calls.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function docker(args, input) {
  const r = spawnSync('docker', args, {
    input,
    encoding: 'utf8',
    timeout: 30000,
  });
  if (r.status !== 0) throw Error(r.stderr || String(r.error));
  return r.stdout.trim();
}
async function worker() {
  require('ts-node/register/transpile-only');
  const { PrismaClient } = require('@prisma/client'),
    { PrismaPg } = require('@prisma/adapter-pg');
  const { SessionService } = require('../src/common/session.service');
  const {
    GenerationHistoryService,
  } = require('../src/modules/generation-history/generation-history.service');
  const db = new PrismaClient({
    adapter: new PrismaPg(process.env.GENERATION_HISTORY_TEST_DATABASE_URL),
  });
  const sessions = new SessionService(db),
    history = new GenerationHistoryService(db);
  const video = (id, status) => ({
    generatedVideoId: id,
    status,
    provider: 'grok',
    resolution: '720p',
    pathname: 'not-for-history',
  });
  try {
    await sessions.recordVideoAttempt(
      's-A',
      'attempt',
      'queued',
      'grok',
      '720p',
    );
    await assert.rejects(
      () =>
        sessions.recordVideoAttempt(
          's-A',
          'duplicate',
          'queued',
          'grok',
          '720p',
        ),
      (e) => e.getStatus() === 409,
    );
    await sessions.recordVideoAttempt(
      's-A',
      'attempt',
      'unknown',
      'grok',
      '720p',
    );
    await assert.rejects(
      () =>
        sessions.recordVideoAttempt(
          's-A',
          'duplicate',
          'queued',
          'grok',
          '720p',
        ),
      (e) => e.getStatus() === 409,
    );
    console.log(
      'PASS PostgreSQL: queued/unknown attempt blocks duplicate dispatch',
    );
    for (const status of ['processing', 'processing', 'complete'])
      await sessions.updateSession('s-A', {
        generatedVideo: video('attempt', status),
      });
    // Replayed and stale callbacks must not fabricate transitions.
    await sessions.updateSession('s-A', {
      generatedVideo: video('attempt', 'processing'),
    });
    await sessions.updateSession('s-A', {
      generatedVideo: video('attempt', 'failed'),
    });
    const events = await db.generationHistoryEvent.findMany({
      where: { runId: 'attempt' },
      orderBy: { revision: 'asc' },
    });
    assert.deepEqual(
      events.map((e) => [e.kind, e.fromStatus, e.status]),
      [
        ['snapshot', null, 'queued'],
        ['transition', 'queued', 'unknown'],
        ['transition', 'unknown', 'processing'],
        ['transition', 'processing', 'complete'],
      ],
    );
    console.log(
      'PASS PostgreSQL: observed transition trail deduplicates and rejects late conflicting callbacks',
    );
    const page = await history.list('A');
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].status, 'complete');
    assert.equal((await history.list('B')).items.length, 0);
    assert.equal(JSON.stringify(page).includes('not-for-history'), false);
    console.log(
      'PASS PostgreSQL: stable attempt, owner isolation, metadata allowlist',
    );
    await db.$executeRawUnsafe('CREATE ROLE history_web_test NOLOGIN');
    await db.$executeRawUnsafe(
      'GRANT USAGE ON SCHEMA public TO history_web_test',
    );
    await db.$executeRawUnsafe(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON generation_history_runs, generation_history_events TO history_web_test',
    );
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE history_web_test');
      assert.equal((await tx.generationHistoryRun.findMany()).length, 0);
      assert.equal((await tx.generationHistoryEvent.findMany()).length, 0);
      assert.equal(
        (
          await tx.generationHistoryRun.updateMany({
            data: { status: 'failed' },
          })
        ).count,
        0,
      );
      assert.equal((await tx.generationHistoryEvent.deleteMany()).count, 0);
    });
    await assert.rejects(() =>
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE history_web_test');
        await tx.generationHistoryRun.create({
          data: {
            id: 'forbidden-api-write',
            userId: 'A',
            sessionId: 's-A',
            module: 'session-video',
            source: 'unknown',
            status: 'queued',
            revision: 0,
          },
        });
      }),
    );
    console.log(
      'PASS PostgreSQL: RLS hides private history from direct API roles',
    );
    await db.$executeRawUnsafe(
      `CREATE FUNCTION reject_test_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = 'reject' THEN RAISE EXCEPTION 'test rejection'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_test_run BEFORE INSERT ON generation_history_runs FOR EACH ROW EXECUTE FUNCTION reject_test_run()',
    );
    await assert.rejects(() =>
      sessions.updateSession('s-A', {
        generatedVideo: video('reject', 'processing'),
      }),
    );
    assert.equal(
      (await sessions.getSession('s-A')).generatedVideo.generatedVideoId,
      'attempt',
    );
    console.log('PASS PostgreSQL: journal failure rolls back video UPDATE');
    await db.$executeRawUnsafe(
      `CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."runId" = 'event-reject' THEN RAISE EXCEPTION 'test event rejection'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_test_event BEFORE INSERT ON generation_history_events FOR EACH ROW EXECUTE FUNCTION reject_test_event()',
    );
    await assert.rejects(() =>
      sessions.updateSession('s-A', {
        generatedVideo: video('event-reject', 'processing'),
      }),
    );
    assert.equal(
      await db.generationHistoryRun.count({ where: { id: 'event-reject' } }),
      0,
    );
    assert.equal(
      (await sessions.getSession('s-A')).generatedVideo.generatedVideoId,
      'attempt',
    );
    console.log(
      'PASS PostgreSQL: event write failure atomically rolls back run and session',
    );
    await db.$executeRaw`DELETE FROM sessions WHERE id = 's-A'`;
    assert.equal((await history.list('A')).items.length, 1);
    assert.equal(
      await db.generationHistoryEvent.count({ where: { runId: 'attempt' } }),
      4,
    );
    console.log(
      'PASS PostgreSQL: temporary session deletion preserves history',
    );
    await sessions.updateSession('s-B', {
      generatedVideo: video('attempt-B', 'processing'),
    });
    const race = await Promise.allSettled([
      history.record({
        id: 'attempt-B',
        userId: 'B',
        sessionId: 's-B',
        module: 'session-video',
        source: 'unknown',
        status: 'complete',
        revision: 2,
      }),
      sessions.softDeleteSession('s-B'),
    ]);
    assert.equal(race[1].status, 'fulfilled');
    if (race[0].status === 'rejected')
      assert.equal(race[0].reason.getStatus(), 404);
    assert.equal((await history.list('B')).items.length, 0);
    assert.equal(
      await db.generationHistoryEvent.count({ where: { runId: 'attempt-B' } }),
      0,
    );
    await assert.rejects(() =>
      history.record({
        id: 'late',
        userId: 'B',
        sessionId: 's-B',
        module: 'session-video',
        source: 'unknown',
        status: 'complete',
        revision: 2,
      }),
    );
    console.log(
      'PASS PostgreSQL: explicit deletion erases memory and rejects late ingestion',
    );
    await db.$executeRaw`DELETE FROM users WHERE id = 'A'`;
    assert.equal((await history.list('A')).items.length, 0);
    assert.equal(await db.generationHistoryEvent.count(), 0);
    console.log(
      'PASS PostgreSQL: account deletion cascades history and events',
    );
  } finally {
    await db.$disconnect();
  }
}
async function main() {
  if (process.argv.includes('--worker')) return worker();
  let container;
  try {
    container = docker([
      'run',
      '--detach',
      '--rm',
      '--pull=never',
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '--env',
      'POSTGRES_HOST_AUTH_METHOD=trust',
      'postgres:16',
    ]);
    for (let i = 0; i < 30; i++) {
      if (
        spawnSync(
          'docker',
          ['exec', container, 'pg_isready', '-U', 'postgres'],
          { timeout: 1000 },
        ).status === 0
      )
        break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const sql =
      `CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'created',"createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),"lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT now(),data JSONB NOT NULL DEFAULT '{}',"liveData" JSONB NOT NULL DEFAULT '{}',"userId" TEXT,"projectId" TEXT,"productItemId" TEXT,"deletedAt" TIMESTAMP(3),"generationStatus" TEXT);
    INSERT INTO users VALUES('A'),('B');INSERT INTO sessions(id,"userId")VALUES('s-A','A'),('s-B','B');\n` +
      fs.readFileSync(
        path.join(
          root,
          'prisma/migrations/20270127090000_client_generation_history/migration.sql',
        ),
        'utf8',
      ) +
      fs.readFileSync(
        path.join(
          root,
          'prisma/migrations/20270127091000_generation_history_events/migration.sql',
        ),
        'utf8',
      );
    docker(
      [
        'exec',
        '-i',
        container,
        'psql',
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
      ],
      sql,
    );
    const port = docker(['port', container, '5432/tcp']).split(':').at(-1);
    const result = spawnSync(process.execPath, [__filename, '--worker'], {
      cwd: root,
      stdio: 'inherit',
      timeout: 60000,
      env: {
        ...process.env,
        GENERATION_HISTORY_TEST_DATABASE_URL: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      },
    });
    if (result.status !== 0)
      throw Error('PostgreSQL history regression failed');
  } finally {
    if (container) docker(['stop', '--time', '1', container]);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
