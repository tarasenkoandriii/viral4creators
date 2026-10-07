/**
 * Живые провайдеры замеров — клиенты продукта, без своих копий запросов:
 *
 * - классификатор — `GreetingRegisterClassifier.classify` (тот же запрос,
 *   разбор и потолок выхода, что при сохранении брифа);
 * - синтез — `SonioxTtsService.synthesize` (mp3) → WAV 16 кГц моно через
 *   ffmpeg, как у Т-1 помощника;
 * - распознавание Gemini — `VoiceTranscriptionService.transcribeWith` с
 *   инструкцией мастера поздравления (`buildGreetingVoicePrompt`), звук —
 *   `inlineData`, у провайдера не остаётся;
 * - распознавание Soniox — `SonioxSttClient.transcribe` (подсказки языка,
 *   имена в `context.terms`, строгий язык на повторе; файл и транскрипт
 *   удаляются у Soniox в `finally` клиента).
 *
 * Модули продукта грузятся здесь лениво: сухой прогон их не трогает и не
 * требует ни ключей, ни собранного клиента базы. Расход в базу НЕ пишется
 * — запись расхода подменена: стоимость считается тут же по `usageMetadata`
 * и прайсу продукта и идёт в потолок прогона.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { estimateCost } from '../../src/common/ai-pricing';
import { GEMINI_MODEL } from '../../src/common/gemini-model';
import { buildGreetingVoicePrompt } from '../../src/common/greeting-voice';
import type { SupportedLocale } from '../../src/common/locale';
import { RATE, decodeWav } from './audio';
import type { Providers } from './runner';

/** Ключи, без которых живой прогон части невозможен (значения не печатаются). */
export function keyStatus(env: NodeJS.ProcessEnv = process.env): {
  gemini: boolean;
  soniox: boolean;
  ffmpeg: boolean;
} {
  let ffmpeg = false;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    ffmpeg = true;
  } catch {
    ffmpeg = false;
  }
  return {
    gemini: !!(env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY),
    soniox: !!env.SONIOX_API_KEY?.trim(),
    ffmpeg,
  };
}

interface UsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** Цена ответа Gemini по его `usageMetadata` — звук по своей ставке. */
export function geminiMicro(meta: UsageMetadata | null | undefined): number {
  if (!meta) return 0;
  const audio = (meta.promptTokensDetails ?? [])
    .filter((d) => String(d.modality).toUpperCase() === 'AUDIO')
    .reduce((a, d) => a + (d.tokenCount ?? 0), 0);
  return estimateCost(GEMINI_MODEL, {
    inputTokens: meta.promptTokenCount ?? 0,
    outputTokens:
      (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0),
    ...(audio ? { inputByModality: { AUDIO: audio } } : {}),
  }).costMicroUsd;
}

/** Подмена записи расхода: запоминает последний `usageMetadata`. */
function usageTap() {
  let last: UsageMetadata | null = null;
  return {
    aiUsage: {
      recordGemini: async (response: { usageMetadata?: UsageMetadata }) => {
        last = response?.usageMetadata ?? null;
      },
      record: async () => undefined,
    },
    take(): UsageMetadata | null {
      const v = last;
      last = null;
      return v;
    },
  };
}

/** mp3 → PCM16 16 кГц моно (ffmpeg). */
function mp3ToPcm(mp3: Buffer): Float32Array {
  const dir = mkdtempSync(join(tmpdir(), 'greeting-eval-'));
  try {
    const src = join(dir, 'in.mp3');
    const dst = join(dir, 'out.wav');
    writeFileSync(src, mp3);
    execFileSync('ffmpeg', [
      '-loglevel',
      'error',
      '-y',
      '-i',
      src,
      '-ac',
      '1',
      '-ar',
      String(RATE),
      '-sample_fmt',
      's16',
      dst,
    ]);
    return decodeWav(readFileSync(dst)).samples;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function liveProviders(): Promise<Providers> {
  const tap = usageTap();
  const [{ GreetingRegisterClassifier }, { SonioxTtsService }, voice, stt] =
    await Promise.all([
      import(
        '../../src/modules/greeting-brief/greeting-register-classifier.service'
      ),
      import('../../src/modules/tts/soniox-tts.service'),
      import('../../src/modules/voice/voice-transcription.service'),
      import('../../src/modules/voice/soniox-stt.client'),
    ]);
  const keys = keyStatus();
  // Память ответов классификатора (C14) — мимо: замер спрашивает модель
  // каждый раз и ничего не сохраняет в базу. `Reflect.construct` — чтобы
  // смена списка зависимостей сервиса не ломала скрипт на типах.
  const noMemory = {
    greetingRegisterAnswer: {
      findUnique: async () => null,
      upsert: async () => undefined,
    },
  };
  const classifier = keys.gemini
    ? (Reflect.construct(GreetingRegisterClassifier, [
        tap.aiUsage,
        noMemory,
      ]) as InstanceType<typeof GreetingRegisterClassifier>)
    : null;
  const tts = new SonioxTtsService();
  const soniox = new stt.SonioxSttClient();
  const transcription = new voice.VoiceTranscriptionService(
    tap.aiUsage as never,
    { get: async () => null } as never,
    soniox,
  );

  return {
    async classify(text) {
      if (!classifier) throw new Error('GEMINI_API_KEY не задан');
      const register = await classifier.classify(text, 'greeting-eval');
      return { register, micro: geminiMicro(tap.take()) };
    },
    async synthesize(text, lang, voiceId) {
      const r = await tts.synthesize({ text, language: lang, voiceId });
      if (!r.ok) throw new Error(`синтез ${lang}: ${r.reason}`);
      return {
        pcm: mp3ToPcm(r.audio),
        micro: estimateCost('soniox-tts', { characters: r.characters })
          .costMicroUsd,
      };
    },
    async recognize(engine, wav, req) {
      if (engine === 'soniox') {
        const r = await soniox.transcribe({
          audio: wav,
          mimeType: 'audio/wav',
          languageHints: req.hints,
          strictLanguage: req.strict,
          terms: req.names,
        });
        return {
          text: r.text,
          language: r.language ?? null,
          reason: r.reason,
          micro: r.billable
            ? estimateCost('soniox-stt-async', { seconds: r.seconds })
                .costMicroUsd
            : 0,
        };
      }
      const r = await transcription.transcribeWith(wav, 'audio/wav', {
        prompt: buildGreetingVoicePrompt({
          hints: req.hints as SupportedLocale[],
          names: req.names,
          strictScript: req.strict,
        }),
        operation: 'voice-assistant-stt',
        userId: null,
      });
      return { text: r.text, reason: r.reason, micro: geminiMicro(tap.take()) };
    },
  };
}
