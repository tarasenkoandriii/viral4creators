/**
 * Поиск знаний (аудит тестов): по умолчанию фрагменты UGC (отзывы,
 * комментарии посетителей) в выдачу НЕ попадают — фильтр `NOT "ugc"` стоит
 * в каждом запросе (вектор, полнотекст, триграммы, выборка строк); только
 * явный `includeUgc: true` его снимает. База — подделка, проверяется SQL.
 */
import { KnowledgeStore, type KnowledgeSearchDb } from './store';
import type { KnowledgeTables } from './tables';

const TABLES: KnowledgeTables = {
  mode: 'site',
  settings: 'kt_settings',
  sources: 'kt_sources',
  documents: 'kt_documents',
  chunks: 'kt_chunks',
  versions: 'kt_versions',
  faq: 'kt_faq',
  exclusions: 'kt_exclusions',
};

function fakeDb() {
  const sql: string[] = [];
  const db: KnowledgeSearchDb = {
    $queryRawUnsafe: (<T>(q: string) => {
      sql.push(q);
      // Каждый поиск находит один фрагмент — дойдёт и итоговая выборка.
      if (q.includes('SELECT "id", "documentId"'))
        return Promise.resolve([] as unknown as T);
      return Promise.resolve([{ id: 'c1' }] as unknown as T);
    }) as KnowledgeSearchDb['$queryRawUnsafe'],
  };
  return { db, sql };
}

describe('поиск знаний: UGC по умолчанию исключён', () => {
  const query = {
    siteId: 'site1',
    version: 3,
    query: 'доставка Київ артикул ZX-900',
  };
  const vector = [0.1, 0.2, 0.3];

  it('без includeUgc — `NOT "ugc"` в каждом запросе (вектор, текст, триграммы, строки)', async () => {
    const { db, sql } = fakeDb();
    await new KnowledgeStore(TABLES, db).search(query, vector);
    expect(sql.length).toBeGreaterThanOrEqual(4);
    for (const q of sql) expect(q).toContain('AND NOT "ugc"');
  });

  it('includeUgc: false — так же; только true снимает фильтр', async () => {
    const off = fakeDb();
    await new KnowledgeStore(TABLES, off.db).search(
      { ...query, includeUgc: false },
      vector,
    );
    for (const q of off.sql) expect(q).toContain('AND NOT "ugc"');
    const on = fakeDb();
    await new KnowledgeStore(TABLES, on.db).search(
      { ...query, includeUgc: true },
      vector,
    );
    expect(on.sql.length).toBeGreaterThanOrEqual(4);
    for (const q of on.sql) expect(q).not.toContain('NOT "ugc"');
  });
});
