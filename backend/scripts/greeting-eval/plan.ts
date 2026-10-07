/**
 * План прогона замеров и его цена — до единого платного вызова.
 *
 * Цена считается по тому же прайсу, что и расход продукта
 * (`src/common/ai-pricing.ts`, `estimateCost`), с запасом в дорогую
 * сторону: выход Gemini — с размышлениями (их модель тратит и на ответ
 * одним словом), звук — по его ставке, повтор при латинице — заложен.
 * Сухой режим печатает эту оценку; живой отказывается стартовать, если
 * она выше потолка (`--max-usd`).
 */
import { estimateCost, formatMicroUsd } from '../../src/common/ai-pricing';
import { GEMINI_MODEL } from '../../src/common/gemini-model';
import { buildGreetingVoicePrompt } from '../../src/common/greeting-voice';
import type { GreetingRegister } from '../../src/common/types/greeting.types';
import {
  EVAL_LANGUAGES,
  OCCASION_SET,
  type EvalLanguage,
  type OccasionScenario,
} from './occasion-set';
import {
  DEFAULT_HINTS,
  SPEECH_SET,
  type SpeechLanguage,
  type SpeechPhrase,
} from './speech-set';
import { FRAME_SECONDS, NOISE_KINDS, type NoiseKind } from './audio';

export type Part = 'classifier' | 'stt';
export type Engine = 'gemini' | 'soniox';

export interface EvalOptions {
  parts: Part[];
  engines: Engine[];
  /** Уровни шума, дБ; `null` — чистая запись. */
  snr: Array<number | null>;
  /** Голоса Soniox TTS. */
  voices: string[];
  /** Языки описаний повода для классификатора. */
  occasionLangs: EvalLanguage[];
  /** Языки фраз распознавания. */
  speechLangs: SpeechLanguage[];
  /** Первые N сюжетов и N фраз на язык — для пробного прогона. */
  limit: number | null;
  /** Потолок расходов, доллары. */
  maxUsd: number;
}

export const DEFAULT_OPTIONS: EvalOptions = {
  parts: ['classifier', 'stt'],
  engines: ['gemini', 'soniox'],
  snr: [null, 20, 10],
  voices: ['Maya'],
  occasionLangs: [...EVAL_LANGUAGES],
  speechLangs: ['ru', 'uk'],
  limit: null,
  maxUsd: 2,
};

export interface ClassifyTask {
  id: string;
  lang: EvalLanguage;
  text: string;
  label: GreetingRegister;
}

export interface SynthTask {
  phrase: SpeechPhrase;
  voice: string;
}

export interface SttTask {
  phrase: SpeechPhrase;
  voice: string;
  snr: number | null;
  noise: NoiseKind | null;
  engine: Engine;
}

export interface EvalPlan {
  options: EvalOptions;
  classify: ClassifyTask[];
  synth: SynthTask[];
  stt: SttTask[];
}

export function hintsOf(p: SpeechPhrase): string[] {
  return p.hints ?? DEFAULT_HINTS[p.lang];
}

export function buildPlan(
  options: EvalOptions,
  occasions: readonly OccasionScenario[] = OCCASION_SET,
  speech: readonly SpeechPhrase[] = SPEECH_SET,
): EvalPlan {
  const classify: ClassifyTask[] = [];
  if (options.parts.includes('classifier')) {
    const scenarios =
      options.limit === null ? occasions : occasions.slice(0, options.limit);
    for (const s of scenarios) {
      for (const lang of options.occasionLangs) {
        classify.push({
          id: s.id,
          lang,
          text: s.text[lang],
          label: s.register,
        });
      }
    }
  }
  const synth: SynthTask[] = [];
  const stt: SttTask[] = [];
  if (options.parts.includes('stt')) {
    for (const lang of options.speechLangs) {
      const all = speech.filter((p) => p.lang === lang);
      const phrases =
        options.limit === null ? all : all.slice(0, options.limit);
      let k = 0;
      for (const phrase of phrases) {
        for (const voice of options.voices) {
          synth.push({ phrase, voice });
          for (const snr of options.snr) {
            // Вид шума — по кругу, чтобы каждый уровень видел все виды.
            const noise =
              snr === null ? null : NOISE_KINDS[k++ % NOISE_KINDS.length];
            for (const engine of options.engines) {
              stt.push({ phrase, voice, snr, noise, engine });
            }
          }
        }
      }
    }
  }
  return { options, classify, synth, stt };
}

