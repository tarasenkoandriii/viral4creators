/** HEALTHCHECK Docker: 0 — файл здоровья свежий, 1 — нет (см. health.ts). */
import { isHealthy } from './health';

const file =
  process.env.BROWSER_WORKER_HEALTH_FILE?.trim() ||
  '/tmp/browser-worker.health';
process.exit(isHealthy(file) ? 0 : 1);
