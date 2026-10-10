/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import {
  SONIOX_PENDING_DELETE_KEY,
  SONIOX_PENDING_DELETE_MAX_ATTEMPTS,
  SONIOX_PENDING_DELETE_MAX_AGE_MS,
  SonioxSttClient,
  addSonioxPendingDelete,
  applySonioxDeleteOutcomes,
  drainSonioxPendingDeletes,
  enqueueSonioxPendingDelete,
  parseSonioxPendingDeletes,
  sonioxPendingOrder,
  sonioxPendingPath,
  type SonioxPendingDelete,
  billedSeconds,
  dominantSonioxLanguage,
  sonioxTranscriptText,
  sonioxTranscriptionBody,
} from './soniox-stt.client';

const AUDIO = Buffer.from('opus');

type Route = { method: string; path: string; status?: number; body?: unknown };

/** Подставной fetch: отвечает по маршрутам, записывает все вызовы. */
function mockFetch(routes: Route[]) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fn = jest.fn(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.replace('https://api.soniox.com/v1', '');
    calls.push({ method, path, body: init.body });
    const route = routes.find((r) => r.method === method && r.path === path);
    const status = route ? (route.status ?? 200) : 404;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => route?.body ?? {},
      text: async () => JSON.stringify(route?.body ?? {}),
    } as Response;
  });
  global.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

const HAPPY: Route[] = [
  { method: 'POST', path: '/files', body: { id: 'f1' } },
  { method: 'POST', path: '/transcriptions', body: { id: 't1' } },
  { method: 'GET', path: '/transcriptions/t1', body: { status: 'completed' } },
  {
    method: 'GET',
    path: '/transcriptions/t1/transcript',
    body: {
      tokens: [
        { text: 'Мари', end_ms: 400, language: 'uk' },
        { text: 'на,', end_ms: 700, language: 'uk' },
        { text: ' [сміх]', is_audio_event: true, end_ms: 1200 },
        { text: ' серйозніше', end_ms: 2300, language: 'uk' },
        { text: '<end>', end_ms: 2400 },
      ],
    },
  },
  { method: 'DELETE', path: '/transcriptions/t1' },
  { method: 'DELETE', path: '/files/f1' },
];

describe('sonioxTranscriptText', () => {
  it('служебный <end> и звуковые события в текст не попадают; длительность — по последнему токену', () => {
    expect(sonioxTranscriptText(HAPPY[3].body as never)).toEqual({
      text: 'Марина, серйозніше',
      seconds: 2.4,
      language: 'uk',
    });
  });
  it('без токенов — берётся text; пусто — null', () => {
    expect(sonioxTranscriptText({ text: '  так ' })).toEqual({
      text: 'так',
      seconds: 0,
      language: null,
    });
    expect(
      sonioxTranscriptText({ tokens: [{ text: '<end>' }] }).text,
    ).toBeNull();
  });
});

describe('dominantSonioxLanguage — язык речи по фрагментам', () => {
  it('вес — буквы, а не число фрагментов: «ну» не перевешивает фразу', () => {
    expect(
      dominantSonioxLanguage([
        { text: 'ну', language: 'ru' },
        { text: ' ', language: 'ru' },
        { text: 'привітай маму з ювілеєм', language: 'uk' },
      ]),
    ).toBe('uk');
  });
  it('регион отбрасывается, без языка — null', () => {
    expect(dominantSonioxLanguage([{ text: 'hello', language: 'en-US' }])).toBe(
      'en',
    );
    expect(dominantSonioxLanguage([{ text: 'hello' }])).toBeNull();
  });
});

describe('billedSeconds', () => {
  it('длительность от провайдера важнее токенов; нет её — токены', () => {
    expect(billedSeconds(9000, 2.4)).toBe(9);
    expect(billedSeconds(null, 2.4)).toBe(2.4);
    expect(billedSeconds(0, 2.4)).toBe(0);
  });
});

