/**
 * Правка мемо с телефона — чистая часть: действие и отпечаток из строки
 * Ш4 (сервер строит `pin`, подпись — маска ПД), список выбора страницы,
 * новый шаг со слотом, замена цели. Права, хосты и ворота на базе —
 * `acceptance/e6b/memo-tma-edit.http.spec.ts`.
 */
import { emptyMemoContent } from '../../assist-ui-core/memo';
import {
  freeSlotName,
  memoActionFor,
  memoElementViews,
  memoPageParam,
  memoPinFor,
  memoStepFromElement,
  memoStepRetarget,
  type MemoUiElementRow,
} from './memo-elements';

const row = (over: Partial<MemoUiElementRow>): MemoUiElementRow => ({
  id: 'el1',
  hostId: 'h1',
  path: '/product/1',
  viewport: 'any',
  elementKey: 'k1',
  tag: 'button',
  label: 'В кошик',
  role: null,
  selector: '[data-assist-id="add-to-cart"]',
  candidates: [],
  stability: 'strong',
  staleDesktopAt: null,
  staleMobileAt: null,
  ...over,
});

describe('правка мемо с телефона — элементы Ш4', () => {
  it('действие по элементу: кнопка/ссылка — click, поле — fill, список — select, флажок — check', () => {
    expect(memoActionFor({ tag: 'button', role: null })).toBe('click');
    expect(memoActionFor({ tag: 'a', role: null })).toBe('click');
    expect(memoActionFor({ tag: 'input', role: null })).toBe('fill');
    expect(memoActionFor({ tag: 'input', role: 'button' })).toBe('click');
    expect(memoActionFor({ tag: 'textarea', role: null })).toBe('fill');
    expect(memoActionFor({ tag: 'select', role: null })).toBe('select');
    expect(memoActionFor({ tag: 'input', role: 'checkbox' })).toBe('check');
  });

  it('отпечаток: разметка из кандидата, подпись — маска ПД, поле с e-mail — ПД', () => {
    const p = memoPinFor(row({ label: 'Подзвонити 0671234567' }), 'click');
    expect(p).toMatchObject({
      role: 'button',
      assistId: 'add-to-cart',
      tag: 'button',
      submit: false,
      pd: false,
      stability: 'strong',
    });
    expect(p.text).not.toContain('0671234567');
    const f = memoPinFor(
      row({ tag: 'input', label: 'Ваш e-mail', selector: '#mail' }),
      'fill',
    );
    expect(f).toMatchObject({
      assistId: null,
      inForm: true,
      pd: true,
      inputType: 'email',
    });
  });

  it('список выбора: страница/маска, вид мемо, один на элемент, пустые без разметки — нет, устаревший — с пометкой', () => {
    const rows = [
      row({ id: 'a', elementKey: 'cart', viewport: 'any' }),
      row({ id: 'b', elementKey: 'cart', viewport: 'mobile' }),
      row({ id: 'c', elementKey: 'desk', viewport: 'desktop' }),
      row({
        id: 'd',
        elementKey: 'old',
        label: 'Старе',
        selector: '#old',
        staleMobileAt: new Date(),
      }),
      row({ id: 'e', elementKey: 'empty', label: '', selector: '#x' }),
      row({ id: 'f', elementKey: 'other', path: '/cart' }),
    ];
    const v = memoElementViews(rows, '/product/1', 'mobile');
    expect(v.map((x) => x.uiElementId).sort()).toEqual(['b', 'd']);
    expect(v.find((x) => x.uiElementId === 'd')?.stale).toBe(true);
    const all = memoElementViews(rows, '/product/*', 'any');
    expect(all.map((x) => x.uiElementId).sort()).toEqual(['a', 'c', 'd']);
    for (const x of all) expect(x).not.toHaveProperty('selector');
  });

  it('параметр страницы: путь или маска хвостом, без мусора', () => {
    expect(memoPageParam('/product/*')).toBe('/product/*');
    expect(memoPageParam('/a/*/b')).toBeNull();
    expect(memoPageParam('javascript:alert(1)')).toBeNull();
    expect(memoPageParam(5)).toBeNull();
  });

  it('новый шаг: поле — слот без значения (свободное имя), маска страницы сохраняется; замена цели — действие и слот прежние', () => {
    const c = emptyMemoContent();
    c.slots = [{ name: 'text', kind: 'text', pii: false, options: [] }];
    const made = memoStepFromElement(
      row({ id: 'f1', tag: 'input', label: "Ваше ім'я", selector: '#n' }),
      '/product/*',
      c.slots,
    );
    expect(made.slot).toEqual({
      name: 'text_2',
      kind: 'text',
      pii: false,
      options: [],
    });
    expect(made.step).toMatchObject({
      page: '/product/*',
      action: 'fill',
      value: { slot: 'text_2' },
      target: { uiElementId: 'f1', mapKey: null },
    });
    expect(made.step.target?.pin.pd).toBe(true);
    const click = memoStepFromElement(row({ path: '/cart' }), '/product/*', []);
    expect(click.slot).toBeNull();
    expect(click.step.page).toBe('/cart');
    const re = memoStepRetarget(
      made.step,
      row({ id: 'f2', tag: 'input', label: 'Ім’я', selector: '#m' }),
    );
    expect(re).toMatchObject({
      action: 'fill',
      value: { slot: 'text_2' },
      target: { uiElementId: 'f2' },
    });
    expect(
      freeSlotName('email', [{ name: 'email' }, { name: 'email_2' }]),
    ).toBe('email_3');
  });
});
