/**
 * Ядро прогона замеров: план → вызовы → строки результата. Провайдеры
 * передаются снаружи (`Providers`): живые собирает `providers.ts` из
 * клиентов продукта, тест — двойники без сети. Деньги — через `Budget`:
 * перед КАЖДЫМ платным вызовом проверяется, что его оценка влезает в
 * остаток потолка; не влезает — прогон останавливается с частичным
 * отчётом, а не уходит за потолок.
 *
 * Распознавание повторяет правила продукта (§4А.3,
 * `GreetingVoiceService.recognizeRecording`): подсказки языка —
 * `voiceLanguageHints`, имена брифа — подсказкой, неречевое вырезается
 * (`stripNonSpeech`), ответ латиницей на кириллице — ОДИН повтор со
 * строгим требованием письменности (`needsScriptRetry`). Иначе замер
 * мерил бы не то, что получит человек.
 */
import {
  mourningKeyword,
  resolveOtherRegister,
} from '../../src/common/greeting-policy';
import {
  needsScriptRetry,
  stripNonSpeech,
  voiceLanguageHints,
} from '../../src/common/greeting-voice';
import type { GreetingRegister } from '../../src/common/types/greeting.types';
import { encodeWav, framed, noisyFramed, seedOf } from './audio';
import { guessCyrillicLanguage } from './metrics';
import {
  classifyCostMicro,
  hintsOf,
  sttCostMicro,
  synthCostMicro,
  type EvalPlan,
  type Engine,
} from './plan';
import type { SpeechLanguage, SpeechTag } from './speech-set';

export interface RecognizeRequest {
  /** Подсказки языка по убыванию вероятности. */
  hints: string[];
  /** Имена брифа — подсказка распознаванию. */
  names: string[];
  /** Повтор после ответа латиницей. */
  strict: boolean;
}

/** Сколько пустых ответов классификатора подряд считать «модель не отвечает». */
export const CLASSIFIER_SILENT_LIMIT = 5;

export interface Providers {
  classify(text: string): Promise<{
    register: GreetingRegister | null;
    micro: number;
    /** Почему ответа нет: причина и `finishReason` модели. */
    why?: string;
  }>;
  synthesize(
    text: string,
    lang: SpeechLanguage,
    voice: string,
  ): Promise<{ pcm: Float32Array; micro: number }>;
  recognize(
    engine: Engine,
    wav: Buffer,
    req: RecognizeRequest,
  ): Promise<{
    text: string | null;
    /** Язык речи по звуку — только если провайдер его сообщил. */
    language?: string | null;
    micro: number;
    reason?: string;
  }>;
}

/** Потолок расходов в микродолларах. */
export class Budget {
  spent = 0;
  constructor(readonly capMicro: number) {}
  allows(estimateMicro: number): boolean {
    return this.spent + estimateMicro <= this.capMicro;
  }
  add(micro: number): void {
    this.spent += Math.max(0, micro);
  }
}

export interface ClassRow {
  id: string;
  lang: string;
  label: GreetingRegister;
  predicted: GreetingRegister | null;
  /** Совпавшее ключевое слово траура (§3.4 п.2) — для разбора. */
  keyword: string | null;
  /** Итог цепочки без ответа человека: ключевые слова + классификатор. */
  pipeline: GreetingRegister;
  /** Пустой ответ — почему (`empty-answer finishReason=MAX_TOKENS` и т.п.). */
  why?: string;
}

export interface SttRow {
  id: string;
  lang: SpeechLanguage;
  voice: string;
  snr: number | null;
  noise: string | null;
  engine: Engine;
  refs: string[];
  names: string[];
  tags: SpeechTag[];
  /** Итог — после повтора, если он был. */
  hypothesis: string | null;
  /** Первая попытка — до повтора. */
  first: string | null;
  retried: boolean;
  /** Язык ответа: по звуку (провайдер) или по буквам. */
  language: string | null;
  languageSource: 'provider' | 'letters' | null;
  reason?: string;
}

export interface RunResult {
  classRows: ClassRow[];
  sttRows: SttRow[];
  /** Почему прогон остановлен раньше; `null` — дошёл до конца. */
  stopped: string | null;
  spentMicro: number;
}

/** Ход прогона — для строки прогресса (печатается всегда, не только с --verbose). */
export interface ProgressEvent {
  stage: 'классификатор' | 'синтез' | 'распознавание';
  done: number;
  total: number;
  spentMicro: number;
  /** Сколько ответов этой стадии пришли пустыми. */
  empty: number;
  /** Длительность последнего вызова, мс. */
  lastMs: number;
}

export interface RunHooks {
  progress?: (e: ProgressEvent) => void;
  /** Вызов идёт дольше обычного: каждые `waitEveryMs` — сколько ждём. */
  waiting?: (stage: ProgressEvent['stage'], label: string, ms: number) => void;
  waitEveryMs?: number;
}

/** Ждёт вызов провайдера, сообщая о долгом ожидании; возвращает и время. */
async function timed<T>(
  hooks: RunHooks,
  stage: ProgressEvent['stage'],
  label: string,
  call: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  const every = hooks.waitEveryMs ?? 20_000;
  const timer = hooks.waiting
    ? setInterval(
        () => hooks.waiting!(stage, label, Date.now() - started),
        every,
      )
    : null;
  try {
    const value = await call();
    return { value, ms: Date.now() - started };
  } finally {
    if (timer) clearInterval(timer);
  }
}

