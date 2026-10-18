import { TutorialApprovalProbeService } from './tutorial-approval-probe.service';
import type { BlobService } from '../storage/blob.service';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { TutorialVideoAdminService } from './tutorial-video-admin.service';
import type { PrismaService } from '../../prisma/prisma.service';
/** Real SQL trigger regression; isolated schema, never production records. */
import { Client } from 'pg';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
const dbUrl =
  process.env.TUTORIAL_APPROVAL_PG_URL ??
  (process.env.CI === 'true' ? process.env.DATABASE_URL : undefined);
if (!dbUrl && process.env.CI === 'true')
  throw new Error('Tutorial approval PostgreSQL test requires DATABASE_URL');
const db = dbUrl ? describe : describe.skip;
db('exact Tutorial approval on PostgreSQL', () => {
  const schema = `tutorial_approval_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const approval = {
    schema: 1,
    blobUrl: 'https://blob/video.mp4',
    versionId: 'v1',
    sha256: 'a'.repeat(64),
    provenanceSha256: 'b'.repeat(64),
    approvedBy: 'operator',
  };
  beforeAll(async () => {
    client = new Client({ connectionString: dbUrl });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}"; CREATE TABLE "tutorial_video_assets" (
      id text PRIMARY KEY, "blobUrl" text, "activeVersionId" text, "tempoManifest" jsonb, "contentHash" text,
      "assemblyStatus" text DEFAULT 'complete', reviewed boolean DEFAULT false, title text);
      INSERT INTO "tutorial_video_assets" (id,"blobUrl",reviewed) VALUES ('legacy','https://blob/accepted.mp4',true);`);
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../../prisma/migrations/20270124170000_tutorial_exact_approval/migration.sql',
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
  beforeEach(async () => {
    await client.query(
      `DELETE FROM "tutorial_video_assets" WHERE id='test'; INSERT INTO "tutorial_video_assets" (id,"blobUrl","activeVersionId") VALUES ('test','https://blob/video.mp4','v1')`,
    );
  });
  const approve = (snapshot = approval) =>
    client.query(
      `UPDATE "tutorial_video_assets" SET reviewed=true,"reviewApproval"=$1 WHERE id='test'`,
      [snapshot],
    );
  it('preserves legacy accepted file and status without inventing its byte hash', async () => {
    const { rows } = await client.query(
      `SELECT * FROM "tutorial_video_assets" WHERE id='legacy'`,
    );
    expect(rows[0]).toMatchObject({
      reviewed: true,
      blobUrl: 'https://blob/accepted.mp4',
      reviewApproval: null,
    });
  });
  it('rejects missing proof, wrong file/version and malformed hashes', async () => {
    await expect(
      client.query(
        `UPDATE "tutorial_video_assets" SET reviewed=true WHERE id='test'`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    for (const patch of [
      { blobUrl: 'other' },
      { versionId: 'v2' },
      { sha256: 'invalid' },
      { provenanceSha256: '' },
      { approvedBy: '' },
    ]) {
      await expect(approve({ ...approval, ...patch })).rejects.toMatchObject({
        code: '23514',
      });
    }
  });
  it('retains proof on unrelated edits and clears it on revocation', async () => {
    await approve();
    await client.query(
      `UPDATE "tutorial_video_assets" SET title='Renamed' WHERE id='test'`,
    );
    expect(
      (
        await client.query(
          `SELECT reviewed FROM "tutorial_video_assets" WHERE id='test'`,
        )
      ).rows[0].reviewed,
    ).toBe(true);
    await client.query(
      `UPDATE "tutorial_video_assets" SET reviewed=false WHERE id='test'`,
    );
    expect(
      (
        await client.query(
          `SELECT "reviewApproval" FROM "tutorial_video_assets" WHERE id='test'`,
        )
      ).rows[0].reviewApproval,
    ).toBeNull();
  });
  it('invalidates review on file, version, manifest, input hash or assembly replacement', async () => {
    for (const [field, value] of [
      ['blobUrl', 'other'],
      ['activeVersionId', 'v2'],
      ['tempoManifest', '{"voice":"other"}'],
      ['contentHash', 'changed'],
      ['assemblyStatus', 'pending'],
    ]) {
      await client.query(
        `DELETE FROM "tutorial_video_assets" WHERE id='test'; INSERT INTO "tutorial_video_assets" (id,"blobUrl","activeVersionId") VALUES ('test','https://blob/video.mp4','v1')`,
      );
      await approve();
      await client.query(
        `UPDATE "tutorial_video_assets" SET "${field}"=$1,reviewed=true WHERE id='test'`,
        [value],
      );
      const { rows } = await client.query(
        `SELECT reviewed,"reviewApproval" FROM "tutorial_video_assets" WHERE id='test'`,
      );
      expect(rows[0]).toEqual({ reviewed: false, reviewApproval: null });
    }
  });
  it('invalidates legacy approval on replacement too', async () => {
    await client.query(
      `UPDATE "tutorial_video_assets" SET "blobUrl"='https://blob/new.mp4' WHERE id='legacy'`,
    );
    expect(
      (
        await client.query(
          `SELECT reviewed FROM "tutorial_video_assets" WHERE id='legacy'`,
        )
      ).rows[0].reviewed,
    ).toBe(false);
  });
  it('rejects stale compare-and-set after a concurrent replacement', async () => {
    await client.query(
      `UPDATE "tutorial_video_assets" SET "activeVersionId"='v2' WHERE id='test'`,
    );
    const result = await client.query(
      `UPDATE "tutorial_video_assets" SET reviewed=true,"reviewApproval"=$1 WHERE id='test' AND "activeVersionId"='v1'`,
      [approval],
    );
    expect(result.rowCount).toBe(0);
  });
  it('binds actual Prisma row bytes and refuses a replacement during download', async () => {
    const prisma = new PrismaClient({ adapter: new PrismaPg(dbUrl!) });
    const id = `approval-${randomUUID()}`;
    const url =
      'https://qa.public.blob.vercel-storage.com/tutorial-videos/exact.mp4';
    let fetchMock: jest.SpyInstance | undefined;
    try {
      await prisma.tutorialVideoAsset.create({
        data: {
          id,
          subjectKey: 'qa',
          locale: 'ru',
          title: 'Approval regression',
          blobUrl: url,
          assemblyStatus: 'complete',
        },
      });
      const service = new TutorialVideoAdminService(
        prisma as unknown as PrismaService,
      );
      fetchMock = jest
        .spyOn(global, 'fetch')
        .mockImplementation(async () => new Response('exact test bytes'));
      const approved = await service.setReviewed(
        id,
        true,
        { expectedBlobUrl: url, expectedVersionId: null },
        'qa-operator',
      );
      expect(approved.reviewed).toBe(true);
      expect(approved.reviewApproval).toMatchObject({
        schema: 1,
        blobUrl: url,
        versionId: null,
        approvedBy: 'qa-operator',
      });
      await prisma.tutorialVideoAsset.update({
        where: { id },
        data: { blobUrl: `${url}?v=2` },
      });
      expect(
        (await prisma.tutorialVideoAsset.findUniqueOrThrow({ where: { id } }))
          .reviewed,
      ).toBe(false);
      fetchMock.mockImplementationOnce(async () => {
        await prisma.tutorialVideoAsset.update({
          where: { id },
          data: { activeVersionId: 'concurrent-version' },
        });
        return new Response('exact test bytes');
      });
      await expect(
        service.setReviewed(
          id,
          true,
          { expectedBlobUrl: `${url}?v=2`, expectedVersionId: null },
          'qa-operator',
        ),
      ).rejects.toThrow(/приёмка отменена/);
      const final = await prisma.tutorialVideoAsset.findUniqueOrThrow({
        where: { id },
      });
      expect(final.reviewed).toBe(false);
      expect(final.reviewApproval).toBeNull();
    } finally {
      fetchMock?.mockRestore();
      await prisma.tutorialVideoAsset.deleteMany({ where: { id } });
      await prisma.$disconnect();
    }
  });
  function probeRig() {
    const prisma = new PrismaClient({ adapter: new PrismaPg(dbUrl!) });
    const buffers = new Map<string, Buffer>();
    const blob = {
      uploadBuffer: jest.fn(async (path: string, bytes: Buffer) => {
        const url = `https://qa.public.blob.vercel-storage.com/${path}`;
        buffers.set(url, bytes);
        return { url };
      }),
      deleteMany: jest.fn(async (_paths: string[]) => 2),
    };
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async (url) => new Response(new Uint8Array(buffers.get(String(url))!)),
      );
    const service = new TutorialApprovalProbeService(
      prisma as unknown as PrismaService,
      blob as unknown as BlobService,
    );
    return { prisma, blob, fetchMock, service };
  }
  it('runs the live probe using the real service and rolls back all synthetic rows', async () => {
    const { prisma, blob, fetchMock, service } = probeRig();
    try {
      const report = await service.run('qa-operator');
      expect(report).toMatchObject({
        ok: true,
        rolledBack: true,
        blobsRemoved: true,
      });
      expect(report.checks).toHaveLength(9);
      expect(report.sha256.first).not.toBe(report.sha256.replacement);
      expect(
        await prisma.tutorialVideoAsset.count({ where: { id: report.runId } }),
      ).toBe(0);
      expect(blob.uploadBuffer).toHaveBeenCalledTimes(2);
      expect(blob.deleteMany).toHaveBeenCalledTimes(1);
      expect(blob.deleteMany.mock.calls[0][0]).toEqual(
        blob.uploadBuffer.mock.calls.map(([path]) => path),
      );
    } finally {
      fetchMock.mockRestore();
      await prisma.$disconnect();
    }
  });
  it('rolls back and cleans up on an actual byte hash mismatch', async () => {
    const { prisma, blob, fetchMock, service } = probeRig();
    fetchMock.mockImplementation(async () => new Response('wrong bytes'));
    try {
      await expect(service.run('qa-operator')).rejects.toThrow(
        /exact-file-version-sha/,
      );
      const id = blob.uploadBuffer.mock.calls[0][0].split('/')[1];
      expect(await prisma.tutorialVideoAsset.count({ where: { id } })).toBe(0);
      expect(blob.deleteMany).toHaveBeenCalledTimes(1);
    } finally {
      fetchMock.mockRestore();
      await prisma.$disconnect();
    }
  });
  it('does not report PASS when temporary Blob cleanup fails', async () => {
    const { prisma, blob, fetchMock, service } = probeRig();
    blob.deleteMany.mockResolvedValue(0);
    try {
      await expect(service.run('qa-operator')).rejects.toThrow(
        /synthetic-blobs-removed/,
      );
    } finally {
      fetchMock.mockRestore();
      await prisma.$disconnect();
    }
  });
});
