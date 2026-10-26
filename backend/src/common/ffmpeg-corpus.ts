/**
 * Корпус реальных запросов к FFmpeg API (ТЗ FFmpeg-server v1.1, этап A).
 *
 * Строится ВЫЗОВОМ самих генераторов команд платформы с типичными и
 * крайними параметрами — никаких строк, переписанных руками. Результат
 * лежит в `ffmpeg-server/test/fixtures/command-corpus.json`; спека
 * `ffmpeg-corpus.spec.ts` регенерирует его и валит CI, если генератор
 * изменился без обновления корпуса (`UPDATE_FFMPEG_CORPUS=1`).
 *
 * Входные URL заменяются синтетическими `https://inputs.test/...`
 * (расширение исходной ссылки сохраняется — оно влияет на демультиплексор
 * у сервера). Текстовые входы (SRT/ASS), которые потребитель строит сам,
 * кладутся в `textInputs` — сервер гоняет по ним настоящий ffmpeg.
 */
import { planPostProduction, planAudioTrackJob } from './postprod';
import { planBatchReframe } from './reframe';
import { buildWatermarkPlan } from './watermark';
import { planPosterFrame } from './poster-frame';
import { aiVideoMetadata } from './ai-marking';
import { stickerOverlay } from './sticker-overlay';
import { buildSrt, SUBTITLE_THEME_FORCE_STYLE } from './subtitles';
import { buildCardsAss } from './greeting-cards';
import {
  planSlideshow,
  planBoundedSlideshow,
  uniformFrames,
  SlideshowFrame,
} from '../modules/tutorial-runner/tutorial-video-assembly';
import { buildTutorialCaptionsAss } from '../modules/tutorial-runner/tutorial-captions';
import {
  planStorySegments,
  StoryPlanSegment,
} from '../modules/story-gifts/story-video-plan';
import { STORY_VIDEO_MIX } from '../modules/story-gifts/story-video-segments';
import { frameSignalsJob } from '../modules/tutorial-quality/demo-quality-frames';
import type { NarratorPreamble } from '../modules/brand-manifest/narrator-preamble';

/** Значения `product` из submit() (Р-FF-6). */
export type FfmpegCorpusProduct =
  | 'postprod'
  | 'actors'
  | 'audio-track'
  | 'portfolio'
  | 'story'
  | 'tutorial-runner'
  | 'tutorial-video-versions'
  | 'shared-video'
  | 'client-site-tutorial'
  | 'tutorial-quality';

export interface FfmpegCorpusEntry {
  id: string;
  product: FfmpegCorpusProduct;
  /** Генератор команды: файл:функция. */
  source: string;
  /** Место вызова `FfmpegApiService.submit()`: файл:метод. */
  callSite: string;
  /** Что проверяет вариант (типичный/крайний). */
  note: string;
  /** false — ветка генератора, которую сегодняшний вызов не включает. */
  live: boolean;
  request: {
    input_files: Record<string, string>;
    output_files: string[];
    ffmpeg_commands: string[];
  };
  /** Содержимое текстовых входов (SRT/ASS), которые строит потребитель. */
  textInputs: Record<string, string>;
}

export interface FfmpegCorpus {
  version: 1;
  generator: string;
  entries: FfmpegCorpusEntry[];
}

const BLOB = 'https://store1.public.blob.vercel-storage.com';

function extOf(url: string): string {
  try {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(new URL(url).pathname);
    return m ? `.${m[1].toLowerCase()}` : '';
  } catch {
    return '';
  }
}

/** Реальные ссылки → синтетические, по ключу входа. */
function synth(
  product: string,
  inputs: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, url] of Object.entries(inputs)) {
    out[key] = url.includes('/story-render-input/')
      ? `https://inputs.test/story-render-input/TOKEN/${url.split('/').pop()}`
      : `https://inputs.test/${product}/${key}${extOf(url)}`;
  }
  return out;
}