export async function runEval(
  plan: EvalPlan,
  providers: Providers,
  budget: Budget,
  log: (line: string) => void = () => undefined,
  hooks: RunHooks = {},
): Promise<RunResult> {
  const classRows: ClassRow[] = [];
  const sttRows: SttRow[] = [];
  const stop = (why: string): RunResult => ({
    classRows,
    sttRows,
    stopped: why,
    spentMicro: budget.spent,
  });

  // Классификатор продукта глотает сбои модели (ответ null). Пять пустых
  // ответов подряд без расхода — модель не отвечает вовсе (неверный ключ,
  // нет сети): отчёт из одних «—» бесполезен, останавливаемся сразу.
  let silent = 0;
  let classEmpty = 0;
  for (const t of plan.classify) {
    const est = classifyCostMicro(t.text);
    if (!budget.allows(est))
      return stop(`потолок: классификатор на ${t.id}.${t.lang}`);
    const { value: r, ms } = await timed(
      hooks,
      'классификатор',
      `${t.id}.${t.lang}`,
      () => providers.classify(t.text),
    );
    budget.add(r.micro);
    if (r.register === null) classEmpty++;
    hooks.progress?.({
      stage: 'классификатор',
      done: classRows.length + 1,
      total: plan.classify.length,
      spentMicro: budget.spent,
      empty: classEmpty,
      lastMs: ms,
    });
    silent = r.register === null && r.micro === 0 ? silent + 1 : 0;
    if (silent >= CLASSIFIER_SILENT_LIMIT)
      return stop(
        'классификатор не отвечает: 5 пустых ответов подряд без расхода — причина в предупреждениях выше (неверный GEMINI_API_KEY; 402 — закончился баланс проекта Gemini в AI Studio; нет сети)',
      );
    classRows.push({
      id: t.id,
      lang: t.lang,
      label: t.label,
      predicted: r.register,
      keyword: mourningKeyword(t.text),
      pipeline: resolveOtherRegister({ text: t.text, classifier: r.register })
        .register,
      ...(r.register === null && r.why ? { why: r.why } : {}),
    });
    log(`класс ${t.id}.${t.lang}: ${t.label} → ${r.register ?? '—'}`);
  }

  // Синтез — один раз на фразу и голос; шумовые варианты — из него.
  const voiceKey = (id: string, voice: string) => `${id}|${voice}`;
  const synthesized = new Map<string, Float32Array>();
  for (const s of plan.synth) {
    const est = synthCostMicro(s.phrase.text);
    if (!budget.allows(est)) return stop(`потолок: синтез ${s.phrase.id}`);
    const { value: r, ms } = await timed(hooks, 'синтез', s.phrase.id, () =>
      providers.synthesize(s.phrase.text, s.phrase.lang, s.voice),
    );
    budget.add(r.micro);
    synthesized.set(voiceKey(s.phrase.id, s.voice), r.pcm);
    hooks.progress?.({
      stage: 'синтез',
      done: synthesized.size,
      total: plan.synth.length,
      spentMicro: budget.spent,
      empty: 0,
      lastMs: ms,
    });
  }

  let sttEmpty = 0;
  for (const t of plan.stt) {
    const pcm = synthesized.get(voiceKey(t.phrase.id, t.voice));
    if (!pcm) continue;
    const audio =
      t.snr === null || t.noise === null
        ? framed(pcm)
        : noisyFramed(
            pcm,
            t.noise,
            t.snr,
            seedOf(`${t.phrase.id}|${t.voice}|${t.snr}`),
          );
    const wav = encodeWav(audio);
    // Язык поздравления = язык фразы; интерфейс — тот же.
    const hints = voiceLanguageHints(t.phrase.lang, t.phrase.lang);
    const names = hintsOf(t.phrase);
    const est = sttCostMicro(t);
    if (!budget.allows(est))
      return stop(`потолок: распознавание ${t.phrase.id}`);
    const sttLabel = `${t.engine} ${t.phrase.id}`;
    const { value: first, ms: firstMs } = await timed(
      hooks,
      'распознавание',
      sttLabel,
      () => providers.recognize(t.engine, wav, { hints, names, strict: false }),
    );
    budget.add(first.micro);
    let text = stripNonSpeech(first.text);
    let language = first.language ?? null;
    let retried = false;
    let reason = first.reason;
    if (text && needsScriptRetry(text, hints, language)) {
      if (!budget.allows(est)) return stop(`потолок: повтор ${t.phrase.id}`);
      const { value: again } = await timed(
        hooks,
        'распознавание',
        `${sttLabel} (повтор)`,
        () =>
          providers.recognize(t.engine, wav, { hints, names, strict: true }),
      );
      budget.add(again.micro);
      retried = true;
      const second = stripNonSpeech(again.text);
      if (second) {
        text = second;
        language = again.language ?? language;
      }
      reason = again.reason ?? reason;
    }
    const guessed = language ? null : guessCyrillicLanguage(text);
    sttRows.push({
      id: t.phrase.id,
      lang: t.phrase.lang,
      voice: t.voice,
      snr: t.snr,
      noise: t.noise,
      engine: t.engine,
      refs: [t.phrase.text, ...(t.phrase.alt ?? [])],
      names: t.phrase.names ?? [],
      tags: t.phrase.tags,
      hypothesis: text,
      first: stripNonSpeech(first.text),
      retried,
      language: language ?? guessed,
      languageSource: language ? 'provider' : guessed ? 'letters' : null,
      ...(reason && !text ? { reason } : {}),
    });
    if (!text) sttEmpty++;
    hooks.progress?.({
      stage: 'распознавание',
      done: sttRows.length,
      total: plan.stt.length,
      spentMicro: budget.spent,
      empty: sttEmpty,
      lastMs: firstMs,
    });
    log(
      `${t.engine} ${t.phrase.id} ${t.snr === null ? 'чисто' : `${t.noise}${t.snr}`}: ${text ?? `— (${reason ?? 'пусто'})`}`,
    );
  }
  return { classRows, sttRows, stopped: null, spentMicro: budget.spent };
}
