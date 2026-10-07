/**
 * Клиент распознавания Soniox сайтов (Э5): шов «голос не остаётся у
 * провайдера» — удаление файла и транскрипции в `finally`, — и «нет ПДн в
 * логах»: ни текст распознавания, ни ответ провайдера в лог не попадают.
 * Полные сценарии с деньгами и базой — acceptance/e5/voice.spec.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import { FakeSoniox, fakeRecording } from '../testing/fake-soniox.testing';
import { SiteSonioxStt, sweepStaleSoniox } from './soniox-stt.client';

function client(fake: FakeSoniox): SiteSonioxStt {
  const c = new SiteSonioxStt();
  c.fetch = fake.fetch;
  c.env = { SONIOX_API_KEY: 'sx' };
  c.pollDelayMs = 0;
  c.cleanupGraceMs = 50;
  c.attemptDeadlineMs = 500;
  return c;
}

describe('SiteSonioxStt', () => {
  const logs: string[] = [];
  beforeAll(() => {
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, m)
        .mockImplementation((...args: unknown[]) => {
          logs.push(String(args[0]));
        });
    }
  });
  afterAll(() => jest.restoreAllMocks());

  it('без ключа — ничего не шлёт', async () => {
    const fake = new FakeSoniox();
    const c = client(fake);
    c.env = {};
    expect(c.configured()).toBe(false);
    expect(
      await c.transcribe({
        audio: fakeRecording(),
        mimeType: 'audio/webm',
        languageHints: [],
      }),
    ).toMatchObject({
      text: null,
      reason: 'no_key',
      billable: false,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('языки сайта — подсказкой; авторизация ключом; текст и язык из токенов', async () => {
    const fake = new FakeSoniox();
    fake.transcript = 'Секретний номер 0671234567';
    const r = await client(fake).transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: ['uk', 'ru'],
    });
    expect(r).toMatchObject({
      text: 'Секретний номер 0671234567',
      language: 'uk',
      billable: true,
      seconds: 2.4,
    });
    expect(
      fake.calls.find((c) => c.path === '/transcriptions')?.body,
    ).toMatchObject({ language_hints: ['uk', 'ru'] });
  });

  it('ошибка провайдера с телом — в лог только маршрут и код, без тела и текста', async () => {
    const fake = new FakeSoniox();
    fake.stt = 'create-fails';
    logs.length = 0;
    await client(fake).transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(logs.join('\n')).toMatch(/\/transcriptions 400/);
    expect(logs.join('\n')).not.toMatch(/bad|Секретний|0671234567/);
  });

  it('термины сайта — в context.terms тела транскрипции, в лог не идут; без терминов — без context', async () => {
    const fake = new FakeSoniox();
    logs.length = 0;
    await client(fake).transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: ['uk'],
      terms: ['Запис на консультацію', 'Кошик'],
    });
    expect(
      fake.calls.find((c) => c.path === '/transcriptions')?.body,
    ).toMatchObject({
      context: { terms: ['Запис на консультацію', 'Кошик'] },
    });
    expect(logs.join('\n')).not.toMatch(/консультацію|Кошик/);
    const bare = new FakeSoniox();
    await client(bare).transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: ['uk'],
    });
    expect(
      bare.calls.find((c) => c.path === '/transcriptions')?.body,
    ).not.toHaveProperty('context');
  });

  it('ни одна строка лога не содержит распознанного текста', async () => {
    const fake = new FakeSoniox();
    fake.transcript = 'Мій телефон 0671234567';
    fake.stt = 'busy-delete';
    logs.length = 0;
    await client(fake).transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: [],
    });
    expect(logs.join('\n')).not.toMatch(/0671234567|телефон/);
  });

  it('шов (как check-docs у генератора): DELETE файла и транскрипции — в finally', () => {
    const src = readFileSync(join(__dirname, 'soniox-stt.client.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const fin = src.slice(src.indexOf('} finally {'));
    expect(fin.slice(0, fin.indexOf('}', 12))).toMatch(
      /await this\.cleanup\(key, transcriptionId, fileId\)/,
    );
    const cleanup = src.slice(src.indexOf('private async cleanup('));
    expect(cleanup).toMatch(/\/files\/\$\{fileId\}/);
    expect(cleanup).toMatch(/\/transcriptions\/\$\{transcriptionId\}/);
    expect(src).toMatch(/method: 'DELETE'/);
  });
});

// ── C4 захода 8: метка сайтов и уборка своего в кроне assist-retention ──
// Подробные правила уборки — shared/soniox-sweep.spec.ts (копия источника).
describe('sweepStaleSoniox и метка сайтов', () => {
  const NOW = new Date('2026-10-07T12:00:00Z');
  const old = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();

  it('нет ключа — к провайдеру не ходит', async () => {
    const fetchFn = jest.fn();
    await expect(
      sweepStaleSoniox({
        env: {},
        fetch: fetchFn as unknown as typeof fetch,
        now: NOW,
      }),
    ).resolves.toMatchObject({ sonioxSkipped: true });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('удаляет только объекты с меткой сайтов; генератор и чужие — пропущены', async () => {
    const calls: string[] = [];
    const fetchFn = jest.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push(`${method} ${url.replace('https://api.soniox.com/v1', '')}`);
      if (method === 'GET') {
        const kind = url.includes('/transcriptions?')
          ? 'transcriptions'
          : 'files';
        const items =
          kind === 'transcriptions'
            ? [
                {
                  id: 'site',
                  created_at: old,
                  client_reference_id: 'v4c-sites:stt',
                },
                {
                  id: 'adm',
                  created_at: old,
                  client_reference_id: 'v4c-sites:admin',
                },
                {
                  id: 'gen',
                  created_at: old,
                  client_reference_id: 'v4c-gen:stt',
                },
              ]
            : [{ id: 'fs', created_at: old, filename: 'v4c-sites-stt' }];
        return {
          ok: true,
          status: 200,
          json: async () => ({ [kind]: items, next_page_cursor: null }),
        } as Response;
      }
      return { ok: true, status: 204 } as Response;
    });
    const r = await sweepStaleSoniox({
      env: { SONIOX_API_KEY: 'sx' },
      fetch: fetchFn as unknown as typeof fetch,
      now: NOW,
    });
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([
      'DELETE /files/fs',
      'DELETE /transcriptions/site',
      'DELETE /transcriptions/adm',
    ]);
    expect(r).toMatchObject({
      sonioxFilesDeleted: 1,
      sonioxTranscriptionsDeleted: 2,
      sonioxForeignSkipped: 1,
    });
  });

  it('загрузка и задача посетителя помечены меткой сайтов', async () => {
    const fake = new FakeSoniox();
    const bodies: Array<{ path: string; body: unknown }> = [];
    const base = fake.fetch;
    const c = client(fake);
    c.fetch = (async (url: string, init: RequestInit = {}) => {
      bodies.push({ path: String(url), body: init.body });
      return base(url, init);
    }) as typeof fetch;
    await c.transcribe({
      audio: fakeRecording(),
      mimeType: 'audio/webm',
      languageHints: [],
    });
    const upload = bodies.find((b) => b.path.endsWith('/files'))!
      .body as FormData;
    expect(upload.get('client_reference_id')).toBe('v4c-sites:stt');
    expect((upload.get('file') as File).name).toBe('v4c-sites-stt');
    const created = bodies.find((b) => b.path.endsWith('/transcriptions'))!;
    expect(JSON.parse(String(created.body))).toMatchObject({
      client_reference_id: 'v4c-sites:stt',
    });
  });
});
