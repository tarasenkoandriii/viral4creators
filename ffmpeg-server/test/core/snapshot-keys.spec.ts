import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { KeyRing } from '../../src/config';
import { fingerprint, sealPayload } from '../../src/crypto/crypto';
import { verifySnapshotKeys } from '../../src/ops/snapshot-keys';

const ring = (active: string, n: number): KeyRing => ({
  active,
  keys: new Map([[active, Buffer.alloc(32, n)]]),
});
const payload = ring('payload-test', 1);
const hmac = ring('hmac-test', 2);
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'snapshot-keys-'));
  file = path.join(root, 'snapshot.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE jobs (id TEXT, payload_enc TEXT, payload_key_id TEXT,
    fingerprint TEXT, fingerprint_key_id TEXT);
    CREATE TABLE idempotency_keys (fingerprint_key_id TEXT);`);
  const body = { input_files: { source: 'https://private.test/sensitive' } };
  const sealed = sealPayload(payload, JSON.stringify(body), 'job-test');
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run(
    'job-test',
    sealed.sealed,
    sealed.keyId,
    fingerprint(hmac, body).value,
    hmac.active,
  );
  db.prepare('INSERT INTO idempotency_keys VALUES (?)').run(hmac.active);
  db.close();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function mutate(sql: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

it('decrypts and verifies a saved payload without changing the snapshot or disclosing data', () => {
  const before = readFileSync(file);
  const result = verifySnapshotKeys(file, payload, hmac);
  expect(result).toMatchObject({
    ok: true,
    encryptedPayloads: 1,
    decryptedPayloads: 1,
    verifiedFingerprints: 1,
  });
  expect(readFileSync(file)).toEqual(before);
  expect(JSON.stringify(result)).not.toMatch(
    /private\.test|sensitive|payload-test|hmac-test/,
  );
});

it('fails for a missing payload key', () => {
  expect(verifySnapshotKeys(file, ring('other', 1), hmac)).toMatchObject({
    ok: false,
    missingPayloadKeys: 1,
  });
});

it('fails for the wrong material under the original payload key ID', () => {
  expect(verifySnapshotKeys(file, ring(payload.active, 9), hmac)).toMatchObject(
    { ok: false, invalidPayloads: 1 },
  );
});

it('fails for the wrong HMAC material', () => {
  expect(verifySnapshotKeys(file, payload, ring(hmac.active, 9))).toMatchObject(
    { ok: false, fingerprintMismatches: 1 },
  );
});

it('requires historical HMAC keys even for tombstones without payloads', () => {
  mutate(
    "UPDATE jobs SET payload_enc=NULL; INSERT INTO idempotency_keys VALUES ('retired-key')",
  );
  expect(verifySnapshotKeys(file, payload, hmac)).toMatchObject({
    ok: false,
    encryptedPayloads: 0,
    missingHmacKeys: 1,
  });
});

it('reports zero decryptions when all payloads have expired', () => {
  mutate('UPDATE jobs SET payload_enc=NULL');
  expect(verifySnapshotKeys(file, payload, hmac)).toMatchObject({
    ok: true,
    encryptedPayloads: 0,
    decryptedPayloads: 0,
  });
});
