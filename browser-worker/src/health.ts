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
    return typeof s.t === 'number' && now - s.t <= maxAgeMs;
  } catch {
    return false;
  }
}
