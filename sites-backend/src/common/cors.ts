import { matchesAllowedOrigin } from '../shared/cors-origin-match';

type OriginCallback = (err: Error | null, allow?: boolean) => void;

/**
 * Проверка Origin для `app.enableCors` — та же логика, что у backend
 * (сравнение — общий модуль shared/cors-origin-match.ts): запрос без
 * Origin (сервер-сервер, curl, health) пропускается, остальное — по
 * списку CORS_ORIGIN, где `*.vercel.app` покрывает превью.
 */
export function corsOriginCheck(allowed: readonly string[]) {
  return (requestOrigin: string | undefined, callback: OriginCallback) => {
    if (!requestOrigin) return callback(null, true);
    const ok = matchesAllowedOrigin(requestOrigin, allowed);
    callback(
      ok ? null : new Error(`Origin ${requestOrigin} не разрешён CORS`),
      ok,
    );
  };
}
