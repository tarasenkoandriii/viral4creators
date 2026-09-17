/* eslint-disable @typescript-eslint/no-explicit-any -- поддельный DOM */
/**
 * Извлечение элементов страницы заказчика (§5.4 ТЗ, этап 112).
 *
 * DOM здесь поддельный и намеренно маленький — тот же приём, что у
 * `scenario-runner.spec.ts` с поддельной страницей: настоящий Chromium в
 * CI этого проекта не поднимается (`doc/CI.md`), а проверять нужно
 * ПРАВИЛА (приоритет селектора, единственность, видимость, отсев
 * чужих ссылок), а не то, что браузер умеет читать свой же DOM.
 *
 * Отдельный первый блок сторожит правило, из-за которого этот файл
 * вообще устроен так странно: функция уезжает в браузер СТРОКОЙ, и
 * любая ссылка наружу (импорт, константа модуля) превращается там в
 * `ReferenceError` — при этом все остальные тесты остаются зелёными,
 * потому что в Node эта ссылка прекрасно разрешается.
 */

import { collectPageExploration } from './page-exploration';

const ORIGIN = 'https://shop.example.com';

// ── поддельный DOM ────────────────────────────────────────────────────

interface FakeElementInit {
  tag: string;
  attrs?: Record<string, string>;
  text?: string;
  visible?: boolean;
  children?: FakeElement[];
}

class FakeElement {
  readonly tagName: string;
  readonly attrs: Record<string, string>;
  readonly textContent: string;
  readonly innerText: string;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  offsetParent: unknown;

