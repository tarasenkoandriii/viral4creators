// Docker dev-запуск (см. doc/TELEGRAM-ADMIN.md): единственное место,
// отвечающее на вопрос «разрешён ли сейчас dev-вход в админку вообще».
// Вынесено отдельно от AdminAuthService, чтобы одна и та же проверка
// была доступна сервису (не создать сессию), контроллеру (честный 404,
// а не 500) и тестам без риска, что копии условия разъедутся.
//
// ДВА условия, а не одно: admin dev-вход выдаёт сессию с ПОЛНЫМИ правами
// оператора, то есть по последствиям он строже обычного входа. С этапа 43
// те же два условия проверяет и TelegramIdentityMiddleware для dev-обхода
// TMA (Б-3.9) — эта функция теперь единственный источник правила для
// обоих; до этапа 53 комментарий здесь утверждал обратное (В-6.20). Второй, независимый предохранитель —
// NODE_ENV !== 'production': даже если ALLOW_DEV_AUTH="true" случайно
// утечёт в продовое окружение, на проде NODE_ENV=production выставляется
// платформой автоматически, и вход остаётся закрытым.
//
// Перенесено из Devil's Advocate (apps/api/src/admin-auth/dev-login.ts).

export interface DevAuthEnv {
  ALLOW_DEV_AUTH?: string;
  NODE_ENV?: string;
  // Index signature so `process.env` (NodeJS.ProcessEnv, itself defined
  // via an index signature) structurally matches this type without
  // TypeScript's "weak type" excess-property check rejecting the
  // default-parameter assignment below — without it, tsc reports
  // "has no properties in common", since index-signature access alone
  // doesn't count as a matching named property.
  [key: string]: string | undefined;
}

export function isDevAuthAllowed(env: DevAuthEnv = process.env): boolean {
  return env.ALLOW_DEV_AUTH === 'true' && env.NODE_ENV !== 'production';
}

/** Единый неймспейс telegramId для "ненастоящих" пользователей — тот же
 * префикс "dev-", что использует TelegramIdentityMiddleware.tryDevBypass().
 * Один и тот же devUserId в TMA и в dev-login админки даёт ОДНОГО
 * пользователя, а не двух разных. */
export function devTelegramId(rawId: string): string {
  return `dev-${rawId}`;
}
