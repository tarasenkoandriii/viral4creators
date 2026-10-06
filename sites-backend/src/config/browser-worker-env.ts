/**
 * Переменные окружения браузерного воркера Ш3 на стороне sites-backend —
 * одно место чтения (doc/DEPLOYMENT.md §6.25).
 *
 *  - BROWSER_WORKER_ENABLED — главный выключатель (умолчание — выключен):
 *    продукты не ставят задания (как до Ш3: «Админка» — `waiting_worker`,
 *    «Снимок» и сверка карты — 409 `BROWSER_WORKER_DISABLED`), а `claim`
 *    отдаёт воркеру пустой список. Выключение посреди работы — kill-switch:
 *    новые задания не выдаются, идущие гасятся на ближайшем heartbeat.
 *  - SITES_WORKER_HMAC_SECRET — подпись запросов воркера (≥ 32 символа),
 *    ОТДЕЛЬНЫЙ от секретов обучалки, Flow-QA и админки (П-С3: «свой секрет
 *    на направление»): совпадение с любым из них — маршруты закрыты (503).
 *  - SITES_WORKER_SEAL_PUBLIC_KEY — открытый ключ X25519 воркера (base64url,
 *    43 символа): секреты учётки уходят воркеру только конвертом под этот
 *    ключ. Не задан — выдача учёток закрыта (обход «Админки» за логином не
 *    стартует, `credentials_unavailable`), остальные задания работают.
 */
import { isUsableSitesSecret } from '../shared/sites-internal-signature';
import { isUsableSealKey } from '../modules/browser-jobs/worker-seal';
import {
  INTERNAL_SECRET_ENVS,
  internalSecretCollision,
} from './internal-secrets-distinct';

export const WORKER_SECRET_ENV = 'SITES_WORKER_HMAC_SECRET';
/**
 * Секреты, с которыми секрет воркера совпадать не должен: других
 * направлений внутреннего API и — аудит Ш3 — ВСЕ прочие секреты
 * sites-backend (кроны, KEK учёток Ш2, ключ «Админки» и его старые версии).
 * Список и сверка — общие для всех HMAC-гвардов (`internal-secrets-distinct.ts`,
 * аудит Н-2).
 */
export const WORKER_DISTINCT_FROM = INTERNAL_SECRET_ENVS.filter(
  (e) => e !== WORKER_SECRET_ENV,
);

/** Имя переменной, с которой совпал секрет воркера (или `null`). */
export function workerSecretCollision(
  env: NodeJS.ProcessEnv,
  secret: string,
): string | null {
  return internalSecretCollision(env, WORKER_SECRET_ENV, secret);
}

export function browserWorkerEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.BROWSER_WORKER_ENABLED ?? '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'on';
}

export function workerSealPublicKey(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = env.SITES_WORKER_SEAL_PUBLIC_KEY?.trim();
  return isUsableSealKey(v) ? v : null;
}

/** Проблемы конфигурации (чек-лист деплоя §6.25 и тесты). */
export function validateBrowserWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!browserWorkerEnabled(env)) return [];
  const out: string[] = [];
  const secret = env[WORKER_SECRET_ENV]?.trim();
  if (!isUsableSitesSecret(secret)) {
    out.push(
      `${WORKER_SECRET_ENV} не задан (≥ 32 символа) — воркер не подключится`,
    );
  }
  const other = secret ? workerSecretCollision(env, secret) : null;
  if (other) {
    out.push(`${WORKER_SECRET_ENV} совпадает с ${other} — нужен свой секрет`);
  }
  if (!workerSealPublicKey(env)) {
    out.push(
      'SITES_WORKER_SEAL_PUBLIC_KEY не задан — обход «Админки» за логином не стартует (учётки не выдаются)',
    );
  }
  return out;
}
