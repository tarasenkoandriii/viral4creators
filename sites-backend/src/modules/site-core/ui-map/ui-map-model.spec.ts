/**
 * Э-С Ш4: чистая модель общей карты — кандидаты и их порядок, устойчивость,
 * ключ элемента, чистка снимка (старая форма Э6 понимается как есть),
 * слияние источников, уверенность, вид посетителя, правила устаревания.
 */
import { UI_MAP_LIMITS, cleanUiElements, uiElementId } from './ui-map';
import {
  UI_MAP_SHARED,
  UI_MAP_STALE,
  candidateFromSelector,
  candidateStability,
  cleanCandidate,
  cleanUiSnapshot,
  isGeneratedToken,
  isStaleFor,
  mergeUiSnapshots,
  nextMissCount,
  parseUiViewport,
  rowFitsViewport,
  seenSnapshotKeys,
  uiConfidence,
  uiSnapshotHash,
  viewportsConfirmedBy,
  visitorViewport,
} from './ui-map-model';

describe('кандидаты селектора', () => {
  it('селектор Э6 → вид кандидата: assist-id, id, тестовый атрибут, aria (роль+имя), name, путь', () => {
    expect(
      candidateFromSelector('button[data-assist-id="add-to-cart"]', 'button')
        .kind,
    ).toBe('assist-id');
    expect(candidateFromSelector('#buy', 'button').kind).toBe('id');
    expect(candidateFromSelector('input[id="1x"]', 'input').kind).toBe('id');
    expect(candidateFromSelector('a[data-testid="cart"]', 'a').kind).toBe(
      'test-id',
    );
    expect(candidateFromSelector('a[aria-label="Кошик"]', 'a')).toEqual({
      kind: 'role-name',
      selector: 'a[aria-label="Кошик"]',
      role: 'link',
      name: 'Кошик',
    });
    expect(candidateFromSelector('input[name="q"]', 'input').kind).toBe('attr');
    expect(candidateFromSelector('main > a:nth-of-type(2)', 'a').kind).toBe(
      'css',
    );
  });

  it('устойчивость: assist-id/тестовый — надёжно; сгенерированный id и цена в тексте — хрупко; путь — хрупко', () => {
    const st = (s: string) =>
      candidateStability(candidateFromSelector(s, 'button'));
    expect(st('[data-assist-id="buy"]')).toBe('strong');
    expect(st('#buy')).toBe('strong');
    expect(st('#css-1x2y3z4')).toBe('fragile');
    expect(st('button[id=":r1:"]')).toBe('fragile');
    expect(st('#item-123456')).toBe('fragile');
    expect(st('button[data-testid="buy"]')).toBe('strong');
    expect(st('button[aria-label="Купити"]')).toBe('medium');
    expect(st('main > button:nth-of-type(1)')).toBe('fragile');
    expect(candidateStability({ kind: 'text', name: 'Купити' })).toBe('medium');
    expect(
      candidateStability({ kind: 'text', name: 'Купити за 499 грн' }),
    ).toBe('fragile');
    for (const ok of ['buy', 'cart-button', 'nav_delivery', 'checkout'])
      expect(isGeneratedToken(ok)).toBe(false);
    for (const gen of [
      'sc-a1b2c3',
      ':r1:',
      'el12345',
      'a1b2c3d4e5',
      'x'.repeat(41),
    ])
      expect(isGeneratedToken(gen)).toBe(true);
  });

  it('cleanCandidate: вид из перечня, CSS — строгая чистка, роль — из перечня, текст — без разметки', () => {
    expect(cleanCandidate({ kind: 'id', selector: '#a' })).toEqual({
      kind: 'id',
      selector: '#a',
    });
    expect(cleanCandidate({ kind: 'text', name: ' Кошик ' })).toEqual({
      kind: 'text',
      name: 'Кошик',
    });
    expect(
      cleanCandidate({ kind: 'role-name', role: 'button', name: 'Купити' }),
    ).toEqual({ kind: 'role-name', role: 'button', name: 'Купити' });
    for (const bad of [
      { kind: 'xpath', selector: '//a' },
      { kind: 'id', selector: '<img onerror=1>' },
      { kind: 'id' },
      { kind: 'role-name', role: 'banner', name: 'x' },
      { kind: 'text', name: '   ' },
      { kind: 'assist-id', selector: '[data-assist-id="a b"]' },
      'мусор',
      null,
    ]) {
      expect(cleanCandidate(bad)).toBeNull();
    }
  });
});