// ── Оценка цены ─────────────────────────────────────────────────────────

/** Темп синтеза: ≈ 13 символов в секунду у обычной речи. */
export const CHARS_PER_SECOND = 13;
/** Gemini считает звук по 32 токена на секунду (ai.google.dev, audio). */
export const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;
/** Длина запроса классификатора без описания — с запасом (проверяет тест). */
export const CLASSIFIER_PROMPT_OVERHEAD_CHARS = 700;
/** Потолок выхода классификатора (`maxOutputTokens` в продукте). */
export const CLASSIFIER_OUTPUT_TOKENS = 200;
/** Выход распознавания с размышлениями — с запасом. */
export const GEMINI_STT_OUTPUT_TOKENS = 400;
/** Запас на повтор после ответа латиницей (§4А.3): доля вызовов. */
export const LATIN_RETRY_RESERVE = 0.1;
/** Символов текста в токене (кириллица дороже латиницы — берём худшее). */
const CHARS_PER_TOKEN = 3;

export function speechSeconds(text: string): number {
  return text.length / CHARS_PER_SECOND + FRAME_SECONDS;
}

export function classifyCostMicro(text: string): number {
  return estimateCost(GEMINI_MODEL, {
    inputTokens: Math.ceil(
      (CLASSIFIER_PROMPT_OVERHEAD_CHARS + text.length) / CHARS_PER_TOKEN,
    ),
    outputTokens: CLASSIFIER_OUTPUT_TOKENS,
  }).costMicroUsd;
}

export function synthCostMicro(text: string): number {
  return estimateCost('soniox-tts', { characters: text.length }).costMicroUsd;
}

export function sttCostMicro(task: Pick<SttTask, 'phrase' | 'engine'>): number {
  const seconds = speechSeconds(task.phrase.text);
  if (task.engine === 'soniox') {
    return estimateCost('soniox-stt-async', { seconds }).costMicroUsd;
  }
  const audio = Math.ceil(seconds * GEMINI_AUDIO_TOKENS_PER_SECOND);
  const prompt = buildGreetingVoicePrompt({
    hints: [task.phrase.lang],
    names: hintsOf(task.phrase),
  });
  return estimateCost(GEMINI_MODEL, {
    inputTokens: audio + Math.ceil(prompt.length / CHARS_PER_TOKEN),
    outputTokens: GEMINI_STT_OUTPUT_TOKENS,
    inputByModality: { AUDIO: audio },
  }).costMicroUsd;
}

export interface CostLine {
  what: string;
  calls: number;
  micro: number;
}

export function estimatePlan(plan: EvalPlan): {
  lines: CostLine[];
  totalMicro: number;
} {
  const sum = <T>(xs: readonly T[], f: (x: T) => number) =>
    xs.reduce((a, x) => a + f(x), 0);
  const lines: CostLine[] = [
    {
      what: `классификатор регистра (Gemini ${GEMINI_MODEL})`,
      calls: plan.classify.length,
      micro: sum(plan.classify, (t) => classifyCostMicro(t.text)),
    },
    {
      what: 'синтез речи (Soniox TTS)',
      calls: plan.synth.length,
      micro: sum(plan.synth, (t) => synthCostMicro(t.phrase.text)),
    },
  ];
  for (const engine of ['gemini', 'soniox'] as const) {
    const tasks = plan.stt.filter((t) => t.engine === engine);
    if (!tasks.length) continue;
    const base = sum(tasks, sttCostMicro);
    lines.push({
      what: `распознавание ${engine === 'gemini' ? `Gemini ${GEMINI_MODEL}` : 'Soniox stt-async'} (+${LATIN_RETRY_RESERVE * 100}% на повтор при латинице)`,
      calls: tasks.length,
      micro: Math.round(base * (1 + LATIN_RETRY_RESERVE)),
    });
  }
  const filtered = lines.filter((l) => l.calls > 0);
  return {
    lines: filtered,
    totalMicro: sum(filtered, (l) => l.micro),
  };
}

export function formatEstimate(e: ReturnType<typeof estimatePlan>): string {
  return [
    ...e.lines.map(
      (l) => `  ${l.what}: ${l.calls} вызовов ≈ ${formatMicroUsd(l.micro)}`,
    ),
    `  ИТОГО ≈ ${formatMicroUsd(e.totalMicro)}`,
  ].join('\n');
}
