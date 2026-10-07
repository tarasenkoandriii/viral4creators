/**
 * demo-quality-frames.ts — чистые правила захода 7 проверки качества демо
 * (07.10.2026, doc/TUTORIAL-DEMO-QUALITY-SPEC.md):
 *
 *  - режим съёмки (`captureMode`) — из полей ролика, а не догадкой по MP4;
 *  - таймкоды шагов проверяемого ФАЙЛА — у версии темпа они свои
 *    (`planTempo` от того же manifest), исходник — `baseSeconds`;
 *  - контрольные кадры — снимки шагов из manifest с этими таймкодами;
 *  - чёрные/замершие кадры — команда `blackdetect`/`freezedetect` для
 *    ffmpeg-api и разбор её вывода (`metadata=print`);
 *  - переопределение вердикта оператором и блокировка публикации.
 *
 * Сеть, база и деньги — у сервиса; здесь правило проверяется тестами без
 * них, и мутации в нём ловятся этими тестами.
 */

import { isSiteTutorialDemoFamilyKey } from '../tutorial-help/site-tutorial-demo';
import {
  tempoInputs,
  TutorialTimelineManifest,
} from '../tutorial-runner/tutorial-manifest';
import { planTempo } from '../tutorial-runner/tutorial-tempo';
import { frameSpansSeconds } from '../tutorial-runner/tutorial-video-assembly';
import { QualityIssue, QualityVerdict } from './demo-quality-rubric';

// ── режим съёмки ─────────────────────────────────────────────────────

export type DemoCaptureMode = 'client-site' | 'polygon' | 'tma';

/**
 * Режим съёмки ролика: черновик обучалки по сайту заказчика —
 * `client-site`; семейство демо обучающего лендинга (`site-tutorial-demo-*`,
 * витрина-полигон) — `polygon`; всё остальное снимает сценарный раннер в
 * TMA под фикстурой — `tma`.
 */
export function deriveCaptureMode(asset: {
  clientSiteDraftId: string | null;
  subjectKey: string;
}): DemoCaptureMode {
  if (asset.clientSiteDraftId) return 'client-site';
  if (isSiteTutorialDemoFamilyKey(asset.subjectKey)) return 'polygon';
  return 'tma';
}

// ── таймкоды шагов проверяемого файла ────────────────────────────────

export interface StepSpanMs {
  stepIndex: number;
  startMs: number;
  endMs: number;
}

/**
 * Таймкоды кадров ФАЙЛА: `factor` — множитель паузы версии темпа, `null`
 * (или 1) — исходная сетка. `null` — посчитать нельзя (нет manifest,
 * негодный вход планировщика): угадывать по общей длине запрещено.
 */
export function stepSpansMs(
  m: TutorialTimelineManifest | null,
  factor: number | null,
): StepSpanMs[] | null {
  if (!m || m.frames.length === 0) return null;
  let seconds = m.frames.map((f) => f.baseSeconds);
  if (factor !== null && factor !== 1) {
    const plan = planTempo(tempoInputs(m), { factor, motion: m.motion });
    if (!plan) return null;
    seconds = plan.seconds;
  }
  const spans = frameSpansSeconds(
    seconds.map((s) => ({ seconds: s })),
    m.motion,
  );
  return m.frames.map((f, i) => ({
    stepIndex: f.stepIndex,
    startMs: Math.round(spans[i].start * 1000),
    endMs: Math.round(spans[i].end * 1000),
  }));
}

// ── контрольные кадры ────────────────────────────────────────────────

/** Потолок контрольных кадров на проверку — просмотр, не архив. */
export const MAX_CONTROL_FRAMES = 12;

export interface ControlFrame extends StepSpanMs {
  imageUrl: string;
  caption: string | null;
}

/**
 * Контрольные кадры: снимок каждого шага (не больше `MAX_CONTROL_FRAMES`,
 * равномерно, первый и последний — всегда) с таймкодами проверяемого
 * файла. Только постоянные исходники (`storage: 'sources'`): транзитные
 * кадры стираются сразу после сборки, а кадры черновика клиента живут
 * под своим сроком хранения — ссылка на них в отчёте стала бы мёртвой.
 */
