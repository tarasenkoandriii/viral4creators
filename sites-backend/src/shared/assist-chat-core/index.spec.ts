// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/assist-chat-core/index.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Ядро копируется побайтно в `sites-backend/src/shared/` скриптом
 * `scripts/sync-sites-shared.mjs`; копия собирается БЕЗ остального
 * `backend/`. Поэтому чистота — проверяемое правило, а не пожелание:
 * ни импортов вне папки, ни Nest/Prisma, ни чтения env.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as core from './index';

const DIR = __dirname;

/** Код без комментариев: шапки файлов упоминают `process.env` словами. */
function codeOf(file: string): string {
  return fs
    .readFileSync(path.join(DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
const sources = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

describe('assist-chat-core — чистота для копии в sites-backend', () => {
  it.each(sources)('%s: импорты только свои и встроенные node', (file) => {
    const src = codeOf(file);
    const specs = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const s of specs) {
      expect(s === 'crypto' || /^\.\/[\w-]+$/.test(s)).toBe(true);
    }
  });

  it.each(sources)('%s: без process.env, Nest и Prisma', (file) => {
    const src = codeOf(file);
    expect(src).not.toMatch(/process\.env|@nestjs|@prisma|PrismaService/);
  });

  it('index реэкспортирует каждый файл ядра', () => {
    const index = fs.readFileSync(path.join(DIR, 'index.ts'), 'utf8');
    for (const f of sources.filter((f) => f !== 'index.ts')) {
      expect(index).toContain(`from './${f.replace(/\.ts$/, '')}'`);
    }
  });

  it('публичное API на месте', () => {
    for (const name of [
      'runChatStream',
      'DelimiterStreamBuffer',
      'splitActionsBlock',
      'parseActionsBlock',
      'maskSensitiveEcho',
      'containsAnyPhrase',
      'hashIpWithDailySalt',
      'createChatAbort',
      'chatUsageFromMeta',
      'toGeminiContent',
    ]) {
      expect(typeof (core as Record<string, unknown>)[name]).toBe('function');
    }
  });
});
