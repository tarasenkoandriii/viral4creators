/**
 * demo-quality-preflight.ts — бесплатная техническая проверка демо ДО
 * Gemini (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, «Вход и проверка»).
 *
 * На Vercel нет ffprobe, поэтому числа берутся из контейнера MP4 тем же
 * разбором, что у технической проверки версий темпа (`mp4-probe.ts`):
 * видеодорожка и её кадры, звук, длительность, холст. Плюс две сверки
 * с метаданными съёмки: тема ролика равна заявленной, длительность не
 * выше лимита. Провал — вердикт `fail` без платного вызова.
 *
 * Чистый модуль: на входе — разбор MP4 и ожидания, на выходе — итог.
 */

import { Mp4Probe } from '../tutorial-runner/mp4-probe';
import { gridFrames } from '../tutorial-runner/tutorial-video-assembly';
import { QualityIssue } from './demo-quality-rubric';

/** Потолок длительности демо. Ролики обучалки — десятки секунд; что
 *  длиннее четырёх минут, то не демо, а сбой сборки (и дорогой анализ). */
export const DEMO_MAX_DURATION_MS = 240_000;

export interface PreflightExpectations {
  /** Длительность по плану сборки (`durationMs` ролика или `videoMs`
   *  версии); `null` — плана нет, сверка кадров пропускается. */
  durationMs: number | null;
  width: number | null;
  height: number | null;
  /** Звук заказан (manifest: озвучка есть); `null` — неизвестно. */
  hasAudio: boolean | null;
  /** Заявленная тема ролика (`TutorialVideoAsset.theme`). */
  declaredTheme: string | null;
  /** Тема, в которой сняты кадры (manifest). */
  capturedTheme: string | null;
  maxDurationMs?: number;
}

export interface PreflightResult {
  ok: boolean;
  problems: string[];
  /** Фактическая длительность файла, мс (0 — не разобрался). */
  durationMs: number;
  videoFrames: number | null;
  expectedFrames: number | null;
  width: number | null;
  height: number | null;
  audioSeconds: number | null;
}

export function demoPreflight(
  probe: Mp4Probe | null,
  expected: PreflightExpectations,
): PreflightResult {
  const maxMs = expected.maxDurationMs ?? DEMO_MAX_DURATION_MS;
  const expectedFrames =
    expected.durationMs !== null && expected.durationMs > 0
      ? gridFrames(expected.durationMs / 1000)
      : null;
  const base: PreflightResult = {
    ok: false,
    problems: [],
    durationMs: 0,
    videoFrames: null,
    expectedFrames,
    width: null,
    height: null,
    audioSeconds: null,
  };
  if (!probe) return { ...base, problems: ['файл не разбирается как MP4'] };

  const problems: string[] = [];
  const video = probe.tracks.find((t) => t.kind === 'video') ?? null;
  const audio = probe.tracks.find((t) => t.kind === 'audio') ?? null;
  const durationMs = Math.round(
    Math.max(probe.durationSeconds, video?.durationSeconds ?? 0) * 1000,
  );

  if (!video) problems.push('нет видеодорожки');
  if (video && video.samples < 1) problems.push('в видеодорожке нет кадров');
  if (durationMs <= 0) problems.push('нулевая длительность');
  if (durationMs > maxMs) {
    problems.push(
      `длительность ${Math.round(durationMs / 1000)} с больше лимита ${Math.round(maxMs / 1000)} с`,
    );
  }
  if (
    video &&
    expected.width !== null &&
    expected.height !== null &&
    (video.width !== expected.width || video.height !== expected.height)
  ) {
    problems.push(
      `кадр ${video.width}×${video.height} вместо ${expected.width}×${expected.height}`,
    );
  }
  // ± 1 кадр — тот же допуск, что у проверки версий темпа (`-shortest`
  // и aac округляют хвост по-своему).
  if (
    video &&
    expectedFrames !== null &&
    Math.abs(video.samples - expectedFrames) > 1
  ) {
    problems.push(`кадров ${video.samples} вместо ${expectedFrames}`);
  }
  if (expected.hasAudio === true && !audio) {
    problems.push('нет звуковой дорожки, хотя озвучка заказана');
  }
  if (expected.hasAudio === true && audio && video) {
    const shortBy = video.durationSeconds - audio.durationSeconds;
    if (shortBy > 0.06) {
      problems.push(
        `звук короче картинки на ${Math.round(shortBy * 1000)} мс — хвост речи мог срезаться`,
      );
    }
  }
  // Тема: сверяем заявленную со снятой, только если обе известны.
  // Неизвестная — не провал (старые строки, обучалка по сайту), её
  // отметит анализ как пробел в данных.
  if (
    (expected.declaredTheme === 'light' || expected.declaredTheme === 'dark') &&
    (expected.capturedTheme === 'light' || expected.capturedTheme === 'dark') &&
    expected.declaredTheme !== expected.capturedTheme
  ) {
    problems.push(
      `тема съёмки ${expected.capturedTheme} не совпадает с заявленной ${expected.declaredTheme}`,
    );
  }

  return {
    ok: problems.length === 0,
    problems,
    durationMs,
    videoFrames: video?.samples ?? null,
    expectedFrames,
    width: video?.width ?? null,
    height: video?.height ?? null,
    audioSeconds: audio ? audio.durationSeconds : null,
  };
}

/** Замечания отчёта из провалов техпроверки — на весь ролик. */
export function preflightIssues(result: PreflightResult): QualityIssue[] {
  return result.problems.map((p) => ({
    category: 'technical' as const,
    severity: 'critical' as const,
    startMs: 0,
    endMs: result.durationMs,
    explanation: p,
    confidence: 1,
    source: 'preflight' as const,
  }));
}
