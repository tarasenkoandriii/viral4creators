// Минимальный парсер заголовка Cookie — только для чтения
// admin_session, не общего назначения. Не заводим зависимость
// cookie-parser ради одного значения. Перенесено из Devil's Advocate
// (apps/api/src/admin-auth/cookie.util.ts).

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

export const ADMIN_SESSION_COOKIE_NAME = 'admin_session';
