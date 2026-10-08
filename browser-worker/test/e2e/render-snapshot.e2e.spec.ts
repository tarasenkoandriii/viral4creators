/**
 * e2e воркера, заход 10 (пакет Д), на НАСТОЯЩЕМ Chromium и настоящем
 * фильтрующем прокси (стенд, «интернет» и фейковый sites-backend — как в
 * worker.e2e.spec.ts):
 *
 *  1. `knowledge-render` (Ш3 (20)): SPA-стенд рисует текст скриптом после
 *     загрузки — воркер отдаёт «очищенный» HTML видимого основного текста
 *     (без скриптов, полей и их значений, скрытого, обвязки), ссылки
 *     только своего хоста, ПД третьих лиц в отзывах — маской; страница,
 *     уводящая на чужой хост, — отказ ЭТОЙ страницы, остальные — дальше;
 *     чистый контекст — cookie сайта не переживает задание;
 *  2. «Снимок» с раскрывашками (Ш3 (5)): меню и вкладка раскрыты —
 *     отдельные состояния с новыми элементами и скриншотами, элементы
 *     раскрытий — в карте Ш4; «Видалити», отправка формы и раскрывашка-
 *     ссылка «/delete» — НЕ нажаты (стенд не получил ни одного такого
 *     запроса); раскрывашка, уводящая со страницы, — назад, без состояния;
 *     без `toggles` — прежняя форма результата (без `states`).
 */
import { existsSync } from 'fs';
import { createApiClient } from '../../src/api-client';
import { BrowserPool } from '../../src/browser/pool';
import { createLogger } from '../../src/logger';
import { Runner } from '../../src/runner';
import { FakeSites } from '../helpers/fake-sites';
import { FakeInternet, PUBLIC_TEST_IP, Stand } from '../helpers/stand';

const SECRET = 'r'.repeat(48);
const SPA = 'spa.z10.test';
const OTHER = 'other.z10.test';
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

/** Оболочка SPA: текста в HTML нет — его рисует скрипт после данных. */
const SPA_SHELL = (route: string) => `<!doctype html><html lang="uk"><head>
<title>Магазин SPA</title><script src="/app.js?r=${route}" defer></script></head>
<body><div id="root"></div><noscript>Увімкніть JavaScript</noscript></body></html>`;

const APP_JS = `
(async () => {
  const route = new URL(document.querySelector('script[src]').src).searchParams.get('r');
  const data = await (await fetch('/api/data?r=' + route)).json();
  document.cookie = 'spa_seen=1; path=/';
  const root = document.getElementById('root');
  root.innerHTML = \`
    <header class="site-header"><nav><a href="/catalog">Каталог</a><a href="/delivery">Доставка</a>
      <a href="https://${OTHER}/x">Партнер</a></nav></header>
    <main>
      <h1>\${data.title}</h1>
      <p>\${data.text}</p>
      <h2>Оплата</h2><ul><li>Карткою на сайті</li><li>Післяплата</li></ul>
      <p style="display:none">ПРИХОВАНИЙ ТЕКСТ ІНЖЕКЦІЇ</p>
      <form><label>Ім'я <input name="n" value="Секретне значення"></label><button>Надіслати</button></form>
      <div class="reviews"><p>Чудовий магазин! Пишіть: buyer@example.com, +380 67 111 22 33</p></div>
      <p>Телефон магазину: +380 44 000 00 00</p>
    </main>
    <footer class="site-footer"><p>Футер © 2026</p></footer>\`;
})();`;

