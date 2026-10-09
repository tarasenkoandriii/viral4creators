/**
 * «Только чтение» под сессией учётки (заход 11, Р-З11-Г1…Г4; раунд
 * исправлений по аудиту пакета Г) на НАСТОЯЩЕМ Chromium: каждый зонд —
 * страница «Админки», которая пытается писать. Всё, что не должно дойти до
 * сайта, — путь с `/no/`; что должно — с `/ok/`. Проверяется то, что
 * получил стенд, а не то, что «решил» страж.
 *
 *  - P1-1: попапы (`window.open`, форма и ссылка `target=_blank`, попап из
 *    встроенного скрипта) — ни запроса;
 *  - P1-2: Worker и SharedWorker (и из `about:blank`-фрейма) — ни запроса,
 *    ни WebSocket;
 *  - P2-2/P3: GraphQL — мутация в адресе POST, повтор ключа, persisted
 *    query, GET/HEAD-мутация, в т. ч. неразобранная на пути GraphQL;
 *  - P2-3: переход, начатый встроенным скриптом во время `goto`, —
 *    проверяется по адресу;
 *  - P2-4: «выход» редиректом 302 (fetch и картинка) — обрыв; безопасный
 *    редирект — проходит, ровно один запрос к цели;
 *  - P3-4: camelCase и `archive/restore/confirm`;
 *  - P2-1, P3-5, M4, M5: SPA-вход (`fetch` в `submit` с задержкой) —
 *    POST входа проходит; запись на сторонний хост в окне входа, запись
 *    дашборда после входа и сообщения WebSocket после окна — нет.
 */
import { existsSync } from 'fs';
import { chromium, type Browser } from 'playwright-core';
import { JobBrowser } from '../../src/browser/context';
import { HARDENING_ARGS, browserEnv } from '../../src/browser/pool';
import { runAdminCrawl } from '../../src/jobs/admin-crawl';
import type { JobContext } from '../../src/jobs/types';
import { createLogger } from '../../src/logger';
import { SecretBox } from '../../src/secret-box';
import { FakeInternet, PUBLIC_TEST_IP, Stand } from '../helpers/stand';

const ADMIN = 'admin.wg.test';
const OTHER = 'other.wg.test';
const MB = 1024 * 1024;

function chromiumPath(): string | null {
  const env = process.env.BROWSER_WORKER_CHROMIUM_PATH;
  if (env && existsSync(env)) return env;
  if (existsSync('/opt/pw-browsers/chromium'))
    return '/opt/pw-browsers/chromium';
  return null;
}
const HAVE_BROWSER =
  chromiumPath() !== null || !!process.env.PLAYWRIGHT_BROWSERS_PATH;
const d = HAVE_BROWSER ? describe : describe.skip;
if (!HAVE_BROWSER && process.env.CI === 'true') {
  throw new Error('CI=true, но Chromium для e2e воркера не найден');
}

const blob = (js: string) =>
  `URL.createObjectURL(new Blob([${JSON.stringify(js)}],{type:'text/javascript'}))`;
const json = `{'content-type':'application/json'}`;

