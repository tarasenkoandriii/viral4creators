/**
 * Извлечение интерактивных элементов страницы заказчика — §5.4 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 112.
 *
 * ## Главное ограничение этого файла: функция обязана уметь уехать в браузер
 *
 * `collectPageExploration` исполняется НЕ здесь, а внутри страницы: её
 * исходник сериализуется (`Function.prototype.toString()`) и отдаётся
 * в `page.evaluate` (см. `chromium-page-explorer.ts`). Отсюда правила,
 * нарушение которых ломает не тест, а прод:
 *
 * - никаких импортов и никаких обращений к чему-либо вне собственного
 *   тела: замыкание не сериализуется, в браузере будет
 *   `ReferenceError`. Поэтому все константы и хелперы объявлены ВНУТРИ,
 *   хотя снаружи это выглядело бы опрятнее;
 * - никакого синтаксиса, который TypeScript компилирует через
 *   хелперы-заглушки (`__spreadArray` и родня). Цель сборки — ES2021,
 *   так что обычный современный код едет как есть, но правило стоит
 *   помнить, если кто-то опустит `target`;
 * - `document` и `window` берутся из браузера, а не приходят
 *   аргументом: `page.evaluate` умеет передавать только то, что
 *   сериализуется в JSON, а DOM в JSON не сериализуется.
 *
 * Тест зовёт эту же функцию напрямую, подставив в `globalThis.document`
 * лёгкий поддельный DOM — тот же приём, что у `scenario-runner.spec.ts`
 * с поддельной страницей, и по той же причине: Chromium в CI этого
 * проекта не поднимается (`doc/CI.md`). Плюс отдельный тест сторожит
 * само правило сериализуемости, разбирая исходник функции, — иначе
 * случайная ссылка на внешнюю константу прошла бы все остальные тесты
 * и упала бы только на живом сайте.
 *
 * ## Приоритет селектора
 *
 * §5.4: `#id` → `[data-testid]`/`[data-test]` → `[name]` →
 * `[aria-label]` → путь по тегам с `:nth-of-type()`. Каждый кандидат
 * ПРОВЕРЯЕТСЯ на единственность (`querySelectorAll(...).length === 1`) —
 * без этого `input[name="email"]` на странице с двумя формами (вход и
 * регистрация) указывал бы на чужое поле, и обучалка молча записывала
 * бы не тот сценарий. Устойчивость важнее краткости: селектор переживёт
 * в `draft.steps` и будет проигран заново, возможно через недели.
 */

import { PageElement } from './page-exploration.types';

/** Ровно то, что возвращает функция, исполняемая внутри страницы. */
export interface CollectedPage {
  currentUrl: string;
  elements: PageElement[];
  looksLikeLogin: boolean;
}

/**
 * ВНИМАНИЕ: тело этой функции уезжает в браузер целиком (см.
 * доккомментарий файла). Ничего снаружи не звать.
 *
 * @param allowedOrigin origin черновика: ссылки наружу в список не
 * попадают вовсе (§5.4 — «лучше не предлагать их вовсе, чем предложить
 * и тут же отказать» доменным замком §8.1).
 */