const UK_RU_EN = [
  {
    startSeconds: 0.2,
    endSeconds: 1.6,
    text: 'Привіт! Ґанок, їжак, є ще й «лапки».',
  },
  {
    startSeconds: 1.6,
    endSeconds: 3.0,
    text: 'Съешь же ещё этих мягких булок: 100%',
  },
  {
    startSeconds: 3.0,
    endSeconds: 4.2,
    text: "Don't panic — it's 10:30, O'Brien said \"hi\"",
  },
  {
    startSeconds: 4.2,
    endSeconds: 5.5,
    text: 'Шрифт {жирний} \\ слеш; кома, крапка.',
  },
];

function entry(
  e: Omit<FfmpegCorpusEntry, 'request' | 'textInputs'> & {
    inputs: Record<string, string>;
    outputs: string[];
    commands: string[];
    textInputs?: Record<string, string>;
  },
): FfmpegCorpusEntry {
  return {
    id: e.id,
    product: e.product,
    source: e.source,
    callSite: e.callSite,
    note: e.note,
    live: e.live,
    request: {
      input_files: synth(e.product, e.inputs),
      output_files: [...e.outputs],
      ffmpeg_commands: [...e.commands],
    },
    textInputs: e.textInputs ?? {},
  };
}

function postprodEntries(): FfmpegCorpusEntry[] {
  const src = 'backend/src/common/postprod.ts:planPostProduction';
  const start = 'backend/src/modules/postprod/postprod.service.ts:start';
  const srt = buildSrt(UK_RU_EN);
  const cards = buildCardsAss(
    { title: 'З днем народження, Олю!', closing: 'Обіймаю — твій Ґеник' },
    {
      totalDurationSeconds: 8,
      aspectRatio: '9:16',
      credit: 'Music: «Ліс» by Автор (CC-BY)',
    },
  );
  const sticker = stickerOverlay('bottom-right', 1080);
  const out: FfmpegCorpusEntry[] = [];

  const crop = planPostProduction({ targetAspectRatio: '1:1' });
  out.push(
    entry({
      id: 'postprod/crop-only',
      product: 'postprod',
      source: src,
      callSite: start,
      note: 'только кроп 16:9→1:1, звук копируется (-map 0:a?)',
      live: true,
      inputs: { source: `${BLOB}/s/raw.mp4` },
      outputs: [crop.outputName],
      commands: [crop.command],
    }),
  );

  const full = planPostProduction({
    targetAspectRatio: '4:5',
    voiceInputKey: 'voice',
    voiceMode: 'voiceover',
    voiceDelayMs: 480,
    musicInputKey: 'music',
    totalDurationSeconds: 8,
    cardsInputKey: 'cards',
    stickerInputKey: 'sticker',
    stickerScale: sticker.scale,
    stickerX: sticker.x,
    stickerY: sticker.y,
    subtitlesInputKey: 'subs',
    subtitleForceStyle: SUBTITLE_THEME_FORCE_STYLE.classic,
    metadata: aiVideoMetadata({ usesPersona: true }),
  });
  out.push(
    entry({
      id: 'postprod/voiceover-crop-subs-cards-music-sticker',
      product: 'postprod',
      source: src,
      callSite: start,
      note: 'всё сразу: кроп, голос с adelay, подложка atrim/apad, SRT с кириллицей/UK и force_style, ASS-карточки, PNG-наклейка overlay, -metadata с ; и =',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/s/voice.mp3`,
        music: `${BLOB}/music/track.mp3`,
        cards: `${BLOB}/s/cards.ass`,
        sticker: `${BLOB}/stickers/heart.png`,
        subs: `${BLOB}/s/subs.srt`,
      },
      outputs: [full.outputName],
      commands: [full.command],
      textInputs: { subs: srt, cards },
    }),
  );

  const dub = planPostProduction({
    voiceInputKey: 'voice',
    voiceMode: 'dub',
    backgroundInputKeys: ['bg1', 'bg2'],
    musicInputKey: 'music',
    totalDurationSeconds: 8.04,
    voiceDelayMs: 0,
    subtitlesInputKey: 'subs',
    subtitleForceStyle: SUBTITLE_THEME_FORCE_STYLE.bold,
  });
  out.push(
    entry({
      id: 'postprod/dub-two-stems-sidechain',
      product: 'postprod',
      source: src,
      callSite: 'backend/src/modules/postprod/postprod.service.ts:reVoice',
      note: 'дубляж с двумя стемами фона: amix normalize=0 стемов, asplit, aformat, sidechaincompress, loudnorm; тема bold',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/s/voice.mp3`,
        music: `${BLOB}/music/track.mp3`,
        bg1: `${BLOB}/s/background-1.wav`,
        bg2: `${BLOB}/s/background-2.mp3`,
        subs: `${BLOB}/s/subs.srt`,
      },
      outputs: [dub.outputName],
      commands: [dub.command],
      textInputs: { subs: srt },
    }),
  );

  const dub1 = planPostProduction({
    targetAspectRatio: '4:3',
    voiceInputKey: 'voice',
    voiceMode: 'dub',
    backgroundInputKeys: ['bg1'],
    totalDurationSeconds: 6,
    voiceDelayMs: 1200,
  });
  out.push(
    entry({
      id: 'postprod/dub-one-stem',
      product: 'postprod',
      source: src,
      callSite: start,
      note: 'дубляж с одним стемом и кропом 16:9→4:3',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/s/voice.mp3`,
        bg1: `${BLOB}/s/background-1.wav`,
      },
      outputs: [dub1.outputName],
      commands: [dub1.command],
    }),
  );

  const silent = planPostProduction({
    voiceInputKey: 'voice',
    sourceHasNoAudio: true,
    voiceDelayMs: 250,
    subtitlesInputKey: 'subs',
    subtitleForceStyle: SUBTITLE_THEME_FORCE_STYLE.minimal,
  });
  out.push(
    entry({
      id: 'postprod/silent-source-voice-minimal-subs',
      product: 'postprod',
      source: src,
      callSite: start,
      note: 'немой исходник (Grok): голос без [0:a]; тема minimal (BackColour с альфой)',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/s/voice.mp3`,
        subs: `${BLOB}/s/subs.srt`,
      },
      outputs: [silent.outputName],
      commands: [silent.command],
      textInputs: { subs: srt },
    }),
  );

  const meta = planPostProduction({
    metadata: aiVideoMetadata({ usesPersona: true }),
    metadataOnly: true,
  });
  out.push(
    entry({
      id: 'postprod/metadata-only-copy',
      product: 'postprod',
      source: src,
      callSite: start,
      note: 'только метка ИИ: -c:v copy -c:a copy',
      live: true,
      inputs: { source: `${BLOB}/s/raw.mp4` },
      outputs: [meta.outputName],
      commands: [meta.command],
    }),
  );

  const actors = planPostProduction({
    subtitlesInputKey: 'subs',
    subtitleForceStyle: SUBTITLE_THEME_FORCE_STYLE.classic,
    metadata: aiVideoMetadata(null),
  });
  out.push(
    entry({
      id: 'actors/subtitle-burn',
      product: 'actors',
      source: src,
      callSite:
        'backend/src/modules/actors/actors.service.ts:advanceSubtitleBurn',
      note: 'прожиг SRT аватара (кириллица, UK, кавычки, двоеточия)',
      live: true,
      inputs: { source: `${BLOB}/a/raw.mp4`, subs: `${BLOB}/a/subs.srt` },
      outputs: [actors.outputName],
      commands: [actors.command],
      textInputs: { subs: srt },
    }),
  );

  const batch = planBatchReframe(['1:1', '4:5', '9:16', '4:3', '1:1']);
  out.push(
    entry({
      id: 'postprod/autoexport-batch',
      product: 'postprod',
      source: 'backend/src/common/reframe.ts:planBatchReframe',
      callSite: 'backend/src/modules/postprod/postprod.service.ts:startExport',
      note: 'несколько независимых команд и outputs в одной задаче; дубль и родной формат отброшены генератором',
      live: true,
      inputs: { source: `${BLOB}/s/final.mp4` },
      outputs: batch.map((i) => i.outputName),
      commands: batch.map((i) => i.command),
    }),
  );
  return out;
}