export function controlFramesFor(
  m: TutorialTimelineManifest | null,
  factor: number | null,
  max = MAX_CONTROL_FRAMES,
): ControlFrame[] | null {
  if (!m || m.storage !== 'sources') return null;
  const spans = stepSpansMs(m, factor);
  if (!spans) return null;
  const all = m.frames.map((f, i) => ({
    ...spans[i],
    imageUrl: f.image.url,
    caption: f.caption ?? f.speech?.text ?? null,
  }));
  if (all.length <= max) return all;
  const picked = new Set<number>();
  for (let k = 0; k < max; k++) {
    picked.add(Math.round((k * (all.length - 1)) / (max - 1)));
  }
  return [...picked].sort((a, b) => a - b).map((i) => all[i]);
}

// ── чёрные и замершие кадры (ffmpeg-api) ─────────────────────────────

/** Чёрное дольше этого — подозрение (пустое начало/конец, сбой кадра). */
export const BLACK_MIN_SECONDS = 0.5;
/** Порог `freezedetect` по длительности: короче — не замер. */
export const FREEZE_MIN_SECONDS = 1;
/** Замер должен перекрывать границу шага с обеих сторон хотя бы на это. */
export const FREEZE_BOUNDARY_MARGIN_MS = 500;
/** Без плана шагов замер подозрителен, только если длиннее этого. */
export const FREEZE_NO_PLAN_MAX_MS = 12_000;
export const SIGNALS_OUTPUT = 'signals.txt';

/**
 * Команда декодера: оба детектора в одном проходе, итог — построчный
 * вывод метаданных кадров в файл (`metadata=print:file=…`), который
 * сервис забирает как выход. Видео никуда не кодируется (`-f null`).
 */
export function frameSignalsJob(videoUrl: string): {
  inputs: Record<string, string>;
  outputs: string[];
  commands: string[];
} {
  return {
    inputs: { video: videoUrl },
    outputs: [SIGNALS_OUTPUT],
    commands: [
      `-i {{video}} -vf "blackdetect=d=${BLACK_MIN_SECONDS}:pix_th=0.10,` +
        `freezedetect=n=0.001:d=${FREEZE_MIN_SECONDS},` +
        `metadata=mode=print:file={{${SIGNALS_OUTPUT}}}" -an -f null -`,
    ],
  };
}

export interface SignalInterval {
  startMs: number;
  endMs: number;
}

export interface SuspiciousSignal extends SignalInterval {
  kind: 'black' | 'freeze';
  explanation: string;
}

export interface FrameSignals {
  black: SignalInterval[];
  freeze: SignalInterval[];
  suspicious: SuspiciousSignal[];
}

const SIGNAL_LIMIT = 50;

function pairIntervals(
  starts: number[],
  ends: number[],
  durationMs: number,
): SignalInterval[] {
  const out: SignalInterval[] = [];
  const pending = [...ends].sort((a, b) => a - b);
  for (const s of [...starts].sort((a, b) => a - b)) {
    const idx = pending.findIndex((e) => e >= s);
    const end = idx >= 0 ? pending.splice(idx, 1)[0] : durationMs;
    if (end > s) out.push({ startMs: s, endMs: end });
    if (out.length >= SIGNAL_LIMIT) break;
  }
  return out;
}

/**
 * Разбор вывода `metadata=print`: пары `black_start/black_end` и
 * `freeze_start/freeze_end` (секунды). Незакрытый интервал тянется до
 * конца ролика. Мусорные строки игнорируются.
 */
export function parseFrameSignalsOutput(
  text: string,
  durationMs: number,
): { black: SignalInterval[]; freeze: SignalInterval[] } {
  const black = { s: [] as number[], e: [] as number[] };
  const freeze = { s: [] as number[], e: [] as number[] };
  for (const raw of text.split(/\r?\n/)) {
    const m =
      /^lavfi\.(black_start|black_end|freezedetect\.freeze_start|freezedetect\.freeze_end)=(-?[\d.]+)\s*$/.exec(
        raw.trim(),
      );
    if (!m) continue;
    const ms = Math.round(Number(m[2]) * 1000);
    if (!Number.isFinite(ms) || ms < 0) continue;
    if (m[1] === 'black_start') black.s.push(ms);
    else if (m[1] === 'black_end') black.e.push(ms);
    else if (m[1].endsWith('freeze_start')) freeze.s.push(ms);
    else freeze.e.push(ms);
  }
  return {
    black: pairIntervals(black.s, black.e, durationMs),
    freeze: pairIntervals(freeze.s, freeze.e, durationMs),
  };
}

