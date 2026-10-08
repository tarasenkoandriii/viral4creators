/**
 * Перешифровка `ASSIST_SECRETS_KEY` (№60, Р-З10-12) на реальной базе:
 * dry-run ничего не пишет, `--apply` переводит строки прежней версии в
 * текущую (их читает новый ключ без прежнего), повтор — идемпотентен,
 * непрочитанное не трогается, гонка с сервисом не затирает его запись.
 * Строки «до №60» — замороженной копией прежнего шифра (ключ K1).
 */
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'crypto';
import { describeDb } from '../modules/assist-sandbox/testing/k3-stack.testing';
import { setPlan } from '../modules/assist-billing/testing/billing-fixtures.testing';
import { openPaymentToken } from '../modules/assist-billing/billing-env';
import {
  decryptLeadFields,
  leadKey,
} from '../modules/assist-site-chat/lead-crypto';
import {
  ChatStack,
  type ChatSite,
} from '../modules/assist-site-chat/testing/chat-stack.testing';
import { decryptIdentity } from '../modules/assist-site-handoff/public/identity-crypto';
import { encryptLeadFields } from '../modules/assist-site-chat/lead-crypto';
import {
  decryptSecret,
  integrationsKey,
} from '../modules/assist-analytics/integrations.service';
import {
  decryptIdentity as decryptLeadIdentity,
  identityKey,
} from '../modules/assist-analytics/public/identity-crypto';
import {
  loadAdminKeyring,
  openAdminSecret,
  sealAdminSecret,
  type AdminSecretAad,
} from '../modules/assist-admin-mode/admin-secrets-crypto';
import { IDENTITY_SECRET_OWNER } from '../modules/assist-admin-mode/admin-mode.service';
import { rotateAssistSecrets, type RotationDb } from './secrets-rotation';

jest.setTimeout(60_000);

const K1 = 'rotation-legacy-k1';
const K2 = 'rotation-new-k2';
const ROTATED = {
  ASSIST_SECRETS_KEY: K2,
  ASSIST_SECRETS_KEY_VERSION: 'v2',
  ASSIST_SECRETS_KEYS_OLD: `v1:${K1}`,
};
const ONLY_K2 = { ASSIST_SECRETS_KEY: K2, ASSIST_SECRETS_KEY_VERSION: 'v2' };