/** Зонды: всё с `/no/` до стенда дойти не должно. */
const NO: Record<string, string> = {
  lowerPost: `fetch('/no/lowerpost',{method:'post',body:'x'})`,
  patch: `fetch('/no/patch',{method:'patch',body:'x'})`,
  keepalive: `fetch('/no/keepalive',{method:'POST',body:'x',keepalive:true})`,
  beacon: `navigator.sendBeacon('/no/beacon','x')`,
  requestSubmit: `var f=document.createElement('form');f.method='post';f.action='/no/reqsubmit';f.innerHTML='<input name=a value=1>';document.body.appendChild(f);f.requestSubmit()`,
  iframePost: `var i=document.createElement('iframe');i.srcdoc='<form method=post action="https://${ADMIN}/no/iframepost"><input name=a value=1></form><script>document.forms[0].submit()<\\/script>';document.body.appendChild(i)`,
  // P1-1: попапы.
  winOpenLogout: `window.open('/no/pop/logout')`,
  winOpenPlain: `window.open('/no/pop/plain')`,
  winOpenOffhost: `window.open('https://${OTHER}/no/pop/offhost')`,
  winOpenFormPost: `var f=document.createElement('form');f.method='post';f.target='_blank';f.action='/no/winformpost';document.body.appendChild(f);f.submit()`,
  winOpenLink: `var a=document.createElement('a');a.href='/no/link/logout';a.target='_blank';document.body.appendChild(a);a.click()`,
  // P1-2: воркеры.
  worker: `try{new Worker(${blob(`fetch('https://${ADMIN}/no/workerpost',{method:'POST',body:'x'})`)})}catch(e){}`,
  workerWs: `try{new Worker(${blob(`new WebSocket('wss://${ADMIN}/no/dw-ws')`)})}catch(e){}`,
  sharedWorker: `try{new SharedWorker(${blob(`fetch('https://${ADMIN}/no/sharedpost',{method:'POST',body:'x'})`)})}catch(e){}`,
  sharedWorkerLogout: `try{new SharedWorker(${blob(`fetch('https://${ADMIN}/no/shw/logout')`)})}catch(e){}`,
  sharedWorkerWs: `try{new SharedWorker(${blob(`var s=new WebSocket('wss://${ADMIN}/no/sw-ws');s.onopen=function(){s.send('x')}`)})}catch(e){}`,
  iframeSharedWorker: `var i=document.createElement('iframe');document.body.appendChild(i);try{new i.contentWindow.SharedWorker(${blob(`fetch('https://${ADMIN}/no/ifr-shw',{method:'POST',body:'x'})`)})}catch(e){}`,
  iframeWorker: `var i=document.createElement('iframe');document.body.appendChild(i);try{new i.contentWindow.Worker(${blob(`new WebSocket('wss://${ADMIN}/no/ifr-dw-ws')`)})}catch(e){}`,
  // WebSocket страницы и фреймов.
  ws: `try{new WebSocket('wss://${ADMIN}/no/ws')}catch(e){}`,
  wsBlankIframe: `var i=document.createElement('iframe');document.body.appendChild(i);try{new i.contentWindow.WebSocket('wss://${ADMIN}/no/blank-ws')}catch(e){}`,
  wsSrcdocIframe: `var i=document.createElement('iframe');i.srcdoc='<script>new WebSocket("wss://${ADMIN}/no/srcdoc-ws")<\\/script>';document.body.appendChild(i)`,
  eventSource: `new EventSource('/no/orders/9/cancel')`,
  prefetchLogout: `var l=document.createElement('link');l.rel='prefetch';l.href='/no/prefetch/logout';document.head.appendChild(l)`,
  optionsCancel: `fetch('/no/opt/orders/5/cancel',{method:'OPTIONS'})`,
  // GraphQL (P2-2, P3-1…3).
  gqlGetMutation: `fetch('/no/graphql?query='+encodeURIComponent('mutation { deleteAll }'))`,
  gqlGetMutationNamedQuery: `fetch('/no/graphql?query='+encodeURIComponent('mutation query { deleteAll }'))`,
  gqlHeadMutation: `fetch('/no/graphql?query='+encodeURIComponent('mutation { deleteAll }'),{method:'HEAD'})`,
  gqlGetRepeat: `fetch('/no/graphql?query='+encodeURIComponent('{ a }')+'&query='+encodeURIComponent('mutation { b }'))`,
  gqlPostUrlMutation: `fetch('/no/graphql?query='+encodeURIComponent('mutation { deleteAll }'),{method:'POST',headers:${json},body:JSON.stringify({query:'{ a }'})})`,
  gqlDupKey: `fetch('/no/graphql',{method:'POST',headers:${json},body:'{"query":"mutation { dupDelete }","query":"{ a }"}'})`,
  gqlDupKeyEscaped: `fetch('/no/graphql',{method:'POST',headers:${json},body:'{"query":"mutation { dupDelete }","\\\\u0071uery":"{ a }"}'})`,
  gqlPersisted: `fetch('/no/graphql',{method:'POST',headers:${json},body:JSON.stringify({query:'{ a }',extensions:{persistedQuery:{version:1,sha256Hash:'deadbeef'}}})})`,
  gqlMultipart: `var fd=new FormData();fd.append('operations','{"query":"{ a }"}');fetch('/no/graphql',{method:'POST',body:fd})`,
  gqlSubstringPath: `fetch('/no/api/sgqlx/save',{method:'POST',headers:${json},body:JSON.stringify({query:'{ a }'})})`,
  // Словари адресов (P3-4).
  camelDelete: `fetch('/no/api/deleteOrder?id=5')`,
  camelLogout: `fetch('/no/api/logoutAll')`,
  archive: `fetch('/no/api/orders/5/archive')`,
  restore: `fetch('/no/api/orders/5/restore')`,
  confirm: `fetch('/no/api/orders/5/confirm')`,
  // Редиректы (P2-4).
  redirectToLogout: `fetch('/r/logout').catch(function(){})`,
  imgRedirectToLogout: `new Image().src='/r/img-logout'`,
  redirectChainToLogout: `fetch('/r/chain1').catch(function(){})`,
};

