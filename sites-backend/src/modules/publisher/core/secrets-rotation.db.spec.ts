/**
 * Ротация `ASSIST_SECRETS_KEY` для Publisher (P-A1 ↔ `common/secrets-
 * rotation.ts`; проектный документ §5.4, §6.5, §15.4): контакт заявителя
 * (+ matchHash и keyVersion одним UPDATE), заметки проспекта и решения по
 * заявке перешифровываются; живые копии — только считаются (`remaining`),
 * пока не истёк `rotationUntil`.
 */
import { randomInt, randomUUID } from 'crypto';
import {
  rotateAssistSecrets,
  type RotationDb,
} from '../../../common/secrets-rotation';
import { ciDescribe } from '../../../prisma/ci-describe.testing';
import {
  seedAccount,
  seedProduct,
  type SeededAccount,
  type SeededProduct,
} from '../testing/fixtures.testing';
import {
  contactMatchHash,
  openContact,
  openNote,
  publisherKeys,
  sealBackupPath,
  sealContact,
  sealNote,
  type ContactPayload,
} from './contact-crypto';
import { addKyivCalendarDays } from './kyiv-time';
import { coreStack, type CoreStack } from './testing/core-stack.testing';

jest.setTimeout(60_000);

const V1 = { ASSIST_SECRETS_KEY: 'rot-pub-k1' };
const V2 = {
  ASSIST_SECRETS_KEY: 'rot-pub-k2',
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: 'v1:rot-pub-k1',
};
const ONLY_V2 = {
  ASSIST_SECRETS_KEY: 'rot-pub-k2',
  ASSIST_SECRETS_KEY_VERSION: 'v2',
};
const CONTACT: ContactPayload = {
  name: 'Синтетичний Заявник',
  contactMethod: 'email',
  contact: 'synthetic.lead@example.test',
  business: 'Тест',
  task: 'Тестова задача',
  selfReported: null,
};