/** Замороженный шифр до №60: поля лида / identify передачи (ключ лида). */
function legacyGcm(plain: unknown, aad: string, secret: string): string {
  const key = createHmac('sha256', secret)
    .update('assist-site-lead-fields-v1')
    .digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([
    c.update(JSON.stringify(plain), 'utf8'),
    c.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/** Замороженный шифр до №60 с произвольной меткой (identify лида, интеграции). */
function legacyLabeled(
  plain: string,
  aad: string,
  secret: string,
  label: string,
): string {
  const key = createHmac('sha256', secret).update(label).digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    c.getAuthTag().toString('base64url'),
    enc.toString('base64url'),
  ].join('.');
}

/** Замороженный token-crypto + billing-env до №60. */
function legacyRecToken(plain: string, secret: string): string {
  const key = createHmac('sha256', secret)
    .update('assist-payment-token-v1')
    .digest();
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [
    iv.toString('base64'),
    c.getAuthTag().toString('base64'),
    ct.toString('base64'),
  ].join('.');
}

describeDb('rotateAssistSecrets — перешифровка ASSIST_SECRETS_KEY', () => {
  const st = new ChatStack();
  let s: ChatSite;
  const ids = { lead: '', bad: '', fresh: '', handoff: '', connector: '' };
  /** AAD секретов «Админки» этой строки (как admin-mode/connectors.service). */
  const adminCtx = (
    ownerId: string,
    purpose: AdminSecretAad['purpose'],
  ): AdminSecretAad => ({
    accountId: s.accountId,
    siteId: s.siteId,
    ownerId,
    purpose,
  });
  const fields = { name: 'Олена', phone: '+380501234567' };
  const identity = {
    name: 'Ivan',
    email: 'i@example.com',
    externalId: 'u-1',
    userHash: null,
  };
  const db = () => st.owner as unknown as RotationDb;
  const scope = () => ({ accountIds: [s.accountId] });

  beforeAll(async () => {
    await st.init();
    s = await st.site();
    const p = st.owner;
    const lead = async (id: string, fieldsEnc: string) => {
      await p.assistSiteLead.create({
        data: {
          id,
          accountId: s.accountId,
          siteId: s.siteId,
          fieldsEnc,
          consentText: 'c',
          consentAt: new Date(),
        },
      });
      return id;
    };
    ids.lead = await lead(`l_${randomUUID()}`, '');
    await p.assistSiteLead.update({
      where: { id: ids.lead },
      data: {
        fieldsEnc: legacyGcm(fields, ids.lead, K1),
        identityEnc: legacyLabeled(
          JSON.stringify(identity),
          ids.lead,
          K1,
          'assist-site-identity-v1',
        ),
      },
    });
    await p.assistSiteIntegration.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        kind: 'goal_webhook',
        secretEnc: legacyLabeled(
          'whsec_legacy',
          `${s.siteId}:goal_webhook`,
          K1,
          'assist-site-integration-secret-v1',
        ),
      },
    });
    ids.bad = await lead(`l_${randomUUID()}`, 'v1.x');
    ids.fresh = `l_${randomUUID()}`;
    await lead(
      ids.fresh,
      encryptLeadFields(fields, ids.fresh, leadKey(ROTATED)!),
    );
    const conv = await p.assistSiteConversation.create({
      data: {
        accountId: s.accountId,
        siteId: s.siteId,
        visitorId: randomUUID(),
        ipHash: 'h',
        parentOrigin: s.origin,
      },
    });
    ids.handoff = `h_${randomUUID()}`;
    await p.assistSiteHandoff.create({
      data: {
        id: ids.handoff,
        accountId: s.accountId,
        siteId: s.siteId,
        conversationId: conv.id,
        reason: 'visitor',
        timeoutAt: new Date(Date.now() + 3_600_000),
        identityEnc: legacyGcm(
          identity,
          `assist-handoff-identity:${ids.handoff}`,
          K1,
        ),
      },
    });
    await setPlan(p, s.accountId, 'start', {
      method: 'wayforpay',
      recTokenEnc: legacyRecToken('rec-legacy', K1),
    });
    // «Админка»: секреты, записанные ключом v1 (до ротации).
    const v1 = loadAdminKeyring({ ASSIST_SECRETS_KEY: K1 });
    const idSealed = sealAdminSecret(
      'jwt-secret-v1',
      adminCtx(IDENTITY_SECRET_OWNER, 'identity-secret'),
      v1,
    );
    await p.assistAdminSettings.create({
      data: {
        siteId: s.siteId,
        accountId: s.accountId,
        identitySecretEnc: idSealed.ciphertext,
        identityKeyVersion: idSealed.keyVersion,
      },
    });
    ids.connector = `c_${randomUUID()}`;
    const sec = sealAdminSecret(
      'api-token-v1',
      adminCtx(ids.connector, 'connector-secret'),
      v1,
    );
    const sign = sealAdminSecret(
      'sign-secret-v1',
      adminCtx(ids.connector, 'connector-signing'),
      v1,
    );
    await p.assistAdminConnector.create({
      data: {
        id: ids.connector,
        accountId: s.accountId,
        siteId: s.siteId,
        name: 'crm',
        baseUrl: 'https://api.example.com',
        specHash: 'h',
        secretEnc: sec.ciphertext,
        secretKeyVersion: sec.keyVersion,
        signSecretEnc: sign.ciphertext,
        signKeyVersion: sign.keyVersion,
      },
    });
  });
  afterAll(async () => {
    await st.close();
  });

  const row = async () => ({
    lead: (
      await st.owner.assistSiteLead.findUniqueOrThrow({
        where: { id: ids.lead },
      })
    ).fieldsEnc,
    bad: (
      await st.owner.assistSiteLead.findUniqueOrThrow({
        where: { id: ids.bad },
      })
    ).fieldsEnc,
    handoff: (
      await st.owner.assistSiteHandoff.findUniqueOrThrow({
        where: { id: ids.handoff },
      })
    ).identityEnc,
    rec: (
      await st.owner.assistSubscription.findUniqueOrThrow({
        where: { accountId: s.accountId },
      })
    ).recTokenEnc,
  });

  it('dry-run: считает версии, ничего не пишет', async () => {
    const before = await row();
    const r = await rotateAssistSecrets(db(), {
      apply: false,
      env: ROTATED,
      scope: scope(),
    });
    expect(r.currentVersion).toBe('v2');
    expect(r.leads).toEqual({
      total: 3,
      versions: { v1: 1, v2: 1 },
      current: 1,
      rewritten: 1,
      failed: 1,
      raced: 0,
    });
    expect(r.leadIdentities).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    expect(r.integrations).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    expect(r.handoffs).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    expect(r.subscriptions).toMatchObject({
      total: 1,
      versions: { v1: 1 },
      rewritten: 1,
    });
    for (const t of [
      r.adminIdentity,
      r.adminConnectorSecrets,
      r.adminConnectorSigning,
    ]) {
      expect(t).toEqual({
        total: 1,
        versions: { v1: 1 },
        current: 0,
        rewritten: 1,
        failed: 0,
        raced: 0,
      });
    }
    expect(r.liveValues).toEqual({});
    // 6 строк сайта + 3 секрета «Админки»: пока > 0 — v1 не убирать.
    expect(r.remaining).toBe(9);
    expect(await row()).toEqual(before);
  });

  it('--apply запрещён при кривом списке прежних ключей', async () => {
    await expect(
      rotateAssistSecrets(db(), {
        apply: true,
        env: { ...ROTATED, ASSIST_SECRETS_KEYS_OLD: 'v1' },
        scope: scope(),
      }),
    ).rejects.toThrow(/invalid_old/);
  });

  it('--apply: прежняя версия → v2; читается без прежнего ключа; мусор не тронут', async () => {
    const r = await rotateAssistSecrets(db(), {
      apply: true,
      env: ROTATED,
      scope: scope(),
    });
    expect(r.leads).toMatchObject({
      rewritten: 1,
      failed: 1,
      current: 1,
      raced: 0,
    });
    expect(r.leadIdentities.rewritten).toBe(1);
    expect(r.integrations.rewritten).toBe(1);
    expect(r.handoffs.rewritten).toBe(1);
    expect(r.subscriptions.rewritten).toBe(1);
    expect(r.adminIdentity.rewritten).toBe(1);
    expect(r.adminConnectorSecrets.rewritten).toBe(1);
    expect(r.adminConnectorSigning.rewritten).toBe(1);
    expect(r.remaining).toBe(1);
    // Секреты «Админки» — версия v2 в шифре и в колонке; читаются без v1.
    const k2 = loadAdminKeyring(ONLY_K2);
    const set = await st.owner.assistAdminSettings.findUniqueOrThrow({
      where: { siteId: s.siteId },
    });
    expect(set.identityKeyVersion).toBe('v2');
    expect(set.identitySecretEnc?.startsWith('as1.v2.')).toBe(true);
    expect(
      openAdminSecret(
        {
          ciphertext: set.identitySecretEnc!,
          keyVersion: set.identityKeyVersion,
        },
        adminCtx(IDENTITY_SECRET_OWNER, 'identity-secret'),
        k2,
      ),
    ).toBe('jwt-secret-v1');
    const con = await st.owner.assistAdminConnector.findUniqueOrThrow({
      where: { id: ids.connector },
    });
    expect([con.secretKeyVersion, con.signKeyVersion]).toEqual(['v2', 'v2']);
    expect(
      openAdminSecret(
        { ciphertext: con.secretEnc!, keyVersion: con.secretKeyVersion },
        adminCtx(ids.connector, 'connector-secret'),
        k2,
      ),
    ).toBe('api-token-v1');
    expect(
      openAdminSecret(
        { ciphertext: con.signSecretEnc!, keyVersion: con.signKeyVersion },
        adminCtx(ids.connector, 'connector-signing'),
        k2,
      ),
    ).toBe('sign-secret-v1');
    const lead = await st.owner.assistSiteLead.findUniqueOrThrow({
      where: { id: ids.lead },
    });
    expect(
      decryptLeadIdentity(lead.identityEnc!, ids.lead, identityKey(ONLY_K2)!),
    ).toEqual(identity);
    const integ = await st.owner.assistSiteIntegration.findFirstOrThrow({
      where: { siteId: s.siteId },
    });
    expect(
      decryptSecret(
        integ.secretEnc,
        `${s.siteId}:goal_webhook`,
        integrationsKey({ ASSIST_SECRETS_KEY: K1 })!,
      ),
    ).toBeNull();
    expect(
      decryptSecret(
        integ.secretEnc,
        `${s.siteId}:goal_webhook`,
        integrationsKey(ONLY_K2)!,
      ),
    ).toBe('whsec_legacy');
    const now = await row();
    expect(
      decryptLeadFields(
        now.lead,
        ids.lead,
        leadKey({ ASSIST_SECRETS_KEY: K1 })!,
      ),
    ).toBeNull();
    expect(decryptLeadFields(now.lead, ids.lead, leadKey(ONLY_K2)!)).toEqual(
      fields,
    );
    expect(now.handoff?.startsWith('v1.')).toBe(true);
    expect(
      decryptIdentity(now.handoff!, ids.handoff, leadKey(ONLY_K2)!),
    ).toEqual(identity);
    expect(openPaymentToken(now.rec, { ASSIST_SECRETS_KEY: K1 })).toBeNull();
    expect(openPaymentToken(now.rec, ONLY_K2)?.value).toBe('rec-legacy');
    expect(now.bad).toBe('v1.x');
  });

  it('повтор — идемпотентен: перешифровывать нечего', async () => {
    const before = await row();
    const r = await rotateAssistSecrets(db(), {
      apply: true,
      env: ROTATED,
      scope: scope(),
    });
    expect(r.leads).toMatchObject({ rewritten: 0, current: 2, failed: 1 });
    expect(r.handoffs).toMatchObject({ rewritten: 0, current: 1 });
    expect(r.subscriptions).toMatchObject({ rewritten: 0, current: 1 });
    expect(r.adminIdentity).toMatchObject({ rewritten: 0, current: 1 });
    expect(r.adminConnectorSigning).toMatchObject({ rewritten: 0, current: 1 });
    expect(await row()).toEqual(before);
    const dry = await rotateAssistSecrets(db(), {
      apply: false,
      env: ONLY_K2,
      scope: scope(),
    });
    expect(dry.leads.versions).toEqual({ v2: 2 });
    expect(dry.remaining).toBe(1);
  });

  it('гонка: строку переписал сервис между чтением и записью — не затираем', async () => {
    // Вернуть лиду прежнюю версию и «переписать» его в момент UPDATE.
    const legacy = legacyGcm(fields, ids.lead, K1);
    await st.owner.assistSiteLead.update({
      where: { id: ids.lead },
      data: { fieldsEnc: legacy },
    });
    const service = encryptLeadFields(
      { name: 'сервис' },
      ids.lead,
      leadKey(ROTATED)!,
    );
    const racing: RotationDb = {
      $queryRawUnsafe: (q, ...v) => db().$queryRawUnsafe(q, ...v),
      $executeRawUnsafe: async (q, ...v) => {
        if (v[1] === ids.lead) {
          await st.owner.assistSiteLead.update({
            where: { id: ids.lead },
            data: { fieldsEnc: service },
          });
        }
        return db().$executeRawUnsafe(q, ...v);
      },
    };
    const r = await rotateAssistSecrets(racing, {
      apply: true,
      env: ROTATED,
      scope: scope(),
    });
    expect(r.leads.raced).toBe(1);
    expect((await row()).lead).toBe(service);
  });
});
