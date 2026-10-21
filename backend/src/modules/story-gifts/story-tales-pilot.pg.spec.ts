/**
 * Story-Tales pass 3 (20270125090000_story_tales_pilot) on real PostgreSQL:
 * a fresh database, EVERY migration applied in order (as `for d in
 * prisma/migrations/*\/; do psql -f $d/migration.sql; done`), then the new
 * tables' CHECK/unique/RLS rules and a Prisma client round-trip. Never
 * production records: the database is created and dropped by the test.
 */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { StoryPilotService } from './story-pilot.service';
import { StoryRetentionService } from './story-retention.service';
import { StoryChargesService } from './story-charges.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';

const dbUrl =
  process.env.STORY_VIDEO_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Story pilot PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;
const MIGRATIONS = resolve(__dirname, '../../../prisma/migrations');
const LAST = '20270125090000_story_tales_pilot';
const migrations = readdirSync(MIGRATIONS)
  .filter((d) => statSync(join(MIGRATIONS, d)).isDirectory())
  .sort();
const sql = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
/**
 * Top-level statements of a migration, like psql runs them (each in its own
 * implicit transaction: `ALTER TYPE … ADD VALUE` and its first use may sit
 * in one file). Skips quotes, dollar-quoted bodies and comments.
 */
function splitSql(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      i = end < 0 ? text.length : end;
    } else if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(text.slice(i))?.[0];
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        i = end < 0 ? text.length : end + tag.length - 1;
      }
    } else if (c === ';') {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.filter((st) =>
    st
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim(),
  );
}