  constructor(init: FakeElementInit) {
    this.tagName = init.tag.toUpperCase();
    this.attrs = init.attrs ?? {};
    this.textContent = init.text ?? '';
    this.innerText = init.text ?? '';
    this.offsetParent = (init.visible ?? true) ? {} : null;
    for (const child of init.children ?? []) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  get nodeType(): number {
    return 1;
  }

  getAttribute(name: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
      ? this.attrs[name]
      : null;
  }

  getClientRects(): unknown[] {
    return this.offsetParent === null ? [] : [{}];
  }

  closest(selector: string): FakeElement | null {
    return closestOf(this, selector);
  }
}

function closestOf(start: FakeElement, tag: string): FakeElement | null {
  let node: FakeElement | null = start;
  while (node) {
    if (node.tagName.toLowerCase() === tag) return node;
    node = node.parentElement;
  }
  return null;
}

function el(init: FakeElementInit): FakeElement {
  return new FakeElement(init);
}

/** Крошечный матчер селекторов: ровно те формы, которые строит сама
 * функция (`tag`, `#id`, `tag[attr="value"]`, `label[for="x"]`) плюс
 * список тегов через запятую. Больше не нужно — и не надо: полноценный
 * движок селекторов здесь был бы отдельной непроверенной зависимостью. */
function matches(node: FakeElement, selector: string): boolean {
  const s = selector.trim();
  if (s.startsWith('#')) return node.getAttribute('id') === s.slice(1);
  const withAttr = /^([a-z]+)\[([\w-]+)="(.*)"\]$/.exec(s);
  if (withAttr) {
    return (
      node.tagName.toLowerCase() === withAttr[1] &&
      node.getAttribute(withAttr[2]) === withAttr[3].replace(/\\"/g, '"')
    );
  }
  return node.tagName.toLowerCase() === s;
}

function installDocument(root: FakeElement, url = `${ORIGIN}/cabinet`): void {
  const all: FakeElement[] = [];
  const walk = (node: FakeElement) => {
    all.push(node);
    node.children.forEach(walk);
  };
  walk(root);

  const doc = {
    baseURI: url,
    location: { href: url },
    querySelectorAll(selector: string) {
      const parts = selector.split(',').map((p) => p.trim());
      return all.filter((n) => parts.some((p) => matches(n, p)));
    },
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    },
  };
  (globalThis as any).document = doc;
}

afterEach(() => {
  delete (globalThis as any).document;
});

// ── сериализуемость ───────────────────────────────────────────────────

describe('функция обязана пережить отправку в браузер', () => {
  const source = collectPageExploration.toString();

  it('в исходнике нет ссылок на модульную обвязку', () => {
    // `require(...)`, `exports.` и `page_exploration_types_1` — ровно то,
    // во что компилятор превращает импорт. В браузере ничего этого нет.
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bexports\b/);
    expect(source).not.toMatch(/_1\./);
  });

  it('в исходнике нет хелперов, которые TypeScript вставляет при низком target', () => {
    // `__spreadArray`, `__assign` и родня живут в файле, а не в функции —
    // уехав строкой, функция их не найдёт.
    expect(source).not.toMatch(/\b__[a-zA-Z]+\(/);
  });

  it('это выражение, которое можно вызвать после конкатенации', () => {
    // Ровно то, что делает `chromium-page-explorer.ts`.
    expect(`(${source})`).toMatch(/^\(function/);
  });
});

// ── приоритет селектора ───────────────────────────────────────────────

describe('приоритет селектора (§5.4)', () => {
  it('id выигрывает у всего остального', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({
            tag: 'input',
            attrs: { id: 'email', name: 'email', 'data-testid': 'email' },
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].selector).toBe('#email');
  });

  it('без id берётся data-testid, и он привязан к тегу', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({
            tag: 'input',
            attrs: { 'data-testid': 'login', name: 'login' },
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].selector).toBe(
      'input[data-testid="login"]',
    );
  });

  it('НЕуникальный кандидат отбрасывается, а не отдаётся молча', () => {
    // Два поля `name="email"` — вход и регистрация на одной странице.
    // Селектор `input[name="email"]` указывал бы на чужую форму, и
    // обучалка записала бы не тот сценарий.
    installDocument(
      el({
        tag: 'body',
        children: [
          el({
            tag: 'form',
            children: [el({ tag: 'input', attrs: { name: 'email' } })],
          }),
          el({
            tag: 'form',
            children: [el({ tag: 'input', attrs: { name: 'email' } })],
          }),
        ],
      }),
    );
    const { elements } = collectPageExploration(ORIGIN);
    expect(elements).toHaveLength(2);
    for (const item of elements) {
      expect(item.selector).not.toBe('input[name="email"]');
      expect(item.selector).toContain(':nth-of-type(');
    }
    // И пути всё-таки РАЗНЫЕ — иначе оба шага били бы в один элемент.
    expect(elements[0].selector).not.toBe(elements[1].selector);
  });

  it('id с нестандартными символами не ломает селектор', () => {
    installDocument(
      el({
        tag: 'form',
        children: [el({ tag: 'input', attrs: { id: '2fa:code' } })],
      }),
    );
    const selector = collectPageExploration(ORIGIN).elements[0].selector;
    expect(selector).not.toBe('#2fa:code');
    expect(selector).toBe('input[id="2fa:code"]');
  });

  it('кавычка в значении атрибута экранируется', () => {
    installDocument(
      el({
        tag: 'form',
        children: [el({ tag: 'input', attrs: { name: 'say"hi' } })],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].selector).toBe(
      'input[name="say\\"hi"]',
    );
  });
});

// ── отбор элементов ───────────────────────────────────────────────────

describe('что попадает в список, а что нет', () => {
  it('скрытые поля и невидимые элементы пропускаются', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'input', attrs: { type: 'hidden', name: 'csrf' } }),
          el({ tag: 'input', attrs: { name: 'shown' } }),
          el({ tag: 'input', attrs: { name: 'collapsed' }, visible: false }),
        ],
      }),
    );
    const names = collectPageExploration(ORIGIN).elements.map((e) => e.name);
    expect(names).toEqual(['shown']);
  });

  it('элемент в fixed-контейнере (модалка входа) всё равно считается видимым', () => {
    // offsetParent у него null — по букве §5.4 он бы выпал, а это ровно
    // форма входа, ради которой визард и существует.
    const input = el({
      tag: 'input',
      attrs: { name: 'pwd', type: 'password' },
    });
    input.offsetParent = null;
    (input as any).getClientRects = () => [{ width: 200 }];
    installDocument(el({ tag: 'div', children: [input] }));
    const result = collectPageExploration(ORIGIN);
    expect(result.elements.map((e) => e.name)).toEqual(['pwd']);
    expect(result.looksLikeLogin).toBe(true);
  });

  it('ссылка на чужой origin не предлагается вовсе', () => {
    installDocument(
      el({
        tag: 'nav',
        children: [
          el({
            tag: 'a',
            attrs: { href: 'https://evil.example.net/phish' },
            text: 'Партнёры',
          }),
          el({ tag: 'a', attrs: { href: '/cabinet' }, text: 'Кабинет' }),
          el({ tag: 'a', attrs: { href: `${ORIGIN}/help` }, text: 'Помощь' }),
        ],
      }),
    );
    const texts = collectPageExploration(ORIGIN).elements.map(
      (e) => e.visibleText,
    );
    expect(texts).toEqual(['Кабинет', 'Помощь']);
  });

  it('ссылка без текста не предлагается — нажимать на «ничего» бессмысленно', () => {
    installDocument(
      el({
        tag: 'nav',
        children: [el({ tag: 'a', attrs: { href: '/x' }, text: '   ' })],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements).toEqual([]);
  });

  it('кнопки отдаются с видимым текстом', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'button', attrs: { id: 'go' }, text: ' Войти  ' }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0]).toMatchObject({
      tag: 'button',
      selector: '#go',
      visibleText: 'Войти',
    });
  });
});

