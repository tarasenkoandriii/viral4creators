import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Штамп сборки (этап 154). Конфиг выполняется В МОМЕНТ СБОРКИ — это
 * единственное место в мини-аппе, которое честно знает дату; на
 * serverless-бэкенде такого момента нет вовсе (см.
 * `backend/src/common/build-info.ts`).
 *
 * Считается здесь, а не задаётся переменной `VITE_*`, намеренно:
 * переменную пришлось бы проставлять руками на каждом стенде, и первый
 * же забытый стенд дал бы тикеты без версии — ровно то, ради чего штамп
 * и заводится.
 *
 * Логика разбора хеша продублирована с `src/lib/build-info.ts` в одну
 * строку сознательно: конфиг не должен импортировать исходники
 * приложения, а `describeBuild` там покрыт тестом и мутациями.
 */
function buildStamp(): string {
  const sha = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').trim();
  const short = /^[0-9a-f]{7,40}$/i.test(sha)
    ? sha.slice(0, 7).toLowerCase()
    : null;
  const d = new Date();
  const date = [
    d.getUTCFullYear(),
    String(d.getUTCMonth() + 1).padStart(2, '0'),
    String(d.getUTCDate()).padStart(2, '0'),
  ].join('.');
  return short ? `${date}-${short}` : date;
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD__: JSON.stringify(buildStamp()),
  },
  server: {
    port: 5173,
    // 0.0.0.0 so the dev server is reachable from outside a Docker
    // container (Vite's default host, 127.0.0.1, is unreachable through a
    // published container port). Harmless for native (non-Docker) dev too.
    host: '0.0.0.0',
    // Some Docker Desktop setups (macOS/Windows bind-mounts) don't deliver
    // native filesystem-change events into the container, so HMR silently
    // stops picking up edits. Toggle with VITE_USE_POLLING=true in that
    // case (set automatically for the docker-compose service); leave unset
    // for native dev, where polling only adds needless CPU usage.
    watch: {
      usePolling: process.env.VITE_USE_POLLING === 'true',
    },
    proxy: {
      // Currently unused — the API client (services/api.ts) calls
      // VITE_API_BASE_URL directly rather than relative '/api' paths — but
      // harmless to keep for anything that does hit a relative path.
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