db(
  'Story-Tales pilot migration on PostgreSQL (all migrations, clean DB)',
  () => {
    const name = `st3_be_pilot_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    let admin: Client;
    let client: Client;
    let prisma: PrismaClient;
    const q = (text: string, params: unknown[] = []) =>
      client.query(text, params);
    const violates = (p: Promise<unknown>) =>
      expect(p).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    const url = () => {
      const u = new URL(dbUrl!);
      u.pathname = `/${name}`;
      return u.toString();
    };

    beforeAll(async () => {
      expect(migrations.at(-1)).toBe(LAST);
      admin = new Client({ connectionString: dbUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      client = new Client({ connectionString: url() });
      await client.connect();
      for (const m of migrations.slice(0, -1))
        for (const statement of splitSql(sql(m))) await q(statement);
      // A link issued before the lockdown must not come back with the pilot.
      await q(
        `INSERT INTO "users" (id, "telegramId") VALUES ('u1','t1'), ('u2','t2')`,
      );
      await q(
        `INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId",status,"shareHash")
       VALUES ('g-old','u1','turnip','Репка','x','[]',$1,'a9fc5a41','APPROVED',$2)`,
        ['f'.repeat(64), 'e'.repeat(64)],
      );
      for (const statement of splitSql(sql(LAST))) await q(statement);
      prisma = new PrismaClient({ adapter: new PrismaPg(url()) });
    }, 240_000);
    afterAll(async () => {
      await prisma?.$disconnect();
      await client?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });

    it('every migration applied; old public links are dropped', async () => {
      const { rows } = await q(
        `SELECT "shareHash","sharedAt","shareExpiresAt" FROM "story_gifts" WHERE id='g-old'`,
      );
      expect(rows[0]).toEqual({
        shareHash: null,
        sharedAt: null,
        shareExpiresAt: null,
      });
    });

    it('new tables have RLS on and no PUBLIC grants, like the other Story tables', async () => {
      const { rows } = await q(
        `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('story_pilot_members','story_pilot_applications','story_terms_acceptances','story_credit_charges')
        ORDER BY relname`,
      );
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.relrowsecurity)).toBe(true);
      const grants = await q(
        `SELECT count(*)::int AS n FROM information_schema.role_table_grants
        WHERE grantee = 'PUBLIC' AND table_name LIKE 'story_%'`,
      );
      expect(grants.rows[0].n).toBe(0);
    });

    it('public link window: all three fields together, at most 90 days', async () => {
      const base = `INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId","shareHash","sharedAt","shareExpiresAt")
       VALUES ($1,'u1','turnip','Репка','x','[]','h','a9fc5a41',$2,$3,$4)`;
      await violates(q(base, ['g-a', 'a'.repeat(64), null, null]));
      await violates(
        q(base, ['g-b', null, new Date(), new Date(Date.now() + 1e6)]),
      );
      await violates(
        q(base, [
          'g-c',
          'b'.repeat(64),
          new Date(),
          new Date(Date.now() + 91 * 864e5),
        ]),
      );
      await violates(
        q(base, ['g-d', 'c'.repeat(64), new Date(), new Date(Date.now() - 1)]),
      );
      await q(base, [
        'g-e',
        'd'.repeat(64),
        new Date(),
        new Date(Date.now() + 90 * 864e5 - 1000),
      ]);
      await q(base, ['g-f', null, null, null]);
    });

    it('narrator public consent (§11.1, ST3-S-04): a live link, a version and the release', async () => {
      const ins = `INSERT INTO "story_gifts" (id,"userId","catalogId",title,text,chapters,"textHash","voiceId","shareHash","sharedAt","shareExpiresAt","narratorPublicConsentAt","narratorPublicConsentVersion","narratorPublicConsentRenderId")
       VALUES ($1,'u1','turnip','Репка','x','[]','h','a9fc5a41',$2,$3,$4,$5,$6,$7)`;
      const live = () => [new Date(), new Date(Date.now() + 864e5)];
      const V = 'story-rules-2026-10-20';
      await violates(q(ins, ['n1', null, null, null, new Date(), V, 'r1']));
      await violates(
        q(ins, ['n2', '1'.repeat(64), ...live(), new Date(), null, 'r1']),
      );
      await violates(q(ins, ['n3', '2'.repeat(64), ...live(), null, V, null]));
      await violates(
        q(ins, ['n4', '3'.repeat(64), ...live(), new Date(), 'Bad!', 'r1']),
      );
      await violates(
        q(ins, ['n7', '6'.repeat(64), ...live(), new Date(), V, null]),
      );
      await violates(
        q(ins, ['n8', '7'.repeat(64), ...live(), null, null, 'r1']),
      );
      await q(ins, ['n5', '4'.repeat(64), ...live(), new Date(), V, 'r1']);
      await q(ins, ['n6', '5'.repeat(64), ...live(), null, null, null]);
    });

    it('applications: one per user, known status, decision time, scenario ≤500', async () => {
      const ins = `INSERT INTO "story_pilot_applications" (id,"userId",scenario,status,"decidedAt") VALUES ($1,$2,$3,$4,$5)`;
      await q(ins, ['a1', 'u1', 'Сказка на ночь', 'pending', null]);
      await violates(q(ins, ['a2', 'u1', null, 'pending', null]));
      await violates(q(ins, ['a3', 'u2', null, 'waiting', null]));
      await violates(q(ins, ['a3', 'u2', null, 'approved', null]));
      await violates(q(ins, ['a3', 'u2', null, 'pending', new Date()]));
      await violates(q(ins, ['a3', 'u2', 'x'.repeat(501), 'pending', null]));
      await violates(q(ins, ['a3', 'u2', '', 'pending', null]));
      await violates(q(ins, ['a3', 'nobody', null, 'pending', null]));
      // ST3-S-10: pending > 90 days → expired (a decision time, no text).
      await q(ins, ['a4', 'u2', null, 'expired', new Date()]);
      await violates(
        q(
          `UPDATE "story_pilot_applications" SET "decidedAt" = NULL WHERE id = 'a4'`,
        ),
      );
    });

    it('members: one row per user; free gift id and time together; revocation after since', async () => {
      const ins = `INSERT INTO "story_pilot_members" (id,"userId","freeGiftUsedAt","freeGiftId","revokedAt") VALUES ($1,$2,$3,$4,$5)`;
      await violates(q(ins, ['m0', 'u1', new Date(), null, null]));
      await violates(q(ins, ['m0', 'u1', null, 'g1', null]));
      await violates(q(ins, ['m0', 'u1', null, null, new Date('2000-01-01')]));
      await q(ins, ['m1', 'u1', null, null, null]);
      await violates(q(ins, ['m2', 'u1', null, null, null]));
    });

    it('terms: only with 18+, a safe version string, once per version', async () => {
      const ins = `INSERT INTO "story_terms_acceptances" (id,"userId","termsVersion",adult) VALUES ($1,'u1',$2,$3)`;
      await violates(q(ins, ['t0', 'story-rules-2026-10-20', false]));
      await violates(q(ins, ['t0', 'Bad Version!', true]));
      await q(ins, ['t1', 'story-rules-2026-10-20', true]);
      await violates(q(ins, ['t2', 'story-rules-2026-10-20', true]));
      await q(ins, ['t3', 'story-rules-2027-01-01', true]);
    });

    it('charges: key matches the step, free means 0, refunded has a time, key unique', async () => {
      const ins = `INSERT INTO "story_credit_charges" (id,"userId",key,kind,"giftId","renderId",credits,"reserveMicroUsd","priceMicroUsd",free,status,"refundedAt")
      VALUES ($1,'u1',$2,$3,$4,$5,$6,100,$7,$8,$9,$10)`;
      await q(ins, [
        'c1',
        'audio:g1:1',
        'audio',
        'g1',
        null,
        5,
        2990000,
        false,
        'RESERVED',
        null,
      ]);
      await violates(
        q(ins, [
          'c2',
          'audio:g1:1',
          'audio',
          'g1',
          null,
          5,
          2990000,
          false,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'audio:g2',
          'audio',
          'g9',
          null,
          5,
          1,
          false,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          null,
          5,
          1,
          false,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'audio:g2',
          'audio',
          'g2',
          'r1',
          5,
          1,
          false,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          'r1',
          5,
          0,
          true,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          'r1',
          -1,
          0,
          false,
          'RESERVED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          'r1',
          5,
          1,
          false,
          'REFUNDED',
          null,
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          'r1',
          5,
          1,
          false,
          'RESERVED',
          new Date(),
        ]),
      );
      await violates(
        q(ins, [
          'c2',
          'video:r1',
          'video',
          'g1',
          'r1',
          5,
          1,
          false,
          'DONE',
          null,
        ]),
      );
      await q(ins, [
        'c2',
        'video:r1',
        'video',
        'g1',
        'r1',
        0,
        0,
        true,
        'RESERVED',
        null,
      ]);
      await q(
        `UPDATE "story_credit_charges" SET status='REFUNDED', "refundedAt"=now() WHERE id='c1'`,
      );
      // ST3-R-05: a new attempt of the same gift after the refund.
      await q(ins, [
        'c3',
        'audio:g1:2',
        'audio',
        'g1',
        null,
        5,
        1,
        false,
        'RESERVED',
        null,
      ]);
      for (const bad of ['audio:g1', 'audio:g1:0', 'audio:g1:x', 'audio:g2:1'])
        await violates(
          q(ins, [
            'c4',
            bad,
            'audio',
            'g1',
            null,
            5,
            1,
            false,
            'RESERVED',
            null,
          ]),
        );
    });

    it('journal: pilot actions are admin-only on pilot targets; earlier actions unchanged', async () => {
      const ins = `INSERT INTO "story_operator_actions" (id,"requestId","actorKind","actorUserId","targetType","targetId",action,reason,"previousState",result)
      VALUES ($1,$2,$3,$4,$5,'x',$6,'Причина действия','{}','{}')`;
      await q(ins, [
        'j1',
        randomUUID(),
        'admin',
        'op',
        'pilot-application',
        'pilot.approve',
      ]);
      await q(ins, [
        'j2',
        randomUUID(),
        'admin',
        'op',
        'pilot-member',
        'pilot.revoke',
      ]);
      await q(ins, [
        'j3',
        randomUUID(),
        'admin',
        'op',
        'pilot-application',
        'pilot.reject',
      ]);
      await violates(
        q(ins, ['j4', null, 'cron', null, 'pilot-member', 'pilot.revoke']),
      );
      await violates(
        q(ins, ['j4', randomUUID(), 'admin', 'op', 'gift', 'pilot.approve']),
      );
      await violates(
        q(ins, [
          'j4',
          randomUUID(),
          'admin',
          'op',
          'pilot-member',
          'gift.close-failed',
        ]),
      );
      await violates(
        q(ins, [
          'j4',
          randomUUID(),
          'admin',
          'op',
          'pilot-member',
          'pilot.invite',
        ]),
      );
      await q(ins, [
        'j5',
        randomUUID(),
        'admin',
        'op',
        'gift',
        'gift.close-failed',
      ]);
      await q(ins, ['j6', null, 'cron', null, 'segment', 'retention.purge']);
      // ST3 retention: the cron erases a decided application's text and a
      // READY clone's source recording; nothing else on those targets.
      await q(ins, [
        'j8',
        null,
        'cron',
        null,
        'pilot-application',
        'retention.purge',
      ]);
      await q(ins, [
        'j9',
        null,
        'cron',
        null,
        'voice-sample',
        'retention.purge',
      ]);
      await violates(
        q(ins, ['j10', null, 'cron', null, 'pilot-member', 'retention.purge']),
      );
      await violates(
        q(ins, [
          'j10',
          randomUUID(),
          'admin',
          'op',
          'voice-sample',
          'gift.close-failed',
        ]),
      );
      await violates(
        q(ins, ['j10', null, 'cron', null, 'voice', 'retention.purge']),
      );
      // ST3-S-02: automatic refunds — cron (14 days) or owner (deletion).
      await q(ins, ['j11', null, 'cron', null, 'gift', 'charge.auto-refund']);
      await q(ins, [
        'j12',
        null,
        'owner',
        null,
        'render',
        'charge.auto-refund',
      ]);
      await violates(
        q(ins, [
          'j13',
          randomUUID(),
          'admin',
          'op',
          'gift',
          'charge.auto-refund',
        ]),
      );
      await violates(
        q(ins, ['j13', null, 'cron', null, 'segment', 'charge.auto-refund']),
      );
      // The journal is kept at most a year: DELETE stays possible.
      await q(`DELETE FROM "story_operator_actions" WHERE id='j9'`);
      await q(ins, [
        'j7',
        null,
        'owner',
        null,
        'segment',
        'owner.recording-delete',
      ]);
      await expect(
        q(
          `UPDATE "story_operator_actions" SET reason='Другая причина' WHERE id='j1'`,
        ),
      ).rejects.toMatchObject({ code: '55000' });
    });

    it('ST3-S-01: revoking a member with a live link + narrator consent clears the whole window', async () => {
      await prisma.user.create({ data: { id: 'u5', telegramId: 't5' } });
      await prisma.storyPilotMember.create({ data: { userId: 'u5' } });
      const now = new Date();
      await prisma.storyGift.create({
        data: {
          id: 'g5',
          userId: 'u5',
          catalogId: 'turnip',
          title: 'Репка',
          text: 'x',
          chapters: [],
          textHash: 'h',
          voiceId: 'a9fc5a41',
          status: 'APPROVED',
          shareHash: '8'.repeat(64),
          sharedAt: now,
          shareExpiresAt: new Date(now.getTime() + 864e5),
          narratorPublicConsentAt: now,
          narratorPublicConsentVersion: 'story-rules-2026-10-20',
          narratorPublicConsentRenderId: 'r5',
        },
      });
      const pilot = new StoryPilotService(prisma as never);
      const out = await pilot.revoke('op', 'u5', { reason: 'Проверка отзыва' });
      expect(out.result).toMatchObject({ revoked: true, linksWithdrawn: 1 });
      expect(
        await prisma.storyGift.findUnique({
          where: { id: 'g5' },
          select: {
            shareHash: true,
            sharedAt: true,
            shareExpiresAt: true,
            narratorPublicConsentAt: true,
            narratorPublicConsentVersion: true,
            narratorPublicConsentRenderId: true,
          },
        }),
      ).toEqual({
        shareHash: null,
        sharedAt: null,
        shareExpiresAt: null,
        narratorPublicConsentAt: null,
        narratorPublicConsentVersion: null,
        narratorPublicConsentRenderId: null,
      });
    });

    it('charges on real rows: refund, a new audio attempt after it, 14-day auto-refund with a journal entry', async () => {
      await prisma.user.create({ data: { id: 'u6', telegramId: 't6' } });
      await prisma.creditLedger.create({
        data: { userId: 'u6', delta: 20, reason: 'ADMIN_ADJUST' },
      });
      await prisma.storyGift.create({
        data: {
          id: 'g6',
          userId: 'u6',
          catalogId: 'turnip',
          title: 'Репка',
          text: 'x',
          chapters: [],
          textHash: 'h',
          voiceId: 'a9fc5a41',
          status: 'UNKNOWN',
        },
      });
      const ledger = new CreditLedgerService(
        prisma as never,
        {
          alert: async () => true,
        } as never,
      );
      const charges = new StoryChargesService(prisma as never, ledger);
      const facts = {
        mode: 'public' as const,
        isOwner: false,
        member: null,
        application: null,
        termsAccepted: true,
        termsEverAccepted: true,
      };
      const step = { kind: 'audio' as const, giftId: 'g6', reserveMicroUsd: 1 };
      await prisma.$transaction((tx) => charges.reserve(tx, facts, 'u6', step));
      expect(await ledger.balanceOf('u6')).toBe(15);
      // A changed price never writes anything (409 STORY_PRICE_CHANGED).
      await expect(
        prisma.$transaction((tx) =>
          charges.reserve(tx, facts, 'u6', { ...step, giftId: 'g6x' }, 4),
        ),
      ).rejects.toMatchObject({ response: { code: 'STORY_PRICE_CHANGED' } });
      expect(await ledger.balanceOf('u6')).toBe(15);
      await charges.refundAudio('g6');
      expect(await ledger.balanceOf('u6')).toBe(20);
      await prisma.$transaction((tx) => charges.reserve(tx, facts, 'u6', step));
      expect(
        (
          await prisma.storyCreditCharge.findMany({
            where: { giftId: 'g6' },
            orderBy: { createdAt: 'asc' },
          })
        ).map((c) => [c.key, c.status]),
      ).toEqual([
        ['audio:g6:1', 'REFUNDED'],
        ['audio:g6:2', 'RESERVED'],
      ]);
      // UNKNOWN for 15 days without an operator: credits back, journaled.
      await prisma.storyCreditCharge.updateMany({
        where: { key: 'audio:g6:2' },
        data: { createdAt: new Date(Date.now() - 15 * 864e5) },
      });
      expect(await charges.autoRefundStale()).toBe(1);
      expect(await ledger.balanceOf('u6')).toBe(20);
      expect(
        await prisma.storyOperatorAction.findFirst({
          where: { targetId: 'g6', action: 'charge.auto-refund' },
          select: { actorKind: true, targetType: true, result: true },
        }),
      ).toEqual({
        actorKind: 'cron',
        targetType: 'gift',
        result: { creditsRefunded: 5 },
      });
    });

    it('правила 9.6: the recording of a READY or a failed/unfinished cloning goes 7 days after the last change, only for Story users, never personas', async () => {
      await prisma.user.create({ data: { id: 'u7', telegramId: 't7' } });
      await prisma.user.create({ data: { id: 'u8', telegramId: 't8' } });
      await prisma.storyTermsAcceptance.create({
        data: {
          userId: 'u7',
          termsVersion: 'story-rules-2026-10-20',
          adult: true,
        },
      });
      const url = (n: string) =>
        `https://x.public.blob.vercel-storage.com/users/u7/voices/${n}.mp3`;
      const voices: Array<
        [string, string, 'READY' | 'FAILED' | 'TRAINING', number]
      > = [
        ['v-ready-old', 'u7', 'READY', 8],
        ['v-failed-old', 'u7', 'FAILED', 8],
        ['v-training-old', 'u7', 'TRAINING', 10],
        ['v-failed-new', 'u7', 'FAILED', 3],
        ['v-other-product', 'u8', 'FAILED', 30],
      ];
      for (const [id, userId, status] of voices)
        await prisma.userVoice.create({
          data: {
            id,
            userId,
            label: id,
            status,
            sampleUrl: url(id),
            consentAt: new Date(),
          },
        });
      for (const [id, , , days] of voices)
        await q(
          `UPDATE "user_voices" SET "updatedAt" = now() - ($2 || ' days')::interval WHERE id = $1`,
          [id, String(days)],
        );
      const saved = process.env.STORY_RETENTION_PURGE_ENABLED;
      process.env.STORY_RETENTION_PURGE_ENABLED = 'true';
      const blob = { deleteBlob: jest.fn(async () => true) };
      try {
        const retention = new StoryRetentionService(
          prisma as never,
          {
            remove: jest.fn(async () => ({ deleted: false, raced: true })),
          } as never,
          blob as never,
        );
        const dry = await retention.run({ dryRun: true, withCandidates: true });
        expect([...dry.candidates!.voiceSamples].sort()).toEqual([
          'v-failed-old',
          'v-ready-old',
          'v-training-old',
        ]);
        await retention.run();
      } finally {
        if (saved === undefined)
          delete process.env.STORY_RETENTION_PURGE_ENABLED;
        else process.env.STORY_RETENTION_PURGE_ENABLED = saved;
      }
      const left = await prisma.userVoice.findMany({
        where: { id: { in: voices.map((v) => v[0]) } },
        select: { id: true, sampleUrl: true },
        orderBy: { id: 'asc' },
      });
      expect(left.map((v) => [v.id, v.sampleUrl === ''])).toEqual([
        ['v-failed-new', false],
        ['v-failed-old', true],
        ['v-other-product', false],
        ['v-ready-old', true],
        ['v-training-old', true],
      ]);
      expect(blob.deleteBlob).toHaveBeenCalledWith(
        'users/u7/voices/v-failed-old.mp3',
      );
      expect(
        await prisma.storyOperatorAction.count({
          where: { targetType: 'voice-sample', action: 'retention.purge' },
        }),
      ).toBe(3);
    });

    it('consent text language is kept with the consent: ru/uk/en only', async () => {
      const giftId = 'g5';
      await q(
        `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd","voiceConsentLocale")
       VALUES ('rl1',$1,'cfg-l1','x','b','h','m','v',0,'uk')`,
        [giftId],
      );
      await violates(
        q(
          `INSERT INTO "story_video_renders" (id,"giftId","configHash","preambleText","baseRevision","baseHash","mainAudioHash","voiceId","reservedMicroUsd","voiceConsentLocale")
         VALUES ('rl2',$1,'cfg-l2','x','b','h','m','v',0,'de')`,
          [giftId],
        ),
      );
      await violates(
        q(
          `INSERT INTO "story_video_segments" (id,"giftId","cacheKey",source,mime,"consentVersion","consentAt","consentLocale") VALUES ('sl1',$1,$2,'recorded','audio/wav','story-preamble-recording-v1',now(),'fr')`,
          [giftId, 'c'.repeat(64)],
        ),
      );
      await q(
        `INSERT INTO "story_video_segments" (id,"giftId","cacheKey",source,mime,"consentVersion","consentAt","consentLocale") VALUES ('sl2',$1,$2,'recorded','audio/wav','story-preamble-recording-v1',now(),'en')`,
        [giftId, 'd'.repeat(64)],
      );
    });

    it('does not refund an UNKNOWN candidate delivered before the refund transaction', async () => {
      await prisma.user.create({
        data: { id: 'refund-race-user', telegramId: 'refund-race-telegram' },
      });
      await prisma.storyGift.create({
        data: {
          id: 'refund-race-gift',
          userId: 'refund-race-user',
          catalogId: 'turnip',
          title: 'Fixture',
          text: 'x',
          chapters: [],
          textHash: 'h',
          voiceId: 'fixture',
          status: 'UNKNOWN',
        },
      });
      await prisma.storyCreditCharge.create({
        data: {
          userId: 'refund-race-user',
          key: 'refund-race-charge',
          kind: 'audio',
          giftId: 'refund-race-gift',
          credits: 0,
          reserveMicroUsd: 1,
          priceMicroUsd: 1,
          createdAt: new Date(Date.now() - 15 * 864e5),
        },
      });
      // Deliver after the sweep selected UNKNOWN but before the transaction begins.
      const racedDb = {
        $queryRaw: prisma.$queryRaw.bind(prisma),
        $transaction: async (
          fn: (tx: Prisma.TransactionClient) => Promise<boolean>,
        ) => {
          await prisma.storyGift.update({
            where: { id: 'refund-race-gift' },
            data: { status: 'READY' },
          });
          return prisma.$transaction(fn);
        },
      };
      const ledger = new CreditLedgerService(
        prisma as never,
        { alert: async () => true } as never,
      );
      const charges = new StoryChargesService(racedDb as never, ledger);
      expect(await charges.autoRefundStale()).toBe(0);
      expect(
        (
          await prisma.storyCreditCharge.findUniqueOrThrow({
            where: { key: 'refund-race-charge' },
          })
        ).status,
      ).toBe('RESERVED');
      expect(
        await prisma.storyOperatorAction.count({
          where: { targetId: 'refund-race-gift', action: 'charge.auto-refund' },
        }),
      ).toBe(0);
      await new StoryChargesService(prisma as never, ledger).captureDelivered();
      expect(
        (
          await prisma.storyCreditCharge.findUniqueOrThrow({
            where: { key: 'refund-race-charge' },
          })
        ).status,
      ).toBe('CAPTURED');
    });

    it('ST3-S-14/R-14: 55 old delivered RESERVED + 1 UNKNOWN — the UNKNOWN is refunded; the sweep captures the delivered', async () => {
      await prisma.user.create({ data: { id: 'u9', telegramId: 't9' } });
      await prisma.creditLedger.create({
        data: { userId: 'u9', delta: 400, reason: 'ADMIN_ADJUST' },
      });
      const old = new Date(Date.now() - 40 * 864e5);
      const gift = (id: string, status: string) => ({
        id,
        userId: 'u9',
        catalogId: 'turnip',
        title: 'Репка',
        text: 'x',
        chapters: [],
        textHash: 'h',
        voiceId: 'a9fc5a41',
        status,
      });
      const paid = Array.from({ length: 55 }, (_, i) => `gp${i}`);
      await prisma.storyGift.createMany({
        data: [
          ...paid.map((id) => gift(id, 'APPROVED')),
          gift('gu', 'UNKNOWN'),
        ],
      });
      const ledger = new CreditLedgerService(
        prisma as never,
        {
          alert: async () => true,
        } as never,
      );
      const charges = new StoryChargesService(prisma as never, ledger);
      const facts = {
        mode: 'public' as const,
        isOwner: false,
        member: null,
        application: null,
        termsAccepted: true,
        termsEverAccepted: true,
      };
      for (const giftId of [...paid, 'gu'])
        await prisma.$transaction((tx) =>
          charges.reserve(tx, facts, 'u9', {
            kind: 'audio',
            giftId,
            reserveMicroUsd: 1,
          }),
        );
      // Rows written before capture existed: all RESERVED, the paid ones older.
      await q(
        `UPDATE "story_credit_charges" SET "createdAt" = $1 WHERE "userId" = 'u9' AND "giftId" <> 'gu'`,
        [old],
      );
      await q(
        `UPDATE "story_credit_charges" SET "createdAt" = now() - interval '15 days' WHERE "giftId" = 'gu'`,
      );
      expect(await ledger.balanceOf('u9')).toBe(400 - 56 * 5);
      // The query selects only UNKNOWN steps: the old paid rows never starve it.
      expect(await charges.autoRefundStale()).toBe(1);
      expect(await ledger.balanceOf('u9')).toBe(400 - 55 * 5);
      expect(
        (await prisma.storyCreditCharge.findFirst({ where: { giftId: 'gu' } }))
          ?.status,
      ).toBe('REFUNDED');
      // The sweep / data fix: delivered steps become CAPTURED, never refunded.
      expect(await charges.captureDelivered()).toBeGreaterThanOrEqual(55);
      const statuses = await prisma.storyCreditCharge.groupBy({
        by: ['status'],
        where: { userId: 'u9' },
        _count: { _all: true },
      });
      expect(
        Object.fromEntries(statuses.map((r) => [r.status, r._count._all])),
      ).toEqual({ CAPTURED: 55, REFUNDED: 1 });
      expect(await charges.autoRefundStale()).toBe(0);
      expect(await ledger.balanceOf('u9')).toBe(400 - 55 * 5);
      // CHECK: CAPTURED has a capture time and no refund time.
      await violates(
        q(
          `UPDATE "story_credit_charges" SET "capturedAt" = NULL WHERE "giftId" = 'gp0'`,
        ),
      );
      await violates(
        q(
          `UPDATE "story_credit_charges" SET "refundedAt" = now() WHERE "giftId" = 'gp0'`,
        ),
      );
    });

    it('the Prisma client reads and writes the new models (schema ↔ migration)', async () => {
      await prisma.user.create({ data: { id: 'u3', telegramId: 't3' } });
      const app = await prisma.storyPilotApplication.create({
        data: { userId: 'u3', scenario: 'Для бабушки' },
      });
      expect(app.status).toBe('pending');
      const member = await prisma.storyPilotMember.create({
        data: { userId: 'u3', applicationId: app.id },
      });
      expect(member.revokedAt).toBeNull();
      await prisma.storyTermsAcceptance.create({
        data: {
          userId: 'u3',
          termsVersion: 'story-rules-2026-10-20',
          adult: true,
        },
      });
      const charge = await prisma.storyCreditCharge.create({
        data: {
          userId: 'u3',
          key: 'audio:g3:1',
          kind: 'audio',
          giftId: 'g3',
          credits: 5,
          reserveMicroUsd: 120000,
          priceMicroUsd: 2990000,
        },
      });
      expect(charge).toMatchObject({ status: 'RESERVED', free: false });
      const gift = await prisma.storyGift.create({
        data: {
          userId: 'u3',
          catalogId: 'turnip',
          title: 'Репка',
          text: 'x',
          chapters: [],
          textHash: 'h',
          voiceId: 'a9fc5a41',
          status: 'APPROVED',
          shareHash: '9'.repeat(64),
          sharedAt: new Date(),
          shareExpiresAt: new Date(Date.now() + 86_400_000),
        },
        select: { shareExpiresAt: true },
      });
      expect(gift.shareExpiresAt).toBeInstanceOf(Date);
      const found = await prisma.user.findUnique({
        where: { id: 'u3' },
        select: {
          storyPilotMember: true,
          storyPilotApplication: true,
          storyTermsAcceptances: true,
          storyCreditCharges: true,
        },
      });
      expect(found?.storyPilotMember?.id).toBe(member.id);
      expect(found?.storyCreditCharges).toHaveLength(1);
      // Account deletion cascades to the pilot rows.
      await prisma.storyGift.deleteMany({ where: { userId: 'u3' } });
      await prisma.user.delete({ where: { id: 'u3' } });
      expect(
        await prisma.storyPilotMember.count({ where: { userId: 'u3' } }),
      ).toBe(0);
    });
  },
);
