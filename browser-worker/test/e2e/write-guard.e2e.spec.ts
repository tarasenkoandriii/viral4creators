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
import { JobBrowser, REDIRECT_MAX_HOPS } from '../../src/browser/context';

/** Лимит шагов редиректа числом — тест не должен следовать за константой. */
const MAX_HOPS = 5;
import { HARDENING_ARGS, browserEnv } from '../../src/browser/pool';
import { runAdminCrawl } from '../../src/jobs/admin-crawl';
import type { JobContext } from '../../src/jobs/types';
import { createLogger } from '../../src/logger';
import { SecretBox } from '../../src/secret-box';
import { FakeInternet, PUBLIC_TEST_IP, Stand } from '../helpers/stand';

const ADMIN = 'admin.wg.test';
const OTHER = 'other.wg.test';
/** Второй хост замка (заход 13, аудит P1-1: cookie хоста A не идут на B). */
const ADMIN2 = 'admin2.wg.test';
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
  // Заход 13 (Р-З13-Г2): пассивные виды под сессией.
  imgDelete: `new Image().src='/no/img/orders/5/delete'`,
  imgTagDelete: `var m=document.createElement('img');m.src='/no/imgtag/deleteOrder?id=5';document.body.appendChild(m)`,
  imgQueryDelete: `new Image().src='/no/imgq/pixel.png?action=delete&id=5'`,
  imgDirDelete: `new Image().src='/no/imgdir/orders/5/cancel/x.png'`,
  cssDelete: `var d=document.createElement('div');d.style.width='10px';d.style.height='10px';d.style.backgroundImage='url(/no/css/orders/5/delete)';document.body.appendChild(d)`,
  videoDelete: `var v=document.createElement('video');v.src='/no/video/orders/5/remove';v.preload='auto';document.body.appendChild(v)`,
  objectDelete: `var o=document.createElement('object');o.data='/no/object/orders/5/delete';o.width=10;o.height=10;document.body.appendChild(o)`,
  imgRedirectToDelete: `new Image().src='/r/img-delete'`,
  // Заход 13 (Р-З13-Г3): дальние шаги редиректа документа.
  iframeDocChain: `var i=document.createElement('iframe');i.src='/r/doc1';document.body.appendChild(i)`,
  navDocChain: `location.href='/r/nav1'`,
  // Раунд исправлений захода 13.
  // P3-3: скрипт / JSONP под сессией.
  scriptJsonp: `var s=document.createElement('script');s.src='/no/jsonp/orders/5/delete?callback=cb';document.head.appendChild(s)`,
  // P3-4: матричный параметр.
  imgMatrix: `new Image().src='/no/matrix/orders/5/delete;.png'`,
  // P2-1: «отскок» через хост вне замка и цепочки, начатые на нём.
  bounceIframe: `var i=document.createElement('iframe');i.src='/r/b1';document.body.appendChild(i)`,
  bounceNav: `location.href='/r/bn1'`,
  bounceImg: `new Image().src='/r/bi1'`,
  bounceFetch: `fetch('/r/bf1').catch(function(){})`,
  offIframe: `var i=document.createElement('iframe');i.src='https://${OTHER}/r/oi';document.body.appendChild(i)`,
  offImg: `new Image().src='https://${OTHER}/r/oimg'`,
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
  // Заход 13: имя файла иконки — не действие (каталог и query чистые).
  imgIconDelete: `new Image().src='/ok/icons/delete.svg'`,
  imgIconCamel: `new Image().src='/ok/icons/removeItem.png'`,
  imgPlain: `new Image().src='/ok/img/orders/5/thumb'`,
  // Раунд исправлений захода 13 (P3-2): иконка «выхода» и каталоги
  // ресурсов со словами import/download; имя файла кода.
  imgIconLogout: `new Image().src='/ok/icons/logout.svg'`,
  imgImportDir: `new Image().src='/ok/uploads/import/2024/photo.jpg'`,
  imgDownloadDir: `new Image().src='/ok/media/download/123/x.png'`,
  scriptDeleteModal: `var s=document.createElement('script');s.src='/ok/js/delete-modal.js';document.head.appendChild(s)`,
  // P2-1 контроль: безопасный «отскок» доходит до конца.
  bounceOk: `fetch('/r/bok1').catch(function(){})`,
};

