/**
 * Термины распознавания «Сайта» без базы (фейк сырого SQL): источники —
 * ТОЛЬКО представления опубликованного; кэш по версиям (новая публикация —
 * новое содержимое, та же — без чтения содержимого); отказ базы — прежние
 * термины. Под настоящей ролью и с изоляцией от «Админки» —
 * `acceptance/e6b/stt-terms.spec.ts`.
 */
import {
  clearSiteSttTermsCache,
  siteSttTerms,
  STT_TERMS_CACHE,
  STT_TERMS_SQL,
  type SttTermsDb,
} from './stt-terms';

function memoContent(name: string, triggers: string[] = []) {
  return {
    schema: 1,
    names: { uk: name },
    triggers: { uk: triggers },
    suggested: {},
    goal: { text: {}, expect: [] },
    slots: [],
    steps: [],
    view: 'any',
  };
}

const target = (key: string, name: string, extra: object = {}) => ({
  key,
  scope: 'page',
  pagePath: '/',
  descriptor: { tag: 'button', role: 'button', text: name, unique: true },
  names: { uk: name },
  ...extra,
});

class FakeDb implements SttTermsDb {
  memos: Array<{ memoId: string; version: number; content: unknown }> = [];
  map: { version: number; content: unknown } | null = null;
  fail = false;
  readonly sql: string[] = [];
  async $queryRawUnsafe<T>(q: string): Promise<T> {
    this.sql.push(q);
    if (this.fail) throw new Error('db down');
    if (q === STT_TERMS_SQL.memoVersions)
      return this.memos.map((m) => ({
        memoId: m.memoId,
        version: m.version,
      })) as T;
    if (q === STT_TERMS_SQL.mapVersion)
      return (this.map ? [{ version: this.map.version }] : []) as T;
    if (q === STT_TERMS_SQL.mapContent)
      return (this.map ? [this.map] : []) as T;
    if (q.includes('"assist_site_memo_published"') && q.includes('"content"'))
      return this.memos.map((m, i) => ({
        memoId: m.memoId,
        number: i + 1,
        key: `k${i}`,
        listed: true,
        view: 'any',
        staleViews: [],
        version: m.version,
        content: m.content,
      })) as T;
    throw new Error(`неожиданный SQL: ${q}`);
  }
  async $executeRawUnsafe(): Promise<number> {
    throw new Error('запись не ожидается');
  }
}

describe('siteSttTerms', () => {
  beforeEach(() => clearSiteSttTermsCache());

  it('только представления опубликованного: термины карты, имена мемо и целей, затем фразы', async () => {
    const db = new FakeDb();
    db.memos = [
      {
        memoId: 'm1',
        version: 1,
        content: memoContent('Запис на консультацію', ['записати мене']),
      },
    ];
    db.map = {
      version: 3,
      content: {
        schemaVersion: 1,
        templates: [],
        terms: ['Хорошоп', 'ivan@example.com'],
        targets: [
          target('cart', 'Кошик'),
          target('gone', 'Видалена', { status: 'removed' }),
          target('pay', 'Оплатити', { denylisted: true }),
        ],
      },
    };
    const terms = await siteSttTerms(db, 's1', 1_000);
    expect(terms).toEqual([
      'Хорошоп',
      'Запис на консультацію',
      'Кошик',
      'записати мене',
    ]);
    for (const q of db.sql)
      expect(q).toMatch(
        /"sites"\."assist_site_(memo_published|voice_map_published)"/,
      );
  });

  it('кэш по версиям: свежая запись — без базы; та же подпись — без содержимого; новая публикация — перечитать', async () => {
    const db = new FakeDb();
    db.memos = [{ memoId: 'm1', version: 1, content: memoContent('Перше') }];
    expect(await siteSttTerms(db, 's1', 0)).toEqual(['Перше']);
    const n0 = db.sql.length;
    // Свежая — ни одного запроса.
    expect(await siteSttTerms(db, 's1', STT_TERMS_CACHE.freshMs - 1)).toEqual([
      'Перше',
    ]);
    expect(db.sql.length).toBe(n0);
    // Протухла, версии те же — только подпись (2 запроса), без содержимого.
    db.memos[0].content = memoContent('Не перечитано');
    expect(await siteSttTerms(db, 's1', STT_TERMS_CACHE.freshMs + 1)).toEqual([
      'Перше',
    ]);
    expect(db.sql.slice(n0)).toEqual([
      STT_TERMS_SQL.memoVersions,
      STT_TERMS_SQL.mapVersion,
    ]);
    // Новая версия мемо — новое содержимое.
    db.memos[0] = { memoId: 'm1', version: 2, content: memoContent('Друге') };
    expect(
      await siteSttTerms(db, 's1', 2 * STT_TERMS_CACHE.freshMs + 2),
    ).toEqual(['Друге']);
    // Другой сайт — своя запись (кэш на сайт).
    const other = new FakeDb();
    expect(await siteSttTerms(other, 's2', 0)).toEqual([]);
  });

  it('отказ базы — прежние термины (или пусто), не исключение', async () => {
    const db = new FakeDb();
    db.memos = [{ memoId: 'm1', version: 1, content: memoContent('Перше') }];
    await siteSttTerms(db, 's1', 0);
    db.fail = true;
    expect(await siteSttTerms(db, 's1', STT_TERMS_CACHE.freshMs + 1)).toEqual([
      'Перше',
    ]);
    const empty = new FakeDb();
    empty.fail = true;
    expect(await siteSttTerms(empty, 's3', 0)).toEqual([]);
  });
});
