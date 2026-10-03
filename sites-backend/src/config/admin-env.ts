/**
 * Переменные окружения «Админки» (Э7, ТЗ §4.12, §5.6) — одно место чтения.
 *
 *  - ASSIST_ADMIN_WIDGET_ORIGIN — origin iframe чата сотрудника
 *    (`https://wa.<домен>`; временно `https://assist-wa.viral4creators.app`,
 *    doc/DEPLOYMENT.md §6.19). ОТДЕЛЬНЫЙ от ASSIST_WIDGET_ORIGIN (У-13):
 *    совпадение — ошибка конфигурации (validateAdminEnv), иначе XSS в
 *    публичном чате доставал бы сессию сотрудника. Без переменной —
 *    заглушка бренда (в проде — ошибка конфигурации).
 *  - ASSIST_SECRETS_KEY (+ ASSIST_SECRETS_KEY_VERSION, ASSIST_SECRETS_KEYS_OLD)
 *    — ключ секретов коннекторов и подписи employee-JWT
 *    (assist-admin-mode/admin-secrets-crypto.ts).
 */
import { WIDGET_ADMIN_ORIGIN_DEFAULT } from '../brand';
import { widgetOrigin } from './widget-env';

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.hostname !== 'localhost') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export function adminWidgetOrigin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    originOf(env.ASSIST_ADMIN_WIDGET_ORIGIN) ?? WIDGET_ADMIN_ORIGIN_DEFAULT
  );
}

/** Проблемы конфигурации «Админки» (для чек-листа деплоя и тестов). */
export function validateAdminEnv(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const out: string[] = [];
  if (!originOf(env.ASSIST_ADMIN_WIDGET_ORIGIN)) {
    out.push('ASSIST_ADMIN_WIDGET_ORIGIN не задана или не https-origin');
  } else if (adminWidgetOrigin(env) === widgetOrigin(env)) {
    out.push(
      'ASSIST_ADMIN_WIDGET_ORIGIN совпадает с ASSIST_WIDGET_ORIGIN — «Админке» нужен отдельный origin (§4.12, У-13)',
    );
  }
  if (!env.ASSIST_SECRETS_KEY?.trim()) {
    out.push('ASSIST_SECRETS_KEY не задан — секреты «Админки» недоступны');
  }
  return out;
}