function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)} с`;
}

/**
 * Что из найденного — подозрение. Неподвижный учебный слайд сам по себе
 * не ошибка (спецификация, «Вход и проверка»): замер подозрителен, когда
 * картинка НЕ сменилась на границе шага (перекрывает её с обеих сторон),
 * а без плана шагов — только очень длинный. Чёрное — любое найденное
 * детектором (он уже отсеял короче `BLACK_MIN_SECONDS`).
 */
export function suspiciousSignals(
  found: { black: SignalInterval[]; freeze: SignalInterval[] },
  spans: StepSpanMs[] | null,
): SuspiciousSignal[] {
  const out: SuspiciousSignal[] = [];
  for (const b of found.black) {
    out.push({
      ...b,
      kind: 'black',
      explanation: `чёрный кадр ${fmt(b.startMs)}–${fmt(b.endMs)}`,
    });
  }
  const boundaries = (spans ?? []).slice(1).map((s) => s.startMs);
  for (const f of found.freeze) {
    if (spans) {
      const crossed = boundaries.filter(
        (b) =>
          f.startMs <= b - FREEZE_BOUNDARY_MARGIN_MS &&
          f.endMs >= b + FREEZE_BOUNDARY_MARGIN_MS,
      );
      if (crossed.length > 0) {
        out.push({
          ...f,
          kind: 'freeze',
          explanation: `картинка не сменилась на границе шага (${crossed
            .map(fmt)
            .join(', ')}): замер ${fmt(f.startMs)}–${fmt(f.endMs)}`,
        });
      }
    } else if (f.endMs - f.startMs > FREEZE_NO_PLAN_MAX_MS) {
      out.push({
        ...f,
        kind: 'freeze',
        explanation: `картинка замерла на ${fmt(f.endMs - f.startMs)} (${fmt(f.startMs)}–${fmt(f.endMs)})`,
      });
    }
  }
  return out.slice(0, SIGNAL_LIMIT);
}

/** Замечания отчёта из подозрений декодера — `major`, то есть `warn`. */
export function signalIssues(list: SuspiciousSignal[]): QualityIssue[] {
  return list.map((s) => ({
    category: 'artifact' as const,
    severity: 'major' as const,
    startMs: s.startMs,
    endMs: s.endMs,
    explanation: `Декодер: ${s.explanation}`,
    confidence: 1,
    source: 'server' as const,
  }));
}

/** Вердикт после сигналов декодера: только до `warn`, не до `fail`. */
export function verdictWithSignals(
  verdict: QualityVerdict | null,
  suspicious: number,
): QualityVerdict | null {
  if (suspicious === 0 || verdict === null) return verdict;
  return verdict === 'ok' ? 'warn' : verdict;
}

// ── переопределение оператором и блокировка ──────────────────────────

export const OVERRIDE_REASON_MIN = 3;
export const OVERRIDE_REASON_MAX = 500;
const VERDICTS: readonly QualityVerdict[] = ['ok', 'warn', 'fail'];

export function isQualityVerdict(v: unknown): v is QualityVerdict {
  return typeof v === 'string' && (VERDICTS as readonly string[]).includes(v);
}

/** Итоговый вердикт: оператор сильнее модели. */
export function effectiveVerdict(row: {
  verdict: string | null;
  overrideVerdict?: string | null;
}): QualityVerdict | null {
  const v = row.overrideVerdict ?? row.verdict;
  return isQualityVerdict(v) ? v : null;
}

/**
 * Блокирует ли проверка публикацию файла: только завершённая с итоговым
 * `fail` (то есть без переопределения оператором на `ok`/`warn`). Нет
 * проверки, она в работе или упала — не блок: «не проверен ИИ» не равно
 * «плохой», а сбой проверки — не вердикт ролику.
 */
export function blocksPublication(
  row: {
    status: string;
    verdict: string | null;
    overrideVerdict?: string | null;
  } | null,
): boolean {
  if (!row || row.status !== 'complete') return false;
  return effectiveVerdict(row) === 'fail';
}
