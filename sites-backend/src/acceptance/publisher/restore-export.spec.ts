/**
 * AI Publisher — приёмка P-E: контакты не покидают защищённый контур в
 * резервной копии (AT-CORE-09, часть P-E; сквозной поиск ПД — этап Z).
 * Документ копии даже ПОСЛЕ расшифровки содержит контакты, текст задачи и
 * заметки только шифротекстом; байты в хранилище — шифр целиком.
 */
import { ciDescribe, testPrisma } from '../../prisma/ci-describe.testing';
import { PubDb, connectOwner } from '../../prisma/publisher-schema.testing';
import type { PrismaService } from '../../prisma/prisma.service';
import { SitesDb } from '../../prisma/sites-db.service';
import { BackupService } from '../../modules/publisher/reports/backup.service';
import { MemoryBackupStorage } from '../../modules/publisher/reports/testing/memory-backup-storage.testing';
import {
  TD10_SECRET,
  seedTd10,
} from '../../modules/publisher/reports/testing/td10.testing';

ciDescribe(
  '[AT-CORE-09] Резервная копия: синтетический контакт — только в шифротексте',
  () => {
    let prisma: PrismaService;
    let owner: Awaited<ReturnType<typeof connectOwner>>;
    const saved = process.env.ASSIST_SECRETS_KEY;

    beforeAll(async () => {
      process.env.ASSIST_SECRETS_KEY = TD10_SECRET;
      prisma = testPrisma();
      owner = await connectOwner();
    });
    afterAll(async () => {
      if (saved === undefined) delete process.env.ASSIST_SECRETS_KEY;
      else process.env.ASSIST_SECRETS_KEY = saved;
      await owner?.end();
      await prisma?.$disconnect();
    });

    it('ни в байтах копии, ни в расшифрованном документе нет контакта, имени, задачи и текста заметок открытым текстом', async () => {
      const db = new SitesDb(prisma);
      const mem = new MemoryBackupStorage();
      const backup = new BackupService(db, mem);
      const td = await seedTd10(new PubDb(owner));
      const product = { id: td.w.productId, accountId: td.w.accountId };
      const prepared = await backup.prepare(product, new Date());
      await db
        .forAccount(product.accountId)
        .$transaction((tx) =>
          backup.insertRow(
            tx,
            product,
            prepared,
            'manual',
            'member:m1',
            new Date(),
          ),
        );
      const row = await prisma.pubBackup.findUniqueOrThrow({
        where: { id: prepared.id },
      });
      const bytes = [...mem.blobs.values()][0];
      const doc = await backup.load(row);
      const text = JSON.stringify(doc);
      for (const secret of [
        td.contact1.contact,
        td.contact1.name,
        td.contact1.task,
        'second.td10@example.com',
        'Нотатка про проспект',
        'Підтвердив інтерес',
      ]) {
        expect([secret, bytes.includes(Buffer.from(secret))]).toEqual([
          secret,
          false,
        ]);
        expect([secret, text.includes(secret)]).toEqual([secret, false]);
      }
      const contact = doc.tables.pub_lead_contacts.find(
        (c) => c.leadId === td.ids.lead1,
      );
      expect(contact?.contactEnc).toMatch(/^v1\./);
      // Путь blob в базе — шифротекст, не путь.
      expect(row.blobPathEnc).not.toMatch(/publisher\//);
      // Служебные очереди с id получателей в копию не входят.
      expect(doc.tables.pub_notifications).toBeUndefined();
      expect(doc.tables.pub_lead_outbox).toBeUndefined();
    }, 120_000);
  },
);
