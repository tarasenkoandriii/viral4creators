/**
 * П-Г3: скачивание архива Chromium с проверкой SHA-256 — фейковое
 * скачивание (поток), настоящая временная папка: совпал — распакован;
 * не совпал — отказ и ничего не распаковано; обход пути, ссылки, мусор без
 * конца — отказ.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildTarForTests,
  downloadVerifiedPack,
  expectedPackSha256,
  extractTar,
} from './chromium-pack-verify';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Ответ fetch с телом-потоком кусками по 1000 байт. */
function fakeFetch(body: Buffer, status = 200): typeof fetch {
  return (async () => {
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= body.length) return c.close();
        c.enqueue(new Uint8Array(body.subarray(off, off + 1000)));
        off += 1000;
      },
    });
    return new Response(stream, { status });
  }) as unknown as typeof fetch;
}

describe('П-Г3: архив Chromium с проверкой SHA-256', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pg3-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pack = buildTarForTests([
    { name: 'chromium.br', data: Buffer.from('бинарник'.repeat(500)) },
    { name: 'al2023.tar.br', data: Buffer.from('библиотеки') },
    { name: 'fonts/a.ttf', data: Buffer.from('шрифт') },
  ]);

  it('env: не задан, задан, мусор', () => {
    expect(expectedPackSha256({})).toEqual({ kind: 'none' });
    expect(
      expectedPackSha256({ CHROMIUM_PACK_SHA256: 'AB'.repeat(32) }),
    ).toEqual({ kind: 'sha256', value: 'ab'.repeat(32) });
    expect(expectedPackSha256({ CHROMIUM_PACK_SHA256: 'abc' })).toEqual({
      kind: 'invalid',
    });
  });

  it('хеш совпал — архив распакован в папку', async () => {
    const dest = join(dir, 'pack');
    const r = await downloadVerifiedPack({
      url: 'https://example.test/pack.tar',
      expectedSha256: sha(pack),
      destDir: dest,
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(pack),
    });
    expect(r).toEqual({ ok: true, sha256: sha(pack), files: 3 });
    expect(readFileSync(join(dest, 'chromium.br'), 'utf8')).toBe(
      'бинарник'.repeat(500),
    );
    expect(readFileSync(join(dest, 'fonts/a.ttf'), 'utf8')).toBe('шрифт');
  });

  it('хеш не совпал — понятный отказ, ничего не распаковано', async () => {
    const dest = join(dir, 'pack');
    const evil = buildTarForTests([
      { name: 'chromium.br', data: Buffer.from('подменённый') },
    ]);
    const r = await downloadVerifiedPack({
      url: 'https://example.test/pack.tar',
      expectedSha256: sha(pack),
      destDir: dest,
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(evil),
    });
    expect(r.ok).toBe(false);
    expect((r as { diagnostic: string }).diagnostic).toMatch(
      /SHA-256.*ожидали .*получили/,
    );
    expect(existsSync(join(dest, 'chromium.br'))).toBe(false);
  });

  it('HTTP-ошибка и архив больше потолка — отказ', async () => {
    const r1 = await downloadVerifiedPack({
      url: 'https://example.test/x',
      expectedSha256: sha(pack),
      destDir: join(dir, 'p1'),
      timeoutMs: 5_000,
      fetchImpl: fakeFetch(Buffer.alloc(0), 404),
    });
    expect((r1 as { diagnostic: string }).diagnostic).toContain('404');
    const r2 = await downloadVerifiedPack({
      url: 'https://example.test/x',
      expectedSha256: sha(pack),
      destDir: join(dir, 'p2'),
      timeoutMs: 5_000,
      maxBytes: 2_000,
      fetchImpl: fakeFetch(pack),
    });
    expect((r2 as { diagnostic: string }).diagnostic).toContain('больше');
  });

  it('распаковка: выход из папки и ссылки — отказ', async () => {
    const dest = join(dir, 'p3');
    await expect(
      extractTar(
        buildTarForTests([{ name: '../escape.txt', data: Buffer.from('x') }]),
        dest,
      ),
    ).rejects.toThrow(/вне папки/);
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false);
    await expect(
      extractTar(
        buildTarForTests([{ name: '/etc/x', data: Buffer.from('x') }]),
        dest,
      ),
    ).rejects.toThrow(/недопустимое имя/);
    await expect(
      extractTar(
        buildTarForTests([{ name: 'link', data: Buffer.alloc(0), type: '2' }]),
        dest,
      ),
    ).rejects.toThrow(/не поддерживается/);
  });
});
