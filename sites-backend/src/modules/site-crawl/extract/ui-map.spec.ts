/**
 * Карта интерфейса из HTML обхода (Э6, §4.12): приоритет селектора тот же,
 * что у `PageExploration` обучалки (§5.4 ТЗ обучалки), единственность,
 * скрытое и чужие ссылки — вон. Сети не ходит (как extractor).
 */
import { uiElementId } from '../../site-core/ui-map/ui-map';
import { extractUiElements } from './ui-map';

const URL = 'https://shop.example.com/pricing';

function html(body: string): string {
  return `<!doctype html><html><head><title>T</title><script>var a='<button id=s>x</button>'</script></head><body>${body}</body></html>`;
}

describe('extractUiElements — селекторы как у PageExploration', () => {
  it('#id → [data-testid] → [name] → [aria-label] → путь nth-of-type', () => {
    const els = extractUiElements(
      html(`
        <main>
          <button id="buy">Купить</button>
          <button data-testid="cart-btn">Корзина</button>
          <input name="email" placeholder="Ваш e-mail">
          <a href="/help" aria-label="Помощь">?</a>
          <section><div><button>Подписаться</button></div></section>
        </main>`),
      URL,
    );
    expect(els.map((e) => [e.selector, e.tag, e.label])).toEqual([
      ['#buy', 'button', 'Купить'],
      ['button[data-testid="cart-btn"]', 'button', 'Корзина'],
      ['input[name="email"]', 'input', 'Ваш e-mail'],
      ['a[aria-label="Помощь"]', 'a', 'Помощь'],
      [
        'main:nth-of-type(1) > section:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)',
        'button',
        'Подписаться',
      ],
    ]);
    expect(els[0].id).toBe(uiElementId('#buy'));
  });

  it('неуникальный атрибут — следующий кандидат; id с цифры — через атрибут', () => {
    const els = extractUiElements(
      html(`
        <form><input name="q" placeholder="Поиск"></form>
        <form><input name="q" aria-label="Поиск 2"></form>
        <button id="1st">Первая</button>`),
      URL,
    );
    expect(els.map((e) => e.selector)).toEqual([
      'form:nth-of-type(1) > input:nth-of-type(1)',
      'input[aria-label="Поиск 2"]',
      'button[id="1st"]',
    ]);
  });

  it('подпись поля — <label for> и обёртка без текста самого поля', () => {
    const els = extractUiElements(
      html(`
        <label for="city">Город</label><select id="city"><option>Киев</option></select>
        <label>Статус: <select name="st"><option>ждут</option><option>готово</option></select></label>`),
      URL,
    );
    expect(els.map((e) => e.label)).toEqual(['Город', 'Статус:']);
  });

  it('скрытое разметкой, hidden-поля, чужие и служебные ссылки, script/template — вон', () => {
    const els = extractUiElements(
      html(`
        <button hidden>Скрыта</button>
        <div style="display: none"><button>Внутри скрытого</button></div>
        <button aria-hidden="true">aria</button>
        <input type="hidden" name="csrf" value="x">
        <a href="https://evil.example/x">Чужая</a>
        <a href="javascript:void(0)">JS</a>
        <a href="#top">Наверх</a>
        <a href="mailto:a@b.c">Почта</a>
        <template><button>Шаблон</button></template>
        <a href="/delivery">Доставка</a>`),
      URL,
    );
    expect(els.map((e) => e.label)).toEqual(['Доставка']);
  });

  it('без подписи — не в карте (модели нечего назвать); кнопка-submit — по value', () => {
    const els = extractUiElements(
      html(
        `<button id="icon"><svg><path d="M0"/></svg></button><input type="submit" value="Отправить" id="go">`,
      ),
      URL,
    );
    expect(els.map((e) => [e.selector, e.label])).toEqual([
      ['#go', 'Отправить'],
    ]);
  });

  it('битый адрес страницы — пусто', () => {
    expect(extractUiElements(html('<button id="a">A</button>'), 'нет')).toEqual(
      [],
    );
  });
});
