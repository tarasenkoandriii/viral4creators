/**
 * Разделение секретов sites-backend (П-С3 «свой секрет на направление»;
 * аудит Ш3 — воркер, аудит Н-2 — обучалка и Flow-QA): секрет HMAC-канала
 * не должен совпадать ни с одним другим секретом процесса. Одно значение,
 * скопированное оператором и в `CRON_SECRET`, или — хуже — в KEK реестра
 * учёток (`SITE_CREDENTIALS_KEYS`) либо ключ «Админки» (`ASSIST_SECRETS_KEY`
 * и его старые версии), превратило бы утечку секрета одного канала в доступ
 * к кронам, к расшифровке учёток или к подписи чужого канала (вызывающий —
 * лишь заголовок).
 *
 * Одно место сверки для всех HMAC-гвардов (обучалка, Flow-QA, воркер):
 * совпадение — маршруты закрыты (503), как без секрета. Значение секрета в
 * сообщения и логи НЕ попадает — только имя переменной.
 */

/** Переменные с одним значением-секретом. */
export const INTERNAL_SECRET_ENVS = [
  'SITES_TUTORIAL_HMAC_SECRET',
  'SITES_QA_HMAC_SECRET',
  'SITES_WORKER_HMAC_SECRET',
  'SITES_INTERNAL_SECRET',
  'CRON_SECRET',
  'ASSIST_SECRETS_KEY',
  'ASSIST_ANALYTICS_REF_SECRET',
  'ASSIST_VOICE_MAP_EXPORT_KEY',
  'ASSIST_WEBHOOK_SECRET',
  'QA_WEBHOOK_SECRET',
  'BLOB_READ_WRITE_TOKEN',
] as const;

/**
 * Связки ключей `v1:<ключ>,v2:<ключ>` — сверяется каждый ключ (и элемент
 * целиком): равенство всей строке их не поймало бы.
 */
export const INTERNAL_SECRET_KEYRING_ENVS = [
  'SITE_CREDENTIALS_KEYS',
  'ASSIST_SECRETS_KEYS_OLD',
] as const;

/**
 * Имя переменной, с которой совпал `secret` (или `null`). `selfEnv` —
 * переменная самого секрета, с собой не сравнивается.
 */
export function internalSecretCollision(
  env: NodeJS.ProcessEnv,
  selfEnv: string,
  secret: string,
): string | null {
  const s = secret.trim();
  if (!s) return null;
  for (const other of INTERNAL_SECRET_ENVS) {
    if (other === selfEnv) continue;
    if (env[other]?.trim() === s) return other;
  }
  for (const ring of INTERNAL_SECRET_KEYRING_ENVS) {
    if (ring === selfEnv) continue;
    for (const part of (env[ring] ?? '').split(',')) {
      const p = part.trim();
      if (!p) continue;
      const key = p.slice(p.indexOf(':') + 1).trim();
      if (p === s || key === s) return ring;
    }
  }
  return null;
}
