import { DatabaseSync } from 'node:sqlite';
import type { KeyRing } from '../config';
import { fingerprint, openPayload, safeEqualHex } from '../crypto/crypto';

/** Read-only proof of snapshot/key compatibility; never returns payloads or key IDs. */
export function verifySnapshotKeys(
  file: string,
  payloadKeys: KeyRing,
  hmacKeys: KeyRing,
) {
  const db = new DatabaseSync(file, { readOnly: true });
  const result = {
    ok: true,
    jobs: 0,
    encryptedPayloads: 0,
    decryptedPayloads: 0,
    verifiedFingerprints: 0,
    missingPayloadKeys: 0,
    missingHmacKeys: 0,
    invalidPayloads: 0,
    fingerprintMismatches: 0,
  };
  try {
    const rows = db.prepare(
      'SELECT id, payload_enc, payload_key_id, fingerprint, fingerprint_key_id FROM jobs',
    );
    for (const raw of rows.iterate()) {
      const row = raw as {
        id: string;
        payload_enc: string | null;
        payload_key_id: string | null;
        fingerprint: string;
        fingerprint_key_id: string;
      };
      result.jobs++;
      if (!row.payload_enc) continue;
      result.encryptedPayloads++;
      if (!row.payload_key_id || !payloadKeys.keys.has(row.payload_key_id)) {
        result.missingPayloadKeys++;
        continue;
      }
      let body: unknown;
      try {
        body = JSON.parse(
          openPayload(payloadKeys, row.payload_key_id, row.payload_enc, row.id),
        );
        result.decryptedPayloads++;
      } catch {
        result.invalidPayloads++;
        continue;
      }
      if (!hmacKeys.keys.has(row.fingerprint_key_id)) continue;
      const actual = fingerprint(hmacKeys, body, row.fingerprint_key_id).value;
      if (safeEqualHex(actual, row.fingerprint)) result.verifiedFingerprints++;
      else result.fingerprintMismatches++;
    }
    // Tombstones still need their original HMAC key for safe replay checks.
    const refs = db.prepare(`
      SELECT fingerprint_key_id FROM jobs
      UNION SELECT fingerprint_key_id FROM idempotency_keys
    `);
    for (const row of refs.iterate()) {
      if (!hmacKeys.keys.has(row.fingerprint_key_id as string))
        result.missingHmacKeys++;
    }
    result.ok =
      result.missingPayloadKeys === 0 &&
      result.missingHmacKeys === 0 &&
      result.invalidPayloads === 0 &&
      result.fingerprintMismatches === 0;
    return result;
  } finally {
    db.close();
  }
}