describe('sonioxTranscriptionBody', () => {
  it('подсказки, имена в context.terms, определение языка по фрагментам', () => {
    expect(
      sonioxTranscriptionBody('f1', {
        languageHints: ['uk', 'ru'],
        terms: ['Марина', null, '  ', 'Андрій'],
      }),
    ).toEqual({
      model: 'stt-async-v5',
      file_id: 'f1',
      language_hints: ['uk', 'ru'],
      enable_language_identification: true,
      enable_speaker_diarization: false,
      context: { terms: ['Марина', 'Андрій'] },
    });
  });
  it('строгость — только на повторе и только при подсказках', () => {
    expect(
      sonioxTranscriptionBody('f1', {
        languageHints: ['ru'],
        strictLanguage: true,
      }),
    ).toMatchObject({ language_hints_strict: true });
    const noHints = sonioxTranscriptionBody('f1', {
      languageHints: [],
      strictLanguage: true,
    });
    expect(noHints).not.toHaveProperty('language_hints_strict');
    // Пустые подсказки — «определи сам», а не пустой список.
    expect(noHints).not.toHaveProperty('language_hints');
    expect(noHints).not.toHaveProperty('context');
  });
});

/** Клиент с короткими сроками: ветки срока без реального ожидания. */
function quickClient(): SonioxSttClient {
  const c = new SonioxSttClient();
  c.attemptDeadlineMs = 30;
  c.cleanupGraceMs = 30;
  return c;
}

describe('SonioxSttClient.transcribe', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SONIOX_API_KEY = 'sk';
    process.env.NODE_ENV = 'test';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('нет ключа — причина, ни одного запроса', async () => {
    delete process.env.SONIOX_API_KEY;
    const { fn } = mockFetch(HAPPY);
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: ['uk'],
    });
    expect(r).toEqual({
      text: null,
      reason: 'SONIOX_API_KEY not set',
      seconds: 0,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('успех: загрузка → задача → готово → текст, и ОБА удаления у провайдера', async () => {
    const { calls } = mockFetch(HAPPY);
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: ['uk', 'ru'],
    });
    expect(r).toEqual({
      text: 'Марина, серйозніше',
      seconds: 2.4,
      language: 'uk',
      billable: true,
    });
    const deletes = calls
      .filter((c) => c.method === 'DELETE')
      .map((c) => c.path);
    // Сначала файл: звук уходит от провайдера при любом исходе.
    expect(deletes).toEqual(['/files/f1', '/transcriptions/t1']);
  });

  it('ошибка распознавания у провайдера — причина, и всё равно удаление', async () => {
    const { calls } = mockFetch([
      ...HAPPY.filter(
        (r) => r.path !== '/transcriptions/t1' || r.method !== 'GET',
      ),
      {
        method: 'GET',
        path: '/transcriptions/t1',
        body: { status: 'error', error_message: 'bad audio' },
      },
    ]);
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r.text).toBeNull();
    expect(r.reason).toBe('Soniox: ошибка распознавания');
    expect(JSON.stringify(r)).not.toContain('bad audio');
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });

  it('задачу создать не удалось — файл всё равно удаляется', async () => {
    const { calls } = mockFetch([
      { method: 'POST', path: '/files', body: { id: 'f1' } },
      {
        method: 'POST',
        path: '/transcriptions',
        status: 402,
        body: { error: 'budget' },
      },
      { method: 'DELETE', path: '/files/f1' },
    ]);
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r.text).toBeNull();
    expect(r.reason).toContain('402');
    expect(
      calls.filter((c) => c.method === 'DELETE').map((c) => c.path),
    ).toEqual(['/files/f1']);
  });

  it('не дождались — честная причина; файл удалён ПЕРВЫМ, транскрипция — после 409 и ожидания', async () => {
    // Soniox не даёт удалить транскрипцию, пока она обрабатывается (409),
    // а удалённый файл роняет задачу, которая до него не дошла. Поэтому
    // звук уходит первым при любом исходе.
    let deleteTries = 0;
    const { calls, fn } = mockFetch([
      ...HAPPY.filter(
        (r) =>
          !(
            r.path === '/transcriptions/t1' &&
            ['GET', 'DELETE'].includes(r.method)
          ),
      ),
      {
        method: 'GET',
        path: '/transcriptions/t1',
        body: { status: 'processing', audio_duration_ms: 3500 },
      },
    ]);
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (
        (init.method ?? '').toUpperCase() === 'DELETE' &&
        url.endsWith('/transcriptions/t1')
      ) {
        deleteTries++;
        calls.push({ method: 'DELETE', path: '/transcriptions/t1' });
        const status = deleteTries < 2 ? 409 : 204;
        return {
          ok: status < 300,
          status,
          json: async () => ({}),
          text: async () => '',
        } as Response;
      }
      return base(url, init);
    });
    const r = await quickClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r.reason).toContain('не уложилось');
    // Задача создана — вызов оплачен; секунды — по длительности от Soniox.
    expect(r).toMatchObject({ billable: true, seconds: 3.5 });
    const deletes = calls
      .filter((c) => c.method === 'DELETE')
      .map((c) => c.path);
    expect(deletes[0]).toBe('/files/f1');
    expect(deletes.filter((p) => p === '/transcriptions/t1')).toHaveLength(2);
  });

  it('транскрипция так и не удаляется (всё время 409) — уборка не виснет', async () => {
    const { fn } = mockFetch(HAPPY);
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (url: string, init: RequestInit = {}) => {
      if (
        (init.method ?? '').toUpperCase() === 'DELETE' &&
        url.endsWith('/transcriptions/t1')
      ) {
        return {
          ok: false,
          status: 409,
          json: async () => ({}),
          text: async () => '',
        } as Response;
      }
      return base(url, init);
    });
    const r = await quickClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r.text).toBe('Марина, серйозніше');
  });

  it('счёт — по длительности от Soniox, а не по последнему токену', async () => {
    mockFetch(
      HAPPY.map((r) =>
        r.method === 'GET' && r.path === '/transcriptions/t1'
          ? { ...r, body: { status: 'completed', audio_duration_ms: 9000 } }
          : r,
      ),
    );
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    // Последний токен — 2.4 с, но Soniox выставит счёт за все 9 секунд файла.
    expect(r.seconds).toBe(9);
  });

  it('тишина — не текст, но вызов оплачен', async () => {
    mockFetch(
      HAPPY.map((r) =>
        r.path === '/transcriptions/t1/transcript'
          ? { ...r, body: { tokens: [] } }
          : r.method === 'GET' && r.path === '/transcriptions/t1'
            ? { ...r, body: { status: 'completed', audio_duration_ms: 4000 } }
            : r,
      ),
    );
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r).toMatchObject({
      text: null,
      reason: 'no speech recognised',
      billable: true,
      seconds: 4,
    });
  });

  it('упала загрузка — задачи нет, вызов не оплачен', async () => {
    mockFetch([{ method: 'POST', path: '/files', status: 500 }]);
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r).toMatchObject({ text: null, billable: false });
  });

  it('отказ уборки не портит результат пользователя', async () => {
    mockFetch(
      HAPPY.map((r) => (r.method === 'DELETE' ? { ...r, status: 500 } : r)),
    );
    const r = await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(r.text).toBe('Марина, серйозніше');
  });

  it('ключ уходит заголовком Bearer', async () => {
    const { fn } = mockFetch(HAPPY);
    await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk',
    );
  });
});

