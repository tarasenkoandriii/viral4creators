/** Контекст исполнения задания воркером (Э-С Ш3). */
import type { JobBrowser } from '../browser/context';
import type { Logger } from '../logger';
import type { SecretBox } from '../secret-box';
import type {
  BrowserJobResult,
  ClaimedJob,
} from '../shared/browser-job-protocol';

export interface JobCredentials {
  username: string | null;
  password: SecretBox | null;
  /** JSON-массив cookie (как хранит Ш2: `session-cookies`). */
  cookies: SecretBox | null;
  wipe(): void;
}

export interface JobContext {
  job: ClaimedJob;
  jb: JobBrowser;
  signal: AbortSignal;
  log: Logger;
  uploadArtifact(a: {
    idx: number;
    data: Buffer;
    contentType: 'image/jpeg' | 'image/png';
    width: number | null;
    height: number | null;
  }): Promise<void>;
  /** Учётка задания (admin-crawl) — один раз на попытку, конвертом. */
  credentials(): Promise<JobCredentials>;
  /**
   * Открыть конверт из параметров задания (сессия раунда обучалки) ключом
   * воркера; не открылся — `JobError('credentials_unavailable')`.
   */
  unseal(sealed: string, aad: string): Buffer;
}

export type JobExecutor = (ctx: JobContext) => Promise<BrowserJobResult>;
