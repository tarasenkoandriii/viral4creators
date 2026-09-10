// Парсер заголовка Cookie для постоянного логина frontend/ — параллельная
// копия admin-auth/cookie.util.ts с другим именем cookie
// (user_session, не admin_session). Дублирование, а не общий импорт,
// осознанное: эти два auth-потока (frontend-логин без прав vs
// admin-панель с isOperator) не должны становиться связанными по коду
// только потому, что парсинг Cookie-заголовка у них одинаковый — см.
// doc/TELEGRAM-ADMIN.md.

export function parseCookieHeader(
  header: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;

  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

export const USER_SESSION_COOKIE_NAME = 'user_session';