// ── C4 захода 8 (ТЗ поздравлений 2.0 стр. 1622): неудалённое у Soniox ──

/** `PlatformSetting` в памяти: CAS `updateMany` по старому значению, P2002 на дубль. */
function settingStore(initial?: SonioxPendingDelete[] | string) {
  let row: { key: string; value: string } | null =
    initial === undefined
      ? null
      : {
          key: SONIOX_PENDING_DELETE_KEY,
          value:
            typeof initial === 'string' ? initial : JSON.stringify(initial),
        };
  const platformSetting = {
    findUnique: jest.fn(async ({ where }: any) =>
      row && where.key === row.key ? { ...row } : null,
    ),
    create: jest.fn(async ({ data }: any) => {
      if (row) throw Object.assign(new Error('unique'), { code: 'P2002' });
      row = { key: data.key, value: data.value };
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (row && row.key === where.key && row.value === where.value) {
        row = { ...row, value: data.value };
        return { count: 1 };
      }
      return { count: 0 };
    }),
  };
  return {
    prisma: { platformSetting } as any,
    platformSetting,
    list: (): SonioxPendingDelete[] | null =>
      row ? (JSON.parse(row.value) as SonioxPendingDelete[]) : null,
    replace: (list: SonioxPendingDelete[]) => {
      row = { key: SONIOX_PENDING_DELETE_KEY, value: JSON.stringify(list) };
    },
  };
}

