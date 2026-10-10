/**
 * Здоровье воркера без входящих портов (Э-С Ш3): процесс раз в 10 с пишет
 * файл с отметкой времени и состоянием; `healthcheck.ts` (HEALTHCHECK
 * Docker) читает его. Нет файла или он старше 60 с — нездоров (цикл
 * завис, процесс умер).
 */
import { readFileSync, renameSync, writeFileSync } from 'fs';

export interface HealthState {
  t: number;
  running: number;
  browser: boolean;
  /** Дренаж перед ротацией Chromium: новые задания не берутся. */
  draining?: boolean;
  rotations?: number;
  lastClaimAt: number;
  lastError: string | null;
  completed: number;
  failed: number;
}

export function writeHealth(file: string, s: HealthState): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file);
}

export function isHealthy(
  file: string,
  now = Date.now(),
  maxAgeMs = 60_000,
): boolean {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as HealthState;
    const fresh = (t: unknown, age: number) =>
      typeof t === 'number' &&
      Number.isFinite(t) &&
      t > 0 &&
      t <= now &&
      now - t <= age;
    // Successful empty claims count too; transient failures may recover.
    // Long jobs and browser draining temporarily pause claims.
    return (
      fresh(s.t, maxAgeMs) &&
      s.browser === true &&
      (fresh(s.lastClaimAt, 90_000) ||
        ((s.running > 0 || s.draining === true) &&
          fresh(s.lastClaimAt, 420_000)))
    );
  } catch {
    return false;
  }
}
