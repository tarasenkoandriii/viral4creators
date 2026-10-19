/** Real SQL constraints of WP5 narrator looks; isolated schema, never production records. */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl =
  process.env.STORY_NARRATOR_LOOKS_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Narrator looks PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;

db('story narrator looks on PostgreSQL', () => {
  const schema = `narrator_looks_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
      CREATE TABLE "users" (id text PRIMARY KEY);
      CREATE TABLE "brand_manifests" (id text PRIMARY KEY, "userId" text);
      CREATE TABLE "brand_characters" (id text PRIMARY KEY, "brandManifestId" text NOT NULL REFERENCES "brand_manifests"(id) ON DELETE CASCADE);
      INSERT INTO "users" VALUES ('u1');
      INSERT INTO "brand_manifests" VALUES ('m1','u1');
      INSERT INTO "brand_characters" VALUES ('c1','m1'), ('c2','m1');`);
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../prisma/migrations/20270124220000_story_narrator_looks/migration.sql',
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

  const base = {
    userId: 'u1',
    manifestId: 'm1',
    characterId: 'c1',
    sourceUrl: 'https://blob/c1.png',
    sourceHash: 'a'.repeat(64),
    outfit: 'casual',
    makeup: 'none',
    configHash: 'b'.repeat(64),
    promptHash: 'c'.repeat(16),
    consentVersion: 'story-parent-image-v1',
    consentAt: new Date('2026-10-19T09:00:00Z'),
    status: 'READY',
    imageCalls: 1,
    reservedMicroUsd: 156000,
    photo: Buffer.from('png'),
    photoHash: 'd'.repeat(64),
    style: null as string | null,
    styleStatus: 'NONE',
    styledHash: null as string | null,
    deletedAt: null as Date | null,
  };
  const insert = (over: Partial<typeof base> = {}) => {
    const row = { id: randomUUID(), ...base, ...over };
    const cols = Object.keys(row);
    return client
      .query(
        `INSERT INTO "story_narrator_looks" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
        Object.values(row),
      )
      .then(() => row.id);
  };
  const violates = (p: Promise<unknown>) =>
    expect(p).rejects.toMatchObject({ code: '23514' });

  it('accepts a ready photo variant and a ready styled variant', async () => {
    await insert();
    await insert({
      imageCalls: 2,
      style: 'cartoon',
      styleStatus: 'READY',
      styledHash: 'e'.repeat(64),
    });
  });

  it('rejects unknown states, presets, styles and consent versions', async () => {
    await violates(insert({ status: 'DONE' }));
    await violates(insert({ outfit: 'evening' }));
    await violates(insert({ makeup: 'heavy' }));
    await violates(
      insert({ style: 'oil', styleStatus: 'READY', styledHash: 'e' }),
    );
    await violates(insert({ consentVersion: 'story-parent-voice-v1' }));
    await violates(insert({ imageCalls: 3 }));
    await violates(insert({ style: null, styleStatus: 'READY' }));
  });

  it('READY needs the hashes of every requested asset', async () => {
    await violates(insert({ photoHash: null as never }));
    await violates(
      insert({ style: 'pencil', styleStatus: 'FAILED', styledHash: null }),
    );
    await insert({
      status: 'UNKNOWN',
      style: 'pencil',
      styleStatus: 'UNKNOWN',
      imageCalls: 2,
    });
  });

  it('caps image bytes and wipes them on deletion', async () => {
    await violates(insert({ photo: Buffer.alloc(4 * 1024 * 1024 + 1) }));
    await violates(insert({ status: 'DELETED', deletedAt: new Date() }));
    await violates(insert({ status: 'FAILED', deletedAt: new Date() }));
    await insert({
      status: 'DELETED',
      deletedAt: new Date(),
      photo: null as never,
    });
  });

  it('brand consent is versioned and the active pointer is released on delete', async () => {
    await violates(
      client.query(
        `UPDATE "brand_manifests" SET "narratorImageConsentAt"=now() WHERE id='m1'`,
      ),
    );
    await violates(
      client.query(
        `UPDATE "brand_manifests" SET "narratorLookAsset"='video' WHERE id='m1'`,
      ),
    );
    const id = await insert({ characterId: 'c2' });
    await client.query(
      `UPDATE "brand_manifests" SET "narratorImageConsentAt"=now(), "narratorImageConsentVersion"='story-parent-image-v1', "narratorLookId"=$1, "narratorLookAsset"='photo' WHERE id='m1'`,
      [id],
    );
    await client.query(`DELETE FROM "brand_characters" WHERE id='c2'`);
    const { rows } = await client.query(
      `SELECT "narratorLookId", (SELECT count(*) FROM "story_narrator_looks" WHERE "characterId"='c2')::int AS n FROM "brand_manifests" WHERE id='m1'`,
    );
    expect(rows[0]).toEqual({ narratorLookId: null, n: 0 });
  });
});
