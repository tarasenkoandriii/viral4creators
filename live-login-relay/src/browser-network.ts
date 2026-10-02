/**
 * Сеть подконтрольного браузера — Ш0.2 аудита
 * docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md (риск К-1).
 *
 * По умолчанию Chromium ходит в мир ТОЛЬКО через фильтрующий прокси
 * (`./shared/egress-filter-proxy` — копия backend/src/common, та же, что
 * у обучалки). Прокси живёт в этом же процессе на 127.0.0.1 со случайным
 * портом: отдельный контейнер потребовал бы своей сети и маршрута в
 * Dokploy, а проверить такую схему без доступа к серверу нельзя.
 *
 * Прокси решает за КАЖДОЕ соединение страницы (переход, подресурс, XHR,
 * iframe, WebSocket, попап): один резолв DNS, отказ служебным адресам и
 * публичным адресам самого хоста (`LIVE_LOGIN_EGRESS_DENY`), подключение
 * к уже проверенному IP. Это закрывает и DNS-rebinding.
 *
 * `LIVE_LOGIN_BROWSER_PROXY_URL` (резидентный выход) при включённом
 * фильтре становится его вышестоящим: учётные данные держит фильтр, и
 * `page.authenticate()` больше не нужен.
 *
 * Что прокси НЕ закрывает — эксплойт самого Chromium, который откроет
 * сокет мимо прокси. Для этого правила `DOCKER-USER` на хосте
 * (doc/LIVE-LOGIN-RELAY-EGRESS.md) — второй, независимый слой.
 */

import {
  EgressVerdict,
  egressProxyChromiumArgs,
  startEgressFilterProxy,
} from './shared/egress-filter-proxy';
import type { RelayConfig } from './config';
import { upstreamFromBrowserProxy } from './config';
import { proxyArgs } from './launch-browser';
import type { Logger } from './logger';

export interface BrowserNetwork {
  /** Флаги Chromium. */
  launchArgs: string[];
  /** Учётные данные прокси для `page.authenticate()` — только без фильтра. */
  proxyAuth?: { username: string; password: string };
  /** Адрес фильтра (`http://127.0.0.1:<порт>`) или `null`. */
  filterUrl: string | null;
  stats(): Record<EgressVerdict, number> | null;
  close(): Promise<void>;
}

export async function startBrowserNetwork(
  config: Pick<RelayConfig, 'browserProxy' | 'egressFilter'>,
  logger?: Pick<Logger, 'warn'>,
): Promise<BrowserNetwork> {
  if (!config.egressFilter.enabled) {
    const p = config.browserProxy;
    return {
      launchArgs: proxyArgs(p),
      proxyAuth:
        p?.username && p.password
          ? { username: p.username, password: p.password }
          : undefined,
      filterUrl: null,
      stats: () => null,
      close: async () => undefined,
    };
  }

  const proxy = await startEgressFilterProxy({
    denyCidrs: config.egressFilter.denyCidrs,
    allowedPorts: config.egressFilter.allowedPorts,
    upstream: upstreamFromBrowserProxy(config.browserProxy),
    onDecision: (verdict) => {
      // Только вид отказа — без адреса и URL: логи реле содержат счётчики,
      // а не то, куда ходил человек (doc/LIVE-LOGIN-RELAY-SPEC.md, логи).
      if (verdict === 'blocked-address' || verdict === 'blocked-port') {
        logger?.warn('egress: соединение браузера отклонено', { verdict });
      }
    },
  });
  return {
    launchArgs: egressProxyChromiumArgs(proxy.url),
    proxyAuth: undefined,
    filterUrl: proxy.url,
    stats: () => proxy.stats(),
    close: () => proxy.close(),
  };
}