ciDescribe('Publisher P-A1: secrets:rotate — контакты, заметки, копии', () => {
  let s: CoreStack;
  let acc: SeededAccount;
  let p: SeededProduct;
  let leadId: string;
  let prospectId: string;
  let decisionId: string;

  beforeAll(async () => {
    s = await coreStack();
    acc = await seedAccount(s.prisma);
    p = await seedProduct(s.prisma, {
      accountId: acc.accountId,
      siteId: acc.siteId,
      kind: 'test',
      mode: 'test',
    });
    const lead = await s.prisma.pubLead.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        submissionKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        publicRef: `L-${Array.from({ length: 10 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[randomInt(32)]).join('')}`,
        status: 'new',
        testFlag: true,
        testReason: 'test_product',
        contactMethod: 'email',
        consentState: 'not_required',
        receivedAt: new Date(),
        reviewDueAt: addKyivCalendarDays(new Date(), 90),
        createdBy: 'public',
      },
    });
    leadId = lead.id;
    const ck = publisherKeys('leadContact', V1)!;
    const sealed = sealContact(CONTACT, leadId, ck);
    await s.prisma.pubLeadContact.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        leadId,
        contactEnc: sealed.enc,
        matchHash: contactMatchHash(
          p.id,
          'email',
          CONTACT.contact,
          publisherKeys('contactMatch', V1)!,
        ),
        keyVersion: sealed.keyVersion,
        createdBy: 'public',
      },
    });
    const prospect = await s.prisma.pubProspect.create({
      data: {
        accountId: acc.accountId,
        productId: p.id,
        code: 'P-0001',
        isExternal: true,
        isTeamOrPartner: false,
        createdBy: 'system:test',
      },
    });
    prospectId = prospect.id;
    await s.prisma.pubProspect.update({
      where: { id: prospectId },
      data: {
        noteEnc: sealNote(
          'Передзвонити у вівторок',
          prospectId,
          publisherKeys('leadNotes', V1)!,
        ).enc,
      },
    });
    // заметка решения: AAD — id решения (перешифровка разрешена P-A0)
    decisionId = `dec-${randomUUID()}`;
    await s.prisma.pubLeadDecision.create({
      data: {
        id: decisionId,
        accountId: acc.accountId,
        productId: p.id,
        leadId,
        fromStatus: 'contacted',
        toStatus: 'rejected',
        reasonCode: 'other',
        noteEnc: sealNote(
          'Не наш профіль',
          decisionId,
          publisherKeys('leadNotes', V1)!,
        ).enc,
        decidedBy: `member:${acc.owner.memberId}`,
        createdBy: `member:${acc.owner.memberId}`,
      },
    });
    const backupId = `bk_${randomUUID()}`;
    await s.prisma.pubBackup.create({
      data: {
        id: backupId,
        accountId: acc.accountId,
        productId: p.id,
        kind: 'manual',
        blobPathEnc: sealBackupPath(
          'publisher/x.enc',
          backupId,
          publisherKeys('backup', V1)!,
        ).enc,
        sha256: 'b'.repeat(64),
        sizeBytes: 10,
        tableCounts: {},
        keyVersion: 'v1',
        rotationUntil: addKyivCalendarDays(new Date(), 90),
        status: 'ok',
        createdBy: `member:${acc.owner.memberId}`,
      },
    });
  });
  afterAll(async () => {
    await s.close();
  });

  const db = () => s.prisma as unknown as RotationDb;
  const scope = () => ({ accountIds: [acc.accountId] });

  it('dry-run: видит контакт и заметку v1, считает заметку решения и копию; ничего не пишет', async () => {
    const r = await rotateAssistSecrets(db(), {
      apply: false,
      env: V2,
      scope: scope(),
    });
    expect(r.publisherContacts).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
      failed: 0,
    });
    expect(r.publisherProspectNotes).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    expect(r.publisherDecisionNotes).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    expect(r.publisherBackups).toEqual({ v1: 1 });
    expect(r.remaining).toBe(4);
    const row = await s.prisma.pubLeadContact.findFirst({ where: { leadId } });
    expect(row!.keyVersion).toBe('v1');
  });

  it('apply: контакт → v2 (шифр, matchHash текущим ключом, keyVersion), заметка проспекта → v2; повтор — без записи', async () => {
    const r = await rotateAssistSecrets(db(), {
      apply: true,
      env: V2,
      scope: scope(),
    });
    expect(r.publisherContacts).toMatchObject({
      rewritten: 1,
      failed: 0,
      raced: 0,
    });
    expect(r.publisherProspectNotes).toMatchObject({ rewritten: 1 });
    expect(r.publisherDecisionNotes).toMatchObject({ rewritten: 1, failed: 0 });
    // осталась только живая копия v1 (её ключ держится до rotationUntil)
    expect(r.remaining).toBe(1);
    const dec = await s.prisma.pubLeadDecision.findFirst({
      where: { id: decisionId },
    });
    expect(dec!.noteEnc!.startsWith('v2.')).toBe(true);
    expect(
      openNote(dec!.noteEnc, decisionId, publisherKeys('leadNotes', ONLY_V2)!)
        ?.value,
    ).toBe('Не наш профіль');
    const row = await s.prisma.pubLeadContact.findFirst({ where: { leadId } });
    expect(row!.keyVersion).toBe('v2');
    expect(row!.contactEnc.startsWith('v2.')).toBe(true);
    // новый ключ без прежнего читает контакт и совпадает matchHash
    expect(
      openContact(
        row!.contactEnc,
        leadId,
        publisherKeys('leadContact', ONLY_V2)!,
      )?.value,
    ).toEqual(CONTACT);
    expect(row!.matchHash).toBe(
      contactMatchHash(
        p.id,
        'email',
        CONTACT.contact,
        publisherKeys('contactMatch', ONLY_V2)!,
      ),
    );
    const pr = await s.prisma.pubProspect.findFirst({
      where: { id: prospectId },
    });
    expect(
      openNote(pr!.noteEnc, prospectId, publisherKeys('leadNotes', ONLY_V2)!)
        ?.value,
    ).toBe('Передзвонити у вівторок');
    const again = await rotateAssistSecrets(db(), {
      apply: true,
      env: V2,
      scope: scope(),
    });
    expect(again.publisherContacts).toMatchObject({ current: 1, rewritten: 0 });
    expect(again.publisherProspectNotes).toMatchObject({
      current: 1,
      rewritten: 0,
    });
  });

  it('без прежнего ключа старые строки — failed (не трогаются), контакт v2 — current', async () => {
    const r = await rotateAssistSecrets(db(), {
      apply: false,
      env: ONLY_V2,
      scope: scope(),
    });
    expect(r.publisherContacts).toMatchObject({ current: 1, failed: 0 });
    expect(r.configProblem).toBeNull();
  });
});
