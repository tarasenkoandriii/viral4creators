/** Отказ задания с кодом из закрытого списка протокола (Э-С Ш3). */
import type { WorkerErrorCode } from './shared/browser-job-protocol';

export class JobError extends Error {
  constructor(readonly code: WorkerErrorCode) {
    super(`job: ${code}`);
    this.name = 'JobError';
  }
}