const MENU_PAGE = `<!doctype html><html><head><title>Меню</title></head><body>
<header><button aria-expanded="false" id="m" onclick="document.getElementById('menu').hidden=false;this.setAttribute('aria-expanded','true')">Меню</button>
<div id="menu" hidden><a href="/reports">Звіти</a><button data-assist-id="calc">Калькулятор</button></div></header>
<main><h1>Головна</h1>
<div role="tablist"><button role="tab" aria-selected="true">Опис</button>
<button role="tab" aria-selected="false" onclick="document.getElementById('specs').hidden=false;this.setAttribute('aria-selected','true')">Характеристики</button></div>
<div id="specs" hidden><button>Порівняти</button></div>
<button aria-expanded="false" onclick="fetch('/hit/delete',{method:'POST'})">Видалити</button>
<a href="/orders/7/delete" aria-expanded="false">Ще дії</a>
<a href="/elsewhere" aria-expanded="false">Інша сторінка</a>
<form><button type="submit" aria-expanded="false" onclick="fetch('/hit/submit',{method:'POST'})">Розгорнути форму</button></form>
</main></body></html>`;

/** Аудит P1-1: раскрывашки, которые уводят на МЕДЛЕННУЮ страницу (> 1 с). */
const SLOW_MENU = `<!doctype html><html><head><title>Меню повільне</title></head><body>
<main><h1>Каталог</h1>
<button aria-expanded="false" onclick="location.href='/slow-b'">Фільтри</button>
<a href="/slow-a" aria-expanded="false">Усі категорії</a>
<button aria-expanded="false" onclick="fetch('/hit/post',{method:'POST'}).catch(()=>{});document.getElementById('more').hidden=false;this.setAttribute('aria-expanded','true')">Показати більше</button>
<div id="more" hidden><button>Ще товари</button></div>
<button aria-expanded="false" onclick="document.getElementById('menu').hidden=false;this.setAttribute('aria-expanded','true')">Меню</button>
<div id="menu" hidden><a href="/reports">Звіти</a></div>
<button aria-expanded="false" onclick="setTimeout(()=>{location.href='/slow-c'},400)">Пізніше</button>
</main></body></html>`;

/** Аудит P2-3: «появление при прокрутке», инлайн-скрытие, одиночный суррогат. */
const REVEAL = `<!doctype html><html lang="uk"><head><title>Про нас</title>
<style>.reveal{opacity:0;transition:opacity .1s}.reveal.on{opacity:1}.fade-in{opacity:0}</style></head>
<body><main><h1>Про магазин</h1>
<p>Ми продаємо срібні монети з 2010 року; доставка Новою поштою по всій Україні, оплата карткою або післяплатою, повернення протягом 14 днів.</p>
<div style="height:3000px"></div>
<p class="reveal">Текст, що зʼявляється при прокрутці.</p>
<p class="fade-in">Блок із класом анімації без тригера.</p>
<p id="js" style="opacity:0">Анімований абзац після прокрутки.</p>
<p style="opacity:0">ПРИХОВАНА ІНЖЕКЦІЯ ДЛЯ ШІ</p>
<p id="sur">Символ</p>
<script>
document.getElementById('sur').textContent = 'Символ \uD800 кінець';
const io = new IntersectionObserver((es) => es.forEach((e) => {
  if (!e.isIntersecting) return;
  e.target.classList.add('on');
  if (e.target.id === 'js') e.target.style.opacity = '1';
}));
document.querySelectorAll('.reveal,#js').forEach((x) => io.observe(x));
</script></main></body></html>`;

