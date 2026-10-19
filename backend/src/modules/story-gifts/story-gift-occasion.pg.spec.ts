/** Real PostgreSQL check of the WP3 migration: backfill and CHECK constraints in an isolated schema. */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const dbUrl =
  process.env.STORY_GIFT_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
const db = dbUrl ? describe : describe.skip;
const migration = (name: string) =>
  readFileSync(
    resolve(__dirname, `../../../prisma/migrations/${name}/migration.sql`),
    'utf8',
  );
db('Story gift occasion/gift migration on PostgreSQL', () => {
  const schema = `story_gift_wp3_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const insert = (fields: Record<string, unknown>) => {
    const row: Record<string, unknown> = {
      id: randomUUID(),
      userId: 'u1',
      catalogId: 'turnip-ushinsky-ru-1949-v1',
      title: 'Репка',
      text: 'Репка.',
      chapters: '[]',
      textHash: 'a'.repeat(64),
      voiceId: 'a9fc5a41',
      ...fields,
    };
    const keys = Object.keys(row);
    return client.query(
      `INSERT INTO "story_gifts" (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      keys.map((k) => row[k]),
    );
  };
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(
      `CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE "users" (id text PRIMARY KEY); INSERT INTO "users" (id) VALUES ('u1');`,
    );
    await client.query(migration('20270124110000_story_gifts'));
    await client.query(migration('20270124120000_story_audio_qa'));
    await insert({
      id: 'legacy-note',
      giftNote: 'Подарок рядом.',
      giftNotePosition: 'end',
      occasion: 'Юбилей',
    });
    await insert({ id: 'legacy-plain' });
    await client.query(migration('20270124200000_story_gift_occasion_gift'));
  });
  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
  it('backfills explicit opt-in only for already voiced notes and keeps legacy captions', async () => {
    const { rows } = await client.query(
      `SELECT id,"giftNoteEnabled","occasion","occasionKind","occasionTheme","narrationLayout" FROM "story_gifts" ORDER BY id`,
    );
    expect(rows).toEqual([
      {
        id: 'legacy-note',
        giftNoteEnabled: true,
        occasion: 'Юбилей',
        occasionKind: null,
        occasionTheme: null,
        narrationLayout: null,
      },
      {
        id: 'legacy-plain',
        giftNoteEnabled: false,
        occasion: null,
        occasionKind: null,
        occasionTheme: null,
        narrationLayout: null,
      },
    ]);
  });
  it('accepts the new shape and rejects invalid kinds, themes, notes, descriptions and layouts', async () => {
    await expect(
      insert({
        occasionKind: 'birthday',
        occasionTheme: 'celebration',
        giftNote: 'Подарок рядом.',
        giftNoteEnabled: true,
        giftNotePosition: 'beginning',
        giftPhotoDescription: 'x'.repeat(200),
        narrationLayout: JSON.stringify({ version: 1, unit: 'utf16' }),
      }),
    ).resolves.toBeTruthy();
    for (const bad of [
      { occasionKind: 'wedding' },
      { occasionTheme: 'neon' },
      { giftNote: 'Без включения' },
      { giftNote: 'x', giftNoteEnabled: true, giftNotePosition: 'middle' },
      { giftPhotoDescription: 'x'.repeat(201) },
      { narrationLayout: JSON.stringify({ version: 2 }) },
      { narrationLayout: JSON.stringify([1]) },
    ])
      await expect(insert(bad)).rejects.toMatchObject({ code: '23514' });
  });
  it('keeps RLS enabled on the table', async () => {
    const { rows } = await client.query(
      `SELECT relrowsecurity FROM pg_class WHERE oid = '"${schema}"."story_gifts"'::regclass`,
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });
});