const quietLogger = () => ({ warn: jest.fn() });
const NOW = new Date('2026-10-07T12:00:00Z');
const entry = (
  over: Partial<SonioxPendingDelete> & { id: string },
): SonioxPendingDelete => ({
  kind: 'transcription',
  since: NOW.toISOString(),
  attempts: 0,
  ...over,
});

describe('очередь неудалённого у Soniox — чистые правила', () => {
  it('разбор: мусор, кривые записи и дубли отбрасываются, id проверяется по форме', () => {
    expect(parseSonioxPendingDeletes(null)).toEqual([]);
    expect(parseSonioxPendingDeletes('не json')).toEqual([]);
    expect(parseSonioxPendingDeletes('{"a":1}')).toEqual([]);
    const since = NOW.toISOString();
    expect(
      parseSonioxPendingDeletes(
        JSON.stringify([
          { kind: 'transcription', id: 't1', since, attempts: 2 },
          { kind: 'transcription', id: 't1', since, attempts: 5 },
          { kind: 'file', id: 'f1', since, attempts: -3, lastStatus: 500 },
          { kind: 'transcription', id: '../../files', since, attempts: 0 },
          { kind: 'model', id: 'x', since, attempts: 0 },
          { kind: 'file', id: 'f2', since: 'вчера', attempts: 0 },
          null,
        ]),
      ),
    ).toEqual([
      { kind: 'transcription', id: 't1', since, attempts: 2 },
      { kind: 'file', id: 'f1', since, attempts: 0, lastStatus: 500 },
    ]);
  });

  it('путь удаления — по виду записи', () => {
    expect(sonioxPendingPath(entry({ id: 't1' }))).toBe('/transcriptions/t1');
    expect(sonioxPendingPath(entry({ id: 'f1', kind: 'file' }))).toBe(
      '/files/f1',
    );
  });

  it('добавление: без дублей, сверх потолка вытесняются самые старые', () => {
    const a = entry({ id: 'a' });
    const same = addSonioxPendingDelete([a], entry({ id: 'a', attempts: 9 }));
    expect(same.list).toEqual([a]);
    expect(same.evicted).toEqual([]);
    // Тот же id, но другой вид — другая запись.
    expect(
      addSonioxPendingDelete([a], entry({ id: 'a', kind: 'file' })).list,
    ).toHaveLength(2);
    const r = addSonioxPendingDelete(
      [a, entry({ id: 'b' })],
      entry({ id: 'c' }),
      2,
    );
    expect(r.list.map((e) => e.id)).toEqual(['b', 'c']);
    expect(r.evicted.map((e) => e.id)).toEqual(['a']);
  });

  it('исходы: удалено/404 — снять, 409 — +1 попытка, попытки или срок вышли — снять, без исхода — не трогать', () => {
    const old = new Date(
      NOW.getTime() - SONIOX_PENDING_DELETE_MAX_AGE_MS,
    ).toISOString();
    const list = [
      entry({ id: 'ok' }),
      entry({ id: 'gone', kind: 'file' }),
      entry({ id: 'busy', attempts: 3 }),
      entry({ id: 'tired', attempts: SONIOX_PENDING_DELETE_MAX_ATTEMPTS - 1 }),
      entry({ id: 'old', since: old }),
      entry({ id: 'later' }),
    ];
    const outcomes = new Map([
      ['transcription:ok', 204],
      ['file:gone', 404],
      ['transcription:busy', 409],
      ['transcription:tired', 409],
      ['transcription:old', 0],
    ]);
    const r = applySonioxDeleteOutcomes(list, outcomes, NOW);
    expect(r.deleted.map((e) => e.id)).toEqual(['ok', 'gone']);
    expect(r.dropped.map((e) => e.id)).toEqual(['tired', 'old']);
    expect(r.list).toEqual([
      {
        ...list[2],
        attempts: 4,
        lastStatus: 409,
        lastAttemptAt: NOW.toISOString(),
      },
      list[5],
    ]);
  });
});

