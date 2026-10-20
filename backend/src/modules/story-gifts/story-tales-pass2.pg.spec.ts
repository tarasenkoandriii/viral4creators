/**
 * Story-Tales pass 2 (20270124230000) on real PostgreSQL; isolated schema,
 * never production records. ST2-S-01 column, ST2-S-02 quota ledger that
 * survives the brand-manifest cascade, ST2-S-04 zero-call looks, and the
 * ST2-S-08 hash wipe SQL of gift deletion against the real CHECK/unique keys.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl =
  process.env.STORY_VIDEO_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Story pass 2 PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;
const migration = (name: string) =>
  readFileSync(
    resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  );

db('Story-Tales pass 2 migration on PostgreSQL', () => {
  const schema = `story_pass2_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const q = (sql: string, params: unknown[] = []) => client.query(sql, params);
  const violates = async (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
  const look = (id: string, manifestId = 'm1', imageCalls = 1) =>
    q(
      `INSERT INTO "story_narrator_looks" (id,"userId","manifestId","characterId","sourceUrl","sourceHash",outfit,makeup,"configHash","promptHash","consentVersion","consentAt","imageCalls","reservedMicroUsd")
       VALUES ($1,'u1',$2,$3,'https://blob/c.png',$4,'casual','none','cfg','p','story-parent-image-v1',now(),$5,156000)`,
      [
        id,
        manifestId,
        manifestId === 'm1' ? 'c1' : 'c2',
        'a'.repeat(64),
        imageCalls,
      ],
    );

  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await q(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE "users" (id text PRIMARY KEY);
      CREATE TABLE "brand_manifests" (id text PRIMARY KEY, "userId" text);
      CREATE TABLE "brand_characters" (id text PRIMARY KEY, "brandManifestId" text NOT NULL REFERENCES "brand_manifests"(id) ON DELETE CASCADE);
      INSERT INTO "users" VALUES ('u1');
      INSERT INTO "brand_manifests" VALUES ('m1','u1'), ('m2','u1');
      INSERT INTO "brand_characters" VALUES ('c1','m1'), ('c2','m2');`);
    for (const m of [
      '20270124110000_story_gifts',
      '20270124130000_story_video_renders',
      '20270124140000_story_parent_narration',
      '20270124180000_story_operator_resolution',
      '20270124210000_story_video_segments',
      '20270124220000_story_narrator_looks',
    ])
      await q(migration(m));
    // A look made before pass 2 must keep counting after the migration.
    await look('legacy', 'm1', 2);
    await q(migration('20270124230000_story_tales_pass2_fixes'));
    await q(
      `INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId")
       VALUES ('g1','u1','turnip','Репка','Милана, это мама','[]',$1,'a9fc5a41')`,
      ['f'.repeat(64)],
    );
  });
  afterAll(async () => {
    if (client) {
      await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });

  it('ST2-S-01: paidSpeechChars defaults to 0 and is never negative', async () => {
    await q(
      `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd")
       VALUES ('r1','g1','cfg-1','Привет, Милана','turnip-v1','b','a','a9fc5a41',618340)`,
    );
    const { rows } = await q(
      `SELECT "paidSpeechChars" FROM "story_video_renders" WHERE id='r1'`,
    );
    expect(rows[0].paidSpeechChars).toBe(0);
    await violates(
      q(
        `UPDATE "story_video_renders" SET "paidSpeechChars" = -1 WHERE id='r1'`,
      ),
    );
  });

  it('ST2-S-02: the quota ledger is backfilled and survives the manifest/character cascade', async () => {
    const before = await q(
      `SELECT "lookId","imageCalls" FROM "story_narrator_look_calls"`,
    );
    expect(before.rows).toEqual([{ lookId: 'legacy', imageCalls: 2 }]);
    await look('l2', 'm2');
    await q(
      `INSERT INTO "story_narrator_look_calls" (id,"userId","lookId","imageCalls") VALUES ($1,'u1','l2',1)`,
      [randomUUID()],
    );
    // = BrandManifestService.remove(): looks cascade, the ledger stays.
    await q(`DELETE FROM "brand_manifests" WHERE id IN ('m1','m2')`);
    expect(
      (await q(`SELECT count(*)::int AS n FROM "story_narrator_looks"`)).rows[0]
        .n,
    ).toBe(0);
    const after = await q(
      `SELECT sum("imageCalls")::int AS calls FROM "story_narrator_look_calls" WHERE "userId"='u1'`,
    );
    expect(after.rows[0].calls).toBe(3);
    // One ledger row per look; 0–2 calls; RLS on.
    await violates(
      q(
        `INSERT INTO "story_narrator_look_calls" (id,"userId","lookId","imageCalls") VALUES ($1,'u1','l2',1)`,
        [randomUUID()],
      ),
    );
    await violates(
      q(
        `INSERT INTO "story_narrator_look_calls" (id,"userId","lookId","imageCalls") VALUES ($1,'u1','l3',3)`,
        [randomUUID()],
      ),
    );
    const rls = await q(
      `SELECT relrowsecurity FROM pg_class WHERE relname='story_narrator_look_calls' AND relnamespace = $1::regnamespace`,
      [schema],
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
  });

  it('ST2-S-09: the journal accepts an owner recording-deletion entry without a user id', async () => {
    const entry = (
      actorKind: string,
      actorUserId: string | null,
      action: string,
    ) =>
      q(
        `INSERT INTO "story_operator_actions" (id,"actorKind","actorUserId","targetType","targetId",action,reason,"previousState",result)
         VALUES ($1,$2,$3,'segment','seg-1',$4,'Владелец удалил запись','{"status":"UNKNOWN"}','{"textErased":true}')`,
        [randomUUID(), actorKind, actorUserId, action],
      );
    await entry('owner', null, 'owner.recording-delete');
    await violates(entry('owner', 'u1', 'owner.recording-delete'));
    await violates(entry('owner', null, 'owner.something-else'));
    await entry('cron', null, 'retention.purge');
    // Still append-only.
    await expect(
      q(`UPDATE "story_operator_actions" SET reason = 'xyz'`),
    ).rejects.toMatchObject({ code: '55000' });
  });

  it('ST2-S-04: a look stopped before any model call may record 0 calls', async () => {
    await q(`INSERT INTO "brand_manifests" VALUES ('m1','u1');
      INSERT INTO "brand_characters" VALUES ('c1','m1');`);
    await look('l0', 'm1', 0);
    await violates(look('l9', 'm1', 3));
  });

  it('ST2-S-08: gift deletion replaces config hashes and cache keys under the real constraints', async () => {
    await q(
      `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd")
       VALUES ('r2','g1','cfg-2:retired:r0','','turnip-v1','b','a','a9fc5a41',0)`,
    );
    for (const [id, key] of [
      ['s1', 'a'],
      ['s2', 'b'],
    ])
      await q(
        `INSERT INTO "story_video_segments" (id,"giftId","cacheKey",source,"voiceId",text) VALUES ($1,'g1',$2,'synth','a9fc5a41','Милана')`,
        [id, key.repeat(64)],
      );
    // The exact statements of StoryGiftsService.remove().
    await q(
      `UPDATE "story_video_renders" SET "configHash" = 'deleted:' || "id" WHERE "giftId" = $1`,
      ['g1'],
    );
    await q(
      `UPDATE "story_video_segments" SET "cacheKey" = encode(sha256(convert_to('story-deleted:' || "id", 'UTF8')), 'hex') WHERE "giftId" = $1`,
      ['g1'],
    );
    const renders = await q(
      `SELECT id,"configHash" FROM "story_video_renders" WHERE "giftId"='g1' ORDER BY id`,
    );
    expect(renders.rows).toEqual([
      { id: 'r1', configHash: 'deleted:r1' },
      { id: 'r2', configHash: 'deleted:r2' },
    ]);
    const segs = await q(
      `SELECT "cacheKey" FROM "story_video_segments" WHERE "giftId"='g1'`,
    );
    expect(segs.rows).toHaveLength(2);
    for (const r of segs.rows) {
      expect(r.cacheKey).toMatch(/^[0-9a-f]{64}$/);
      expect(r.cacheKey).not.toBe('a'.repeat(64));
    }
    expect(new Set(segs.rows.map((r) => r.cacheKey)).size).toBe(2);
  });
});
