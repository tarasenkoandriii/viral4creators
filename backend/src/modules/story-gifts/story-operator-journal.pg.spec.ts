/** WP1: the real migration on PostgreSQL in an isolated schema, never production records. */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl =
  process.env.STORY_OPERATOR_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Story operator PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;

db('story_operator_actions on PostgreSQL', () => {
  const schema = `story_operator_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const insert = (over: Record<string, unknown> = {}) => {
    const row = {
      id: randomUUID(),
      requestId: randomUUID(),
      actorKind: 'admin',
      actorUserId: 'admin-1',
      targetType: 'render',
      targetId: 'r1',
      action: 'render.close-failed',
      reason: 'Сверено с кабинетом',
      previousState: { status: 'UNKNOWN' },
      result: { status: 'FAILED' },
      ...over,
    };
    return client.query(
      `INSERT INTO "story_operator_actions" (id,"requestId","actorKind","actorUserId","targetType","targetId",action,reason,"previousState",result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.id,
        row.requestId,
        row.actorKind,
        row.actorUserId,
        row.targetType,
        row.targetId,
        row.action,
        row.reason,
        row.previousState,
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
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../prisma/migrations/20270124180000_story_operator_resolution/migration.sql',
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

  it('accepts an operator entry and a cron retention entry', async () => {
    await insert();
    await insert({
      requestId: null,
      actorKind: 'cron',
      actorUserId: null,
      targetType: 'gift',
      action: 'retention.purge',
    });
    // WP4 segment cache: UNKNOWN → DELETED by an operator.
    await insert({
      targetType: 'segment',
      targetId: 'seg-1',
      action: 'segment.close-deleted',
      result: { status: 'DELETED', cacheReleased: true },
    });
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "story_operator_actions"`,
    );
    expect(rows[0].n).toBe(3);
  });

  it('rejects empty reason, unknown action/target, actor mismatch and malformed requestId', async () => {
    for (const bad of [
      { reason: '   ' },
      { reason: 'x'.repeat(501) },
      { action: 'render.resubmit' },
      { action: 'segment.resynthesize' },
      { targetType: 'user' },
      { actorUserId: null },
      { requestId: null },
      { actorKind: 'cron' },
      { requestId: 'NOT-A-UUID' },
    ])
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
  });

  it('a repeated requestId is a unique violation (idempotency key)', async () => {
    const requestId = randomUUID();
    await insert({ requestId });
    await expect(insert({ requestId })).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('is append-only: UPDATE is refused, DELETE (lawful erasure) is possible', async () => {
    const id = randomUUID();
    await insert({ id });
    await expect(
      client.query(
        `UPDATE "story_operator_actions" SET reason='переписано' WHERE id=$1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    const del = await client.query(
      `DELETE FROM "story_operator_actions" WHERE id=$1`,
      [id],
    );
    expect(del.rowCount).toBe(1);
  });

  it('row level security is enabled', async () => {
    const { rows } = await client.query(
      `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relname='story_operator_actions'`,
      [schema],
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });
});