/**
 * Аудит P1-1: зонды утечки сессии при редиректе подресурса или документа
 * на хост вне замка и на ДРУГОЙ хост замка. Сборщик `/collect/*` пишет,
 * какие cookie и заголовки авторизации до него дошли.
 */
const AUTH = `{headers:{authorization:'Bearer SECRET-TOKEN','x-csrf-token':'CSRF-SECRET'}}`;
const LEAK: Record<string, string> = {
  authLeakOff: `fetch('/r/auth-off',${AUTH}).catch(function(){})`,
  authLeakLock2: `fetch('/r/auth-lock2',${AUTH}).catch(function(){})`,
  authSameOrigin: `fetch('/r/auth-same',${AUTH}).catch(function(){})`,
  imgLeakOff: `new Image().src='/r/img-off'`,
  docLeakLock2: `var i=document.createElement('iframe');i.src='/r/doc-lock2';document.body.appendChild(i)`,
};

d('write-guard e2e: «только чтение» под сессией (настоящий Chromium)', () => {
  const stand = new Stand();
  const internet = new FakeInternet(stand);
  let browser: Browser;
  const dns = new Map<string, string[]>([
    [ADMIN, [PUBLIC_TEST_IP]],
    [OTHER, [PUBLIC_TEST_IP]],
    [ADMIN2, [PUBLIC_TEST_IP]],
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
  /** Что дошло до сборщиков `/collect/*` и до первых шагов `/r/auth-*`. */
  const collected: Array<{
    at: string;
    cookie: string;
    authorization: string;
    csrf: string;
  }> = [];
  /** Cookie запросов к концу безопасной цепочки документа (заход 13). */
  const finalCookies: string[] = [];

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
      .on(ADMIN, '/r/doc1', redirect('/r/doc2'))
      .on(ADMIN, '/r/doc2', redirect('/no/docchain/sign-out'))
      .on(ADMIN, '/r/nav1', redirect('/r/nav2'))
      .on(ADMIN, '/r/nav2', redirect('/no/navchain/orders/9/cancel'))
      .on(ADMIN, '/r/img-delete', redirect('/no/imgredir/orders/5/delete'))
      // P2-1: «отскок» через хост вне замка и цепочки, начатые на нём.
      .on(ADMIN, '/r/b1', redirect(`https://${OTHER}/r/b2`))
      .on(
        OTHER,
        '/r/b2',
        redirect(`https://${ADMIN}/no/bounce-if/orders/5/delete`),
      )
      .on(ADMIN, '/r/bn1', redirect(`https://${OTHER}/r/bn2`))
      .on(
        OTHER,
        '/r/bn2',
        redirect(`https://${ADMIN}/no/bounce-nav/orders/9/cancel`),
      )
      .on(ADMIN, '/r/bi1', redirect(`https://${OTHER}/r/bi2`))
      .on(
        OTHER,
        '/r/bi2',
        redirect(`https://${ADMIN}/no/bounce-img/orders/5/delete`),
      )
      .on(ADMIN, '/r/bf1', redirect(`https://${OTHER}/r/bf2`))
      .on(OTHER, '/r/bf2', redirect(`https://${ADMIN}/no/bounce-fetch/logout`))
      .on(
        OTHER,
        '/r/oi',
        redirect(`https://${ADMIN}/no/off-if/orders/5/delete`),
      )
      .on(
        OTHER,
        '/r/oimg',
        redirect(`https://${ADMIN}/no/off-img/orders/5/delete`),
      )
      .on(ADMIN, '/r/bok1', redirect(`https://${OTHER}/r/bok2`))
      .on(OTHER, '/r/bok2', redirect(`https://${ADMIN}/ok/bounce-final`))
      // Конец цепочки главного фрейма — вне замка: обрыв, offhost.
      .on(ADMIN, '/r/nx1', redirect(`https://${OTHER}/r/nx2`))
      .on(OTHER, '/r/nx2', redirect(`https://${OTHER}/offhost-final`))
      .page(
        ADMIN,
        '/probe/navOffhostChain',
        `<!doctype html><title>p</title><h1>navOffhostChain</h1><script>setTimeout(function(){location.href='/r/nx1'},50)</script>`,
      )
      // P3-5: петля редиректа — не больше REDIRECT_MAX_HOPS запросов.
      .on(ADMIN, '/r/loop', redirect('/r/loop'))
      .on(ADMIN, '/r/loopd', redirect('/r/loopd'))
      .page(
        ADMIN,
        '/probe/loopFetch',
        `<!doctype html><title>p</title><h1>loop</h1><script>setTimeout(function(){fetch('/r/loop').catch(function(){})},50)</script>`,
      )
      .page(
        ADMIN,
        '/probe/loopDoc',
        `<!doctype html><title>p</title><h1>loop</h1><script>setTimeout(function(){var i=document.createElement('iframe');i.src='/r/loopd';document.body.appendChild(i)},50)</script>`,
      )
      // Безопасная цепочка документа: промежуточный шаг ставит cookie,
      // конечный адрес записывает, с какими cookie пришёл запрос.
      .on(ADMIN, '/r/okdoc1', (_q, res) => {
        res.writeHead(302, {
          location: '/r/okdoc2',
          'set-cookie': 'z13hop=1; Path=/; Secure; SameSite=Lax',
        });
        res.end();
      })
      .on(ADMIN, '/r/okdoc2', redirect('/ok/doc-final'))
      .on(ADMIN, '/ok/doc-final', (q, res) => {
        finalCookies.push(String(q.headers.cookie ?? ''));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>f</title><h1>кінцева сторінка</h1>');
      })
      .page(
        ADMIN,
        '/probe/okDocChain',
        `<!doctype html><title>p</title><h1>okDocChain</h1><script>setTimeout(function(){var i=document.createElement('iframe');i.id='f';i.src='/r/okdoc1';document.body.appendChild(i)},50)</script>`,
      )
      .page(
        ADMIN,
        '/probe/okNavChain',
        `<!doctype html><title>p</title><h1>okNavChain</h1><script>setTimeout(function(){location.href='/r/okdoc1'},50)</script>`,
      )
      .on(ADMIN, '/ok/redir-target', (_q, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":"ціль редиректу"}');
      })
      .page(
        ADMIN,
        '/probe/redirectOk',
        `<!doctype html><title>p</title><h1 id=h>чекаю</h1><script>fetch('/r/ok').then(function(r){return r.json()}).then(function(d){document.getElementById('h').textContent=d.ok})</script>`,
      );
    // P1-1: утечка сессии при редиректе (сборщики и первые шаги).
    const collect =
      (at: string) =>
      (
        q: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ) => {
        collected.push({
          at,
          cookie: String(q.headers.cookie ?? ''),
          authorization: String(q.headers.authorization ?? ''),
          csrf: String(q.headers['x-csrf-token'] ?? ''),
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>c</title><h1>c</h1>');
      };
    const firstHop =
      (at: string, to: string) =>
      (
        q: import('http').IncomingMessage,
        res: import('http').ServerResponse,
      ) => {
        collected.push({
          at,
          cookie: String(q.headers.cookie ?? ''),
          authorization: String(q.headers.authorization ?? ''),
          csrf: String(q.headers['x-csrf-token'] ?? ''),
        });
        res.writeHead(302, { location: to });
        res.end();
      };
    stand
      .on(
        ADMIN,
        '/r/auth-off',
        firstHop('first-auth-off', `https://${OTHER}/collect/auth-off`),
      )
      .on(
        ADMIN,
        '/r/auth-lock2',
        firstHop('first-auth-lock2', `https://${ADMIN2}/collect/auth-lock2`),
      )
      .on(
        ADMIN,
        '/r/auth-same',
        firstHop('first-auth-same', '/collect/auth-same'),
      )
      .on(
        ADMIN,
        '/r/img-off',
        firstHop('first-img-off', `https://${OTHER}/collect/img-off`),
      )
      .on(
        ADMIN,
        '/r/doc-lock2',
        firstHop('first-doc-lock2', `https://${ADMIN2}/collect/doc-lock2`),
      )
      .on(OTHER, '/collect/auth-off', collect('auth-off'))
      .on(ADMIN2, '/collect/auth-lock2', collect('auth-lock2'))
      .on(ADMIN, '/collect/auth-same', collect('auth-same'))
      .on(OTHER, '/collect/img-off', collect('img-off'))
      .on(ADMIN2, '/collect/doc-lock2', collect('doc-lock2'));
    for (const [name, js] of Object.entries(LEAK)) {
      stand.page(
        ADMIN,
        `/probe/${name}`,
        `<!doctype html><title>p</title><h1>${name}</h1><script>setTimeout(function(){${js}},50)</script>`,
      );
    }
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
    mode: 'session' | 'snapshot' = 'session',
    opts: { hosts?: string[]; sessionCookie?: boolean } = {},
  ): Promise<{
    hits: string[];
    blocked: Record<string, number>;
    text: string;
    gotoError: string;
    frames: string[];
    url: string;
    offhost: boolean;
  }> => {
    const jb = await JobBrowser.open(
      browser,
      opts.hosts ?? [ADMIN],
      'desktop',
      egress(),
    );
    let offhost = false;
    if (opts.sessionCookie) {
      // Сессия учётки — host-only cookie хоста A (как у живой «Админки»).
      await jb.context.addCookies([
        {
          name: 'sid',
          value: 'SESSION-SECRET',
          url: `https://${ADMIN}/`,
          secure: true,
          sameSite: 'None',
        },
      ]);
    }
    const before = stand.hits.length;
    let text = '';
    let blocked: Record<string, number> = {};
    let gotoError = '';
    let frames: string[] = [];
    let url = '';
    try {
      if (mode === 'session') await jb.sessionReadOnly();
      else jb.setReadOnly(true);
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
      frames = page.frames().map((f) => f.url());
      url = page.url();
      offhost = jb.offhost;
    } finally {
      blocked = jb.writesBlocked();
      await jb.close();
    }
    return {
      hits: stand.hits.slice(before).filter((h) => !h.includes('/probe/')),
      blocked,
      text,
      gotoError,
      frames,
      url,
      offhost,
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

  // ── Заход 13: картинки под сессией и дальние шаги документа ─────────────

  it('Р-З13-Г2: картинка с разрушительным адресом — обрыв, причина passive (не «запись» danger)', async () => {
    const r = await run('/probe/imgDelete');
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.blocked.passive).toBeGreaterThanOrEqual(1);
    expect(r.blocked.danger).toBe(0);
  });

  it('Р-З13-Г2: «Снимок» без сессии — картинку не трогаем (GET без cookie ничего не меняет)', async () => {
    const r = await run('/probe/imgDelete', 1_500, 'snapshot');
    expect(r.hits.some((h) => h.includes('/no/img/orders/5/delete'))).toBe(
      true,
    );
    expect(r.blocked.danger + r.blocked.passive).toBe(0);
  });

  it('Р-З13-Г3: документ фрейма — третий шаг цепочки («выход») оборван', async () => {
    const r = await run('/probe/iframeDocChain');
    expect(r.hits.some((h) => h.includes('/r/doc2'))).toBe(true);
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.blocked.logout).toBeGreaterThanOrEqual(1);
  });

  it('Р-З13-Г3: переход страницы — третий шаг цепочки (cancel) оборван', async () => {
    const r = await run('/probe/navDocChain');
    expect(forbidden(r.hits)).toEqual([]);
    expect(r.blocked.danger).toBeGreaterThanOrEqual(1);
  });

  it('Р-З13-Г3: безопасная цепочка документа — фрейм на НАСТОЯЩЕМ конечном адресе, cookie шага дошла, конец запрошен не больше двух раз', async () => {
    finalCookies.length = 0;
    const r = await run('/probe/okDocChain');
    expect(r.frames).toContain(`https://${ADMIN}/ok/doc-final`);
    const finals = r.hits.filter((h) => h.includes('/ok/doc-final'));
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect(finals.length).toBeLessThanOrEqual(2);
    expect(r.hits.filter((h) => h.includes('/r/okdoc1'))).toHaveLength(1);
    expect(r.hits.filter((h) => h.includes('/r/okdoc2'))).toHaveLength(1);
    expect(finalCookies.length).toBe(finals.length);
    for (const c of finalCookies) expect(c).toContain('z13hop=1');
  });

  it('Р-З13-Г3: безопасная цепочка перехода главного фрейма — страница на конечном адресе', async () => {
    const r = await run('/probe/okNavChain');
    expect(r.url).toBe(`https://${ADMIN}/ok/doc-final`);
    expect(r.text).toContain('кінцева сторінка');
    expect(r.blocked.danger + r.blocked.logout + r.blocked.passive).toBe(0);
  });

  // ── Раунд исправлений захода 13 ─────────────────────────────────────────

  it('аудит P1-1: редирект на хост вне замка и на другой хост замка — ни cookie учётки, ни Authorization, ни CSRF; тот же origin — как у браузера', async () => {
    collected.length = 0;
    for (const name of Object.keys(LEAK)) {
      await run(`/probe/${name}`, 1_500, 'session', {
        hosts: [ADMIN, ADMIN2],
        sessionCookie: true,
      });
    }
    const at = (k: string) => collected.filter((c) => c.at === k);
    // Контроль: первые шаги на хосте A получили сессию (тест не пустой).
    for (const k of [
      'first-auth-off',
      'first-auth-lock2',
      'first-img-off',
      'first-doc-lock2',
    ]) {
      expect([k, at(k).length > 0]).toEqual([k, true]);
      for (const c of at(k)) expect(c.cookie).toContain('SESSION-SECRET');
    }
    expect(at('first-auth-off')[0].authorization).toBe('Bearer SECRET-TOKEN');
    // Сборщики на чужом хосте и на хосте замка B — без сессии хоста A.
    for (const k of ['auth-off', 'auth-lock2', 'img-off', 'doc-lock2']) {
      expect([k, at(k).length > 0]).toEqual([k, true]);
      for (const c of at(k)) {
        expect([k, c.cookie]).not.toEqual([
          k,
          expect.stringContaining('SESSION-SECRET'),
        ]);
        expect([k, c.authorization, c.csrf]).toEqual([k, '', '']);
      }
    }
    // Тот же origin — заголовки и cookie сохраняются (как у браузера).
    expect(at('auth-same').length).toBeGreaterThan(0);
    for (const c of at('auth-same')) {
      expect(c.cookie).toContain('SESSION-SECRET');
      expect(c.authorization).toBe('Bearer SECRET-TOKEN');
      expect(c.csrf).toBe('CSRF-SECRET');
    }
  });

  it('аудит P2-1: «отскок» через хост вне замка обрывается на возврате (iframe, переход, картинка, fetch, цепочки с чужого хоста)', async () => {
    for (const name of [
      'bounceIframe',
      'bounceNav',
      'bounceImg',
      'bounceFetch',
      'offIframe',
      'offImg',
    ]) {
      const r = await run(`/probe/${name}`);
      expect([name, forbidden(r.hits)]).toEqual([name, []]);
      expect([
        name,
        r.blocked.danger + r.blocked.logout + r.blocked.passive >= 1,
      ]).toEqual([name, true]);
      // Шаг на чужом хосте пройден воркером — цепочка видна целиком.
      expect([name, r.hits.some((h) => h.includes(OTHER))]).toEqual([
        name,
        true,
      ]);
    }
  });

  it('аудит P2-1: безопасный «отскок» доходит до конца ровно раз', async () => {
    const r = await run('/probe/bounceOk');
    expect(r.hits.filter((h) => h.includes('/ok/bounce-final'))).toHaveLength(
      1,
    );
  });

  it('аудит P2-1: конец цепочки главного фрейма вне замка — обрыв, offhost; конечный адрес браузер не открыл', async () => {
    const r = await run('/probe/navOffhostChain');
    expect(r.offhost).toBe(true);
    // Переход оборван (страница ошибки, как у прямого увода), не на чужом хосте.
    expect(r.url).not.toContain(OTHER);
    // Проверочный запрос воркера — один; браузер туда не ходил.
    expect(r.hits.filter((h) => h.includes('/offhost-final'))).toHaveLength(1);
  });

  it('аудит P3-5: петля редиректа — не больше REDIRECT_MAX_HOPS запросов, затем обрыв (fetch и документ)', async () => {
    expect(REDIRECT_MAX_HOPS).toBe(MAX_HOPS);
    const f = await run('/probe/loopFetch');
    expect(f.hits.filter((h) => h.endsWith('/r/loop'))).toHaveLength(MAX_HOPS);
    const d2 = await run('/probe/loopDoc');
    expect(d2.hits.filter((h) => h.endsWith('/r/loopd'))).toHaveLength(
      MAX_HOPS,
    );
    expect(d2.frames.some((u) => u.endsWith('/r/loopd'))).toBe(false);
  });

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
