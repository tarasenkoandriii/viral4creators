/**
 * Зеркало `src/brand.ts` ≡ `sites-backend/src/brand.ts` (раздел AI
 * Publisher и путь файла подтверждения владения) — проектный документ §13.1.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mirror from '../src/brand';

async function main() {
  const src = path.resolve(__dirname, '..', '..', 'sites-backend/src/brand.ts');
  const mod = (await import(pathToFileURL(src).href)) as Record<string, unknown> & {
    default?: Record<string, unknown>;
  };
  const be = (mod.PUBLISHER_KEY_PREFIX ? mod : mod.default) as Record<string, unknown>;
  const keys = [
    'PUBLISHER_KEY_PREFIX',
    'PUBLISHER_VERSION_META',
    'PUBLISHER_SESSION_STORAGE_KEY',
    'PUBLISHER_EVENT_NAMES',
    'PUBLISHER_CLIENT_EVENT_NAMES',
    'VERIFY_FILE_PATH',
  ] as const;
  for (const k of keys) assert.deepEqual(mirror[k], be[k], `brand: ${k} расходится с sites-backend/src/brand.ts`);
  assert.equal(
    String(mirror.PUBLISHER_PUBLIC_KEY_RE),
    String(be.PUBLISHER_PUBLIC_KEY_RE),
    'brand: PUBLISHER_PUBLIC_KEY_RE',
  );
  // Публичный префикс API — из контракта P-D.
  const pub = (await import(
    pathToFileURL(path.resolve(__dirname, '..', '..', 'sites-backend/src/modules/publisher/contracts/public-api.ts'))
      .href
  ).catch(() => null)) as { PUBLIC_PREFIX?: string; default?: { PUBLIC_PREFIX?: string } } | null;
  const prefix = pub?.PUBLIC_PREFIX ?? pub?.default?.PUBLIC_PREFIX;
  if (prefix) assert.equal(mirror.PUBLIC_API_PREFIX, prefix, 'PUBLIC_API_PREFIX ≠ contracts/public-api.ts');
  else {
    const text = (await import('node:fs')).readFileSync(
      path.resolve(__dirname, '..', '..', 'sites-backend/src/modules/publisher/contracts/public-api.ts'),
      'utf8',
    );
    assert.ok(
      text.includes(`PUBLIC_PREFIX = '${mirror.PUBLIC_API_PREFIX}'`),
      'PUBLIC_API_PREFIX ≠ contracts/public-api.ts (по тексту)',
    );
  }
  assert.equal(mirror.PUBLISHER_BRAND.lang, 'uk');
  assert.equal(mirror.PUBLISHER_BRAND.domain, 'ai-publisher.org');
  console.log(`ok   brand: ${keys.length + 2} констант зеркала совпадают с sites-backend (+ префикс API)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
