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
import { SiteSonioxStt } from './soniox-stt.client';

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
