/**
 * «Проверить установку» (ТЗ §3-бис.2) — НЕ подтверждает владение. Владелец — W4.
 *
 * Для каждого хоста сайта: главная (IP-pin, SSRF-ворота Э1 — тот же
 * `pinnedFetch`, что у PublicPageFetcher; см. ниже, почему не он сам),
 * поиск тега загрузчика с НАШИМ pk (data-site), разбор CSP страницы
 * (заголовок + `<meta http-equiv>`) против origin виджета + последний
 * пинг загрузчика (assist_site_install_pings). Итог по хосту: ok |
 * csp_blocked («тег есть, пинга нет или CSP без наших директив» —
 * приёмка Э2 п.2: «вероятно, CSP») | not_found | unverified_host | fetch_failed.
 *
 * Почему не PublicPageFetcher.fetchPage: он отдаёт ИЗВЛЕЧЁННЫЙ текст
 * (без `<script>` и без заголовков), а здесь нужны сырой HTML и заголовок
 * CSP. Сеть та же: pinnedFetch (резолв один раз, блок-лист адресов,
 * только https:443, редиректы в пределах origin, лимит тела), тот же UA
 * бота, отказ домена (opt-out) соблюдается. Неподтверждённые хосты не
 * запрашиваются вовсе: чужой сайт нашими руками не трогаем.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CRAWLER_USER_AGENT, WIDGET_LOADER_PATH } from '../../brand';
import { CRAWL_DEFAULTS } from '../../config/assist-defaults';
import { widgetOrigin as envWidgetOrigin } from '../../config/widget-env';
import { SitesDb } from '../../prisma/sites-db.service';
import type { AccountMembership } from '../site-core/account/roles';
import { evaluateHostAccess } from '../site-core/ownership/host-access';
import { PUBLIC_SITE_HOST } from '../site-core/ownership/host-roles';
import { notFoundSite } from '../site-core/site-core.constants';
import {
  PINNED_HTTP_DEPS,
  PinnedHttpDeps,
  pinnedFetch,
} from '../site-crawl/net/pinned-fetch';
import { decodeHtml, isOptedOut } from '../site-crawl/page-fetcher';
import type { InstallCheckResult, InstallCheckView } from './api-types';
import { setupError } from './errors';
import { WIDGET_CSP_DIRECTIVES, type WidgetCspDirective } from './snippet';

/** Пути, которые грузит виджет, — для сверки с path-частью источника CSP. */
const DIRECTIVE_PATH: Record<WidgetCspDirective, string> = {
  'script-src': WIDGET_LOADER_PATH,
  'frame-src': '/w/v1/frame',
  'img-src': '/widget/v1/ping',
  'connect-src': '/widget/v1/config',
};

/** Чем директива подменяется, если её нет (CSP3 §6.8.1, «fallback list»). */
const FALLBACK: Record<WidgetCspDirective, string[]> = {
  'script-src': ['script-src-elem', 'script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
};

type Policy = Map<string, string[]>;

/** Заголовок (политики через запятую) → политики; повтор директивы — первая. */
function parsePolicies(raw: string): Policy[] {
  const out: Policy[] = [];
  for (const policy of raw.split(',')) {
    const p: Policy = new Map();
    for (const part of policy.split(';')) {
      const tokens = part.trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) continue;
      const name = tokens[0].toLowerCase();
      if (!p.has(name)) p.set(name, tokens.slice(1));
    }
    if (p.size) out.push(p);
  }
  return out;
}

