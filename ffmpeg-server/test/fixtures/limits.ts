import type { LimitsProfile } from '../../src/contracts';

/** Стартовый профиль пилота (ТЗ §9) — для тестов EXEC. */
export const PILOT_LIMITS: LimitsProfile = {
  revision: 1,
  maxInputs: 20,
  maxCommands: 10,
  maxOutputs: 10,
  maxCommandsTextBytes: 128 * 1024,
  maxInputBytes: 512 * 1024 * 1024,
  maxTotalInputBytes: 1024 * 1024 * 1024,
  maxTotalOutputBytes: 512 * 1024 * 1024,
  maxWorkspaceBytes: 4 * 1024 * 1024 * 1024,
  maxWidth: 1920,
  maxHeight: 1080,
  maxFps: 60,
  maxInputDurationSec: 600,
  maxImagePixels: 24_000_000,
  pipelineDeadlineSec: 900,
  queueDeadlineSec: 1200,
  downloadFileDeadlineSec: 120,
  downloadConnectTimeoutSec: 10,
  downloadStallTimeoutSec: 15,
  maxThreads: 2,
  stderrTailBytes: 64 * 1024,
};
