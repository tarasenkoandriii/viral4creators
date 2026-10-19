/** WP4 migration on real PostgreSQL; isolated schema, never production records. */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const dbUrl =
  process.env.STORY_VIDEO_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Story video segments PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;
const migration = (name: string) =>
  readFileSync(
    resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  );
db('story video segments migration on PostgreSQL', () => {
  const schema = `story_segments_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const key = (c: string) => c.repeat(64);
  const insert = (fields: Record<string, unknown>) => {
    const row = {
      id: randomUUID(),
      giftId: 'g1',
      cacheKey: key('a'),
      source: 'synth',
      voiceId: 'a9fc5a41',
      ...fields,
    };
    const cols = Object.keys(row);
    return client.query(
      `INSERT INTO "story_video_segments" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      Object.values(row),
    );
  };
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE "users" (id text PRIMARY KEY);`,
    );
    for (const m of [
      '20270124110000_story_gifts',
      '20270124130000_story_video_renders',
      '20270124140000_story_parent_narration',
      '20270124210000_story_video_segments',
    ])
      await client.query(migration(m));
    await client.query(
      `INSERT INTO "users" VALUES ('u1');
       INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId")
       VALUES ('g1','u1','turnip','Репка','Репка','[]','h','a9fc5a41');`,
    );
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
  beforeEach(() => client.query(`DELETE FROM "story_video_segments"`));
  it('keeps old renders valid and stores the segment manifest as JSON', async () => {
    await client.query(
      `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd")
       VALUES ('legacy','g1','c1','Привет','turnip-v1','b','m','a9fc5a41',1),
              ('new','g1','c2','Привет','turnip-v1','b','m','a9fc5a41',1)`,
    );
    await client.query(
      `UPDATE "story_video_renders" SET segments=$1 WHERE id='new'`,
      [{ version: 1, segments: [] }],
    );
    const { rows } = await client.query(
      `SELECT id, segments FROM "story_video_renders" ORDER BY id`,
    );
    expect(rows).toEqual([
      { id: 'legacy', segments: null },
      { id: 'new', segments: { version: 1, segments: [] } },
    ]);
  });
  it('enforces states, sources, consent, size and key shape', async () => {
    await insert({});
    for (const bad of [
      { cacheKey: key('b'), status: 'DONE' },
      { cacheKey: key('b'), source: 'clone' },
      { cacheKey: key('b'), voiceId: null },
      { cacheKey: 'short' },
      { cacheKey: key('b'), status: 'READY' },
      {
        cacheKey: key('b'),
        source: 'recorded',
        voiceId: null,
        mime: 'audio/wav',
      },
      {
        cacheKey: key('b'),
        source: 'recorded',
        voiceId: null,
        consentVersion: 'v',
        consentAt: new Date(),
      },
      { cacheKey: key('b'), audio: Buffer.alloc(1048577) },
      { cacheKey: key('b'), mime: 'audio/webm' },
    ])
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
    await insert({
      cacheKey: key('c'),
      source: 'recorded',
      voiceId: null,
      mime: 'audio/wav',
      consentVersion: 'story-preamble-recording-v1',
      consentAt: new Date(),
      status: 'READY',
      audio: Buffer.from('RIFF'),
      audioHash: key('d'),
      durationSeconds: 3,
    });
  });
  it('F1: a provider job id binds to at most one render; renders without a job are unlimited', async () => {
    await client.query(`DELETE FROM "story_video_renders"`);
    const render = (id: string, jobId: string | null) =>
      client.query(
        `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd","jobId")
         VALUES ($1,'g1',$1,'Привет','turnip-v1','b','m','a9fc5a41',1,$2)`,
        [id, jobId],
      );
    await render('j1', 'job-1');
    await render('n1', null);
    await render('n2', null);
    await expect(render('j2', 'job-1')).rejects.toMatchObject({
      code: '23505',
    });
    const { rows } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('story_video_renders_jobId_key','story_video_segments_userVoiceId_idx') ORDER BY 1`,
      [schema],
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'story_video_renders_jobId_key',
      'story_video_segments_userVoiceId_idx',
    ]);
  });
  it('keeps one cache row per gift and key, and cascades with the gift', async () => {
    await insert({});
    await expect(insert({})).rejects.toMatchObject({ code: '23505' });
    await client.query(
      `INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId")
       VALUES ('g2','u1','turnip','Репка','Репка','[]','h','a9fc5a41')`,
    );
    await insert({ giftId: 'g2' });
    await client.query(`DELETE FROM "story_gifts" WHERE id='g2'`);
    const { rows } = await client.query(
      `SELECT "giftId" FROM "story_video_segments"`,
    );
    expect(rows).toEqual([{ giftId: 'g1' }]);
  });
});
