import {
  SONIOX_TAG_GENERATOR,
  SONIOX_TAG_SITES,
  sonioxFileName,
  sonioxReferenceId,
  sweepOwnStaleSoniox,
} from './soniox-sweep';

const NOW = new Date('2026-10-07T12:00:00Z');
const ago = (min: number) =>
  new Date(NOW.getTime() - min * 60_000).toISOString();
const TAG = SONIOX_TAG_SITES;
const REF = sonioxReferenceId(TAG);
const NAME = sonioxFileName(TAG);

type Item = Record<string, unknown>;

/** Soniox в памяти: списки по страницам и коды DELETE по id. */
function provider(opts: {
  files?: Item[][];
  transcriptions?: Item[][];
  del?: Record<string, number>;
  listStatus?: number;
}) {
  const calls: string[] = [];
  const fn = jest.fn(async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/v1', '');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push(`${method} ${path}${u.search}`);
    if (method === 'GET') {
      const kind = path.slice(1) as 'files' | 'transcriptions';
      if (opts.listStatus)
        return { ok: false, status: opts.listStatus } as Response;
      const pages = opts[kind] ?? [[]];
      const n = Number(u.searchParams.get('cursor') ?? '0');
      const body = {
        [kind]: pages[n] ?? [],
        next_page_cursor: n + 1 < pages.length ? String(n + 1) : null,
      };
      return { ok: true, status: 200, json: async () => body } as Response;
    }
    const id = path.split('/').pop()!;
    const status = opts.del?.[id] ?? 204;
    return { ok: status < 300, status } as Response;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}
const logger = () => ({ warn: jest.fn() });
const deletes = (calls: string[]) =>
  calls.filter((c) => c.startsWith('DELETE'));

describe('sweepOwnStaleSoniox — уборка своего у Soniox (C4 захода 8)', () => {
  it('метки продуктов различаются и предсказуемы', () => {
    expect(sonioxReferenceId(SONIOX_TAG_GENERATOR)).toBe('v4c-gen:stt');
    expect(sonioxReferenceId(SONIOX_TAG_SITES, 'admin')).toBe(
      'v4c-sites:admin',
    );
    expect(sonioxFileName(SONIOX_TAG_SITES)).toBe('v4c-sites-stt');
  });

  it('нет ключа — к провайдеру не ходит', async () => {
    const p = provider({});
    await expect(
      sweepOwnStaleSoniox({ tag: TAG, key: '', fetch: p.fetch, now: NOW }),
    ).resolves.toMatchObject({ sonioxSkipped: true, sonioxFailed: 0 });
    expect(p.calls).toHaveLength(0);
  });

  it('удаляет только СВОЁ старше часа: сначала файлы, затем транскрипции; чужое и свежее не трогает', async () => {
    const p = provider({
      transcriptions: [
        [
          { id: 't-old', created_at: ago(120), client_reference_id: REF },
          {
            id: 't-busy',
            created_at: ago(90),
            client_reference_id: sonioxReferenceId(TAG, 'admin'),
          },
          { id: 't-bad', created_at: ago(90), client_reference_id: REF },
          // Свежая своя — не трогать, но её файл — свой.
          {
            id: 't-new',
            created_at: ago(5),
            client_reference_id: REF,
            file_id: 'f-linked',
          },
          // Чужие: другой продукт, без метки, генератор при уборке сайтов.
          { id: 't-da', created_at: ago(300), client_reference_id: 'da:x' },
          { id: 't-none', created_at: ago(300) },
          {
            id: 't-gen',
            created_at: ago(300),
            client_reference_id: sonioxReferenceId(SONIOX_TAG_GENERATOR),
          },
          { id: '../x', created_at: ago(900), client_reference_id: REF },
          { id: 't-nodate', created_at: 'вчера', client_reference_id: REF },
        ],
      ],
      files: [
        [
          { id: 'f-own', created_at: ago(61), filename: NAME },
          { id: 'f-fresh', created_at: ago(5), filename: NAME },
          { id: 'f-linked', created_at: ago(70), filename: 'voice' },
        ],
        [
          { id: 'f-ref', created_at: ago(300), client_reference_id: REF },
          { id: 'f-foreign', created_at: ago(300), filename: 'voice' },
          { id: 'f-gen', created_at: ago(300), filename: 'v4c-gen-stt' },
        ],
      ],
      del: { 'f-ref': 404, 't-busy': 409, 't-bad': 500 },
    });
    const log = logger();
    const r = await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: p.fetch,
      now: NOW,
      logger: log,
    });
    expect(r).toEqual({
      sonioxFilesDeleted: 3,
      sonioxTranscriptionsDeleted: 1,
      sonioxBusy: 1,
      sonioxFailed: 1,
      sonioxForeignSkipped: 5,
    });
    expect(deletes(p.calls)).toEqual([
      'DELETE /files/f-own',
      'DELETE /files/f-linked',
      'DELETE /files/f-ref',
      'DELETE /transcriptions/t-old',
      'DELETE /transcriptions/t-busy',
      'DELETE /transcriptions/t-bad',
    ]);
    expect(p.calls).toContain('GET /files?limit=1000&cursor=1');
    // В лог — только числа, без идентификаторов.
    const text = log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('чужих пропущено 5');
    expect(text).not.toMatch(/f-own|t-old/);
  });

  it('генератор не трогает объекты сайтов', async () => {
    const p = provider({
      transcriptions: [
        [{ id: 't-site', created_at: ago(300), client_reference_id: REF }],
      ],
      files: [[{ id: 'f-site', created_at: ago(300), filename: NAME }]],
    });
    const r = await sweepOwnStaleSoniox({
      tag: SONIOX_TAG_GENERATOR,
      key: 'sx',
      fetch: p.fetch,
      now: NOW,
      logger: logger(),
    });
    expect(deletes(p.calls)).toEqual([]);
    expect(r.sonioxForeignSkipped).toBe(2);
  });

  it('за прогон — не больше заданного числа удалений; чисто — молчит', async () => {
    const p = provider({
      files: [
        [
          { id: 'a', created_at: ago(70), filename: NAME },
          { id: 'b', created_at: ago(70), filename: NAME },
        ],
      ],
      transcriptions: [
        [{ id: 'c', created_at: ago(70), client_reference_id: REF }],
      ],
    });
    const r = await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: p.fetch,
      now: NOW,
      logger: logger(),
      maxDeletes: 2,
    });
    expect(r.sonioxFilesDeleted + r.sonioxTranscriptionsDeleted).toBe(2);
    expect(deletes(p.calls)).toHaveLength(2);

    const quiet = logger();
    await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: provider({}).fetch,
      now: NOW,
      logger: quiet,
    });
    expect(quiet.warn).not.toHaveBeenCalled();
  });

  it('список недоступен (код или сеть) или срок вышел — без исключения', async () => {
    const p = provider({ listStatus: 503 });
    await expect(
      sweepOwnStaleSoniox({
        tag: TAG,
        key: 'sx',
        fetch: p.fetch,
        now: NOW,
        logger: logger(),
      }),
    ).resolves.toMatchObject({ sonioxFailed: 2, sonioxFilesDeleted: 0 });
    const broken = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      sweepOwnStaleSoniox({
        tag: TAG,
        key: 'sx',
        fetch: broken as unknown as typeof fetch,
        now: NOW,
      }),
    ).resolves.toMatchObject({ sonioxFailed: 2 });
    const q = provider({
      files: [[{ id: 'a', created_at: ago(70), filename: NAME }]],
    });
    await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: q.fetch,
      now: NOW,
      deadlineMs: -1,
    });
    expect(q.calls).toHaveLength(0);
  });

  it('сеть упала на удалении — сбой, не исключение', async () => {
    const p = provider({
      files: [[{ id: 'a', created_at: ago(70), filename: NAME }]],
    });
    const base = (p.fetch as unknown as jest.Mock).getMockImplementation()!;
    (p.fetch as unknown as jest.Mock).mockImplementation(
      async (url: string, init: RequestInit = {}) => {
        if ((init.method ?? '').toUpperCase() === 'DELETE') {
          throw new TypeError('fetch failed');
        }
        return base(url, init);
      },
    );
    const r = await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: p.fetch,
      now: NOW,
      logger: logger(),
    });
    expect(r).toMatchObject({ sonioxFailed: 1, sonioxFilesDeleted: 0 });
  });

  it('по умолчанию — глобальный fetch и текущее время; сбой сети (не Error) — в лог без текста', async () => {
    const realFetch = global.fetch;
    const fresh = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const p = provider({
      files: [
        [
          { id: 'a', created_at: fresh, filename: NAME },
          { id: 'b', created_at: 12345, filename: NAME },
        ],
      ],
    });
    global.fetch = p.fetch;
    try {
      const r = await sweepOwnStaleSoniox({ tag: TAG, key: 'sx' });
      expect(r.sonioxFilesDeleted).toBe(1);
      expect(deletes(p.calls)).toEqual(['DELETE /files/a']);
    } finally {
      global.fetch = realFetch;
    }
    const log = logger();
    const broken = jest.fn().mockRejectedValue('строка, а не Error');
    await sweepOwnStaleSoniox({
      tag: TAG,
      key: 'sx',
      fetch: broken as unknown as typeof fetch,
      now: NOW,
      logger: log,
    });
    const text = log.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('не получен: string');
    expect(text).not.toContain('строка, а не Error');
  });
});