describe('cleanUiSnapshot — снимок любого источника', () => {
  it('старая форма Э6: тот же id от селектора, что у cleanUiElements', () => {
    const raw = [
      { selector: '#np-calc', tag: 'button', label: 'Розрахувати доставку' },
      { selector: 'a[aria-label="Кошик"]', tag: 'a', label: 'Кошик' },
    ];
    const v1 = cleanUiElements(raw);
    const v2 = cleanUiSnapshot(raw);
    expect(v2.map((e) => [e.id, e.selector, e.tag, e.label])).toEqual(
      v1.map((e) => [e.id, e.selector, e.tag, e.label]),
    );
    expect(v2.map((e) => e.key)).toEqual(['i:np-calc', 'r:link|кошик']);
  });

  it('приоритет: data-assist-id > id > роль+имя > текст > путь; лучший CSS — для подсветки', () => {
    const [e] = cleanUiSnapshot([
      {
        tag: 'button',
        label: 'В кошик',
        selector: 'main > button:nth-of-type(3)',
        assistId: 'add-to-cart',
        candidates: [
          { kind: 'id', selector: '#buy' },
          { kind: 'role-name', role: 'button', name: 'В кошик' },
        ],
      },
    ]);
    expect(e.key).toBe('a:add-to-cart');
    expect(e.selector).toBe('[data-assist-id="add-to-cart"]');
    expect(e.id).toBe(uiElementId('[data-assist-id="add-to-cart"]'));
    expect(e.stability).toBe('strong');
    expect(e.candidates.map((c) => c.kind)).toEqual([
      'assist-id',
      'id',
      'role-name',
      'text',
      'css',
    ]);
    // Только путь и текст — ключ по тексту (он устойчивее позиции).
    const [p] = cleanUiSnapshot([
      { tag: 'a', label: 'Доставка', selector: 'nav > a:nth-of-type(2)' },
    ]);
    expect([p.key, p.stability, p.selector]).toEqual([
      'x:a|доставка',
      'medium',
      'nav > a:nth-of-type(2)',
    ]);
  });

  it('текст, который не единственный на странице, — не ключ (у всех таких элементов)', () => {
    const out = cleanUiSnapshot([
      {
        tag: 'button',
        label: 'Купити',
        selector: 'li:nth-of-type(1) > button',
      },
      {
        tag: 'button',
        label: 'Купити',
        selector: 'li:nth-of-type(2) > button',
      },
    ]);
    expect(out.map((e) => e.key)).toEqual([
      'c:li:nth-of-type(1) > button',
      'c:li:nth-of-type(2) > button',
    ]);
    expect(out.every((e) => e.candidates.every((c) => c.kind !== 'text'))).toBe(
      true,
    );
  });

  it('строго: тег из перечня, подпись обязательна, только текст — мало, дубли ключа/селектора — вон, ≤ 60, ≤ 5 кандидатов', () => {
    expect(
      cleanUiSnapshot([
        { tag: 'div', label: 'x', selector: '#d' },
        { tag: 'a', label: '', selector: '#a' },
        { tag: 'a', label: 'Тільки текст' },
        { tag: 'a', label: 'Біда', selector: '<script>' },
        { tag: 'a', label: 'Біда', assistId: 'має пробіл' },
        { tag: 'a', label: 'A', selector: '#a' },
        { tag: 'a', label: 'A2', selector: '#a' },
      ]).map((e) => e.selector),
    ).toEqual(['#a']);
    const many = Array.from({ length: 100 }, (_, i) => ({
      selector: `#b${i}`,
      tag: 'button',
      label: `Кнопка ${i}`,
    }));
    expect(cleanUiSnapshot(many)).toHaveLength(UI_MAP_LIMITS.elements);
    const [wide] = cleanUiSnapshot([
      {
        tag: 'button',
        label: 'Широкий',
        role: 'button',
        assistId: 'w',
        candidates: [
          { kind: 'id', selector: '#w' },
          { kind: 'test-id', selector: 'button[data-testid="w"]' },
          { kind: 'attr', selector: 'button[name="w"]' },
          { kind: 'css', selector: 'main > button' },
        ],
      },
    ]);
    expect(wide.candidates).toHaveLength(UI_MAP_SHARED.candidatesPerElement);
    expect(cleanUiSnapshot('не массив')).toEqual([]);
  });

  it('отпечаток меняется с кандидатами (разметили data-assist-id — новая версия)', () => {
    const a = cleanUiSnapshot([{ selector: '#a', tag: 'a', label: 'A' }]);
    const b = cleanUiSnapshot([
      { selector: '#a', tag: 'a', label: 'A', assistId: 'nav-a' },
    ]);
    expect(uiSnapshotHash(a)).toBe(uiSnapshotHash(a));
    expect(uiSnapshotHash(a)).not.toBe(uiSnapshotHash(b));
  });
});