d('browser-worker e2e: рендер SPA и раскрывашки «Снимка» (заход 10)', () => {
  const stand = new Stand();
  const internet = new FakeInternet(stand);
  const sites = new FakeSites(SECRET);
  const cookiesSeen: string[] = [];
  let pool: BrowserPool;
  let runner: Runner;

  beforeAll(async () => {
    await stand.start();
    await internet.start();
    await sites.start();
    stand
      .page(SPA, '/', SPA_SHELL('home'))
      .page(SPA, '/about', SPA_SHELL('about'))
      .page(SPA, '/set', SPA_SHELL('home'), {
        'set-cookie': 'tenant=A; Path=/; Secure',
      })
      .on(SPA, '/app.js', (_q, res) => {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(APP_JS);
      })
      .on(SPA, '/api/data', (q, res) => {
        cookiesSeen.push(String(q.headers.cookie ?? ''));
        const r = new URL(q.url ?? '/', 'https://x').searchParams.get('r');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            r === 'about'
              ? { title: 'Про нас', text: 'Ми працюємо з 2010 року у Києві.' }
              : {
                  title: 'Доставка по Україні',
                  text: 'Доставляємо Новою поштою за 1–2 дні, безкоштовно від 1000 грн.',
                },
          ),
        );
      })
      .on(SPA, '/away', (_q, res) => {
        res.writeHead(302, { location: `https://${OTHER}/` });
        res.end();
      })
      .page(OTHER, '/', '<!doctype html><title>other</title><h1>Інший</h1>')
      .page(SPA, '/menu', MENU_PAGE)
      .page(SPA, '/menu-slow', SLOW_MENU)
      .page(SPA, '/reveal', REVEAL)
      .page(
        SPA,
        '/elsewhere',
        '<!doctype html><title>Інша</title><h1>Інша сторінка</h1>',
      );
    for (const path of ['/slow-a', '/slow-b', '/slow-c'])
      stand.on(SPA, path, (_q, res) => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><title>slow</title><h1>Повільна ${path}</h1>`,
          );
        }, 1_200);
      });
    stand.on(SPA, '/hit/post', (_q, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    const dns = new Map<string, string[]>([
      [SPA, [PUBLIC_TEST_IP]],
      [OTHER, [PUBLIC_TEST_IP]],
    ]);
    const logger = createLogger('error', () => undefined);
    pool = new BrowserPool({
      executablePath: chromiumPath(),
      sandbox: false,
      rotateJobs: 5,
      rotateMs: 60 * 60_000,
      logger,
    });
    runner = new Runner({
      api: createApiClient({
        baseUrl: sites.url,
        secret: SECRET,
        workerId: 'bw-e2e-z10',
      }),
      pool,
      logger,
      kinds: ['ui-snapshot', 'knowledge-render'],
      concurrency: 1,
      pollMs: 200,
      idlePollMaxMs: 400,
      shutdownGraceMs: 2_000,
      heartbeatMs: 1_000,
      sealPrivateKey: null,
      egress: {
        denyCidrs: [],
        allowedPorts: [80, 443],
        upstream: { protocol: 'http:', host: '127.0.0.1', port: internet.port },
        lookup: (h) => Promise.resolve(dns.get(h.toLowerCase()) ?? []),
        ignoreHttpsErrors: true,
        traffic: { responseBytes: 2 * MB, jobBytes: 8 * MB },
      },
    });
    runner.start();
  });

  afterAll(async () => {
    await runner?.shutdown();
    await pool?.close();
    await sites.stop();
    await internet.stop();
    await stand.stop();
  });

  interface RenderResult {
    pages: Array<{
      i: number;
      ok: boolean;
      error: string | null;
      html: string | null;
      links: string[];
    }>;
  }

  it('knowledge-render: видимый текст SPA — «очищенным» HTML, ссылки своего хоста, отказ одной страницы не роняет остальные', async () => {
    const j = await sites.waitDone(
      sites.add('knowledge-render', {
        urls: [
          `https://${SPA}/`,
          `https://${SPA}/away`,
          `https://${SPA}/about`,
        ],
        allowedHosts: [SPA],
        viewport: 'desktop',
      }),
    );
    expect(j.error).toBeNull();
    const r = j.result as RenderResult;
    const byI = new Map(r.pages.map((p) => [p.i, p]));
    const home = byI.get(0)!;
    expect(home.ok).toBe(true);
    const html = home.html!;
    // Текст, который нарисовал скрипт, — есть; заголовки — тегами.
    expect(html).toContain('<h1>Доставка по Україні</h1>');
    expect(html).toContain('Доставляємо Новою поштою');
    expect(html).toContain('<li>Післяплата</li>');
    expect(html).toContain('<html lang="uk">');
    expect(html).toContain('<title>Магазин SPA</title>');
    // Скрытое, скрипты, поля и их значения, обвязка — нет.
    expect(html).not.toMatch(
      /ПРИХОВАНИЙ|Секретне значення|<script|<input|<form|Футер|<nav/,
    );
    // ПД третьих лиц в отзывах — маской; телефон самого магазина — как есть
    // (публичный текст сайта — как у обычного обхода).
    expect(html).not.toMatch(/buyer@example\.com|111 22 33/);
    expect(html).toContain('[e-mail]');
    expect(html).toContain('+380 44 000 00 00');
    // Маркер отзывов сохранён для извлекателя (UGC — пониженный вес).
    expect(html).toContain('class="reviews"');
    // Ссылки — только свой хост (меню SPA видно), чужой — нет.
    expect(home.links).toEqual(
      expect.arrayContaining([
        `https://${SPA}/catalog`,
        `https://${SPA}/delivery`,
      ]),
    );
    expect(home.links.some((l) => l.includes(OTHER))).toBe(false);
    // Увод на чужой хост — отказ этой страницы; третья — отрисована.
    expect(byI.get(1)).toMatchObject({ ok: false, error: 'offhost_redirect' });
    expect(byI.get(2)!.html).toContain('Ми працюємо з 2010 року');
    expect(stand.hit(`${OTHER}/x`)).toBe(false);
  });

  it('knowledge-render: чистый контекст — cookie сайта живёт только внутри задания, следующему не достаётся', async () => {
    cookiesSeen.length = 0;
    await sites.waitDone(
      sites.add('knowledge-render', {
        urls: [`https://${SPA}/set`, `https://${SPA}/about`],
        allowedHosts: [SPA],
        viewport: 'desktop',
      }),
    );
    // Контроль: внутри задания cookie стенда доходит (механизм виден).
    expect(cookiesSeen.some((c) => c.includes('tenant=A'))).toBe(true);
    cookiesSeen.length = 0;
    await sites.waitDone(
      sites.add('knowledge-render', {
        urls: [`https://${SPA}/about`],
        allowedHosts: [SPA],
        viewport: 'mobile',
      }),
    );
    expect(cookiesSeen.length).toBeGreaterThan(0);
    expect(cookiesSeen.every((c) => !c.includes('tenant=A'))).toBe(true);
  });

  interface SnapResult {
    snapshot: { elements: Array<{ text: string }> };
    mapElements: Array<{ label: string; assistId: string | null }>;
    screenshot: number | null;
    states?: Array<{
      label: string;
      elements: Array<{ text: string; assistId: string | null }>;
      screenshot: number | null;
    }>;
  }

  it('«Снимок» с раскрывашками: меню и вкладка — отдельные состояния; опасное, форма и ссылка-действие не нажаты', async () => {
    const before = stand.hits.length;
    const j = await sites.waitDone(
      sites.add('ui-snapshot', {
        url: `https://${SPA}/menu`,
        allowedHosts: [SPA],
        viewport: 'desktop',
        screenshot: true,
        mapElements: true,
        toggles: 5,
      }),
    );
    expect(j.error).toBeNull();
    const r = j.result as SnapResult;
    const labels = (r.states ?? []).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Меню', 'Характеристики']));
    const menu = r.states!.find((s) => s.label === 'Меню')!;
    // Новые элементы раскрытия: их не было в основном снимке.
    expect(menu.elements.map((e) => e.text)).toEqual(
      expect.arrayContaining(['Звіти', 'Калькулятор']),
    );
    expect(r.snapshot.elements.map((e) => e.text)).not.toContain('Звіти');
    const specs = r.states!.find((s) => s.label === 'Характеристики')!;
    expect(specs.elements.map((e) => e.text)).toContain('Порівняти');
    // Карта Ш4 дополнена элементами раскрытий.
    expect(r.mapElements.some((m) => m.assistId === 'calc')).toBe(true);
    // Скриншоты состояний — свои артефакты (JPEG), не основной.
    for (const s of r.states!) {
      expect(s.screenshot).not.toBeNull();
      expect(s.screenshot).not.toBe(r.screenshot);
      const shot = j.artifacts.get(s.screenshot!)!;
      expect(shot.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(
        true,
      );
    }
    // Стоп-лист: опасная кнопка, отправка формы и ссылка-действие — нет.
    expect(labels).not.toContain('Видалити');
    expect(labels).not.toContain('Розгорнути форму');
    expect(labels).not.toContain('Ще дії');
    const hits = stand.hits.slice(before);
    expect(hits.some((h) => /\/hit\/delete|\/hit\/submit/.test(h))).toBe(false);
    expect(hits.some((h) => h.includes('/orders/7/delete'))).toBe(false);
    // Увела со страницы — назад, состояния нет.
    expect(labels).not.toContain('Інша сторінка');
    expect(r.states!.length).toBeLessThanOrEqual(5);
  });

  it('«Снимок» без toggles — прежняя форма результата (без states), ничего не нажато', async () => {
    const before = stand.hits.length;
    const j = await sites.waitDone(
      sites.add('ui-snapshot', {
        url: `https://${SPA}/menu`,
        allowedHosts: [SPA],
        viewport: 'mobile',
        screenshot: false,
        mapElements: false,
      }),
    );
    expect(j.error).toBeNull();
    expect('states' in (j.result as object)).toBe(false);
    expect(stand.hits.slice(before).some((h) => h.includes('/elsewhere'))).toBe(
      false,
    );
  });

  it('аудит P1-1: раскрывашка уводит на медленную страницу — снимок цел; ссылка-раскрывашка не нажата; POST на время раскрытий оборван', async () => {
    const before = stand.hits.length;
    const j = await sites.waitDone(
      sites.add('ui-snapshot', {
        url: `https://${SPA}/menu-slow`,
        allowedHosts: [SPA],
        viewport: 'desktop',
        screenshot: true,
        mapElements: true,
        toggles: 5,
      }),
    );
    expect(j.error).toBeNull();
    const r = j.result as SnapResult & { finalUrl: string };
    expect(r.finalUrl).toBe(`https://${SPA}/menu-slow`);
    expect(r.snapshot.elements.map((e) => e.text)).toContain('Фільтри');
    const labels = (r.states ?? []).map((s) => s.label);
    expect(labels).toEqual(expect.arrayContaining(['Показати більше', 'Меню']));
    // Увела — назад, без состояния; ссылка на другую страницу — не нажата.
    expect(labels).not.toContain('Фільтри');
    expect(labels).not.toContain('Усі категорії');
    const hits = stand.hits.slice(before);
    expect(hits.some((h) => h.includes('/slow-a'))).toBe(false);
    // Только чтение: POST из обработчика раскрывашки до сайта не дошёл.
    expect(hits.some((h) => h.startsWith('POST'))).toBe(false);
    // Состояния — только со своей страницы.
    for (const st of r.states ?? [])
      expect(st.elements.map((e) => e.text).join('|')).not.toMatch(/Повільна/);
  });

  it('аудит P2-3/P2-2: «появление при прокрутке» — в тексте, инлайн opacity:0 — нет; одиночный суррогат — U+FFFD', async () => {
    const j = await sites.waitDone(
      sites.add('knowledge-render', {
        urls: [`https://${SPA}/reveal`],
        allowedHosts: [SPA],
        viewport: 'desktop',
      }),
    );
    expect(j.error).toBeNull();
    const html = (j.result as RenderResult).pages[0].html!;
    expect(html).toContain('Текст, що зʼявляється при прокрутці.');
    expect(html).toContain('Анімований абзац після прокрутки.');
    // Класс анимации (`opacity:0` из CSS) — не скрытие (как у извлекателя).
    expect(html).toContain('Блок із класом анімації без тригера.');
    expect(html).not.toContain('ПРИХОВАНА ІНЖЕКЦІЯ');
    expect(html).toContain('Символ \uFFFD кінець');
    expect(html).not.toMatch(/[\uD800-\uDFFF]/);
  });
});