const HOST_SOURCE =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*|\*\.[a-z0-9.-]+|[a-z0-9.-]+)(?::(\*|\d{1,5}))?(\/[^?#]*)?$/i;

function hostSourceMatches(src: string, target: URL): boolean {
  const m = HOST_SOURCE.exec(src);
  if (!m) return false;
  const [, scheme, host, port, path] = m;
  // CSP3: `http://x` и схема-без-схемы допускают и https (апгрейд).
  if (scheme && !['https', 'http'].includes(scheme.toLowerCase())) return false;
  const th = target.hostname.toLowerCase();
  const h = host.toLowerCase();
  if (h !== '*') {
    if (h.startsWith('*.')) {
      if (!th.endsWith(h.slice(1))) return false;
    } else if (h !== th) {
      return false;
    }
  }
  const tPort = target.port || '443';
  if (port) {
    if (port !== '*' && port !== tPort) return false;
  } else if (tPort !== '443') {
    return false;
  }
  if (path && path !== '/') {
    return path.endsWith('/')
      ? target.pathname.startsWith(path)
      : target.pathname === path;
  }
  return true;
}

function sourceListAllows(
  sources: string[],
  target: URL,
  directive: WidgetCspDirective,
): boolean {
  const lower = sources.map((s) => s.toLowerCase());
  // strict-dynamic: хост-источники игнорируются — тег без nonce не пройдёт.
  if (directive === 'script-src' && lower.includes("'strict-dynamic'")) {
    return false;
  }
  for (const s of lower) {
    if (s === '*') return true;
    if (s === 'https:' || s === 'http:') return true;
    if (s.startsWith("'")) continue; // 'self', 'none', nonce, хеши
    if (hostSourceMatches(s, target)) return true;
  }
  return false;
}

/**
 * Чистый разбор CSP страницы: каких директив не хватает виджету.
 * `[]` — хватает (или CSP нет). Учитывает default-src как запасной.
 */
export function missingCspDirectives(
  cspHeader: string | null,
  widgetOrigin: string,
): string[] {
  if (!cspHeader || !cspHeader.trim()) return [];
  const origin = new URL(widgetOrigin).origin;
  const missing = new Set<WidgetCspDirective>();
  for (const policy of parsePolicies(cspHeader)) {
    for (const d of WIDGET_CSP_DIRECTIVES) {
      const name = FALLBACK[d].find((n) => policy.has(n));
      if (!name) continue; // директивы нет — ограничения нет
      const target = new URL(DIRECTIVE_PATH[d], origin);
      if (!sourceListAllows(policy.get(name) ?? [], target, d)) missing.add(d);
    }
  }
  return WIDGET_CSP_DIRECTIVES.filter((d) => missing.has(d));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attrOf(tag: string, name: string): string | null {
  const re = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
    'i',
  );
  const m = re.exec(tag);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/**
 * Э5 (ТЗ §4.10 «Микрофон в чужом iframe»): политика страницы запрещает
 * микрофон iframe виджета. `allow="microphone"` на iframe (загрузчик Э2)
 * передаёт право, только если его разрешает страница верхнего уровня:
 *  - нет заголовков — по умолчанию `self` + делегирование атрибутом: можно;
 *  - `Permissions-Policy: microphone=()` или список без origin виджета
 *    (и без `*`) — нельзя;
 *  - устаревший `Feature-Policy: microphone 'none'` / список без нас — нельзя.
 * Чистая функция (тест — install-check.spec).
 */
export function microphoneBlocked(
  permissionsPolicy: string | null,
  featurePolicy: string | null,
  widgetOrigin: string,
): boolean {
  const ours = widgetOrigin.replace(/\/+$/, '').toLowerCase();
  if (permissionsPolicy) {
    for (const part of permissionsPolicy.split(',')) {
      const m = /^\s*microphone\s*=\s*(.*?)\s*$/i.exec(part);
      if (!m) continue;
      const v = m[1];
      if (v === '*') return false;
      const list = /^\((.*)\)$/.exec(v);
      if (!list) return true;
      const items = list[1].split(/\s+/).filter(Boolean);
      return !items.some(
        (x) => x === '*' || x.replace(/^"|"$/g, '').toLowerCase() === ours,
      );
    }
  }
  if (featurePolicy) {
    for (const part of featurePolicy.split(';')) {
      const items = part.trim().split(/\s+/);
      if (items[0]?.toLowerCase() !== 'microphone') continue;
      const rest = items.slice(1).map((x) => x.toLowerCase());
      return !rest.some((x) => x === '*' || x === ours);
    }
  }
  return false;
}

/** CSP из `<meta http-equiv="Content-Security-Policy">` страницы. */
export function metaCsp(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (
      (attrOf(tag, 'http-equiv') ?? '').toLowerCase() !==
      'content-security-policy'
    ) {
      continue;
    }
    const content = attrOf(tag, 'content');
    if (content) out.push(content);
  }
  return out;
}

/** Есть ли в HTML тег загрузчика с нашим origin и одним из ключей сайта. */
export function findLoaderTag(
  html: string,
  widgetOrigin: string,
  keys: string[],
): boolean {
  const loader = `${new URL(widgetOrigin).origin}${WIDGET_LOADER_PATH}`;
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attrOf(tag, 'src');
    const site = attrOf(tag, 'data-site');
    if (!src || !site || !keys.includes(site)) continue;
    try {
      const u = new URL(src, 'https://placeholder.invalid');
      if (`${u.origin}${u.pathname}` === loader) return true;
    } catch {
      /* битый src — не наш тег */
    }
  }
  return false;
}

function hostOrigin(h: { scheme: string; host: string; port: number }): string {
  const def = h.scheme === 'https' ? 443 : 80;
  return `${h.scheme}://${h.host}${h.port === def ? '' : `:${h.port}`}`;
}

@Injectable()
export class InstallCheckService {
  /** Часы — подменяются в тестах. */
  now: () => Date = () => new Date();
  /** Origin виджета — env (одно место чтения: config/widget-env.ts). */
  widgetOrigin: () => string = () => envWidgetOrigin();

  constructor(
    private readonly sitesDb: SitesDb,
    @Optional()
    @Inject(PINNED_HTTP_DEPS)
    private readonly net: Partial<PinnedHttpDeps> = {},
  ) {}

  async check(m: AccountMembership, siteId: string): Promise<InstallCheckView> {
    const db = this.sitesDb.forAccount(m.accountId);
    const site = await db.site.findFirst({
      where: { id: siteId },
      select: { id: true },
    });
    if (!site) throw notFoundSite();
    const assist = await db.assistSite.findFirst({
      where: { siteId },
      select: { publicKey: true, testKey: true },
    });
    if (!assist?.publicKey) {
      throw setupError(
        400,
        'KEYS_MISSING',
        'Сначала получите код установки виджета',
      );
    }
    const keys = [assist.publicKey, assist.testKey].filter(
      (k): k is string => !!k,
    );
    // Хосты «Админки» — не хосты виджета «Сайта» (ТЗ §10).
    const hosts = await db.siteHost.findMany({
      where: { siteId, ...PUBLIC_SITE_HOST },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: {
        id: true,
        accountId: true,
        scheme: true,
        host: true,
        port: true,
        status: true,
        expiresAt: true,
        revokedAt: true,
        reverifyBlockedAt: true,
      },
    });
    const system = this.sitesDb.system(
      'проверка установки: пинги загрузчика и отказ доменов — таблицы вне тенанта',
    );
    const pings = await system.assistSiteInstallPing.findMany({
      where: { siteId },
      select: {
        origin: true,
        allowed: true,
        configFetchOk: true,
        lastSeenAt: true,
      },
    });
    const now = this.now();
    const widgetOrigin = this.widgetOrigin();
    const out: InstallCheckView['hosts'] = [];
    for (const h of hosts) {
      const origin = hostOrigin(h);
      const ping = pings.find((p) => p.origin === origin) ?? null;
      const base = {
        hostId: h.id,
        origin,
        tagFound: false,
        lastPingAt: ping ? ping.lastSeenAt.toISOString() : null,
        missingCsp: [] as string[],
      };
      const access = evaluateHostAccess(h, 'assist-widget', now);
      if (!access.ok) {
        out.push({ ...base, result: 'unverified_host' });
        continue;
      }
      const pingOk = !!ping && ping.allowed;
      const page = await this.fetchHome(origin, h.host, system);
      if (!page) {
        out.push({ ...base, result: pingOk ? 'ok' : 'fetch_failed' });
        continue;
      }
      // Э5: микрофон голоса — не ошибка установки (чат работает), а
      // отдельное предупреждение владельцу.
      const micBlocked = microphoneBlocked(
        page.permissionsPolicy,
        page.featurePolicy,
        widgetOrigin,
      );
      const tagFound = findLoaderTag(page.html, widgetOrigin, keys);
      const csp = [page.csp, ...metaCsp(page.html)].filter(Boolean).join(', ');
      const missing = missingCspDirectives(csp || null, widgetOrigin);
      // Пинг пришёл, а конфиг fetch'ем — нет: connect-src без нашего origin.
      if (ping?.configFetchOk === false && !missing.includes('connect-src')) {
        missing.push('connect-src');
      }
      let result: InstallCheckResult;
      if (!tagFound && !pingOk) result = 'not_found';
      else if (missing.length) result = 'csp_blocked';
      else if (pingOk) result = 'ok';
      // Тег есть, CSP на вид в порядке, но загрузчик ни разу не отозвался.
      else result = 'csp_blocked';
      out.push({
        ...base,
        tagFound,
        missingCsp: missing,
        result,
        ...(micBlocked ? { microphoneBlocked: true } : {}),
      });
    }
    return { checkedAt: now.toISOString(), hosts: out };
  }

  private async fetchHome(
    origin: string,
    hostname: string,
    system: Parameters<typeof isOptedOut>[0],
  ): Promise<{
    html: string;
    csp: string | null;
    permissionsPolicy: string | null;
    featurePolicy: string | null;
  } | null> {
    if (!origin.startsWith('https://')) return null;
    if (await isOptedOut(system, hostname)) return null;
    try {
      const res = await pinnedFetch(
        `${origin}/`,
        {
          headers: {
            'user-agent': CRAWLER_USER_AGENT,
            accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          },
          maxBytes: CRAWL_DEFAULTS.maxHtmlBytes,
          truncateAtMaxBytes: true,
          timeoutMs: CRAWL_DEFAULTS.requestTimeoutMs,
          maxRedirects: CRAWL_DEFAULTS.maxRedirects,
          sameOrigin: true,
        },
        this.net,
      );
      if (res.status < 200 || res.status >= 300) return null;
      const ct = res.headers['content-type'] ?? '';
      return {
        html: decodeHtml(res.body, ct),
        csp: res.headers['content-security-policy'] ?? null,
        permissionsPolicy: res.headers['permissions-policy'] ?? null,
        featurePolicy: res.headers['feature-policy'] ?? null,
      };
    } catch {
      return null;
    }
  }
}