describe('mergeUiSnapshots — слияние источников по стабильному ключу', () => {
  const crawl = cleanUiSnapshot([
    { selector: '#buy', tag: 'button', label: 'Купити (обхід)' },
    { selector: 'main > a:nth-of-type(1)', tag: 'a', label: 'Доставка' },
    { selector: '#only-crawl', tag: 'a', label: 'Тільки в HTML' },
  ]);
  const tutorial = cleanUiSnapshot([
    { selector: 'div > a:nth-of-type(4)', tag: 'a', label: 'Доставка' },
    { selector: '#buy', tag: 'button', label: 'Купити' },
  ]);

  it('один элемент на ключ; подпись и порядок — от главного источника; кандидаты — объединение', () => {
    const m = mergeUiSnapshots([
      { source: 'crawl', elements: crawl },
      { source: 'tutorial', elements: tutorial },
    ]);
    expect(m.map((e) => [e.key, e.label, e.sources])).toEqual([
      ['x:a|доставка', 'Доставка', ['tutorial', 'crawl']],
      ['i:buy', 'Купити', ['tutorial', 'crawl']],
      ['i:only-crawl', 'Тільки в HTML', ['crawl']],
    ]);
    const delivery = m[0];
    expect(delivery.candidates.map((c) => c.selector ?? c.name)).toEqual([
      'Доставка',
      'div > a:nth-of-type(4)',
      'main > a:nth-of-type(1)',
    ]);
    // Порядок входа не важен — результат тот же.
    expect(
      mergeUiSnapshots([
        { source: 'tutorial', elements: tutorial },
        { source: 'crawl', elements: crawl },
      ]),
    ).toEqual(m);
  });

  it('уверенность: браузер и второй источник — выше; ручная разметка — 100', () => {
    const m = mergeUiSnapshots([
      { source: 'crawl', elements: crawl },
      { source: 'tutorial', elements: tutorial },
    ]);
    const buy = m.find((e) => e.key === 'i:buy')!;
    const only = m.find((e) => e.key === 'i:only-crawl')!;
    expect(buy.confidence).toBe(95);
    expect(only.confidence).toBe(80);
    expect(uiConfidence('fragile', ['crawl'])).toBe(30);
    expect(uiConfidence('fragile', ['manual'])).toBe(100);
    expect(uiConfidence('medium', ['qa', 'loader', 'crawl'])).toBe(75);
  });

  it('аудит Ш4: младший источник, узнанный только по тексту, не подменяет ключ и селектор (чужая кнопка с data-assist-id в HTML)', () => {
    // Обучалка видела настоящую кнопку (JS-вёрстка, в HTML её нет), обход —
    // кнопку с тем же текстом из комментария посетителя.
    const tut = cleanUiSnapshot([
      {
        selector: 'div > button:nth-of-type(2)',
        tag: 'button',
        label: 'Оформити замовлення',
      },
    ]);
    const evil = cleanUiSnapshot([
      {
        selector: 'button[data-assist-id="pay"]',
        tag: 'button',
        label: 'Оформити замовлення',
      },
    ]);
    const [m, ...rest] = mergeUiSnapshots([
      { source: 'tutorial', elements: tut },
      { source: 'crawl', elements: evil },
    ]);
    expect(rest).toEqual([]);
    expect(m.sources).toEqual(['tutorial', 'crawl']);
    expect([m.key, m.selector, m.elementId]).toEqual([
      'x:button|оформити замовлення',
      'div > button:nth-of-type(2)',
      tut[0].id,
    ]);
    // Кандидат обхода — в запасе, после своих.
    expect(m.candidates.map((c) => c.kind)).toEqual([
      'text',
      'css',
      'assist-id',
    ]);
    // Совпадение по селекторному ключу — полноценное (тот же узел HTML).
    const same = cleanUiSnapshot([
      {
        selector: 'div > button:nth-of-type(2)',
        tag: 'button',
        label: 'Оформити замовлення',
        assistId: 'pay',
      },
    ]);
    const [n] = mergeUiSnapshots([
      { source: 'tutorial', elements: tut },
      { source: 'crawl', elements: same },
    ]);
    expect([n.key, n.selector]).toEqual(['a:pay', '[data-assist-id="pay"]']);
  });

  it('два элемента одного снимка не склеиваются, даже если совпадает кандидат', () => {
    const snap = cleanUiSnapshot([
      {
        selector: '#a',
        tag: 'a',
        label: 'Перша',
        candidates: [{ kind: 'css', selector: 'nav a' }],
      },
      {
        selector: '#b',
        tag: 'a',
        label: 'Друга',
        candidates: [{ kind: 'css', selector: 'nav a' }],
      },
    ]);
    expect(mergeUiSnapshots([{ source: 'qa', elements: snap }])).toHaveLength(
      2,
    );
  });
});

