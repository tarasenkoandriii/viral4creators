/**
 * Общий контекст процесса API: конфигурация, БД, сервисы и порты EXEC.
 * Собирается в app.ts; тесты подставляют фейковые порты и часы.
 */
import type { DiskMonitor } from './cleanup/disk';
import type { ServerConfig } from './config';
import type { ControlService } from './control/control';
import type { LimitsService } from './control/limits';
import type { Readiness } from './control/readiness';
import type { Db } from './db/database';
import type { Logger } from './metrics/logger';
import type { Metrics } from './metrics/metrics';
import type { DownloadOpts, Ports } from './queue/ports';

export interface Ctx {
  cfg: ServerConfig;
  db: Db;
  log: Logger;
  metrics: Metrics;
  control: ControlService;
  limits: LimitsService;
  ports: Ports;
  disk: DiskMonitor;
  readiness: Readiness;
  now: () => number;
  /** Доп. параметры downloader (тесты: CA, резолвер, порт). */
  downloadExtra: Partial<DownloadOpts> & Record<string, unknown>;
  /** Будит диспетчер (новая задача, отмена, resume). */
  kick: () => void;
  /** id задачи, которую сейчас ведёт диспетчер (null — простой). */
  activeJobId: () => string | null;
}
