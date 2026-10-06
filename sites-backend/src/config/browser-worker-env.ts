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

export const WORKER_SECRET_ENV = 'SITES_WORKER_HMAC_SECRET';
/**
 * Секреты, с которыми секрет воркера совпадать не должен: других
 * направлений внутреннего API и — аудит Ш3 — ВСЕ прочие секреты
 * sites-backend той же длины. Воркер живёт рядом с чужим JS: одно значение,
 * скопированное оператором и в `CRON_SECRET`, или — хуже — в KEK реестра
 * учёток `ASSIST_SECRETS_KEY`, превратило бы утечку env воркера в доступ к
 * кронам или к расшифровке всех учёток Ш2.
 */
export const WORKER_DISTINCT_FROM = [
  'SITES_TUTORIAL_HMAC_SECRET',
  'SITES_QA_HMAC_SECRET',
  'SITES_INTERNAL_SECRET',
  'CRON_SECRET',
  'ASSIST_SECRETS_KEY',
  'ASSIST_ANALYTICS_REF_SECRET',
  'ASSIST_WEBHOOK_SECRET',
  'QA_WEBHOOK_SECRET',
  'BLOB_READ_WRITE_TOKEN',
] as const;

/** Ключи хранилища учёток Ш2 (`v1:<ключ>,v2:<ключ>`) — сверяется каждый. */
const CREDENTIAL_KEYS_ENV = 'SITE_CREDENTIALS_KEYS';

/**
 * Имя переменной, с которой совпал секрет воркера (или `null`). Кроме
 * списка `WORKER_DISTINCT_FROM` — каждый ключ `SITE_CREDENTIALS_KEYS`
 * (KEK реестра учёток Ш2): равенство всей строке его не поймало бы.
 */
export function workerSecretCollision(
  env: NodeJS.ProcessEnv,
  secret: string,
): string | null {
  for (const other of WORKER_DISTINCT_FROM) {
    if (env[other]?.trim() === secret) return other;
  }
  for (const part of (env[CREDENTIAL_KEYS_ENV] ?? '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const key = p.slice(p.indexOf(':') + 1).trim();
    if (p === secret || key === secret) return CREDENTIAL_KEYS_ENV;
  }
  return null;
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