// ── подписи полей ─────────────────────────────────────────────────────

describe('подпись поля (§5.4: label → aria-label → placeholder)', () => {
  it('<label for> выигрывает у placeholder', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'label', attrs: { for: 'em' }, text: 'Почта' }),
          el({
            tag: 'input',
            attrs: { id: 'em', placeholder: 'you@example.com' },
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].label).toBe('Почта');
  });

  it('обёртывающий <label> тоже считается подписью', () => {
    installDocument(
      el({
        tag: 'label',
        text: 'Телефон',
        children: [el({ tag: 'input', attrs: { name: 'phone' } })],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].label).toBe('Телефон');
  });

  it('без label берётся aria-label, без него — placeholder', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'input', attrs: { name: 'a', 'aria-label': 'Код' } }),
          el({ tag: 'input', attrs: { name: 'b', placeholder: 'Промокод' } }),
        ],
      }),
    );
    const labels = collectPageExploration(ORIGIN).elements.map((e) => e.label);
    expect(labels).toEqual(['Код', 'Промокод']);
  });
});

// ── эвристика логина и общая форма ────────────────────────────────────

describe('форма результата', () => {
  it('looksLikeLogin — по видимому полю пароля', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'input', attrs: { name: 'l' } }),
          el({ tag: 'input', attrs: { name: 'p', type: 'password' } }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).looksLikeLogin).toBe(true);
  });

  it('скрытое поле пароля логином страницу не делает', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({
            tag: 'input',
            attrs: { name: 'p', type: 'password' },
            visible: false,
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).looksLikeLogin).toBe(false);
  });

  it('currentUrl берётся из самой страницы, а не из запроса', () => {
    installDocument(el({ tag: 'div' }), `${ORIGIN}/after-redirect`);
    expect(collectPageExploration(ORIGIN).currentUrl).toBe(
      `${ORIGIN}/after-redirect`,
    );
  });

  it('список элементов ограничен сверху — навигация на 5000 ссылок не должна ехать в JSON', () => {
    const children = Array.from({ length: 400 }, (_, i) =>
      el({ tag: 'input', attrs: { name: `f${i}` } }),
    );
    installDocument(el({ tag: 'form', children }));
    expect(collectPageExploration(ORIGIN).elements.length).toBeLessThanOrEqual(
      200,
    );
  });

  it('длинный текст обрезается, а не едет целиком', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'button', attrs: { id: 'b' }, text: 'я'.repeat(5000) }),
        ],
      }),
    );
    const text = collectPageExploration(ORIGIN).elements[0].visibleText ?? '';
    expect(text.length).toBeLessThanOrEqual(200);
  });
});

// ── этап 117: варианты <select> ───────────────────────────────────────

describe('варианты выпадающего списка (§5.4, дополнено этапом 117)', () => {
  it('отдаются значением и надписью — вводить надпись руками бесполезно', () => {
    // `fill` по `<select>` сопоставляет строку со ЗНАЧЕНИЕМ опции;
    // угадать его из интерфейса невозможно, и раньше список
    // показывался пустым текстовым полем.
    installDocument(
      el({
        tag: 'form',
        children: [
          el({
            tag: 'select',
            attrs: { name: 'city' },
            children: [
              el({ tag: 'option', attrs: { value: 'msk' }, text: 'Москва' }),
              el({ tag: 'option', attrs: { value: 'spb' }, text: 'Петербург' }),
            ],
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].options).toEqual([
      { value: 'msk', label: 'Москва' },
      { value: 'spb', label: 'Петербург' },
    ]);
  });

  it('без атрибута value значением считается сама надпись', () => {
    installDocument(
      el({
        tag: 'form',
        children: [
          el({
            tag: 'select',
            attrs: { name: 'x' },
            children: [el({ tag: 'option', text: 'Любой' })],
          }),
        ],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].options).toEqual([
      { value: 'Любой', label: 'Любой' },
    ]);
  });

  it('у обычного поля вариантов нет вовсе', () => {
    installDocument(
      el({
        tag: 'form',
        children: [el({ tag: 'input', attrs: { name: 'q' } })],
      }),
    );
    expect(collectPageExploration(ORIGIN).elements[0].options).toBeUndefined();
  });

  it('список стран не раздувает ответ до бесконечности', () => {
    const options = Array.from({ length: 300 }, (_, i) =>
      el({ tag: 'option', attrs: { value: `c${i}` }, text: `Страна ${i}` }),
    );
    installDocument(
      el({
        tag: 'form',
        children: [
          el({ tag: 'select', attrs: { name: 'c' }, children: options }),
        ],
      }),
    );
    const found = collectPageExploration(ORIGIN).elements[0].options ?? [];
    expect(found.length).toBeLessThanOrEqual(100);
  });
});
