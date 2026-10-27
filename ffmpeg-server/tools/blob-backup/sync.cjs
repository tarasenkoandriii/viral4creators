'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { gzipSync, gunzipSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const PREFIX = 'ffmpeg-sqlite/';
const MAX_FILE = 8 * 1024 ** 2;
const MAX_STORE = 6 * 1024 ** 3;
const MAX_MONTH_BYTES = 12 * 1024 ** 3;
const MAX_MONTH_ATTEMPTS = 4800;
const NAME = /^ffmpeg-server-(\d{8}T\d{6}Z)\.db$/;
const REMOTE_NAME = /^ffmpeg-sqlite\/ffmpeg-server-(\d{8}T\d{6}Z)-[a-f0-9]{64}\.db(?:\.gz)?$/;

function timestamp(stamp) {
  return Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
}
function plan({ name, bytes, ledger, now }) {
  const match = NAME.exec(name);
  if (!match || !Number.isFinite(timestamp(match[1]))) throw Error('invalid_snapshot_name');
  const age = now - timestamp(match[1]);
  if (age < -60_000 || age > 1800_000) throw Error('stale_snapshot');
  if (bytes <= 0 || bytes > MAX_FILE) throw Error('snapshot_size_limit');
  const next = { bytes: (ledger.bytes || 0) + bytes, attempts: (ledger.attempts || 0) + 1 };
  if (next.bytes > MAX_MONTH_BYTES || next.attempts > MAX_MONTH_ATTEMPTS) throw Error('monthly_budget_limit');
  // Conservative allowance: up to four transfers at $0.15/GB, plus storage/ops.
  // This bounds this job, not the Vercel account bill or future provider prices.
  if (next.bytes / 1e9 * 4 * 0.15 + 0.5 > 8) throw Error('monthly_budget_limit');
  return next;
}
async function atomic(file, value) {
  await fs.writeFile(file + '.partial', JSON.stringify(value) + '\n', { mode: 0o600 });
  await fs.rename(file + '.partial', file);
}
function verifyDb(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('integrity_failed');
    return { jobs: db.prepare('SELECT count(*) AS n FROM jobs').get().n,
      idempotencyKeys: db.prepare('SELECT count(*) AS n FROM idempotency_keys').get().n };
  } finally { db.close(); }
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
async function sync({ sdk, snapshot, token, stateDir, now = Date.now() }) {
  const name = path.basename(snapshot);
  const stat = await fs.stat(snapshot);
  const month = new Date(now).toISOString().slice(0, 7);
  const ledgerFile = path.join(stateDir, `ledger-${month}.json`);
  const ledger = await readJson(ledgerFile, {});
  // Validate the uncompressed file before reading it into memory.
  plan({ name, bytes: stat.size, ledger: {}, now });
  const before = verifyDb(snapshot);
  const body = await fs.readFile(snapshot);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const compressed = gzipSync(body);
  const storedSha = crypto.createHash('sha256').update(compressed).digest('hex');
  const next = plan({ name, bytes: compressed.length, ledger, now });
  const remotePath = PREFIX + name.slice(0, -3) + '-' + sha + '.db.gz';
  const prior = await readJson(path.join(stateDir, 'status.json'), {});
  if (prior.ok && prior.snapshot === name && prior.sha256 === sha && prior.compression === 'gzip') return { ...prior, replay: true };
  // Reserve before network I/O, including ambiguous/failed uploads. No blind retry.
  await atomic(ledgerFile, next);
  const opts = { token, abortSignal: AbortSignal.timeout(60_000) };
  const listing = await sdk.list({ ...opts, prefix: PREFIX, limit: 1000 });
  if (listing.hasMore) {
    if (!listing.cursor) throw Error('store_object_limit');
    const page = await sdk.list({ ...opts, prefix: PREFIX, limit: 1000, cursor: listing.cursor });
    listing.blobs.push(...page.blobs);
    if (page.hasMore || listing.blobs.length > 1200) throw Error('store_object_limit');
  }
  if (listing.blobs.some(b => !REMOTE_NAME.test(b.pathname))) throw Error('unexpected_store_object');
  if (listing.blobs.reduce((s, b) => s + b.size, 0) + compressed.length > MAX_STORE) throw Error('store_size_limit');
  // An ambiguous previous upload is reused, never overwritten.
  const existing = listing.blobs.find(b => b.pathname === remotePath);
  const blob = existing || await sdk.put(remotePath, compressed, { ...opts, access: 'private',
    addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 60,
    contentType: 'application/gzip' });
  const remote = await sdk.get(remotePath, { ...opts, access: 'private', useCache: false });
  if (!remote || remote.statusCode !== 200) throw Error('readback_failed');
  const hash = crypto.createHash('sha256');
  let size = 0; const chunks = [];
  for await (const chunk of remote.stream) {
    size += chunk.length;
    if (size > MAX_FILE) throw Error('readback_size_limit');
    hash.update(chunk); chunks.push(Buffer.from(chunk));
  }
  if (size !== compressed.length || hash.digest('hex') !== storedSha) throw Error('readback_hash_mismatch');
  const restoredBytes = gunzipSync(Buffer.concat(chunks), { maxOutputLength: MAX_FILE });
  if (crypto.createHash('sha256').update(restoredBytes).digest('hex') !== sha) throw Error('restore_hash_mismatch');
  const restored = path.join('/tmp', 'ffmpeg-blob-restore.db');
  try {
    await fs.writeFile(restored, restoredBytes, { mode: 0o600 });
    const check = verifyDb(restored);
    if (check.jobs !== before.jobs || check.idempotencyKeys !== before.idempotencyKeys) throw Error('restore_counts_mismatch');
  } finally { await fs.rm(restored, { force: true }); }
  // Verify the store really prevents anonymous access. Never return its URL.
  const anon = await fetch(blob.url, { headers: { Range: 'bytes=0-0' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  await anon.body?.cancel();
  if (![401, 403, 404].includes(anon.status)) throw Error('anonymous_access_not_denied');
  let pruned = 0;
  for (const old of listing.blobs) {
    const match = REMOTE_NAME.exec(old.pathname);
    if (old.pathname !== remotePath && now - timestamp(match[1]) > 7 * 86400_000) {
      await sdk.del(old.pathname, opts); pruned++;
    }
  }
  const result = { ok: true, checkedAt: now, snapshot: name, sha256: sha, bytes: size,
    snapshotBytes: body.length, storedSha256: storedSha, compression: 'gzip',
    ...before, privateAccess: true, anonymousStatus: anon.status, readbackVerified: true,
    pruned, monthReservedBytes: next.bytes, monthAttempts: next.attempts };
  await atomic(path.join(stateDir, 'status.json'), result);
  return result;
}
module.exports = { plan, timestamp, sync, MAX_FILE, MAX_MONTH_BYTES };
if (require.main === module) {
  const stateDir = '/state';
  (async () => {
    const sdk = require('@vercel/blob');
    const token = (await fs.readFile('/run/blob-token', 'utf8')).trim();
    const result = await sync({ sdk, token, stateDir, snapshot: '/backup/' + process.argv[2] });
    await fs.rm(path.join(stateDir, 'failure.json'), { force: true });
    console.log(JSON.stringify(result));
  })().catch(async () => {
    // Errors from SDK/fetch may contain request URLs; persist no raw exception.
    await atomic(path.join(stateDir, 'failure.json'), { ok: false, at: Date.now(), error: 'backup_sync_failed' });
    console.error('backup_sync_failed'); process.exitCode = 1;
  });
}
