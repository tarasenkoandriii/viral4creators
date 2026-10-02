/**
 * Назначения секретов учётной записи (Э-С Ш2) — без шифрования: этот файл
 * можно импортировать вне модуля (разбор тела внутреннего API), а
 * `credential-crypto.ts` — нет (правило графа `credentials-crypto-private`).
 */
export const CREDENTIAL_PURPOSES = [
  'password',
  'login-fields',
  'session-cookies',
] as const;
export type CredentialPurpose = (typeof CREDENTIAL_PURPOSES)[number];

export function isCredentialPurpose(v: unknown): v is CredentialPurpose {
  return (
    typeof v === 'string' &&
    (CREDENTIAL_PURPOSES as readonly string[]).includes(v)
  );
}