/** Встроенный скрипт до `domcontentloaded` (P2-3) и попап из него. */
const INLINE: Record<string, string> = {
  inlineLogout: `location.href='/no/inline/logout'`,
  inlineCancel: `location.href='/no/inline/orders/9/cancel'`,
  inlinePopup: `window.open('/no/inline/popup')`,
};

/** Контроль: чтение доходит (страж не «глушит всё подряд»). */
const OK: Record<string, string> = {
  gqlCommentMutation: `fetch('/ok/graphql',{method:'POST',headers:${json},body:JSON.stringify({query:'# mutation\\n{ a(s: "mutation { x }") }'})})`,
  optionsPlain: `fetch('/ok/opt-plain',{method:'OPTIONS'})`,
  plainGet: `fetch('/ok/api/orders?page=2')`,
};

d('write-guard e2e: «только чтение» под сессией (настоящий Chromium)', () => {
  const stand = new Stand();
  const internet = new FakeInternet(stand);
  let browser: Browser;
  const dns = new Map<string, string[]>([
    [ADMIN, [PUBLIC_TEST_IP]],
    [OTHER, [PUBLIC_TEST_IP]],
  ]);
  const egress = () => ({
    denyCidrs: [],
    allowedPorts: [80, 443],
    upstream: {
      protocol: 'http:' as const,
      host: '127.0.0.1',
      port: internet.port,
    },
    lookup: (h: string) => Promise.resolve(dns.get(h.toLowerCase()) ?? []),
    ignoreHttpsErrors: true,
    traffic: { responseBytes: 2 * MB, jobBytes: 16 * MB },
  });
  let spaSessions = 0;

  beforeAll(async () => {
    await stand.start();
    await internet.start();
    const all = { ...NO, ...OK };
    for (const [name, js] of Object.entries(all)) {
      stand.page(
        ADMIN,
        `/probe/${name}`,
        `<!doctype html><title>p</title><h1>${name}</h1><script>setTimeout(function(){${js}},50)</script>`,
      );
    }
    for (const [name, js] of Object.entries(INLINE)) {
      stand.page(
        ADMIN,
        `/probe/${name}`,
        `<!doctype html><title>p</title><script>${js}</script><h1>${name}</h1>`,
      );
    }
    const redirect =
      (to: string) => (_q: unknown, res: import('http').ServerResponse) => {
        res.writeHead(302, { location: to });
        res.end();
      };
    stand
      .on(ADMIN, '/r/logout', redirect('/no/redir/logout'))
      .on(ADMIN, '/r/img-logout', redirect('/no/imgredir/logout'))
      .on(ADMIN, '/r/chain1', redirect('/r/chain2'))
      .on(ADMIN, '/r/chain2', redirect('/no/chain/sign-out'))
      .on(ADMIN, '/r/ok', redirect('/ok/redir-target'))
      .on(ADMIN, '/ok/redir-target', (_q, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":"ціль редиректу"}');
      })
      .page(
        ADMIN,
        '/probe/redirectOk',
        `<!doctype html><title>p</title><h1 id=h>чекаю</h1><script>fetch('/r/ok').then(function(r){return r.json()}).then(function(d){document.getElementById('h').textContent=d.ok})</script>`,
      );
    browser = await chromium.launch({
      headless: true,
      executablePath: chromiumPath() ?? undefined,
      chromiumSandbox: false,
      args: HARDENING_ARGS,
      env: browserEnv(),
    });
  });

  afterAll(async () => {
    await browser?.close();
    await internet.stop();
    await stand.stop();
  });

  /** Страница-зонд под `sessionReadOnly`; что дошло до стенда. */
  const run = async (
    path: string,
    wait = 1_500,
  ): Promise<{
    hits: string[];
    blocked: Record<string, number>;
    text: string;
    gotoError: string;
  }> => {
    const jb = await JobBrowser.open(browser, [ADMIN], 'desktop', egress());
    const before = stand.hits.length;
    let text = '';
    let blocked: Record<string, number> = {};
    let gotoError = '';
    try {
      await jb.sessionReadOnly();
      const page = await jb.newPage();
      // Переход, оборванный стражем (встроенный скрипт уводит на
      // «выход»), — ошибка задания, а не «выход»: здесь важно, что дошло.
      await jb.goto(page, `https://${ADMIN}${path}`).catch((e: Error) => {
        gotoError = (e as { code?: string }).code ?? e.message;
      });
      await new Promise((r) => setTimeout(r, wait));
      text = await page
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');
    } finally {
      blocked = jb.writesBlocked();
      await jb.close();
    }
    return {
      hits: stand.hits.slice(before).filter((h) => !h.includes('/probe/')),
      blocked,
      text,
      gotoError,
    };
  };

  const forbidden = (hits: string[]) =>
    hits.filter((h) => h.includes('/no/') || h.startsWith('UPGRADE'));

  for (const name of [...Object.keys(NO), ...Object.keys(INLINE)]) {
    it(`не доходит: ${name}`, async () => {
      const r = await run(`/probe/${name}`);
      expect(forbidden(r.hits)).toEqual([]);
    });
  }

  it('встроенный скрипт уводит на «выход» во время goto — переход оборван, код egress_blocked (обход пропустит страницу)', async () => {
    const r = await run('/probe/inlineLogout');
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.gotoError).toBe('egress_blocked');
    expect(r.blocked.logout).toBe(1);
  });

  it('попап засчитан в журнал (popup), задание живо', async () => {
    const r = await run('/probe/winOpenFormPost');
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.blocked.popup).toBeGreaterThanOrEqual(1);
  });

  it('редирект на «выход» — обрыв по Location; первый шаг дошёл, цель — нет', async () => {
    const r = await run('/probe/redirectChainToLogout');
    expect(r.hits.some((h) => h.includes('/r/chain1'))).toBe(true);
    expect(r.hits.some((h) => h.includes('/r/chain2'))).toBe(true);
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.blocked.logout).toBeGreaterThanOrEqual(1);
  });

  for (const name of Object.keys(OK)) {
    it(`доходит (контроль): ${name}`, async () => {
      const r = await run(`/probe/${name}`);
      expect(r.hits.some((h) => h.includes('/ok/'))).toBe(true);
    });
  }

  it('безопасный редирект проходит: цель запрошена ровно раз, ответ дошёл до страницы', async () => {
    const r = await run('/probe/redirectOk');
    expect(r.hits.filter((h) => h.includes('/ok/redir-target'))).toHaveLength(
      1,
    );
    expect(r.hits.filter((h) => h.includes('/r/ok'))).toHaveLength(1);
    expect(r.text).toContain('ціль редиректу');
  });

  // ── Вход (P2-1, P3-5, M4, M5) ───────────────────────────────────────────
  const spaLogin = (
    delay: number,
  ) => `<!doctype html><html><head><title>Вхід</title></head><body>
<form id=f><label>Логін <input name=login></label><label>Пароль <input type=password name=password></label><button type=submit>Увійти</button></form>
<div id=dash hidden><h1>Дашборд SPA</h1></div>
<script>
var ws;
document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  try { ws = new WebSocket('wss://${ADMIN}/ws-login'); ws.onopen = function () { ws.send('in-window'); }; } catch (x) {}
  setTimeout(function () {
    fetch('https://${OTHER}/no/3p-login', { method: 'POST', mode: 'no-cors', body: 'x' }).catch(function () {});
    fetch('/api/spa-login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p: 1 }) })
      .then(function (r) {
        if (!r.ok) return;
        document.getElementById('f').remove();
        document.getElementById('dash').hidden = false;
        setTimeout(function () {
          fetch('/no/after-login', { method: 'POST', body: 'x' }).catch(function () {});
          try { ws.send('after-window'); } catch (x) {}
        }, 300);
      });
  }, ${delay});
});
</script></body></html>`;

  const crawlLogin = async (start: string) => {
    const jb = await JobBrowser.open(browser, [ADMIN], 'desktop', egress());
    const before = stand.hits.length;
    try {
      const ctx = {
        job: {
          id: 'wg-login',
          kind: 'admin-crawl',
          params: {
            startUrl: `https://${ADMIN}${start}`,
            allowedHosts: [ADMIN],
            viewport: 'desktop',
            maxPages: 1,
            maxDepth: 0,
            loginMethod: 'password',
          },
        },
        jb,
        signal: new AbortController().signal,
        log: createLogger('error', () => undefined),
        uploadArtifact: () => Promise.resolve(),
        credentials: () =>
          Promise.resolve({
            username: 'manager',
            password: new SecretBox(['Pw', 'wg', 'marker'].join('-')),
            cookies: null,
            wipe: () => undefined,
          }),
        unseal: () => Buffer.alloc(0),
      } as unknown as JobContext;
      const r = await runAdminCrawl(ctx);
      // Таймеры страницы после входа (запись дашборда, сообщение WS) —
      // успевают сработать, пока страница жива.
      await new Promise((res) => setTimeout(res, 800));
      return {
        r,
        hits: stand.hits.slice(before),
        blocked: jb.writesBlocked(),
      };
    } finally {
      await jb.close();
    }
  };

  it('SPA-вход (fetch через 300 мс после Enter): POST входа проходит; сторонний хост в окне, запись дашборда и WS после окна — нет', async () => {
    stand
      .page(ADMIN, '/spa-login', spaLogin(300))
      .wsAccept(ADMIN, '/ws-login')
      .on(ADMIN, '/api/spa-login', (q, res) => {
        if (q.method === 'POST') spaSessions += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    spaSessions = 0;
    const { r, hits, blocked } = await crawlLogin('/spa-login');
    expect(r.loggedIn).toBe(true);
    expect(spaSessions).toBe(1);
    expect(r.pages[0]?.text ?? '').toContain('Дашборд SPA');
    // Окно входа: запись на хост замка — да; на сторонний (M4) — нет.
    expect(
      hits.some((h) => h.startsWith('POST') && h.includes('/api/spa-login')),
    ).toBe(true);
    expect(hits.some((h) => h.includes(`${OTHER}/no/3p-login`))).toBe(false);
    // WebSocket из окна входа соединился и сказал своё…
    expect(hits).toContain(`WSMSG ${ADMIN}/ws-login in-window`);
    // …а после окна (M5) — молчит; запись дашборда после входа (P3-5) — нет.
    expect(hits.some((h) => h.includes('after-window'))).toBe(false);
    expect(hits.some((h) => h.includes('/no/after-login'))).toBe(false);
    expect(blocked.websocket).toBeGreaterThanOrEqual(1);
    expect(blocked.method).toBeGreaterThanOrEqual(2);
  });

  it('классический вход формой: POST и редирект проходят, запись при загрузке дашборда — нет', async () => {
    let sessions = 0;
    stand
      .page(
        ADMIN,
        '/form-login',
        `<!doctype html><title>Вхід</title><form method=post action="/form-login"><input name=login><input type=password name=password><button type=submit>Увійти</button></form>`,
      )
      .on(ADMIN, '/form-login', (q, res, body) => {
        if (
          q.method === 'POST' &&
          new URLSearchParams(body).get('login') === 'manager'
        ) {
          sessions += 1;
          res.writeHead(302, {
            location: '/form-admin',
            'set-cookie': 'fsid=ok; Path=/; Secure; HttpOnly',
          });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><title>Вхід</title><form method=post action="/form-login"><input name=login><input type=password name=password><button type=submit>Увійти</button></form>',
        );
      })
      .on(ADMIN, '/form-admin', (q, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          String(q.headers.cookie ?? '').includes('fsid=ok')
            ? `<!doctype html><title>Адмінка</title><h1>Панель форми</h1><script>fetch('/no/last-login',{method:'POST',body:'x'}).catch(function(){})</script>`
            : '<!doctype html><title>?</title><h1>Без сесії</h1>',
        );
      });
    const { r, hits } = await crawlLogin('/form-login');
    expect(r.loggedIn).toBe(true);
    expect(sessions).toBe(1);
    expect(r.pages[0]?.text ?? '').toContain('Панель форми');
    expect(hits.some((h) => h.includes('/no/'))).toBe(false);
  });
});