describe('очередь неудалённого у Soniox — запись', () => {
  it('нет строки — создаётся; повтор того же id не дублирует', async () => {
    const st = settingStore();
    const log = quietLogger();
    await expect(
      enqueueSonioxPendingDelete(
        st.prisma,
        'transcription',
        't1',
        409,
        log,
        NOW,
      ),
    ).resolves.toBe(true);
    await enqueueSonioxPendingDelete(
      st.prisma,
      'transcription',
      't1',
      409,
      log,
      NOW,
    );
    expect(st.list()).toEqual([
      {
        kind: 'transcription',
        id: 't1',
        since: NOW.toISOString(),
        attempts: 0,
        lastStatus: 409,
      },
    ]);
  });

  it('гонка: значение поменялось между чтением и записью — перечитать и не потерять чужую запись', async () => {
    const st = settingStore([entry({ id: 'a' })]);
    const realUpdate = st.platformSetting.updateMany.getMockImplementation()!;
    let raced = false;
    st.platformSetting.updateMany.mockImplementation(async (args: any) => {
      if (!raced) {
        raced = true;
        st.replace([entry({ id: 'a' }), entry({ id: 'b' })]);
      }
      return realUpdate(args);
    });
    await enqueueSonioxPendingDelete(
      st.prisma,
      'file',
      'f1',
      0,
      quietLogger(),
      NOW,
    );
    expect(st.list()!.map((e) => e.id)).toEqual(['a', 'b', 'f1']);
    expect(st.platformSetting.updateMany).toHaveBeenCalledTimes(2);
  });

  it('гонка при создании строки (P2002) — перечитать и дописать', async () => {
    const st = settingStore();
    const realCreate = st.platformSetting.create.getMockImplementation()!;
    st.platformSetting.create.mockImplementationOnce(async () => {
      st.replace([entry({ id: 'other' })]);
      return realCreate({
        data: { key: SONIOX_PENDING_DELETE_KEY, value: '[]' },
      });
    });
    await enqueueSonioxPendingDelete(
      st.prisma,
      'transcription',
      't1',
      409,
      quietLogger(),
      NOW,
    );
    expect(st.list()!.map((e) => e.id)).toEqual(['other', 't1']);
  });

  it('база недоступна или её нет — не бросает, id остаётся в логе', async () => {
    const log = quietLogger();
    const broken = {
      platformSetting: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
      },
    } as any;
    await expect(
      enqueueSonioxPendingDelete(broken, 'transcription', 't9', 409, log, NOW),
    ).resolves.toBe(false);
    expect(log.warn.mock.calls[0][0]).toContain('t9');
    await expect(
      enqueueSonioxPendingDelete(undefined, 'file', 'f9', 0, log, NOW),
    ).resolves.toBe(false);
    expect(log.warn.mock.calls[1][0]).toContain('f9');
  });
});

describe('SonioxSttClient — неудалённое уходит в очередь', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SONIOX_API_KEY = 'sk';
    process.env.NODE_ENV = 'test';
  });
  afterAll(() => {
    process.env = saved;
  });

  function client(prisma?: any): SonioxSttClient {
    const c = new SonioxSttClient(prisma);
    c.attemptDeadlineMs = 30;
    c.cleanupGraceMs = 30;
    return c;
  }
  const req = { audio: AUDIO, mimeType: 'audio/webm', languageHints: [] };

  it('транскрипция всё ещё 409 после ожидания — id в очереди, текст пользователю отдан', async () => {
    const st = settingStore();
    mockFetch(
      HAPPY.map((r) =>
        r.method === 'DELETE' && r.path === '/transcriptions/t1'
          ? { ...r, status: 409 }
          : r,
      ),
    );
    const r = await client(st.prisma).transcribe(req);
    expect(r.text).toBe('Марина, серйозніше');
    expect(st.list()).toEqual([
      expect.objectContaining({
        kind: 'transcription',
        id: 't1',
        attempts: 0,
        lastStatus: 409,
      }),
    ]);
  });

  it('сбой удаления файла и транскрипции (500) — обе записи в очереди, без ожидания 409', async () => {
    const st = settingStore();
    const { calls } = mockFetch(
      HAPPY.map((r) => (r.method === 'DELETE' ? { ...r, status: 500 } : r)),
    );
    await client(st.prisma).transcribe(req);
    expect(st.list()!.map((e) => `${e.kind}:${e.id}`)).toEqual([
      'file:f1',
      'transcription:t1',
    ]);
    // 500 — не «ещё обрабатывается»: одна попытка, а не цикл ожидания.
    expect(
      calls.filter(
        (c) => c.method === 'DELETE' && c.path === '/transcriptions/t1',
      ),
    ).toHaveLength(1);
  });

  it('удалено (или 404) — очередь не трогается вовсе', async () => {
    const st = settingStore();
    mockFetch(
      HAPPY.map((r) =>
        r.method === 'DELETE' && r.path === '/files/f1'
          ? { ...r, status: 404 }
          : r,
      ),
    );
    await client(st.prisma).transcribe(req);
    expect(st.platformSetting.findUnique).not.toHaveBeenCalled();
    expect(st.list()).toBeNull();
  });

  it('без базы (как раньше) — не бросает, результат не портится', async () => {
    mockFetch(
      HAPPY.map((r) => (r.method === 'DELETE' ? { ...r, status: 409 } : r)),
    );
    const r = await client().transcribe(req);
    expect(r.text).toBe('Марина, серйозніше');
  });
});

