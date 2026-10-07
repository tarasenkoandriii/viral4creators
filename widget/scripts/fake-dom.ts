/**
 * Минимальный «DOM» для unit-тестов исполнителя голосового плана (act.js,
 * undo.js) без браузера: jsdom/happy-dom в зависимостях виджета нет, а
 * Playwright-стенд здесь не поднять. Ровно то, что читают `act/exec.ts`,
 * `act/snapshot.ts` и `undo/index.ts`: дерево узлов, атрибуты, простые
 * составные селекторы (`tag`, `[a]`, `[a="v"]`, `[a=v]`, `.c`, `#id` через
 * запятую), прямоугольник, события, поля ввода/списка/флажка/радио.
 * Подключение — `installFakeDom()` ДО импорта тестируемых модулей нет
 * необходимости: модули трогают глобалы только при вызове.
 */

type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

const SIMPLE =
  /^([a-z0-9*]*)((?:\[[\w-]+(?:=(?:"[^"]*"|[^\]]*))?\]|\.[\w-]+|#[\w-]+)*)$/i;

function matchOne(el: FakeNode, sel: string): boolean {
  const m = SIMPLE.exec(sel.trim());
  if (!m) return false; // потомковые селекторы не нужны исполнителю
  const tag = m[1];
  if (tag && tag !== '*' && el.tagName !== tag.toUpperCase()) return false;
  const parts = m[2].match(/\[[^\]]+\]|\.[\w-]+|#[\w-]+/g) || [];
  for (const p of parts) {
    if (p[0] === '.') {
      if (!(el.getAttribute('class') || '').split(/\s+/).includes(p.slice(1)))
        return false;
    } else if (p[0] === '#') {
      if (el.getAttribute('id') !== p.slice(1)) return false;
    } else {
      const a = /^\[([\w-]+)(?:=(?:"([^"]*)"|([^\]]*)))?\]$/i.exec(p)!;
      const v = el.getAttribute(a[1]);
      if (v === null) return false;
      const want = a[2] ?? a[3];
      if (want !== undefined && v !== want) return false;
    }
  }
  return true;
}

function matches(el: FakeNode, sel: string): boolean {
  return sel.split(',').some((s) => matchOne(el, s));
}

export class FakeNode {
  tagName: string;
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  parentElement: FakeNode | null = null;
  innerText = '';
  isContentEditable = false;
  disabled = false;
  rect: Rect = {
    left: 10,
    top: 10,
    right: 110,
    bottom: 40,
    width: 100,
    height: 30,
  };
  events: string[] = [];
  clicks = 0;
  removed = false;
  style = {
    props: new Map<string, string>(),
    setProperty(k: string, v: string) {
      this.props.set(k, v);
    },
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  get isConnected(): boolean {
    let n: FakeNode = this.parentElement || fakeDocument;
    while (n.parentElement) n = n.parentElement;
    return (
      (this === fakeDocument.documentElement ||
        n === fakeDocument.documentElement) &&
      !this.removed
    );
  }
  get textContent(): string {
    return this.innerText;
  }
  set textContent(v: string) {
    this.innerText = v;
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? (this.attrs.get(n) as string) : null;
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, v);
  }
  hasAttribute(n: string): boolean {
    return this.attrs.has(n);
  }
  get id(): string {
    return this.getAttribute('id') || '';
  }
  appendChild<T extends FakeNode>(c: T): T {
    if (c.parentElement)
      c.parentElement.children = c.parentElement.children.filter(
        (x) => x !== c
      );
    c.parentElement = this;
    c.removed = false;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (x) => x !== this
      );
    this.parentElement = null;
    this.removed = true;
  }
  contains(x: FakeNode | null): boolean {
    for (let n = x; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  closest(sel: string): FakeNode | null {
    if (matches(this, sel)) return this;
    for (let n = this.parentElement; n; n = n.parentElement)
      if (matches(n, sel)) return n;
    return null;
  }
  querySelectorAll(sel: string): FakeNode[] {
    const out: FakeNode[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.children) {
        if (matches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeNode | null {
    return this.querySelectorAll(sel)[0] || null;
  }
  getRootNode(): FakeDocument {
    return fakeDocument;
  }
  getBoundingClientRect(): Rect {
    return this.rect;
  }
  attachShadow(): FakeNode {
    return new FakeNode('#shadow');
  }
  dispatchEvent(e: { type: string }): boolean {
    this.events.push(e.type);
    return true;
  }
  focus() {
    this.events.push('focus()');
  }
  scrollIntoView() {
    this.events.push('scrollIntoView()');
  }
  click() {
    this.clicks++;
    this.events.push('click()');
  }
}

export class FakeInput extends FakeNode {
  type = 'text';
  name = '';
  value = '';
  checked = false;
  placeholder = '';
  form: FakeNode | null = null;
  labels: FakeNode[] = [];
  constructor(type = 'text') {
    super('input');
    this.type = type;
    this.setAttribute('type', type); // свойство отражает атрибут, как в DOM
  }
  click() {
    super.click();
    if (this.type === 'checkbox') this.checked = !this.checked;
    if (this.type === 'radio' && !this.checked) {
      for (const r of fakeDocument.querySelectorAll('input')) {
        const x = r as FakeInput;
        if (x !== this && x.type === 'radio' && x.name === this.name)
          x.checked = false;
      }
      this.checked = true;
    }
  }
}

export class FakeTextArea extends FakeNode {
  name = '';
  value = '';
  constructor() {
    super('textarea');
  }
}

export class FakeSelect extends FakeNode {
  type = 'select-one';
  name = '';
  options: Array<{ text: string; value: string }> = [];
  selectedIndex = 0;
  labels: FakeNode[] = [];
  constructor(opts: string[]) {
    super('select');
    this.options = opts.map((t) => ({ text: t, value: t }));
  }
  get value(): string {
    return this.options[this.selectedIndex]?.value ?? '';
  }
  set value(v: string) {
    this.selectedIndex = this.options.findIndex((o) => o.value === v);
  }
  get selectedOptions() {
    return this.options[this.selectedIndex]
      ? [this.options[this.selectedIndex]]
      : [];
  }
}

export class FakeDocument extends FakeNode {
  documentElement = new FakeNode('html');
  body = new FakeNode('body');
  title = 'Магазин';
  constructor() {
    super('#document');
  }
  getElementById(id: string): FakeNode | null {
    return this.querySelector('#' + id);
  }
  querySelectorAll(sel: string): FakeNode[] {
    return [
      ...(matches(this.documentElement, sel) ? [this.documentElement] : []),
      ...this.documentElement.querySelectorAll(sel),
    ];
  }
}

export let fakeDocument = new FakeDocument();

/** Глобалы браузера, которые читает исполнитель. Свежий документ — каждый вызов. */
export function installFakeDom(): FakeDocument {
  fakeDocument = new FakeDocument();
  fakeDocument.documentElement.appendChild(fakeDocument.body);
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = fakeDocument;
  g.window = globalThis;
  g.HTMLElement = FakeNode;
  g.HTMLInputElement = FakeInput;
  g.HTMLTextAreaElement = FakeTextArea;
  g.HTMLSelectElement = FakeSelect;
  g.MouseEvent = class extends Event {};
  g.PointerEvent = class extends Event {};
  g.InputEvent = class extends Event {};
  g.innerHeight = 800;
  g.innerWidth = 1200;
  g.location = new URL('https://shop.example.com/p/1');
  g.getComputedStyle = () => ({
    visibility: 'visible',
    display: 'block',
    opacity: '1',
    position: 'static',
  });
  g.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  return fakeDocument;
}
