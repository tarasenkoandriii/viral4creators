jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { AudioTrackService } from './audio-track.service';
import { GenerationStatus } from '../../common/types/generation.types';

interface GenerateRequest {
  model: string;
  contents: Array<{ text: string }>;
  config?: Record<string, unknown>;
}

/**
 * Сборка альтернативной дорожки (этап 138, §5 ТЗ).
 *
 * Правила укладки в ролик и промпт проверяются своими тестами
 * (`common/audio-track-fit.spec.ts`, `track-translation.spec.ts`);
 * здесь — порядок ходов и то, что попадает в карточку. Ошибка тут не
 * видна ничем: зритель на чужом языке просто слышит фразу, которая
 * кончилась ничем.
 */
const SPEECH = '0:01 Стальная кружка держит тепло шесть часов';

function build(
  over: {
    durations?: (number | null)[];
    translations?: (string | null)[];
    session?: Record<string, unknown> | null;
    synthesisFails?: boolean;
    /** Посимвольная разметка синтеза (этап 141 после аудита). */
    alignment?: {
      characters: string[];
      starts: number[];
      ends: number[];
    };
  } = {},
) {
  // Два независимых счётчика, а не один: перевод и синтез зовутся по
  // очереди, и общий счётчик сдвигал бы длительность на шаг — тест
  // проверял бы не тот сценарий, который в нём написан.
  const durations = over.durations ?? [4];
  const translations = over.translations ?? ['Steel mug keeps heat'];
  let translateCall = 0;
  let synthCall = 0;

  const rows = new Map<string, Record<string, unknown>>();
  const prisma = {
    videoAudioTrack: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(
        async (args: {
          where: { sessionId_locale: { sessionId: string; locale: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = `${args.where.sessionId_locale.sessionId}:${args.where.sessionId_locale.locale}`;
          const prev = rows.get(key);
          rows.set(key, prev ? { ...prev, ...args.update } : args.create);
          return rows.get(key);
        },
      ),
    },
  };
  const sessions = {
    getSession: jest.fn().mockResolvedValue(
      over.session === undefined
        ? {
            sessionId: 's1',
            locale: 'ru',
            generationPrompt: { finalVoiceoverScript: SPEECH },
            generatedVideo: {
              generatedVideoId: 'v1',
              status: GenerationStatus.COMPLETE,
              downloadUrl: 'https://blob.test/post.mp4',
            },
          }
        : over.session,
    ),
  };
  const blob = {
    uploadBuffer: jest.fn().mockImplementation(async (pathname: string) => ({
      url: `https://blob.test/${pathname}`,
    })),
  };
  const aiUsage = {
    record: jest.fn().mockResolvedValue(undefined),
    recordGemini: jest.fn().mockResolvedValue(undefined),
  };
  const provider = {
    providerKey: 'elevenlabs',
    synthesize: jest.fn(async () =>
      over.synthesisFails
        ? { ok: false, skipped: false, reason: 'провайдер отказал' }
        : {
            ok: true,
            audio: Buffer.from([1, 2, 3]),
            mimeType: 'audio/mpeg',
            characters: 10,
            voiceId: 'v',
            model: 'm',
            durationSeconds:
              durations[Math.min(synthCall++, durations.length - 1)],
            alignment: over.alignment,
          },
    ),
  };
  const tts = { resolve: jest.fn().mockResolvedValue(provider) };
  const ffmpeg = {
    submit: jest.fn().mockResolvedValue({ jobId: 'job-1', status: 'pending' }),
    status: jest.fn(),
  };
  const svc = new AudioTrackService(
    prisma as never,
    sessions as never,
    blob as never,
    aiUsage as never,
    tts as never,
    ffmpeg as never,
  );
  // Параметр объявлен, хотя тело его не читает: без него `mock.calls`
  // типизируется пустым кортежем, и чтение аргумента — ошибка `tsc`,
  // которую песочница увидит только на прогоне CI.
  const generateContent = jest.fn(async (_request: GenerateRequest) => {
    const text =
      translations[Math.min(translateCall++, translations.length - 1)];
    return { text: text ?? '' };
  });
  (svc as unknown as { genai: unknown }).genai = {
    models: { generateContent },
  };
  return {
    svc,
    prisma,
    blob,
    aiUsage,
    provider,
    generateContent,
    rows,
    ffmpeg,
  };
}

const saved = (prisma: { videoAudioTrack: { upsert: jest.Mock } }) => {
  const calls = prisma.videoAudioTrack.upsert.mock.calls;
  return calls[calls.length - 1][0].create ?? {};
};

describe('AudioTrackService', () => {
  it('короткая речь: одна попытка, карточка READY с измеренной длиной', async () => {
    const { svc, prisma, blob, generateContent } = build({ durations: [4] });
    const r = await svc.build('s1', 'de');

    expect(r.status).toBe('READY');
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      'sessions/s1/audio-tracks/de.mp3',
      expect.any(Buffer),
      'audio/mpeg',
    );
    expect(saved(prisma)).toMatchObject({
      locale: 'de',
      status: 'READY',
      attempts: 1,
      voiceSeconds: 4,
      speech: 'Steel mug keeps heat',
      tempoRate: null,
    });
  });

  it('длинная речь: второй перевод — и только он, а не цикл', async () => {
    // Порядок ходов из ТЗ: текст правится ОДИН раз, дальше звук.
    const { svc, prisma, generateContent } = build({
      durations: [12, 6],
      translations: ['Very long line', 'Short line'],
    });
    const r = await svc.build('s1', 'de');

    expect(generateContent).toHaveBeenCalledTimes(2);
    // Второй промпт несёт явное число процентов и прошлый вариант.
    const secondPrompt = generateContent.mock.calls[1][0].contents[0].text;
    expect(secondPrompt).toContain('% shorter');
    expect(secondPrompt).toContain('Very long line');
    expect(r.status).toBe('READY');
    expect(saved(prisma)).toMatchObject({
      attempts: 2,
      speech: 'Short line',
    });
  });

  it('после сокращения всё ещё длинно — ускорение записано в карточку', async () => {
    const { svc, prisma } = build({
      durations: [12, 7.8],
      translations: ['Very long line', 'Still long'],
    });
    await svc.build('s1', 'de');
    const row = saved(prisma);
    expect(row.status).toBe('READY');
    expect(row.tempoRate).toBeGreaterThan(1);
    expect(String(row.note)).toMatch(/ускорена/);
  });

  it('не влезает даже с ускорением — HANDOVER с причиной, а не молча', async () => {
    const { svc, prisma } = build({
      durations: [20, 18],
      translations: ['Very long line', 'Still very long'],
    });
    const r = await svc.build('s1', 'de');
    expect(r.status).toBe('HANDOVER');
    expect(saved(prisma).note).toMatch(/длиннее ролика/);
    // Голос всё равно сохранён: человеку с ним работать.
    expect(saved(prisma).voiceUrl).toContain('audio-tracks/de.mp3');
  });

  it('второй перевод не удался — ход всё равно израсходован', async () => {
    // Иначе следующий прогон снова пойдёт просить короче и снова
    // заплатит за то же самое.
    const { svc, prisma } = build({
      durations: [8, 8],
      translations: ['Very long line', null],
    });
    await svc.build('s1', 'de');
    const row = saved(prisma);
    expect(row.attempts).toBe(1);
    expect(row.speech).toBe('Very long line');
    // Решение принято как «перевод уже сокращали»: дальше только темп.
    expect(row.tempoRate).toBeGreaterThan(1);
  });

  it('отметку «залито» не перебивает даже прямой вызов сборки', async () => {
    // Инвариант держится здесь, а не только в экране админки: подменить
    // файл под отметкой значит оставить человека в уверенности, что
    // залито именно то, что он скачивал.
    const { svc, prisma, generateContent, provider } = build();
    prisma.videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ uploadedAt: new Date() });

    const r = await svc.build('s1', 'de');

    expect(r.status).toBe('READY');
    expect(generateContent).not.toHaveBeenCalled();
    expect(provider.synthesize).not.toHaveBeenCalled();
    expect(prisma.videoAudioTrack.upsert).not.toHaveBeenCalled();
  });

  it('язык оригинала дорожкой не дублируется', async () => {
    const { svc, prisma, generateContent } = build();
    const r = await svc.build('s1', 'ru');
    expect(r.status).toBe('FAILED');
    expect(generateContent).not.toHaveBeenCalled();
    expect(saved(prisma).note).toMatch(/язык оригинала/);
  });

  it('ролика нет или он не готов — карточка FAILED, без вызовов провайдеров', async () => {
    const { svc, generateContent, provider } = build({ session: null });
    expect((await svc.build('s1', 'de')).status).toBe('FAILED');
    expect(generateContent).not.toHaveBeenCalled();
    expect(provider.synthesize).not.toHaveBeenCalled();
  });

  it('отказ синтеза не бросает наружу — карточка с причиной', async () => {
    const { svc, prisma } = build({ synthesisFails: true });
    const r = await svc.build('s1', 'de');
    expect(r.status).toBe('FAILED');
    expect(saved(prisma).note).toMatch(/синтез/);
  });

  it('неизмеренная длительность отдаётся человеку, а не считается нулём', async () => {
    const { svc, prisma } = build({ durations: [null] });
    const r = await svc.build('s1', 'de');
    expect(r.status).toBe('HANDOVER');
    expect(saved(prisma).note).toMatch(/измерить/);
  });

  it('расход пишется двумя строками: перевод и синтез', async () => {
    const { svc, aiUsage } = build();
    await svc.build('s1', 'de');
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ operation: 'track-translate' }),
    );
    expect(aiUsage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'voiceover',
        model: 'elevenlabs-tts',
      }),
    );
  });
});

