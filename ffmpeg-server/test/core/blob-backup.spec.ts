import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync, gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const { plan, sync } = jest.requireActual<{
  plan: (args: {
    name: string;
    bytes: number;
    now: number;
    ledger: { bytes?: number; attempts?: number };
  }) => { bytes: number; attempts: number };
  sync: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}>('../../tools/blob-backup/sync.cjs');
const now = Date.parse('2026-10-27T00:00:00Z');
const name = 'ffmpeg-server-20261027T000000Z.db';

it.each([
  { name: '../wrong.db', bytes: 100, ledger: {} },
  { name: 'ffmpeg-server-20261025T000000Z.db', bytes: 100, ledger: {} },
  { name, bytes: 9 * 1024 ** 2, ledger: {} },
  { name, bytes: 100, ledger: { attempts: 4800 } },
  { name, bytes: 100, ledger: { bytes: 12 * 1024 ** 3 } },
])('rejects invalid/stale/over-budget snapshot: %j', (args) => {
  expect(() => plan({ ...args, now })).toThrow();
});

describe('private Blob backup', () => {
  let root: string;
  let snapshot: string;
  let body: Buffer;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'blob-backup-'));
    snapshot = path.join(root, name);
    const db = new DatabaseSync(snapshot);
    db.exec(
      'CREATE TABLE jobs (id TEXT); CREATE TABLE idempotency_keys (id TEXT); INSERT INTO jobs VALUES (1); INSERT INTO idempotency_keys VALUES (1)',
    );
    db.close();
    body = readFileSync(snapshot);
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 403 }));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function sdk(valid = true) {
    return {
      list: jest.fn().mockResolvedValue({ blobs: [], hasMore: false }),
      put: jest
        .fn()
        .mockResolvedValue({ url: 'https://private.test/snapshot.db' }),
      get: jest.fn().mockImplementation(async () => ({
        statusCode: 200,
        stream: Readable.from([
          valid ? gzipSync(body) : Buffer.from('corrupt'),
        ]),
      })),
      del: jest.fn(),
    };
  }
  it('verifies private readback/restore and avoids duplicate upload', async () => {
    const api = sdk();
    const args = {
      sdk: api,
      snapshot,
      token: 'test-only',
      stateDir: root,
      now,
    };
    const result = await sync(args);
    expect(result).toMatchObject({
      ok: true,
      readbackVerified: true,
      anonymousStatus: 403,
      jobs: 1,
      idempotencyKeys: 1,
    });
    expect(api.put).toHaveBeenCalledWith(
      expect.stringMatching(/\.db\.gz$/),
      gzipSync(body),
      expect.objectContaining({ access: 'private', allowOverwrite: false }),
    );
    expect(gunzipSync(api.put.mock.calls[0][1])).toEqual(body);
    expect(result.snapshotBytes).toBe(body.length);
    expect(result.bytes).toBeLessThan(body.length);
    expect(await sync(args)).toMatchObject({ ok: true, replay: true });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/test-only|private\.test/);
  });
  it('reserves quota and does not prune when readback is corrupt', async () => {
    const api = sdk(false);
    await expect(
      sync({ sdk: api, snapshot, token: 'test-only', stateDir: root, now }),
    ).rejects.toThrow('readback_hash_mismatch');
    expect(api.del).not.toHaveBeenCalled();
    const ledger = JSON.parse(
      readFileSync(path.join(root, 'ledger-2026-10.json'), 'utf8'),
    );
    expect(ledger.attempts).toBe(1);
  });
  it('fails if anonymous access succeeds', async () => {
    jest
      .mocked(global.fetch)
      .mockResolvedValue(new Response(null, { status: 200 }));
    const api = sdk();
    await expect(
      sync({ sdk: api, snapshot, token: 'test-only', stateDir: root, now }),
    ).rejects.toThrow('anonymous_access_not_denied');
    expect(api.del).not.toHaveBeenCalled();
  });
  it('prunes expired snapshots only after successful readback', async () => {
    const api = sdk();
    const old =
      'ffmpeg-sqlite/ffmpeg-server-20261018T000000Z-' + 'a'.repeat(64) + '.db';
    api.list.mockResolvedValue({
      blobs: [{ pathname: old, size: 100 }],
      hasMore: false,
    });
    const result = await sync({
      sdk: api,
      snapshot,
      token: 'test-only',
      stateDir: root,
      now,
    });
    expect(result.pruned).toBe(1);
    expect(api.del).toHaveBeenCalledWith(old, expect.any(Object));
    expect(api.del.mock.invocationCallOrder[0]).toBeGreaterThan(
      api.get.mock.invocationCallOrder[0],
    );
  });
  it('rejects unexpected objects instead of deleting or uploading over them', async () => {
    const api = sdk();
    api.list.mockResolvedValue({
      blobs: [{ pathname: 'other-customer.db', size: 100 }],
      hasMore: false,
    });
    await expect(
      sync({ sdk: api, snapshot, token: 'test-only', stateDir: root, now }),
    ).rejects.toThrow('unexpected_store_object');
    expect(api.put).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
  });
  it('follows one retention page and rejects unbounded pagination', async () => {
    const api = sdk();
    api.list
      .mockResolvedValueOnce({ blobs: [], hasMore: true, cursor: 'next-page' })
      .mockResolvedValueOnce({
        blobs: [],
        hasMore: true,
        cursor: 'third-page',
      });
    await expect(
      sync({ sdk: api, snapshot, token: 'test-only', stateDir: root, now }),
    ).rejects.toThrow('store_object_limit');
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.put).not.toHaveBeenCalled();
  });
  it('accepts a bounded second retention page', async () => {
    const api = sdk();
    api.list
      .mockResolvedValueOnce({ blobs: [], hasMore: true, cursor: 'next-page' })
      .mockResolvedValueOnce({ blobs: [], hasMore: false });
    expect(
      await sync({
        sdk: api,
        snapshot,
        token: 'test-only',
        stateDir: root,
        now,
      }),
    ).toMatchObject({ ok: true, compression: 'gzip' });
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});