export function collectPageExploration(allowedOrigin: string): CollectedPage {
  const MAX_ELEMENTS = 200;
  const MAX_TEXT = 200;
  const TAGS = ['input', 'select', 'textarea', 'button', 'a'];

  const doc: Document = globalThis.document;
  const elements: PageElement[] = [];
  let looksLikeLogin = false;

  function clean(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.replace(/\s+/g, ' ').trim();
    if (trimmed.length === 0) return undefined;
    return trimmed.slice(0, MAX_TEXT);
  }

  function quote(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function isVisible(el: Element): boolean {
    // §5.4 называет критерием `offsetParent !== null`. Одного его мало:
    // у элемента внутри `position: fixed` контейнера offsetParent равен
    // null, а модальное окно входа — ровно такой случай и ровно то, ради
    // чего этот визард существует. Поэтому второй, более широкий
    // критерий: есть хоть один прямоугольник отрисовки.
    const html = el as HTMLElement;
    if (html.offsetParent !== null && html.offsetParent !== undefined) {
      return true;
    }
    if (typeof el.getClientRects === 'function') {
      const rects = el.getClientRects();
      return !!rects && rects.length > 0;
    }
    return false;
  }

  function unique(selector: string): boolean {
    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch {
      // Селектор с экзотическим значением атрибута может оказаться
      // синтаксически некорректным — это не повод падать, это повод
      // взять следующего кандидата.
      return false;
    }
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 12) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') break;
      const parent: Element | null = node.parentElement;
      let index = 1;
      if (parent) {
        const siblings = parent.children;
        for (let i = 0; i < siblings.length; i++) {
          const sib = siblings[i];
          if (sib === node) break;
          if (sib.tagName === node.tagName) index++;
        }
      }
      parts.unshift(`${tag}:nth-of-type(${index})`);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  }

  function selectorFor(el: Element, tag: string): string {
    const id = el.getAttribute('id');
    if (id) {
      // Идентификатор, начинающийся с цифры или содержащий что угодно,
      // в форме `#...` не всегда валиден — тогда та же мысль через
      // атрибут, которая валидна всегда.
      const short = /^[A-Za-z][\w-]*$/.test(id) ? `#${id}` : null;
      if (short && unique(short)) return short;
      const byAttr = `${tag}[id="${quote(id)}"]`;
      if (unique(byAttr)) return byAttr;
    }
    const attrs = ['data-testid', 'data-test', 'name', 'aria-label'];
    for (let i = 0; i < attrs.length; i++) {
      const value = el.getAttribute(attrs[i]);
      if (!value) continue;
      const candidate = `${tag}[${attrs[i]}="${quote(value)}"]`;
      if (unique(candidate)) return candidate;
    }
    return cssPath(el);
  }

  /**
   * Текст подписи БЕЗ текста самого поля.
   *
   * Найдено на боевом прогоне. Большинство форм размечает подпись
   * ОБЁРТКОЙ — `<label>Статус: <select>…</select></label>`, — а
   * `textContent` у обёртки включает и содержимое поля. У `<select>`
   * это все его `<option>`, и подпись приезжала на экран визарда
   * склейкой «Статус: всеждут проверкизаписываютсяодобренныеотклонённые».
   * Человек видел мусор ровно там, где ему нужно понять, что за поле
   * перед ним.
   *
   * Идём по узлам сами, а не `cloneNode`+удаление: клон пришлось бы
   * сопоставлять с оригиналом, чтобы понять, какой из потомков —
   * нужное поле. Текст рядом с полем внутри вложенной обёртки
   * (`<label><span>Статус:</span><select>…</select></label>`) при этом
   * не теряется — в не-поля спускаемся рекурсивно.
   */
  function labelOwnText(label: Element): string {
    const kids = label.childNodes;
    if (!kids) return label.textContent ?? '';
    let out = '';
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      // 3 — текстовый узел, 1 — элемент. Числами, а не `Node.TEXT_NODE`:
      // функция уезжает в браузер строкой, и чем меньше она опирается
      // на окружение, тем лучше (см. шапку файла).
      if (node.nodeType === 3) {
        out += node.nodeValue ?? '';
        continue;
      }
      if (node.nodeType !== 1) continue;
      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'select' ||
        tag === 'textarea' ||
        tag === 'button'
      ) {
        continue;
      }
      out += labelOwnText(child);
    }
    return out;
  }

  function labelFor(el: Element): string | undefined {
    const id = el.getAttribute('id');
    if (id) {
      try {
        const bound = doc.querySelector(`label[for="${quote(id)}"]`);
        // `label[for]` обычно поле не оборачивает, но ничто не мешает:
        // правило одно и то же для обоих случаев.
        const text = clean(bound ? labelOwnText(bound) : null);
        if (text) return text;
      } catch {
        /* некорректный селектор из чужого id — идём дальше */
      }
    }
    if (typeof el.closest === 'function') {
      const wrapping = el.closest('label');
      if (wrapping && wrapping !== el) {
        const text = clean(labelOwnText(wrapping));
        if (text) return text;
      }
    }
    return (
      clean(el.getAttribute('aria-label')) ??
      clean(el.getAttribute('placeholder')) ??
      undefined
    );
  }

  function sameOrigin(href: string | null): boolean {
    if (!href) return false;
    try {
      return new URL(href, doc.baseURI).origin === allowedOrigin;
    } catch {
      return false;
    }
  }

  const found = doc.querySelectorAll(TAGS.join(','));
  for (let i = 0; i < found.length; i++) {
    if (elements.length >= MAX_ELEMENTS) break;
    const el = found[i];
    const tag = el.tagName.toLowerCase();
    if (TAGS.indexOf(tag) === -1) continue;

    const type = clean(el.getAttribute('type'))?.toLowerCase();
    // Скрытые поля — не то, что человек может заполнить; они же чаще
    // всего и есть CSRF-токены, которым в предпросмотре делать нечего.
    if (tag === 'input' && type === 'hidden') continue;
    if (!isVisible(el)) continue;

    if (tag === 'input' && type === 'password') looksLikeLogin = true;

    const visibleText =
      tag === 'button' || tag === 'a'
        ? clean((el as HTMLElement).innerText ?? el.textContent)
        : undefined;

    if (tag === 'a') {
      // Ссылка наружу всё равно была бы отвергнута доменным замком —
      // не предлагаем её вовсе (§5.4).
      if (!sameOrigin(el.getAttribute('href'))) continue;
      if (!visibleText) continue;
    }

    const item: PageElement = {
      selector: selectorFor(el, tag),
      tag: tag as PageElement['tag'],
    };
    if (tag === 'select') {
      // Значение опции, а не её надпись, — то, что примет `fill`.
      // Потолок на случай списка стран на 250 позиций: длиннее
      // показывать в визарде всё равно нечем.
      const options: Array<{ value: string; label: string }> = [];
      const children = el.children;
      for (let k = 0; k < children.length && options.length < 100; k++) {
        const opt = children[k];
        if (opt.tagName.toLowerCase() !== 'option') continue;
        const label = clean(opt.textContent) ?? '';
        const value = opt.getAttribute('value') ?? label;
        if (label) options.push({ value, label });
      }
      if (options.length > 0) item.options = options;
    }
    if (type) item.type = type;
    const name = clean(el.getAttribute('name'));
    if (name) item.name = name;
    const label = labelFor(el);
    if (label) item.label = label;
    if (visibleText) item.visibleText = visibleText;
    elements.push(item);
  }

  return {
    currentUrl: doc.location ? doc.location.href : '',
    elements,
    looksLikeLogin,
  };
}