/**
 * Сборка полного звука (вторая половина этапа 138).
 *
 * Дорожка для YouTube — это ВЕСЬ звук ролика на другом языке, а не один
 * голос. Здесь проверяется, что сборка запускается тогда и только
 * тогда, когда её есть смысл оплачивать, и что готовый файл доезжает до
 * карточки.
 */
describe('AudioTrackService — сборка полного звука', () => {
  it('у влезшей дорожки сборка запускается, и вход source — ИСХОДНЫЙ рендер', async () => {
    // В готовом ролике уже звучит оригинальный голос: собери дорожку из
    // него, и новая речь легла бы поверх старой.
    const { svc, ffmpeg, prisma } = build({
      session: {
        sessionId: 's1',
        locale: 'ru',
        generationPrompt: { finalVoiceoverScript: SPEECH },
        generatedVideo: {
          generatedVideoId: 'v1',
          status: GenerationStatus.COMPLETE,
          renderedUrl: 'https://blob.test/raw.mp4',
          downloadUrl: 'https://blob.test/post.mp4',
        },
      },
    });
    await svc.build('s1', 'de');

    expect(ffmpeg.submit).toHaveBeenCalledTimes(1);
    const job = ffmpeg.submit.mock.calls[0][0];
    expect(job.inputs.source).toBe('https://blob.test/raw.mp4');
    expect(job.inputs.voice).toContain('audio-tracks/de.mp3');
    expect(job.commands[0]).toContain('-vn');
    expect(saved(prisma).mixJobId).toBe('job-1');
  });

  it('у дорожки, ушедшей человеку, сборка НЕ оплачивается заранее', async () => {
    // Человек может поправить реплику руками — платить за сборку до его
    // решения значит платить дважды.
    const { svc, ffmpeg, prisma } = build({
      durations: [20, 18],
      translations: ['Very long line', 'Still very long'],
    });
    await svc.build('s1', 'de');
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    expect(saved(prisma).mixJobId).toBeNull();
  });

  it('ускорение речи уезжает в ту же задачу ffmpeg', async () => {
    const { svc, ffmpeg } = build({
      durations: [12, 7.8],
      translations: ['Very long line', 'Still long'],
    });
    await svc.build('s1', 'de');
    expect(ffmpeg.submit.mock.calls[0][0].commands[0]).toContain('atempo=');
  });

  it('пересборка стирает прежний готовый файл из карточки', async () => {
    // Иначе оператор скачал бы файл от прежнего перевода, думая, что
    // это новый.
    const { svc, prisma } = build();
    await svc.build('s1', 'de');
    const row = saved(prisma);
    expect(row.trackUrl).toBeNull();
    expect(row.mixError).toBeNull();
  });

  it('без файла ролика сборку не запускаем — собирать не из чего', async () => {
    const { svc, ffmpeg, prisma } = build({
      session: {
        sessionId: 's1',
        locale: 'ru',
        generationPrompt: { finalVoiceoverScript: SPEECH },
        generatedVideo: {
          generatedVideoId: 'v1',
          status: GenerationStatus.COMPLETE,
        },
      },
    });
    await svc.build('s1', 'de');
    expect(ffmpeg.submit).not.toHaveBeenCalled();
    // Голос при этом сохранён: он сам по себе полезен человеку.
    expect(saved(prisma).voiceUrl).toContain('audio-tracks/de.mp3');
  });

  it('отказ ffmpeg при запуске не роняет карточку', async () => {
    const { svc, ffmpeg, prisma } = build();
    ffmpeg.submit.mockRejectedValue(new Error('ffmpeg down'));
    const r = await svc.build('s1', 'de');
    expect(r.status).toBe('READY');
    expect(saved(prisma).mixJobId).toBeNull();
  });
});