describe('вид вёрстки и устаревание', () => {
  it('вид посетителя: Client Hint точнее UA; без признаков — компьютер', () => {
    expect(visitorViewport({ chUaMobile: '?1', userAgent: 'Windows' })).toBe(
      'mobile',
    );
    expect(visitorViewport({ chUaMobile: '?0', userAgent: 'iPhone' })).toBe(
      'desktop',
    );
    expect(
      visitorViewport({
        userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36',
      }),
    ).toBe('mobile');
    expect(
      visitorViewport({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }),
    ).toBe('desktop');
    expect(visitorViewport({})).toBe('desktop');
    expect(parseUiViewport('mobile')).toBe('mobile');
    expect(parseUiViewport('tablet')).toBeNull();
  });

  it('элемент вида годится только своему виду; any — всем; вид неизвестен — любой', () => {
    expect(rowFitsViewport('mobile', 'desktop')).toBe(false);
    expect(rowFitsViewport('mobile', 'mobile')).toBe(true);
    expect(rowFitsViewport('any', 'desktop')).toBe(true);
    expect(rowFitsViewport('desktop', undefined)).toBe(true);
  });

  it('устарел — для своего вида; вид неизвестен — устаревший хоть где-то', () => {
    const mob = { staleDesktopAt: null, staleMobileAt: new Date() };
    expect(isStaleFor(mob, 'desktop')).toBe(false);
    expect(isStaleFor(mob, 'mobile')).toBe(true);
    expect(isStaleFor(mob, undefined)).toBe(true);
    expect(
      isStaleFor({ staleDesktopAt: null, staleMobileAt: null }, undefined),
    ).toBe(false);
  });

  it('подтверждение снимком any — оба вида, видом — только свой', () => {
    expect(viewportsConfirmedBy('any')).toEqual(['desktop', 'mobile']);
    expect(viewportsConfirmedBy('mobile')).toEqual(['mobile']);
  });

  it('окно промахов: истекло — счёт заново', () => {
    const t0 = new Date('2026-10-01T00:00:00Z');
    const a = nextMissCount({ count: 0, since: null }, t0);
    expect(a).toEqual({ count: 1, since: t0 });
    const b = nextMissCount(a, new Date(t0.getTime() + 1000));
    expect(b).toEqual({ count: 2, since: t0 });
    const late = new Date(t0.getTime() + UI_MAP_STALE.windowMs + 1);
    expect(nextMissCount(b, late)).toEqual({ count: 1, since: late });
  });
});

describe('seenSnapshotKeys — ключи снимка для «найден» (Ш4 (3), Р-З9-2)', () => {
  it('элементы с тегом карты — все ключи кандидатов, как раньше', () => {
    const keys = seenSnapshotKeys([
      { tag: 'button', label: 'Купити', role: 'button', assistId: 'buy' },
    ]);
    expect(keys).toEqual(
      expect.arrayContaining(['a:buy', 'x:button|купити', 'r:button|купити']),
    );
  });

  it('`other` с интерактивной ролью — тег карты по роли, только ключи, не зависящие от тега (без текста и CSS-пути)', () => {
    expect(
      seenSnapshotKeys([
        { tag: 'other', role: 'button', label: 'Купити', assistId: 'buy' },
      ]).sort(),
    ).toEqual(['a:buy', 'r:button|купити']);
    expect(
      seenSnapshotKeys([
        { tag: 'other', role: 'link', label: 'Доставка', selector: '#dl' },
      ]).sort(),
    ).toEqual(['i:dl', 'r:link|доставка']);
    expect(
      seenSnapshotKeys([
        {
          tag: 'other',
          role: 'tab',
          label: 'Оплата',
          selector: 'main > div:nth-of-type(2)',
        },
      ]),
    ).toEqual(['r:tab|оплата']);
  });

  it('`other` без роли или с неинтерактивной ролью — ничего; мусор — ничего', () => {
    expect(
      seenSnapshotKeys([
        { tag: 'other', label: 'Купити', assistId: 'buy' },
        { tag: 'other', role: 'heading', label: 'Купити', assistId: 'buy' },
        { tag: 'other', role: 'textbox', label: 'Пошук', assistId: 'q' },
        null,
        'x',
      ]),
    ).toEqual([]);
    expect(seenSnapshotKeys('nope')).toEqual([]);
  });

  it('неединственная роль+имя среди `other` — не ключ (три «Купити» у товаров)', () => {
    const many = [1, 2, 3].map(() => ({
      tag: 'other',
      role: 'button',
      label: 'Купити',
    }));
    expect(seenSnapshotKeys(many)).toEqual([]);
  });
});
