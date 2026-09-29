import {
  SonioxSttClient,
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
    expect(r.reason).toContain('bad audio');
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
