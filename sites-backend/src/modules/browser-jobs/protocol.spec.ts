/**
 * Протокол очереди воркера (Э-С Ш3) — тот же модуль, что копия у воркера
 * (scripts/sync-worker-shared.mjs): параметры без секретов (строгие
 * ключи), замок хостов, результат только на хостах замка, коды — из
 * закрытого списка, повтор — по коду.
 */
import {
  ProtocolError,
  RETRYABLE_ERRORS,
  WORKER_LIMITS,
  isWorkerErrorCode,
  lockedUrl,
  multiline,
  parseJobParams,
  parseJobResult,
  wellFormed,
  wellFormedText,
} from './protocol';
import { ORIGIN_RULES, retryDelayMs } from './browser-job-rules';
import { artifactRefs } from './browser-jobs.service';

describe('протокол очереди браузерного воркера', () => {
  const snap = {
    url: 'https://shop.example.com/',
    allowedHosts: ['shop.example.com'],
    viewport: 'mobile',
    screenshot: true,
    mapElements: false,
  };

  it('параметры: лишний ключ (секрет) — отказ; замок — только имена, без IP', () => {
    expect(() =>
      parseJobParams('ui-snapshot', { ...snap, cookies: 'x' }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('ui-snapshot', {
        ...snap,
        allowedHosts: ['169.254.169.254'],
      }),
    ).toThrow(/allowedHosts/);
    expect(() =>
      parseJobParams('ui-snapshot', { ...snap, url: 'file:///etc/passwd' }),
    ).toThrow(/scheme/);
    expect(() =>
      parseJobParams('ui-snapshot', {
        ...snap,
        url: 'https://evil.example.com/',
      }),
    ).toThrow(/url.host/);
    expect(parseJobParams('ui-snapshot', snap)).toEqual(snap);
  });

  it('замок учитывает нестандартный порт; фрагмент срезается', () => {
    expect(
      lockedUrl('https://shop.example.com:8443/a#x', ['shop.example.com:8443']),
    ).toBe('https://shop.example.com:8443/a');
    expect(() =>
      lockedUrl('https://shop.example.com:8443/a', ['shop.example.com']),
    ).toThrow(ProtocolError);
  });

  it('результат: элементы сверх лимита и адрес вне замка — отказ', () => {
    const p = parseJobParams('ui-snapshot', snap);
    const res = (elements: unknown[], url = 'https://shop.example.com/') => ({
      finalUrl: url,
      snapshot: { url, title: '', elements },
      mapElements: [],
      screenshot: null,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
    });
    expect(() =>
      parseJobResult('ui-snapshot', p, res([], 'https://evil.example.com/')),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobResult('ui-snapshot', p, res(new Array(151).fill({}))),
    ).toThrow(/elements/);
    expect(parseJobResult('ui-snapshot', p, res([]))).toMatchObject({
      screenshot: null,
    });
  });

  it('аудит Ш3: ссылка элемента снимка — только http(s), origin + путь', () => {
    const p = parseJobParams('ui-snapshot', snap);
    const el = (href: unknown) => ({
      ref: 'e1',
      role: 'link',
      tag: 'a',
      text: 'Каталог',
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href,
      disabled: false,
      checked: null,
      selected: null,
      options: [],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
    });
    const res = (href: unknown) => ({
      finalUrl: 'https://shop.example.com/',
      snapshot: {
        url: 'https://shop.example.com/',
        title: '',
        elements: [el(href)],
      },
      mapElements: [],
      screenshot: null,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
    });
    for (const bad of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'https://user:pw@shop.example.com/',
      'не адрес',
    ]) {
      expect(() => parseJobResult('ui-snapshot', p, res(bad))).toThrow(
        /elements\.0\.href/,
      );
    }
    const ok = parseJobResult(
      'ui-snapshot',
      p,
      res('https://other.example.com/catalog?utm=1#x'),
    ) as { snapshot: { elements: Array<{ href: string | null }> } };
    expect(ok.snapshot.elements[0].href).toBe(
      'https://other.example.com/catalog',
    );
  });

  it('коды ошибок — закрытый список; повтор только у временных; пауза растёт и ограничена', () => {
    expect(isWorkerErrorCode('egress_blocked')).toBe(true);
    expect(isWorkerErrorCode('ECONNRESET at 10.0.0.1')).toBe(false);
    expect(RETRYABLE_ERRORS.has('nav_timeout')).toBe(true);
    expect(RETRYABLE_ERRORS.has('login_failed')).toBe(false);
    expect(RETRYABLE_ERRORS.has('egress_blocked')).toBe(false);
    // Потолок трафика (Ш3-хвост (9)) — причина есть, повтора нет.
    expect(isWorkerErrorCode('traffic_limit')).toBe(true);
    expect(RETRYABLE_ERRORS.has('traffic_limit')).toBe(false);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelayMs(20)).toBe(10 * 60_000);
    // Раунд обучалки (Ш3-хвост (3)): отказ стоп-листа и «нет цели» — без
    // повтора (повтор нажал бы кнопку второй раз).
    expect(isWorkerErrorCode('click_refused')).toBe(true);
    expect(RETRYABLE_ERRORS.has('click_refused')).toBe(false);
    expect(RETRYABLE_ERRORS.has('target_missing')).toBe(false);
  });

  it('tutorial-explore: ≤ 1 клик CSS, ввод — только конвертами; сессия — конвертом; ≤ 4 хоста замка', () => {
    const p = {
      url: 'https://shop.example.com/cart',
      allowedHosts: ['shop.example.com', 'www.example.com'],
      allowedOrigin: 'https://www.example.com',
      viewport: 'mobile',
      clicks: ['a[aria-label="Кошик"]'],
      fills: [],
      replay: null,
      login: null,
      session: null,
      replyKey: 'k'.repeat(43),
      nonce: 'n'.repeat(22),
      videoFrame: false,
    };
    expect(parseJobParams('tutorial-explore', p)).toEqual(p);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, actions: [] }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, clicks: ['text=Купити'] }),
    ).toThrow(/clicks/);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, session: 'sid=1' }),
    ).toThrow(/session/);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, replyKey: 'short' }),
    ).toThrow(/replyKey/);
    expect(() =>
      parseJobParams('tutorial-explore', {
        ...p,
        allowedHosts: [
          ...p.allowedHosts,
          'm.example.com',
          'a.example.com',
          'b.example.com',
        ],
      }),
    ).toThrow(/allowedHosts/);
    const r = parseJobResult(
      'tutorial-explore',
      parseJobParams('tutorial-explore', p),
      {
        currentUrl: 'https://www.example.com/cart?id=5#x',
        elements: [],
        looksLikeLogin: true,
        screenshot: 0,
        videoFrame: null,
        reply: null,
        sensitiveFill: false,
        autoLogin: null,
      },
    ) as { currentUrl: string };
    // Аудит захода 7: query (ПД) — только в конверте ответа.
    expect(r.currentUrl).toBe('https://www.example.com/cart');
  });

  it('frames-capture: `image` — jpeg | png2x, старые параметры без него — как раньше', () => {
    const f = {
      url: 'https://shop.example.com/',
      allowedHosts: ['shop.example.com'],
      viewport: 'mobile',
      frames: 2,
    };
    expect(parseJobParams('frames-capture', f)).toEqual(f);
    expect(
      parseJobParams('frames-capture', { ...f, image: 'png2x' }),
    ).toMatchObject({ image: 'png2x' });
    expect(() =>
      parseJobParams('frames-capture', { ...f, image: 'webp' }),
    ).toThrow(/image/);
  });

  // ── заход 10, пакет Д ──────────────────────────────────────────────────

  it('Ш3 (21): текст страниц «Админки» сохраняет переводы строк; прочие управляющие и bidi — пробел', () => {
    const p = parseJobParams('admin-crawl', {
      startUrl: 'https://admin.example.com/',
      allowedHosts: ['admin.example.com'],
      viewport: 'desktop',
      maxPages: 2,
      maxDepth: 1,
      loginMethod: 'password',
    });
    const r = parseJobResult('admin-crawl', p, {
      loggedIn: true,
      pages: [
        {
          url: 'https://admin.example.com/orders',
          title: 'Замовлення\nрядок',
          text: '# Замовлення\r\nколонка: Клієнт\rкнопка: Зберегти\tще‮евил\u0007​!',
        },
      ],
      refusedClicks: 0,
      skippedLinks: 0,
    }) as { pages: Array<{ title: string; text: string }> };
    expect(r.pages[0].text.split('\n')).toEqual([
      '# Замовлення',
      'колонка: Клієнт',
      'кнопка: Зберегти ще евил  !',
    ]);
    // Заголовок — однострочный, как прежде.
    expect(r.pages[0].title).toBe('Замовлення рядок');
    expect(multiline('a⁦b\u0085c\nd', 10, 'f')).toBe('a b c\nd');
    expect(() => multiline('x'.repeat(11), 10, 'f')).toThrow(ProtocolError);
    expect(() => multiline(5, 10, 'f')).toThrow(ProtocolError);
  });

  const kr = {
    urls: ['https://shop.example.com/', 'https://shop.example.com/about?x=1'],
    allowedHosts: ['shop.example.com'],
    viewport: 'desktop',
  };

  it('knowledge-render: параметры — 1…4 адреса одного хоста замка, без лишних ключей', () => {
    expect(parseJobParams('knowledge-render', kr)).toEqual(kr);
    expect(() =>
      parseJobParams('knowledge-render', { ...kr, cookies: 'x' }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('knowledge-render', {
        ...kr,
        allowedHosts: ['shop.example.com', 'other.example.com'],
      }),
    ).toThrow(/allowedHosts/);
    expect(() =>
      parseJobParams('knowledge-render', {
        ...kr,
        urls: ['https://other.example.com/'],
      }),
    ).toThrow(/url.host/);
    expect(() =>
      parseJobParams('knowledge-render', { ...kr, urls: [] }),
    ).toThrow(/urls/);
    expect(() =>
      parseJobParams('knowledge-render', {
        ...kr,
        urls: Array.from(
          { length: WORKER_LIMITS.renderPages + 1 },
          (_, i) => `https://shop.example.com/${i}`,
        ),
      }),
    ).toThrow(/urls/);
    expect(() =>
      parseJobParams('knowledge-render', {
        ...kr,
        urls: ['https://shop.example.com/', 'https://shop.example.com/#a'],
      }),
    ).toThrow(/urls/);
  });

  it('knowledge-render: результат — номер адреса из параметров, HTML многострочный и в лимите, ссылки только хоста замка', () => {
    const p = parseJobParams('knowledge-render', kr);
    const page = (over: Record<string, unknown> = {}) => ({
      i: 0,
      ok: true,
      error: null,
      html: '<main><h1>Доставка</h1>\n<p>Текст‮</p></main>',
      links: ['https://shop.example.com/catalog?page=2#top'],
      ...over,
    });
    const r = parseJobResult('knowledge-render', p, {
      pages: [
        page(),
        page({ i: 1, ok: false, error: 'nav_timeout', html: null, links: [] }),
      ],
    }) as {
      pages: Array<{
        html: string | null;
        links: string[];
        error: string | null;
      }>;
    };
    expect(r.pages[0].html).toBe(
      '<main><h1>Доставка</h1>\n<p>Текст </p></main>',
    );
    expect(r.pages[0].links).toEqual([
      'https://shop.example.com/catalog?page=2',
    ]);
    expect(r.pages[1]).toMatchObject({ html: null, error: 'nav_timeout' });
    const bad: Array<[unknown, RegExp]> = [
      [{ pages: [page({ i: 2 })] }, /pages\.0\.i/],
      [{ pages: [page(), page()] }, /pages\.1\.i/],
      [{ pages: [page(), page({ i: 1 }), page({ i: 1 })] }, /result\.pages/],
      [{ pages: [page({ links: ['https://evil.example.com/'] })] }, /links\.0/],
      [{ pages: [page({ links: ['javascript:alert(1)'] })] }, /links\.0/],
      [
        {
          pages: [
            page({ html: 'x'.repeat(WORKER_LIMITS.renderHtmlChars + 1) }),
          ],
        },
        /html/,
      ],
      [{ pages: [page({ ok: false })] }, /error/],
      [{ pages: [page({ error: 'nav_failed' })] }, /error/],
      [
        {
          pages: [
            page({ ok: false, error: 'free text', html: null, links: [] }),
          ],
        },
        /error/,
      ],
      [
        { pages: [page({ ok: false, error: 'nav_failed', links: [] })] },
        /html/,
      ],
      [
        { pages: [page({ url: 'https://shop.example.com/' })] },
        ProtocolError as unknown as RegExp,
      ],
    ];
    for (const [raw, re] of bad) {
      expect(() => parseJobResult('knowledge-render', p, raw)).toThrow(re);
    }
  });

  it('«Снимок» Ш3 (5): toggles 0…5 (без поля — как прежде); states — не больше просили, свои скриншоты, артефакты учтены', () => {
    expect(() =>
      parseJobParams('ui-snapshot', { ...snap, toggles: 6 }),
    ).toThrow(/toggles/);
    expect(parseJobParams('ui-snapshot', { ...snap, toggles: 5 })).toEqual({
      ...snap,
      toggles: 5,
    });
    const p = parseJobParams('ui-snapshot', { ...snap, toggles: 2 });
    const el = {
      ref: 'e1',
      role: 'link',
      tag: 'a',
      text: 'Звіти',
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href: null,
      disabled: false,
      checked: null,
      selected: null,
      options: [],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
    };
    const res = (states: unknown) => ({
      finalUrl: 'https://shop.example.com/',
      snapshot: { url: 'https://shop.example.com/', title: '', elements: [] },
      mapElements: [],
      screenshot: 0,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
      states,
    });
    const ok = parseJobResult(
      'ui-snapshot',
      p,
      res([{ label: 'Меню‮', elements: [el], screenshot: 1 }]),
    );
    expect(ok).toMatchObject({
      states: [{ label: 'Меню ', screenshot: 1 }],
    });
    expect(artifactRefs(ok).sort()).toEqual([0, 1]);
    const st = { label: 'Меню', elements: [], screenshot: null };
    expect(() => parseJobResult('ui-snapshot', p, res([st, st, st]))).toThrow(
      /states/,
    );
    expect(() =>
      parseJobResult('ui-snapshot', p, res([{ ...st, screenshot: 0 }])),
    ).toThrow(/screenshot/);
    expect(() =>
      parseJobResult(
        'ui-snapshot',
        p,
        res([
          {
            ...st,
            elements: new Array(WORKER_LIMITS.stateElements + 1).fill(el),
          },
        ]),
      ),
    ).toThrow(/elements/);
    expect(() =>
      parseJobResult('ui-snapshot', p, res([{ ...st, extra: 1 }])),
    ).toThrow(ProtocolError);
    // Без toggles в параметрах — состояния нельзя.
    expect(() =>
      parseJobResult(
        'ui-snapshot',
        parseJobParams('ui-snapshot', snap),
        res([st]),
      ),
    ).toThrow(/states/);
  });

  it('источники захода 10: рендер — свой вид, ≤ 50 страниц/сайт/сутки; Т-3 — сверка, 1/сайт/сутки', () => {
    expect(ORIGIN_RULES['knowledge-render']).toMatchObject({
      kind: 'knowledge-render',
      purpose: 'assist-crawl',
    });
    expect(
      ORIGIN_RULES['knowledge-render'].dailyPerSite * WORKER_LIMITS.renderPages,
    ).toBeLessThanOrEqual(50);
    expect(ORIGIN_RULES['voice-autotest']).toMatchObject({
      kind: 'descriptor-resolve',
      purpose: 'assist-crawl',
      dailyPerSite: 1,
    });
    // Аудит P3 (1): символьные пределы НЕ гарантируют байтовый потолок —
    // U+2028/U+FFFD дают 3 байта на символ, JSON удваивает кавычки. Поэтому
    // байты режет воркер (`fitRenderBudget`), а сервер меряет UTF-8 и не
    // принимает больше `resultBytes` (400, без повтора у воркера).
    const worst = JSON.stringify({
      pages: Array.from({ length: WORKER_LIMITS.renderPages }, (_, i) => ({
        i,
        ok: true,
        error: null,
        html: '\u2028'.repeat(WORKER_LIMITS.renderHtmlChars),
        links: [],
      })),
    });
    expect(Buffer.byteLength(worst, 'utf8')).toBeGreaterThan(
      WORKER_LIMITS.resultBytes,
    );
  });

  it('аудит P2-2: одиночный суррогат UTF-16 — U+FFFD в тексте, многострочном и во ВСЁМ результате; пары не трогаются', () => {
    expect(wellFormedText('a\uD800b\uDC00c\uD83D\uDE00')).toBe(
      'a\uFFFDb\uFFFDc\uD83D\uDE00',
    );
    expect(multiline('x\uDBFF', 10, 'f')).toBe('x\uFFFD');
    expect(wellFormed({ ['k\uD800']: ['\uDC00', 1, null] })).toEqual({
      'k\uFFFD': ['\uFFFD', 1, null],
    });
    const p = parseJobParams('ui-snapshot', snap);
    const el = {
      ref: 'e1',
      role: 'combobox',
      tag: 'select',
      text: 'Розмір\uD83D',
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href: null,
      disabled: false,
      checked: null,
      selected: null,
      // Опции берутся как есть (только длина) — тоже чистятся.
      options: ['S\uD800'],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
    };
    const r = parseJobResult('ui-snapshot', p, {
      finalUrl: 'https://shop.example.com/',
      snapshot: {
        url: 'https://shop.example.com/',
        title: 'Магазин\uDE00',
        elements: [el],
      },
      mapElements: [],
      screenshot: null,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
    }) as {
      snapshot: {
        title: string;
        elements: Array<{ text: string; options: string[] }>;
      };
    };
    expect(r.snapshot.title).toBe('Магазин\uFFFD');
    expect(r.snapshot.elements[0].text).toBe('Розмір\uFFFD');
    expect(r.snapshot.elements[0].options).toEqual(['S\uFFFD']);
    expect(JSON.stringify(r)).not.toMatch(/\\ud[89ab]/i);
  });
});
