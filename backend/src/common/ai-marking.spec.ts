/**
 * Маркировка ИИ в метаданных MP4 (В-6, заход 8 C11): что пишется, что
 * не пропускается в команду, и — если в среде есть настоящий ffmpeg —
 * что метка действительно оказывается в файле и переживает следующие
 * проходы (экспорт формата, водяной знак). Без ffmpeg последний блок
 * пропускается: в CI его может не быть, а платный ffmpeg-api в тестах
 * не зовём.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { aiMarkingRequired, aiVideoMetadata, metadataArgs } from './ai-marking';
import { planPostProduction, PostProdError } from './postprod';
import { planReframe } from './reframe';
import { buildWatermarkPlan } from './watermark';

describe('aiVideoMetadata', () => {
  it('у любого поздравления — ai_generated и термин IPTC', () => {
    const meta = aiVideoMetadata({ usesPersona: false });
    expect(meta.comment).toBe(
      'ai_generated=1;digital_source_type=trainedAlgorithmicMedia',
    );
    expect(meta.description).toBe('AI-generated video');
    expect(aiVideoMetadata({}).comment).toBe(meta.comment);
  });

  it('с персоной — ещё и ai_persona=1', () => {
    const meta = aiVideoMetadata({ usesPersona: true });
    expect(meta.comment).toBe(
      'ai_generated=1;digital_source_type=trainedAlgorithmicMedia;ai_persona=1',
    );
    expect(meta.description).toContain('real person');
  });

  it('товарный ролик (снимка поздравления нет) — базовая метка без ai_persona', () => {
    for (const none of [null, undefined]) {
      expect(aiVideoMetadata(none)).toEqual({
        comment: 'ai_generated=1;digital_source_type=trainedAlgorithmicMedia',
        description: 'AI-generated video',
      });
    }
  });

  it('отдельный проход ради метки — только у ролика с персоной', () => {
    expect(aiMarkingRequired({ usesPersona: true })).toBe(true);
    expect(aiMarkingRequired({ usesPersona: false })).toBe(false);
    expect(aiMarkingRequired({})).toBe(false);
    expect(aiMarkingRequired(null)).toBe(false);
  });
});

describe('metadataArgs', () => {
  it('по аргументу на тег, значение в кавычках', () => {
    expect(metadataArgs({ comment: 'ai_generated=1' })).toEqual([
      '-metadata "comment=ai_generated=1"',
    ]);
    expect(metadataArgs(null)).toEqual([]);
  });

  it('кавычка, подстановка входа и перевод строки не проходят', () => {
    for (const value of ['a"b', 'x {{source}}', 'a\nb', '', 'a$(id)']) {
      expect(() => metadataArgs({ comment: value })).toThrow(
        /недопустимый тег/,
      );
    }
    expect(() => metadataArgs({ 'bad key': 'x' })).toThrow(/недопустимый тег/);
  });
});

describe('planPostProduction с меткой', () => {
  it('одна метка — тоже работа: пересборка потоком без перекодирования', () => {
    const plan = planPostProduction({
      metadata: aiVideoMetadata({ usesPersona: true }),
      metadataOnly: true,
    });
    expect(plan.command).toBe(
      '-i {{source}} -map 0:v -map 0:a? -c:v copy -c:a copy ' +
        '-metadata "comment=ai_generated=1;digital_source_type=trainedAlgorithmicMedia;ai_persona=1" ' +
        '-metadata "description=AI-generated video with a synthetic likeness or voice of a real person" ' +
        '-movflags +faststart {{final.mp4}}',
    );
  });

  it('метка без другой работы и без разрешения — задачи нет (платный -c copy не заводим)', () => {
    expect(() =>
      planPostProduction({ metadata: aiVideoMetadata(null) }),
    ).toThrow(PostProdError);
  });

  it('без метки и без работы — по-прежнему отказ', () => {
    expect(() => planPostProduction({ metadata: null })).toThrow(PostProdError);
  });
});

const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync('ffprobe', ['-version']).status === 0;
const withFfmpeg = hasFfmpeg ? describe : describe.skip;

withFfmpeg('настоящий ffmpeg: метка в файле', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-marking-'));
    const made = spawnSync('ffmpeg', [
      ...['-v', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=24:duration=1'],
      ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'],
      ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
      ...['-shortest', join(dir, 'source.mp4')],
    ]);
    if (made.status !== 0) throw new Error(String(made.stderr));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Команда хостед-ffmpeg с `{{ключ}}` → локальный прогон. */
  function run(command: string, files: Record<string, string>): void {
    const local = command.replace(/\{\{([^}]+)\}\}/g, (_, key: string) =>
      join(dir, files[key] ?? key),
    );
    const r = spawnSync('bash', ['-c', `ffmpeg -v error -y ${local}`]);
    if (r.status !== 0) throw new Error(String(r.stderr));
  }

  function tags(file: string): Record<string, string> {
    const r = spawnSync('ffprobe', [
      ...['-v', 'error', '-of', 'json', '-show_entries', 'format_tags'],
      join(dir, file),
    ]);
    return ((JSON.parse(String(r.stdout)) as { format?: { tags?: object } })
      .format?.tags ?? {}) as Record<string, string>;
  }

  it('сборка пишет comment и description, следующие проходы их сохраняют', () => {
    const plan = planPostProduction({
      metadata: aiVideoMetadata({ usesPersona: true }),
      metadataOnly: true,
    });
    run(plan.command, { source: 'source.mp4' });
    const final = tags('final.mp4');
    expect(final.comment).toBe(
      'ai_generated=1;digital_source_type=trainedAlgorithmicMedia;ai_persona=1',
    );
    expect(final.description).toContain('AI-generated');

    // Экспорт другого формата берёт готовый файл — метка едет сама.
    const reframe = planReframe({
      targetAspectRatio: '4:5',
      outputName: 'export.mp4',
    });
    run(reframe.command, { source: 'final.mp4' });
    expect(tags('export.mp4').comment).toBe(final.comment);

    // Водяной знак (drawtext) — только если в сборке ffmpeg есть шрифты.
    const wm = buildWatermarkPlan('viral4creators', 'SLIGHT');
    try {
      run(wm.command, { input: 'final.mp4' });
    } catch {
      return;
    }
    expect(tags('watermarked.mp4').comment).toBe(final.comment);
  });
});