describe('AudioTrackService.pollMix', () => {
  it('готовую задачу забирает в наше хранилище', async () => {
    const { svc, prisma, blob, ffmpeg } = build();
    (
      prisma as unknown as {
        videoAudioTrack: { findUnique: jest.Mock };
      }
    ).videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ mixJobId: 'job-1', trackUrl: null });
    ffmpeg.status.mockResolvedValue({
      status: 'completed',
      outputs: { 'track.m4a': 'https://ffmpeg.test/track.m4a' },
    });
    global.fetch = jest.fn().mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }) as never;

    await svc.pollMix('s1', 'de');

    expect(blob.uploadBuffer).toHaveBeenCalledWith(
      'sessions/s1/audio-tracks/de-track.m4a',
      expect.any(Buffer),
      'audio/mp4',
    );
    const row = saved(prisma);
    expect(row.trackUrl).toContain('de-track.m4a');
    expect(row.mixJobId).toBeNull();
  });

  it('незавершённую задачу не трогает вовсе', async () => {
    const { svc, prisma, ffmpeg, blob } = build();
    (
      prisma as unknown as {
        videoAudioTrack: { findUnique: jest.Mock };
      }
    ).videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ mixJobId: 'job-1', trackUrl: null });
    ffmpeg.status.mockResolvedValue({ status: 'pending' });

    await svc.pollMix('s1', 'de');

    expect(blob.uploadBuffer).not.toHaveBeenCalled();
    expect(prisma.videoAudioTrack.upsert).not.toHaveBeenCalled();
  });

  it('сетевая икота опроса не гасит уже оплаченную задачу', async () => {
    const { svc, prisma, ffmpeg } = build();
    (
      prisma as unknown as {
        videoAudioTrack: { findUnique: jest.Mock };
      }
    ).videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ mixJobId: 'job-1', trackUrl: null });
    ffmpeg.status.mockRejectedValue(new Error('сеть'));

    await svc.pollMix('s1', 'de');

    // Карточка не тронута: следующий опрос повторит.
    expect(prisma.videoAudioTrack.upsert).not.toHaveBeenCalled();
  });

  it('провал сборки записывается причиной, а не молчанием', async () => {
    const { svc, prisma, ffmpeg } = build();
    (
      prisma as unknown as {
        videoAudioTrack: { findUnique: jest.Mock };
      }
    ).videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ mixJobId: 'job-1', trackUrl: null });
    ffmpeg.status.mockResolvedValue({ status: 'failed', error: 'кодек' });

    await svc.pollMix('s1', 'de');

    expect(saved(prisma).mixError).toBe('кодек');
  });

  it('уже забранную дорожку второй раз не забирает', async () => {
    const { svc, ffmpeg, prisma } = build();
    (
      prisma as unknown as {
        videoAudioTrack: { findUnique: jest.Mock };
      }
    ).videoAudioTrack.findUnique = jest
      .fn()
      .mockResolvedValue({ mixJobId: 'job-1', trackUrl: 'https://ok' });
    await svc.pollMix('s1', 'de');
    expect(ffmpeg.status).not.toHaveBeenCalled();
  });
});

