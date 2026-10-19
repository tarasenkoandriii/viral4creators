import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { AccountMembership } from '../site-core/account/roles';
import { QaCatalogService } from './qa-catalog.service';
import { QaFindingService } from './qa-finding.service';
import { QaArtifactService, QaArtifactStorage } from './qa-artifact.service';
import {
  QA_TEST_PNG,
  QA_TEST_METADATA_PNG,
} from './qa-artifact-fixture.testing';
import { FakeArtifactStorage } from '../browser-jobs/testing/fake-artifact-storage.testing';
const ciDescribe = process.env.CI === 'true' ? describe : describe.skip;
ciDescribe(
  'QA artifacts on isolated Postgres and private storage adapter',
  () => {
    let prisma: PrismaService,
      db: SitesDb,
      api: QaArtifactService,
      catalog: QaCatalogService,
      storage: FakeArtifactStorage,
      account: string,
      site: string,
      finding: string;
    const member = (id = account, qa = 'admin') =>
      ({
        accountId: id,
        memberId: 'qa-test',
        role: 'operator',
        productRoles: { qa, assist: 'none', assistAdmin: 'none' },
      }) as AccountMembership;
    const upload = (bytes = QA_TEST_PNG) => ({
      requestId: randomUUID(),
      contentType: 'image/png',
      contentBase64: bytes.toString('base64'),
      redacted: true,
    });
    beforeAll(async () => {
      const url = new URL(process.env.SITES_DATABASE_URL ?? 'http://invalid');
      if (url.hostname !== 'localhost' || url.pathname !== '/sites')
        throw new Error('isolated localhost/sites only');
      prisma = new PrismaService();
      db = new SitesDb(prisma);
      catalog = new QaCatalogService(db);
      storage = new FakeArtifactStorage();
      api = new QaArtifactService(catalog, db, storage as QaArtifactStorage);
      account = (
        await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
      ).id;
      site = (
        await db
          .forAccount(account)
          .site.create({ data: { accountId: account, name: 'QA artifacts' } })
      ).id;
      finding = (
        await new QaFindingService(catalog).create(member(), site, {
          title: 'Synthetic artifact check',
          category: 'logic',
          severity: 'P3',
          status: 'not_reproduced',
          url: 'https://example.com/',
          context: 'test',
          steps: 'test',
          expected: 'test',
          actual: 'test',
          impact: 'test',
          evidence: [],
          deployedSha: null,
          observedAt: '2026-10-10T00:00:00Z',
          verification: null,
        })
      ).id;
    }, 30000);
    afterAll(async () => {
      if (prisma) {
        await prisma.qaArtifact.deleteMany({ where: { accountId: account } });
        await prisma.siteAccount.deleteMany({ where: { id: account } });
        await prisma.$disconnect();
      }
    });
    it('stores clean bytes privately and replays without another upload', async () => {
      const body = upload(QA_TEST_METADATA_PNG),
        result = await api.upload(member(), site, finding, body);
      expect(result.findingRevision).toBe(1);
      expect(result.bytes).toBe(QA_TEST_PNG.length);
      expect(result).not.toHaveProperty('pathname');
      expect(result).not.toHaveProperty('url');
      const row = await prisma.qaArtifact.findFirstOrThrow({
        where: { id: result.id, accountId: account },
      });
      expect(row.pathname).toMatch(/^qa-evidence\//);
      expect(storage.files.get(row.pathname)?.body).toEqual(QA_TEST_PNG);
      expect((await api.upload(member(), site, finding, body)).replayed).toBe(
        true,
      );
      expect(
        (await api.list(member(), site, finding)).items.filter(
          (x) => x.id === result.id,
        ),
      ).toHaveLength(1);
      const link = await api.download(
        member(account, 'viewer'),
        site,
        finding,
        result.id,
      );
      expect(link.validUntil.getTime()).toBeLessThanOrEqual(
        Date.now() + 300000,
      );
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(
        Date.now() + 29 * 86400000,
      );
    });
    it('denies viewer writes, missing QA permission and foreign site access before storage', async () => {
      const put = jest.spyOn(storage, 'put');
      await expect(
        api.upload(member(account, 'viewer'), site, finding, upload()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        api.list(member(account, 'none'), site, finding),
      ).rejects.toMatchObject({ status: 403 });
      const other = (
        await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
      ).id;
      await expect(
        api.list(member(other), site, finding),
      ).rejects.toMatchObject({ status: 404 });
      await prisma.siteAccount.delete({ where: { id: other } });
      expect(put).not.toHaveBeenCalled();
      put.mockRestore();
    });
    it('serializes concurrent reservations: one request cannot create duplicate blobs', async () => {
      const body = upload();
      const results = await Promise.allSettled([
        api.upload(member(), site, finding, body),
        api.upload(member(), site, finding, body),
      ]);
      expect(results.some((x) => x.status === 'fulfilled')).toBe(true);
      expect(
        await prisma.qaArtifact.count({
          where: {
            accountId: account,
            siteId: site,
            requestId: body.requestId,
          },
        }),
      ).toBe(1);
      const changed = Buffer.from(QA_TEST_PNG);
      changed[0] = 0;
      await expect(
        api.upload(member(), site, finding, {
          ...body,
          contentBase64: changed.toString('base64'),
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
    it('preserves expired metadata for retry when blob deletion fails, and hides expired reads', async () => {
      const a = await api.upload(member(), site, finding, upload());
      await prisma.qaArtifact.update({
        where: { id: a.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await expect(
        api.download(member(), site, finding, a.id),
      ).rejects.toMatchObject({ status: 404 });
      const fail = jest
        .spyOn(storage, 'remove')
        .mockRejectedValueOnce(new Error('offline'));
      await expect(api.retain()).rejects.toMatchObject({ status: 503 });
      expect(await prisma.qaArtifact.count({ where: { id: a.id } })).toBe(1);
      fail.mockRestore();
      expect((await api.retain()).removed).toBe(1);
      expect(await prisma.qaArtifact.count({ where: { id: a.id } })).toBe(0);
    });
    it('keeps a pending reservation when upload and compensation fail', async () => {
      const body = upload();
      const put = jest
        .spyOn(storage, 'put')
        .mockRejectedValueOnce(new Error('offline'));
      const remove = jest
        .spyOn(storage, 'remove')
        .mockRejectedValueOnce(new Error('offline'));
      await expect(
        api.upload(member(), site, finding, body),
      ).rejects.toMatchObject({ status: 503 });
      const row = await prisma.qaArtifact.findFirstOrThrow({
        where: { accountId: account, requestId: body.requestId },
      });
      expect(row.state).toBe('pending');
      await expect(
        api.upload(member(), site, finding, body),
      ).rejects.toMatchObject({ status: 409 });
      put.mockRestore();
      remove.mockRestore();
      await prisma.qaArtifact.update({
        where: { id: row.id },
        data: { expiresAt: new Date(0) },
      });
      await api.retain();
      expect(await prisma.qaArtifact.count({ where: { id: row.id } })).toBe(0);
    });
    it('enforces compound tenant foreign keys even outside the service', async () => {
      const other = (
        await prisma.siteAccount.create({ data: { verifyToken: randomUUID() } })
      ).id;
      await expect(
        prisma.qaArtifact.create({
          data: {
            id: randomUUID(),
            accountId: other,
            siteId: site,
            findingId: finding,
            findingRevision: 1,
            requestId: randomUUID(),
            pathname: 'qa-evidence/foreign.png',
            sha256: 'a'.repeat(64),
            bytes: 1,
            expiresAt: new Date(),
            createdByMemberId: 'test',
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await prisma.siteAccount.delete({ where: { id: other } });
    });
  },
);
