/**
 * Ядро карты интерфейса (Э6, §4.12): ключ страницы, id элемента, строгая
 * чистка элементов от любого источника.
 */
import {
  UI_MAP_LIMITS,
  cleanUiElements,
  cleanUiLabel,
  cleanUiSelector,
  uiElementId,
  uiElementsHash,
  uiMapKey,
} from './ui-map';

describe('uiMapKey — хост и путь страницы', () => {
  it('без query, фрагмента, www и концевого /; корень — /', () => {
    expect(uiMapKey('https://WWW.Shop.example.com/Cart/?a=1#x')).toEqual({
      host: 'shop.example.com',
      path: '/Cart',
    });
    expect(uiMapKey('https://shop.example.com')).toEqual({
      host: 'shop.example.com',
      path: '/',
    });
  });

  it('не http(s), логин в адресе, мусор, длинный путь — null', () => {
    expect(uiMapKey('javascript:alert(1)')).toBeNull();
    expect(uiMapKey('https://u:p@shop.example.com/')).toBeNull();
    expect(uiMapKey('не адрес')).toBeNull();
    expect(uiMapKey(42)).toBeNull();
    expect(
      uiMapKey(`https://a.example.com/${'x'.repeat(UI_MAP_LIMITS.path + 1)}`),
    ).toBeNull();
  });
});

describe('элементы карты', () => {
  it('id — от селектора, стабилен', () => {
    expect(uiElementId('#buy')).toMatch(/^u[0-9a-f]{8}$/);
    expect(uiElementId('#buy')).toBe(uiElementId('#buy'));
    expect(uiElementId('#buy')).not.toBe(uiElementId('#cart'));
  });

  it('подпись — текст без разметки и управляющих символов, ≤ 80', () => {
    expect(cleanUiLabel('  Купить‮ <b>сейчас</b> ')).toBe('Купить bсейчас/b');
    expect(cleanUiLabel('x'.repeat(200))!.length).toBe(UI_MAP_LIMITS.label);
    expect(cleanUiLabel('   ')).toBeNull();
    expect(cleanUiLabel(5)).toBeNull();
  });

  it('селектор — печатный CSS без <>, ≤ 200', () => {
    expect(cleanUiSelector('button[aria-label="Кошик"]')).toBe(
      'button[aria-label="Кошик"]',
    );
    expect(cleanUiSelector('main > a:nth-of-type(2)')).toBe(
      'main > a:nth-of-type(2)',
    );
    expect(cleanUiSelector('<img src=x onerror=alert(1)>')).toBeNull();
    expect(cleanUiSelector('a\nb')).toBeNull();
    expect(cleanUiSelector('x'.repeat(201))).toBeNull();
  });

  it('cleanUiElements: тег из перечня, без подписи — вон, дубли — вон, id пересчитан', () => {
    const out = cleanUiElements([
      { id: 'u00000000', selector: '#buy', tag: 'button', label: 'Купить' },
      { selector: '#buy', tag: 'button', label: 'Дубль' },
      { selector: '#x', tag: 'div', label: 'не тот тег' },
      { selector: '#y', tag: 'a', label: '' },
      { selector: '<script>', tag: 'a', label: 'зло' },
      'мусор',
      null,
    ]);
    expect(out).toEqual([
      {
        id: uiElementId('#buy'),
        selector: '#buy',
        tag: 'button',
        label: 'Купить',
      },
    ]);
    expect(cleanUiElements('не массив')).toEqual([]);
  });

  it('потолок элементов на страницу', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      selector: `#b${i}`,
      tag: 'button',
      label: `Кнопка ${i}`,
    }));
    expect(cleanUiElements(many)).toHaveLength(UI_MAP_LIMITS.elements);
  });

  it('хеш набора меняется со сменой вёрстки', () => {
    const a = cleanUiElements([{ selector: '#a', tag: 'a', label: 'A' }]);
    const b = cleanUiElements([{ selector: '#b', tag: 'a', label: 'A' }]);
    expect(uiElementsHash(a)).toBe(uiElementsHash(a));
    expect(uiElementsHash(a)).not.toBe(uiElementsHash(b));
  });
});