/**
 * Этап 141. Субтитры дорожки: последний невыполненный пункт «Делаем»
 * этапа 138. Перевод стал построчным ради них — и заодно ради пауз в
 * самой речи.
 */
describe('AudioTrackService — субтитры дорожки (этап 141)', () => {
  const TWO_BEATS = [
    '0:01 Стальная кружка держит тепло',
    '0:04 Шесть часов',
  ].join('\n');
  const twoBeatSession = {
    sessionId: 's1',
    locale: 'ru',
    generationPrompt: { finalVoiceoverScript: TWO_BEATS },
    generatedVideo: {
      generatedVideoId: 'v1',
      status: GenerationStatus.COMPLETE,
      downloadUrl: 'https://blob.test/post.mp4',
    },
  };

  it('в строку дорожки ложится .srt с текстом перевода и секундами оригинала', async () => {
    const { svc, prisma } = build({
      session: twoBeatSession,
      translations: ['1. Steel mug keeps the heat\n2. Six hours'],
      durations: [4],
    });

    await svc.build('s1', 'de');

    const srt = String(saved(prisma).subtitlesSrt);
    expect(srt).toContain('Steel mug keeps the heat');
    expect(srt).toContain('Six hours');
    // Секунды — оригинала: первая реплика в ролике начинается на 0:01.
    expect(srt).toContain('00:00:01,000 --> ');
  });

  it('речь сохраняет разбивку на биты — паузы ролика не склеиваются', async () => {
    // Прежняя редакция брала первую строку ответа и выговаривала всё
    // одной фразой: немецкий голос успевал к середине ролика, а
    // картинка шла дальше.
    const { svc, prisma, generateContent } = build({
      session: twoBeatSession,
      translations: ['1. Steel mug keeps the heat\n2. Six hours'],
    });

    await svc.build('s1', 'de');

    expect(String(saved(prisma).speech).split('\n')).toHaveLength(2);
    // И промпт просил ровно столько строк, сколько битов у оригинала.
    expect(generateContent.mock.calls[0][0].contents[0].text).toContain(
      'exactly 2 lines',
    );
  });

  it('разметка синтеза доезжает до субтитра, а не выбрасывается', async () => {
    // Она приходит тем же вызовом, за который уже заплачено; продукт
    // давно так и делает для вшитых субтитров. Первая редакция этапа
    // её игнорировала (находка аудита).
    const characters = [...'Steel mug keeps the heat Six hours'];
    const { svc, prisma } = build({
      session: twoBeatSession,
      translations: ['1. Steel mug keeps the heat\n2. Six hours'],
      durations: [4],
      alignment: {
        characters,
        // Вторая реплика начинается ровно на 3-й секунде файла голоса.
        starts: characters.map((_, i) => (i < 25 ? 0 : 3)),
        ends: characters.map((_, i) => (i < 25 ? 3 : 4)),
      },
    });

    await svc.build('s1', 'de');

    // Голос вступает на 0:01 — значит вторая реплика на 1 + 3 = 4-й.
    expect(String(saved(prisma).subtitlesSrt)).toContain('\n2\n00:00:04,0');
  });

  it('без разметки субтитр живёт внутри ИЗМЕРЕННОЙ речи, а не до конца ролика', async () => {
    // Недобор штатен: в хвосте играет подложка. Тянуть субтитр до
    // конца ролика значило бы показывать реплику, когда голос уже
    // замолчал (находка аудита).
    const { svc, prisma } = build({
      session: twoBeatSession,
      translations: ['1. Steel mug keeps the heat\n2. Six hours'],
      durations: [4],
    });

    await svc.build('s1', 'de');

    // Речь: 4 секунды от 0:01 — значит субтитр кончается на 0:05.
    const srt = String(saved(prisma).subtitlesSrt);
    expect(srt).toContain('--> 00:00:05,000');
    expect(srt).not.toContain('00:00:08,000');
  });

  it('ускорение речи сжимает и субтитр', async () => {
    // `atempo` стоит ДО `adelay`: ускоряется речь, а не момент её
    // начала. Субтитр, не знающий про ускорение, отставал бы от
    // голоса тем сильнее, чем дальше реплика от начала.
    const characters = [...'Steel mug keeps the heat Six hours'];
    const alignment = {
      characters,
      starts: characters.map((_, i) => (i < 25 ? 0 : 3)),
      ends: characters.map((_, i) => (i < 25 ? 3 : 4)),
    };
    const opts = {
      session: twoBeatSession,
      translations: ['1. Steel mug keeps the heat\n2. Six hours'],
      alignment,
    };

    const fast = build({ ...opts, durations: [12, 7.8] });
    await fast.svc.build('s1', 'de');
    const withTempo = saved(fast.prisma);
    expect(withTempo.tempoRate).toBeGreaterThan(1);

    const slow = build({ ...opts, durations: [4] });
    await slow.svc.build('s1', 'de');
    const noTempo = saved(slow.prisma);
    expect(noTempo.tempoRate ?? null).toBeNull();

    // Без ускорения вторая реплика — на 1 + 3 = 4-й секунде; с
    // ускорением она приезжает раньше.
    expect(String(noTempo.subtitlesSrt)).toContain('\n2\n00:00:04,0');
    expect(String(withTempo.subtitlesSrt)).not.toContain('\n2\n00:00:04,0');
  });

  it('ролик без реплик до субтитров не доходит вовсе', async () => {
    const { svc, prisma } = build({
      session: {
        ...twoBeatSession,
        generationPrompt: { finalVoiceoverScript: '' },
      },
    });

    await svc.build('s1', 'de');

    expect(saved(prisma).subtitlesSrt).toBeUndefined();
  });
});