function audioTrackEntries(): FfmpegCorpusEntry[] {
  const src = 'backend/src/common/postprod.ts:planAudioTrackJob';
  const call =
    'backend/src/modules/publishing/audio-track.service.ts:submitMix';
  const vo = planAudioTrackJob({
    voiceInputKey: 'voice',
    musicInputKey: 'music',
    mode: 'voiceover',
    tempoRate: 1.08,
    voiceDelayMs: 300,
    totalDurationSeconds: 8,
  });
  const dub = planAudioTrackJob({
    voiceInputKey: 'voice',
    backgroundInputKeys: ['bg1'],
    mode: 'dub',
    tempoRate: null,
    voiceDelayMs: 0,
    totalDurationSeconds: 7.5,
  });
  const silent = planAudioTrackJob({
    voiceInputKey: 'voice',
    mode: 'voiceover',
    sourceHasNoAudio: true,
    tempoRate: 0.95,
    totalDurationSeconds: 6,
  });
  return [
    entry({
      id: 'audio-track/voiceover-music-tempo',
      product: 'audio-track',
      source: src,
      callSite: call,
      note: 'дорожка m4a: atempo, adelay, подложка, apad + -t, -vn',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/t/voice-de.mp3`,
        music: `${BLOB}/music/track.mp3`,
      },
      outputs: [vo.outputName],
      commands: [vo.command],
    }),
    entry({
      id: 'audio-track/dub-stem',
      product: 'audio-track',
      source: src,
      callSite: call,
      note: 'дубляж со стемом: sidechaincompress',
      live: true,
      inputs: {
        source: `${BLOB}/s/raw.mp4`,
        voice: `${BLOB}/t/voice-en.mp3`,
        bg1: `${BLOB}/s/background-1.mp3`,
      },
      outputs: [dub.outputName],
      commands: [dub.command],
    }),
    entry({
      id: 'audio-track/silent-source',
      product: 'audio-track',
      source: src,
      callSite: call,
      note: 'немой исходник: один голос, loudnorm без amix',
      live: true,
      inputs: { source: `${BLOB}/s/raw.mp4`, voice: `${BLOB}/t/voice-uk.mp3` },
      outputs: [silent.outputName],
      commands: [silent.command],
    }),
  ];
}

function portfolioEntries(): FfmpegCorpusEntry[] {
  const src = 'backend/src/common/watermark.ts:buildWatermarkPlan';
  const call =
    'backend/src/modules/portfolio/portfolio-watermark.service.ts:submitJob';
  const cases: Array<
    [string, string, 'SLIGHT' | 'STANDARD' | 'STRONG', string]
  > = [
    [
      'portfolio/watermark-default',
      'viral4creators',
      'STANDARD',
      'знак по умолчанию (SITE_NAME)',
    ],
    [
      'portfolio/watermark-slight-cyrillic',
      'Студія «Ґанок» — їжак',
      'SLIGHT',
      'кириллица и UK в drawtext (нужен шрифт с кириллицей)',
    ],
    [
      'portfolio/watermark-strong-escapes',
      'O\'Brien: 100% \\ "best"',
      'STRONG',
      'крайний случай экранирования drawtext: \' : % \\ " внутри -vf "…"',
    ],
    [
      'portfolio/watermark-shell-chars',
      'Cost $5 `now`, [a];b {x}',
      'STANDARD',
      '$ и обратная кавычка (подстановка shell) и разделители графа в тексте знака — не 422, текст как есть',
    ],
  ];
  return cases.map(([id, text, intensity, note]) => {
    const plan = buildWatermarkPlan(text, intensity);
    return entry({
      id,
      product: 'portfolio',
      source: src,
      callSite: call,
      note,
      live: true,
      inputs: { input: `${BLOB}/portfolio/item.mp4` },
      outputs: [plan.outputName],
      commands: [plan.command],
    });
  });
}

function posterEntries(): FfmpegCorpusEntry[] {
  const plan = planPosterFrame();
  return [
    entry({
      id: 'shared-video/poster',
      product: 'shared-video',
      source: 'backend/src/common/poster-frame.ts:planPosterFrame',
      callSite:
        'backend/src/modules/shared-video/shared-video-poster.service.ts:capture',
      note: 'постер: -ss до -i, -frames:v 1, -q:v, JPEG',
      live: true,
      inputs: { video: `${BLOB}/shared/video.mp4` },
      outputs: [plan.outputName],
      commands: [plan.command],
    }),
  ];
}

function tutorialEntries(): FfmpegCorpusEntry[] {
  const src =
    'backend/src/modules/tutorial-runner/tutorial-video-assembly.ts:planSlideshow';
  const out: FfmpegCorpusEntry[] = [];
  const frameUrl = (i: number) =>
    `${BLOB}/tutorial-video-frames/a1/frame-${i}.png`;

  // Sequential bounded planner: generated commands, never rewritten in fixtures.
  for (const motion of ['none', 'fade', 'fade+zoom'] as const) {
    const frames = Array.from({ length: 9 }, (_, stepIndex) => ({
      stepIndex,
      url: frameUrl(stepIndex),
      seconds: 1.5,
      audioUrl: `${BLOB}/voice/${stepIndex}.mp3`,
    }));
    const plan = planBoundedSlideshow(frames, { motion });
    if (!plan) throw new Error('corpus: bounded plan is null');
    out.push(
      entry({
        id: `tutorial-runner/bounded-${motion}`,
        product: 'tutorial-runner',
        source:
          'backend/src/modules/tutorial-runner/tutorial-video-assembly.ts:planBoundedSlideshow',
        callSite:
          'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
        note: 'Two lossless screen groups and one final composition in a single durable job',
        live: true,
        inputs: plan.inputs,
        outputs: plan.outputs,
        commands: plan.commands,
      }),
    );
  }

  // Обучалка по сайту заказчика, немой путь (uniformFrames + 'none').
  const silentFrames = uniformFrames([0, 1, 2].map(frameUrl));
  const silent = planSlideshow(silentFrames, { motion: 'none' });
  if (!silent) throw new Error('corpus: silent slideshow plan is null');
  out.push(
    entry({
      id: 'client-site-tutorial/silent-uniform',
      product: 'client-site-tutorial',
      source: src,
      callSite:
        'backend/src/modules/client-site-tutorial/client-site-tutorial-admin.service.ts:submitAssembly',
      note: 'немое слайд-шоу: -framerate -loop 1 -t -i, scale/pad/setsar, concat a=0',
      live: true,
      inputs: silent.inputs,
      outputs: silent.outputs,
      commands: silent.commands,
    }),
  );

  // Озвученный путь заказчика: реплика на кадр + подписи + 'fade'.
  const voiced: SlideshowFrame[] = [
    {
      stepIndex: 0,
      url: frameUrl(0),
      seconds: 2.7,
      audioUrl: `${BLOB}/v/0.mp3`,
    },
    { stepIndex: 1, url: frameUrl(1), seconds: 2 },
    {
      stepIndex: 3,
      url: frameUrl(3),
      seconds: 3.1333,
      audioUrl: `${BLOB}/v/3.mp3`,
    },
  ];
  const narration = [
    'Натисніть «Створити» — і ґудзик стане зеленим.',
    null,
    'Нажмите: "Готово"; всё сохранится автоматически.',
  ];
  const assFade = buildTutorialCaptionsAss(
    voiced.map((f, i) => ({ seconds: f.seconds, narration: narration[i] })),
    'fade',
  );
  const fade = planSlideshow(voiced, {
    motion: 'fade',
    captionsUrl: `${BLOB}/tutorial-video-frames/d1/captions.ass`,
  });
  if (!fade) throw new Error('corpus: voiced slideshow plan is null');
  out.push(
    entry({
      id: 'client-site-tutorial/voiced-fade-captions',
      product: 'client-site-tutorial',
      source: src,
      callSite:
        'backend/src/modules/client-site-tutorial/client-site-tutorial-admin.service.ts:submitVoicedAssembly',
      note: 'xfade-переходы, реплики на кадр с anullsrc для немого кадра, atrim end_sample, ASS-подписи UK/RU через subtitles= в filter_complex',
      live: true,
      inputs: fade.inputs,
      outputs: fade.outputs,
      commands: fade.commands,
      textInputs: { captions: assFade },
    }),
  );

  // Сценарный путь: зум + указатель (color/geq/perspective/overlay enable).
  const zoomFrames: SlideshowFrame[] = [
    {
      stepIndex: 0,
      url: frameUrl(0),
      seconds: 2.5,
      audioUrl: `${BLOB}/v/0.mp3`,
      pointer: { x: 0.5, y: 0.8 },
    },
    { stepIndex: 1, url: frameUrl(1), seconds: 3, audioUrl: `${BLOB}/v/1.mp3` },
  ];
  const zoom = planSlideshow(zoomFrames, { motion: 'fade+zoom' });
  if (!zoom) throw new Error('corpus: zoom slideshow plan is null');
  out.push(
    entry({
      id: 'tutorial-runner/zoom-pointer',
      product: 'tutorial-runner',
      source: src,
      callSite:
        'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
      note: 'fade+zoom: perspective eval=frame, кольцо-указатель color+geq+overlay enable=…',
      live: true,
      inputs: zoom.inputs,
      outputs: zoom.outputs,
      commands: zoom.commands,
    }),
  );

  // Production regression: integer/short-decimal examples missed frame-grid precision.
  const fractionalFrames: SlideshowFrame[] = [
    {
      stepIndex: 1,
      url: frameUrl(1),
      seconds: 2.9,
      audioUrl: `${BLOB}/v/1.mp3`,
    },
    {
      stepIndex: 2,
      url: frameUrl(2),
      seconds: 2.25,
      audioUrl: `${BLOB}/v/2.mp3`,
    },
    {
      stepIndex: 3,
      url: frameUrl(3),
      seconds: 3.87,
      audioUrl: `${BLOB}/v/3.mp3`,
      pointer: { x: 0.5, y: 0.7713 },
    },
    {
      stepIndex: 4,
      url: frameUrl(4),
      seconds: 3.5300000000000002,
      audioUrl: `${BLOB}/v/4.mp3`,
    },
  ];
  const fractionalAss = buildTutorialCaptionsAss(
    fractionalFrames.map((f) => ({
      seconds: f.seconds,
      narration: 'Перевірка точності монтажу',
    })),
    'none',
  );
  const fractional = planSlideshow(fractionalFrames, {
    motion: 'none',
    captionsUrl: `${BLOB}/fractional/captions.ass`,
  });
  if (!fractional) throw new Error('corpus: fractional slideshow plan is null');
  out.push(
    entry({
      id: 'tutorial-runner/fractional-frame-grid',
      product: 'tutorial-runner',
      source: src,
      callSite:
        'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
      note: 'Production regression: native JS fractional frame seconds, per-frame audio, pointer and ASS; no rounding or policy-limit change',
      live: true,
      inputs: fractional.inputs,
      outputs: fractional.outputs,
      commands: fractional.commands,
      textInputs: { captions: fractionalAss },
    }),
  );

  // Одна дорожка на весь ролик (вариант А).
  const voFrames = uniformFrames([0, 1].map(frameUrl), 2.4);
  const vo = planSlideshow(voFrames, {
    motion: 'none',
    voiceoverUrl: `${BLOB}/v/voiceover.mp3`,
  });
  if (!vo) throw new Error('corpus: voiceover slideshow plan is null');
  out.push(
    entry({
      id: 'tutorial-runner/single-voiceover',
      product: 'tutorial-runner',
      source: src,
      callSite:
        'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
      note: 'общая дорожка: apad + atrim end_sample, -shortest',
      live: true,
      inputs: vo.inputs,
      outputs: vo.outputs,
      commands: vo.commands,
    }),
  );

  // Версия ролика с преамбулой рассказчика и подписями.
  const preamble: NarratorPreamble = {
    version: 1,
    url: `${BLOB}/brand-manifests/m1/preambles/0b6f3b8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.mp4`,
    pathname:
      'brand-manifests/m1/preambles/0b6f3b8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.mp4',
    seconds: 6.4,
    locale: 'uk',
    approvedAt: '2026-10-01T10:00:00.000Z',
    manifestId: 'm1',
    characterId: null,
    imageUrl: null,
    voiceId: null,
    voiceProvider: null,
  };
  const verFrames: SlideshowFrame[] = [
    { stepIndex: 0, url: frameUrl(0), seconds: 3, audioUrl: `${BLOB}/v/0.mp3` },
    {
      stepIndex: 1,
      url: frameUrl(1),
      seconds: 2.5,
      audioUrl: `${BLOB}/v/1.mp3`,
    },
  ];
  const verAss = buildTutorialCaptionsAss(
    verFrames.map((f, i) => ({
      seconds: f.seconds,
      narration:
        i === 0 ? 'Вітаємо! Це — ваш перший крок.' : 'Готово: їдемо далі.',
    })),
    'none',
  );
  const ver = planSlideshow(verFrames, {
    motion: 'none',
    preamble,
    captionsUrl: `${BLOB}/tutorial-video-frames/a1/versions/v1/captions.ass`,
    outputName: 'tutorial.mp4',
  });
  if (!ver) throw new Error('corpus: version slideshow plan is null');
  out.push(
    entry({
      id: 'tutorial-video-versions/preamble-captions',
      product: 'tutorial-video-versions',
      source: src,
      callSite:
        'backend/src/modules/postprod/tutorial-video-versions.service.ts:submitVersion',
      note: 'преамбула mp4: tpad stop_mode=clone, trim, settb=AVTB, fps, concat n=2 с телом',
      live: true,
      inputs: ver.inputs,
      outputs: ver.outputs,
      commands: ver.commands,
      textInputs: { captions: verAss },
    }),
  );

  // Немая обучалка заказчика с преамбулой: тишина тела —
  // anullsrc=r/cl + atrim=duration (ветка без звука у кадров).
  const silentPre = planSlideshow(uniformFrames([0, 1].map(frameUrl)), {
    motion: 'none',
    preamble,
  });
  if (!silentPre) throw new Error('corpus: silent preamble plan is null');
  out.push(
    entry({
      id: 'client-site-tutorial/silent-preamble',
      product: 'client-site-tutorial',
      source: src,
      callSite:
        'backend/src/modules/client-site-tutorial/client-site-tutorial-admin.service.ts:submitAssembly',
      note: 'немое тело + преамбула: anullsrc=r=…:cl=… с atrim=duration (бесконечный источник ограничен)',
      live: true,
      inputs: silentPre.inputs,
      outputs: silentPre.outputs,
      commands: silentPre.commands,
    }),
  );

  // Реплики на кадр без переходов, у одного кадра реплики нет:
  // anullsrc=…:d=… (ветка overlap = 0).
  const mixed: SlideshowFrame[] = [
    {
      stepIndex: 0,
      url: frameUrl(0),
      seconds: 2.6,
      audioUrl: `${BLOB}/v/0.mp3`,
    },
    { stepIndex: 2, url: frameUrl(2), seconds: 2 },
  ];
  const mixedPlan = planSlideshow(mixed, { motion: 'none' });
  if (!mixedPlan) throw new Error('corpus: mixed slideshow plan is null');
  out.push(
    entry({
      id: 'tutorial-runner/voiced-silent-frame',
      product: 'tutorial-runner',
      source: src,
      callSite:
        'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
      note: 'без переходов: тишина немого кадра — anullsrc=…:d=…, пары [v][a] в concat',
      live: true,
      inputs: mixedPlan.inputs,
      outputs: mixedPlan.outputs,
      commands: mixedPlan.commands,
    }),
  );
  for (const kind of ['whole', 'mixed', 'decorated'] as const) {
    const frames: SlideshowFrame[] = Array.from(
      { length: 9 },
      (_, stepIndex) => ({
        stepIndex,
        url: frameUrl(stepIndex),
        seconds: 1.5,
        ...(kind === 'decorated' || (kind === 'mixed' && stepIndex === 8)
          ? { audioUrl: `${BLOB}/voice/${stepIndex}.mp3` }
          : {}),
      }),
    );
    const ass = buildTutorialCaptionsAss(
      frames.map((f) => ({
        seconds: f.seconds,
        narration: 'Перевірка синхронізації',
      })),
      'fade',
    );
    const plan = planBoundedSlideshow(frames, {
      motion: 'fade',
      ...(kind === 'whole' ? { voiceoverUrl: `${BLOB}/whole.mp3` } : {}),
      ...(kind === 'decorated'
        ? { preamble, captionsUrl: `${BLOB}/captions.ass` }
        : {}),
    });
    if (!plan) throw new Error('corpus: bounded variant is null');
    out.push(
      entry({
        id: `tutorial-runner/bounded-${kind}`,
        product: 'tutorial-runner',
        source:
          'backend/src/modules/tutorial-runner/tutorial-video-assembly.ts:planBoundedSlideshow',
        callSite:
          'backend/src/modules/tutorial-runner/tutorial-scenario-runner.service.ts:submitVideoAssembly',
        note: 'Bounded composition: whole narration, silent part or final preamble/captions',
        live: true,
        inputs: plan.inputs,
        outputs: plan.outputs,
        commands: plan.commands,
        textInputs: kind === 'decorated' ? { captions: ass } : {},
      }),
    );
  }
  return out;
}

function storyEntries(): FfmpegCorpusEntry[] {
  const src =
    'backend/src/modules/story-gifts/story-video-plan.ts:planStorySegments';
  const call = 'backend/src/modules/story-gifts/story-video.service.ts:create';
  const input = (part: string) =>
    `https://api.example/api/story-render-input/TOKEN/${part}`;
  const mk = (
    id: string,
    note: string,
    live: boolean,
    segments: StoryPlanSegment[],
    extra: Partial<Parameters<typeof planStorySegments>[0]> = {},
  ) => {
    const planned = planStorySegments({
      segments,
      baseSeconds: 62.5,
      ...extra,
    });
    return entry({
      id,
      product: 'story',
      source: src,
      callSite: call,
      note,
      live,
      inputs: Object.fromEntries(
        Object.entries(planned.inputs).map(([k, part]) => [k, input(part)]),
      ),
      outputs: planned.outputs,
      commands: planned.commands,
    });
  };
  return [
    mk(
      'story/legacy-intro-main',
      'прежняя раскладка: ведущий `ffmpeg`, -loop 1 -framerate 25, setpts-фактор, concat',
      true,
      [
        { kind: 'intro', seconds: 7.25, visual: 'cover' },
        { kind: 'main', seconds: 61.3, visual: 'base' },
      ],
    ),
    mk(
      'story/segments-recorded-narrator-note-outro',
      'сегменты: своя запись с loudnorm, кадр рассказчика, записка с фото, концовка; mono 48 кГц',
      true,
      [
        { kind: 'intro', seconds: 9.5, visual: 'narrator', normalize: true },
        {
          kind: 'gift_note',
          position: 'beginning',
          seconds: 6,
          visual: 'photo',
        },
        { kind: 'main', seconds: 75, visual: 'base' },
        { kind: 'outro', seconds: 4.2, visual: 'cover' },
      ],
    ),
    mk(
      'story/stems-music-ducking-effects',
      'будущие стемы (STORY_VIDEO_MIX): -stream_loop -1 музыки, asplit + sidechaincompress, amix normalize=0',
      false,
      [
        { kind: 'intro', seconds: 8, visual: 'cover' },
        { kind: 'main', seconds: 80, visual: 'base' },
        { kind: 'gift_note', position: 'end', seconds: 12, visual: 'photo' },
      ],
      {
        music: { volume: STORY_VIDEO_MIX.music },
        effects: { volume: STORY_VIDEO_MIX.effects },
        ducking: STORY_VIDEO_MIX.ducking,
      },
    ),
  ];
}

function qualityEntries(): FfmpegCorpusEntry[] {
  const job = frameSignalsJob(`${BLOB}/tutorial/demo.mp4`);
  return [
    entry({
      id: 'tutorial-quality/frame-signals',
      product: 'tutorial-quality',
      source:
        'backend/src/modules/tutorial-quality/demo-quality-frames.ts:frameSignalsJob',
      callSite:
        'backend/src/modules/tutorial-quality/demo-quality.service.ts:submitSignals',
      note: 'выход пишет ФИЛЬТР (metadata=print:file={{signals.txt}}), сам ffmpeg — в -f null -',
      live: true,
      inputs: job.inputs,
      outputs: job.outputs,
      commands: job.commands,
    }),
  ];
}

export function buildFfmpegCorpus(): FfmpegCorpus {
  return {
    version: 1,
    generator: 'backend/src/common/ffmpeg-corpus.ts:buildFfmpegCorpus',
    entries: [
      ...postprodEntries(),
      ...audioTrackEntries(),
      ...portfolioEntries(),
      ...posterEntries(),
      ...tutorialEntries(),
      ...storyEntries(),
      ...qualityEntries(),
    ],
  };
}

/** Стабильная сериализация файла корпуса (2 пробела, \n в конце). */
export function serializeFfmpegCorpus(corpus: FfmpegCorpus): string {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}