describe('drainSonioxPendingDeletes — повтор метлой', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.SONIOX_API_KEY = 'sk';
  });
  afterAll(() => {
    process.env = saved;
  });

  it('удалено/404 — снято, 409 — ещё попытка, вышли попытки/срок — снято с предупреждением', async () => {
    const old = new Date(
      NOW.getTime() - SONIOX_PENDING_DELETE_MAX_AGE_MS - 1,
    ).toISOString();
    const st = settingStore([
      entry({ id: 't1' }),
      entry({ id: 'f2', kind: 'file' }),
      entry({ id: 't3', attempts: 1 }),
      entry({ id: 't4', attempts: SONIOX_PENDING_DELETE_MAX_ATTEMPTS - 1 }),
      entry({ id: 't5', since: old }),
    ]);
    const { calls } = mockFetch([
      { method: 'DELETE', path: '/transcriptions/t1', status: 204 },
      { method: 'DELETE', path: '/files/f2', status: 404 },
      { method: 'DELETE', path: '/transcriptions/t3', status: 409 },
      { method: 'DELETE', path: '/transcriptions/t4', status: 409 },
      { method: 'DELETE', path: '/transcriptions/t5', status: 500 },
    ]);
    const log = quietLogger();
    const r = await drainSonioxPendingDeletes(st.prisma, log, NOW);
    expect(r).toEqual({ deleted: 2, dropped: 2, left: 1 });
    // Ни разу не пробованные — по времени постановки: t5 (самая старая) первой.
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /transcriptions/t5',
      'DELETE /transcriptions/t1',
      'DELETE /files/f2',
      'DELETE /transcriptions/t3',
      'DELETE /transcriptions/t4',
    ]);
    expect(st.list()).toEqual([
      expect.objectContaining({ id: 't3', attempts: 2, lastStatus: 409 }),
    ]);
    const warned = log.warn.mock.calls.map((c) => c[0] as string).join('\n');
    expect(warned).toContain('t4');
    expect(warned).toContain('t5');
    expect(warned).toContain('вручную');
  });

  it('запись, добавленная распознаванием во время прогона, не теряется', async () => {
    const st = settingStore([entry({ id: 't1' })]);
    const { fn } = mockFetch([
      { method: 'DELETE', path: '/transcriptions/t1', status: 204 },
    ]);
    const base = fn.getMockImplementation()!;
    fn.mockImplementation(async (url: string, init: RequestInit = {}) => {
      st.replace([entry({ id: 't1' }), entry({ id: 'new' })]);
      return base(url, init);
    });
    await drainSonioxPendingDeletes(st.prisma, quietLogger(), NOW);
    expect(st.list()!.map((e) => e.id)).toEqual(['new']);
  });

  it('неудаляемые не держат голову очереди: сначала непробованные, затем давнее всего пробованные', async () => {
    const t = (min: number) =>
      new Date(NOW.getTime() - min * 60_000).toISOString();
    expect(
      sonioxPendingOrder([
        entry({ id: 'stuck', since: t(600), lastAttemptAt: t(1) }),
        entry({ id: 'older-try', since: t(10), lastAttemptAt: t(30) }),
        entry({ id: 'new', since: t(5) }),
        entry({ id: 'newer', since: t(2) }),
      ]).map((e) => e.id),
    ).toEqual(['new', 'newer', 'older-try', 'stuck']);
    // Прогон на 1 место берёт не «застрявшую» голову, а новую запись.
    const st = settingStore([
      entry({ id: 'stuck', since: t(600), attempts: 5, lastAttemptAt: t(1) }),
      entry({ id: 'fresh', since: t(5) }),
    ]);
    const { calls } = mockFetch([
      { method: 'DELETE', path: '/transcriptions/fresh', status: 204 },
    ]);
    await drainSonioxPendingDeletes(st.prisma, quietLogger(), NOW, {
      perRun: 1,
    });
    expect(calls.map((c) => c.path)).toEqual(['/transcriptions/fresh']);
    // Время попытки переживает разбор строки настройки.
    expect(
      parseSonioxPendingDeletes(
        JSON.stringify([
          {
            kind: 'file',
            id: 'f',
            since: t(1),
            attempts: 1,
            lastAttemptAt: t(0),
          },
          {
            kind: 'file',
            id: 'g',
            since: t(1),
            attempts: 1,
            lastAttemptAt: 'х',
          },
        ]),
      ).map((e) => e.lastAttemptAt),
    ).toEqual([t(0), undefined]);
  });

  it('загрузка и задача помечены меткой генератора — уборка по списку отличит своё', async () => {
    process.env.NODE_ENV = 'test';
    const { calls } = mockFetch(HAPPY);
    await new SonioxSttClient().transcribe({
      audio: AUDIO,
      mimeType: 'audio/webm',
      languageHints: [],
    });
    const upload = calls.find((c) => c.path === '/files')!.body as FormData;
    expect(upload.get('client_reference_id')).toBe('v4c-gen:stt');
    expect((upload.get('file') as File).name).toBe('v4c-gen-stt');
    const created = calls.find(
      (c) => c.method === 'POST' && c.path === '/transcriptions',
    )!;
    expect(JSON.parse(String(created.body))).toMatchObject({
      file_id: 'f1',
      client_reference_id: 'v4c-gen:stt',
    });
  });

  it('за прогон — не больше заданного числа удалений, остальное ждёт', async () => {
    const st = settingStore([
      entry({ id: 'a' }),
      entry({ id: 'b' }),
      entry({ id: 'c' }),
    ]);
    const { calls } = mockFetch([
      { method: 'DELETE', path: '/transcriptions/a', status: 204 },
      { method: 'DELETE', path: '/transcriptions/b', status: 204 },
      { method: 'DELETE', path: '/transcriptions/c', status: 204 },
    ]);
    const r = await drainSonioxPendingDeletes(st.prisma, quietLogger(), NOW, {
      perRun: 2,
    });
    expect(calls).toHaveLength(2);
    expect(r).toEqual({ deleted: 2, dropped: 0, left: 1 });
    expect(st.list()!.map((e) => e.id)).toEqual(['c']);
  });

  it('пустая очередь — ни одного запроса; нет ключа — очередь цела', async () => {
    const { fn } = mockFetch([]);
    await expect(
      drainSonioxPendingDeletes(settingStore().prisma, quietLogger(), NOW),
    ).resolves.toEqual({ deleted: 0, dropped: 0, left: 0 });
    delete process.env.SONIOX_API_KEY;
    const st = settingStore([entry({ id: 't1' })]);
    await expect(
      drainSonioxPendingDeletes(st.prisma, quietLogger(), NOW),
    ).resolves.toEqual({ deleted: 0, dropped: 0, left: 1, skipped: true });
    expect(fn).not.toHaveBeenCalled();
    expect(st.list()).toHaveLength(1);
  });

  it('сбой базы — не бросает', async () => {
    const broken = {
      platformSetting: {
        findUnique: jest.fn().mockRejectedValue(new Error('db down')),
      },
    } as any;
    await expect(
      drainSonioxPendingDeletes(broken, quietLogger(), NOW),
    ).resolves.toEqual({ deleted: 0, dropped: 0, left: 0 });
  });
});
