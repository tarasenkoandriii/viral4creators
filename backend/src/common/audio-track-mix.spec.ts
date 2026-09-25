import {
  PostProdError,
  planAudioTrackJob,
  planPostProduction,
} from './postprod';
import { DEFAULT_DUCK } from './postprod';

/**
 * Сборка альтернативной звуковой дорожки (этап 138, §5 ТЗ
 * TZ-Multilingual-YouTube.md).
 *
 * Главное, что здесь проверяется, — дорожка собирается ТЕМ ЖЕ рецептом,
 * что и оригинальный звук. Собери её отдельно «из музыки и голоса», и
 * зритель на немецком получил бы заметно более пустой звук, чем зритель
 * на украинском: в миксе `voiceover` есть ещё и приглушённая дорожка
 * самого ролика — атмосфера и шумы. Заметить это было бы некому до
 * жалоб, поэтому сравнение с обычной сборкой стоит тестом.
 */
const base = {
  voiceInputKey: 'voice',
  mode: 'voiceover' as const,
  totalDurationSeconds: 8,
  voiceDelayMs: 1000,
};

describe('planAudioTrackJob', () => {
  it('приглушённая дорожка ролика в миксе есть — как и у обычной сборки', () => {
    const track = planAudioTrackJob(base);
    const post = planPostProduction({
      voiceInputKey: 'voice',
      voiceMode: 'voiceover',
      voiceDelayMs: 1000,
      totalDurationSeconds: 8,
    });
    expect(track.command).toContain(`[0:a]volume=${DEFAULT_DUCK}[bg]`);
    expect(post.command).toContain(`[0:a]volume=${DEFAULT_DUCK}[bg]`);
    // Тот же микшер и та же нормализация громкости — не переписанные
    // заново числа.
    expect(track.command).toContain('amix=inputs=2:duration=first');
    expect(track.command).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');
  });

  it('на выходе только звук: видеопоток не перекодируется вовсе', () => {
    // Перекодирование картинки — самая дорогая часть обычной задачи, и
    // дорожке она не нужна: YouTube принимает отдельный аудиофайл.
    const plan = planAudioTrackJob(base);
    expect(plan.command).toContain('-vn');
    expect(plan.command).toContain('-c:a aac -b:a 192k');
    expect(plan.command).not.toContain('libx264');
    expect(plan.outputName).toBe('track.m4a');
  });

  it('длина гарантируется с обеих сторон: apad тянет, -t режет', () => {
    // У обычной сборки длину держит видеопоток, здесь его нет — а
    // YouTube ждёт дорожку примерно той же длины, что ролик.
    const plan = planAudioTrackJob(base);
    expect(plan.command).toContain('apad=whole_dur=8');
    expect(plan.command).toContain('-t 8');
  });

  it('ускорение речи — фильтром в этой же задаче, ДО сдвига', () => {
    // Второй проход ffmpeg ради ускорения был бы вторым счётом. А
    // порядок важен: ускоряется сама речь, а не момент её начала.
    const plan = planAudioTrackJob({ ...base, tempoRate: 1.08 });
    expect(plan.command).toContain('[1:a]atempo=1.08,adelay=1000:all=1[vo]');
  });

  it('без ускорения фильтра atempo нет вовсе', () => {
    expect(planAudioTrackJob(base).command).not.toContain('atempo');
    expect(planAudioTrackJob({ ...base, tempoRate: 1 }).command).not.toContain(
      'atempo',
    );
  });

  it('дубляж и немой исходник: дорожки ролика в миксе нет', () => {
    // Режим `dub` выбрасывает звук исходника целиком — это его смысл,
    // и у альтернативной дорожки он должен работать так же.
    expect(planAudioTrackJob({ ...base, mode: 'dub' }).command).not.toContain(
      '[0:a]',
    );
    expect(
      planAudioTrackJob({ ...base, sourceHasNoAudio: true }).command,
    ).not.toContain('[0:a]');
  });

  it('подложка приводится к длине ролика и идёт третьим входом', () => {
    const plan = planAudioTrackJob({ ...base, musicInputKey: 'music' });
    expect(plan.inputKeys).toEqual(['source', 'voice', 'music']);
    expect(plan.command).toContain('[2:a]atrim=0:8,apad=whole_dur=8,volume=');
    expect(plan.command).toContain('amix=inputs=3');
  });

  it('без голоса и без длины задача не создаётся', () => {
    // Молча собранная «дорожка» без речи — это просто копия звука
    // ролика на чужом языке в списке языков.
    expect(() => planAudioTrackJob({ ...base, voiceInputKey: '  ' })).toThrow(
      PostProdError,
    );
    expect(() =>
      planAudioTrackJob({ ...base, totalDurationSeconds: 0 }),
    ).toThrow(PostProdError);
  });
});
