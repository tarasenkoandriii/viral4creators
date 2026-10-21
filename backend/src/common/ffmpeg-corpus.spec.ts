/**
 * Сверка корпуса команд FFmpeg (ТЗ FFmpeg-server v1.1 §13: «корпус всех
 * генераторов команд репозитория … проходит parser/manifest без ручного
 * изменения строк»).
 *
 * Корпус регенерируется вызовом самих генераторов и сравнивается с файлом
 * `ffmpeg-server/test/fixtures/command-corpus.json`, по которому
 * ffmpeg-server проверяет парсер и executor. Поменяли генератор —
 * обновите корпус:
 *
 *   UPDATE_FFMPEG_CORPUS=1 npx jest src/common/ffmpeg-corpus.spec.ts
 *
 * и прогоните `npx jest test/command` в ffmpeg-server: новая команда
 * должна пройти allowlist сервера (или осознанно расширить его).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildFfmpegCorpus, serializeFfmpegCorpus } from './ffmpeg-corpus';

const CORPUS_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'ffmpeg-server',
  'test',
  'fixtures',
  'command-corpus.json',
);

describe('ffmpeg command corpus', () => {
  const corpus = buildFfmpegCorpus();
  const text = serializeFfmpegCorpus(corpus);

  it('совпадает с ffmpeg-server/test/fixtures/command-corpus.json', () => {
    if (process.env.UPDATE_FFMPEG_CORPUS === '1') {
      writeFileSync(CORPUS_PATH, text, 'utf8');
    }
    let stored: unknown = null;
    try {
      stored = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
    } catch {
      stored = null;
    }
    // Сравнение по содержимому, а не по тексту: форматирование файла
    // (prettier и т.п.) не должно валить CI, изменение команды — должно.
    const fresh = JSON.parse(text) as unknown;
    if (JSON.stringify(stored) !== JSON.stringify(fresh)) {
      throw new Error(
        'Корпус FFmpeg устарел: обновите его — ' +
          'UPDATE_FFMPEG_CORPUS=1 npx jest src/common/ffmpeg-corpus.spec.ts',
      );
    }
    expect(stored).toEqual(fresh);
  });

  it('id уникальны, URL синтетические, у каждого есть потребитель и источник', () => {
    const ids = corpus.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of corpus.entries) {
      expect(e.source).toMatch(/^backend\/src\/.+\.ts:[A-Za-z]+$/);
      expect(e.callSite).toMatch(/^backend\/src\/.+\.ts:[A-Za-z]+$/);
      for (const url of Object.values(e.request.input_files)) {
        expect(url.startsWith('https://inputs.test/')).toBe(true);
      }
      expect(e.request.ffmpeg_commands.length).toBeGreaterThan(0);
      expect(e.request.output_files.length).toBeGreaterThan(0);
    }
  });

  it('покрывает всех потребителей FfmpegApiService.submit()', () => {
    const products = new Set(corpus.entries.map((e) => e.product));
    expect([...products].sort()).toEqual(
      [
        'actors',
        'audio-track',
        'client-site-tutorial',
        'portfolio',
        'postprod',
        'shared-video',
        'story',
        'tutorial-quality',
        'tutorial-runner',
        'tutorial-video-versions',
      ].sort(),
    );
  });
});
