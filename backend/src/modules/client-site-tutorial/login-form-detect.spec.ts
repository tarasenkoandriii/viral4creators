/**
 * Поиск полей формы входа для учётки реестра (Э-С Ш2-хвост (3)): типы
 * полей, `autocomplete`, подписи, порядок в документе; сомнение — «не
 * нашли», а не угаданный ввод; пароль — только в поле пароля.
 */
import { findLoginFields, passwordFieldSource } from './login-form-detect';
import type { PageElement } from './page-exploration.types';

const header: PageElement[] = [
  { selector: 'a[href="/"]', tag: 'a', visibleText: 'Главная' },
  { selector: '#search', tag: 'input', type: 'search', label: 'Поиск' },
  { selector: '#signup', tag: 'button', visibleText: 'Регистрация' },
];

const loginForm: PageElement[] = [
  ...header,
  {
    selector: '#email',
    tag: 'input',
    type: 'email',
    label: 'Email',
    autocomplete: 'username',
  },
  {
    selector: '#pw',
    tag: 'input',
    type: 'password',
    label: 'Пароль',
    autocomplete: 'current-password',
  },
  { selector: '#show', tag: 'button', visibleText: 'Показать пароль' },
  { selector: '#forgot', tag: 'a', visibleText: 'Забыли пароль?' },
  { selector: '#go', tag: 'button', type: 'submit', visibleText: 'Войти' },
  { selector: '#google', tag: 'button', visibleText: 'Войти через Google' },
];

describe('findLoginFields', () => {
  it('обычная форма: логин по autocomplete/типу, пароль, кнопка «Войти» после пароля; шапка и соцвход — мимо', () => {
    expect(findLoginFields(loginForm, { needUsername: true })).toEqual({
      ok: true,
      usernameSelector: '#email',
      passwordSelector: '#pw',
      submitSelector: '#go',
    });
  });

  it('без autocomplete и типов: подпись и порядок (text перед паролем, кнопка без type)', () => {
    const plain: PageElement[] = [
      { selector: 'input[name="q"]', tag: 'input', label: 'Поиск по сайту' },
      { selector: 'input[name="login"]', tag: 'input', name: 'login' },
      { selector: 'input[name="pass"]', tag: 'input', type: 'password' },
      { selector: 'form > button', tag: 'button', visibleText: 'Увійти' },
    ];
    expect(findLoginFields(plain, { needUsername: true })).toEqual({
      ok: true,
      usernameSelector: 'input[name="login"]',
      passwordSelector: 'input[name="pass"]',
      submitSelector: 'form > button',
    });
  });

  it('учётка без логина — только пароль и кнопка; `input[type=submit]` тоже кнопка', () => {
    const pinOnly: PageElement[] = [
      { selector: '#pin', tag: 'input', type: 'password' },
      { selector: '#ok', tag: 'input', type: 'submit', label: 'OK' },
    ];
    expect(findLoginFields(pinOnly, { needUsername: false })).toEqual({
      ok: true,
      usernameSelector: null,
      passwordSelector: '#pin',
      submitSelector: '#ok',
    });
  });

  it('нет поля пароля, регистрация (новый + повтор), два текущих пароля — «не нашли пароль»', () => {
    expect(findLoginFields(header, { needUsername: true })).toEqual({
      ok: false,
      missing: ['password'],
    });
    const signup: PageElement[] = [
      { selector: '#e', tag: 'input', type: 'email' },
      {
        selector: '#p1',
        tag: 'input',
        type: 'password',
        autocomplete: 'new-password',
      },
      {
        selector: '#p2',
        tag: 'input',
        type: 'password',
        label: 'Повторите пароль',
      },
      {
        selector: '#reg',
        tag: 'button',
        type: 'submit',
        visibleText: 'Создать',
      },
    ];
    expect(findLoginFields(signup, { needUsername: true }).ok).toBe(false);
    const twoCurrent: PageElement[] = [
      {
        selector: '#a',
        tag: 'input',
        type: 'password',
        autocomplete: 'current-password',
      },
      {
        selector: '#b',
        tag: 'input',
        type: 'password',
        autocomplete: 'current-password',
      },
    ];
    expect(findLoginFields(twoCurrent, { needUsername: false })).toEqual({
      ok: false,
      missing: ['password'],
    });
  });

  it('пароль нашёлся, логина и кнопки нет — перечислено, чего не хватает', () => {
    const bare: PageElement[] = [
      { selector: '#pw', tag: 'input', type: 'password' },
      { selector: '#cancel', tag: 'button', visibleText: 'Отмена' },
    ];
    expect(findLoginFields(bare, { needUsername: true })).toEqual({
      ok: false,
      missing: ['username', 'submit'],
    });
  });

  it('указанные человеком поля проверяются: пароль — только поле пароля, логин — не пароль', () => {
    expect(
      findLoginFields(loginForm, {
        needUsername: true,
        pick: { usernameSelector: '#search' },
      }),
    ).toEqual({ ok: false, missing: ['username'] });
    // Указали «пароль» в текстовое поле — отказ (пароль был бы виден в кадре).
    expect(
      findLoginFields(loginForm, {
        needUsername: true,
        pick: { passwordSelector: '#email' },
      }),
    ).toEqual({ ok: false, missing: ['password'] });
    expect(
      findLoginFields(loginForm, {
        needUsername: true,
        pick: { usernameSelector: '#pw' },
      }),
    ).toEqual({ ok: false, missing: ['username'] });
    // Кнопка, которой на странице нет.
    expect(
      findLoginFields(loginForm, {
        needUsername: true,
        pick: { submitSelector: '#nope' },
      }),
    ).toEqual({ ok: false, missing: ['submit'] });
    expect(
      findLoginFields(loginForm, {
        needUsername: true,
        pick: { submitSelector: '#forgot', usernameSelector: '#email' },
      }),
    ).toMatchObject({ ok: true, submitSelector: '#forgot' });
  });

  it('кнопка с предупреждением стоп-листа не выбирается сама', () => {
    const danger: PageElement[] = [
      { selector: '#pw', tag: 'input', type: 'password' },
      {
        selector: '#pay',
        tag: 'button',
        type: 'submit',
        visibleText: 'Оплатить',
        danger: 'оплата',
      },
    ];
    expect(findLoginFields(danger, { needUsername: false })).toEqual({
      ok: false,
      missing: ['submit'],
    });
  });
});

describe('passwordFieldSource', () => {
  function run(el: unknown): unknown {
    (globalThis as { document?: unknown }).document = {
      querySelector: () => el,
    };
    try {
      return new Function(`return ${passwordFieldSource('#pw')}`)();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  }
  const input = (attr: string | null, prop: string) => ({
    tagName: 'INPUT',
    type: prop,
    getAttribute: () => attr,
  });

  it('только input с type=password и по атрибуту, и по свойству', () => {
    expect(run(input('password', 'password'))).toBe(true);
    expect(run(input('text', 'text'))).toBe(false);
    // Страница сменила тип свойством («показать пароль») — уже не поле пароля.
    expect(run(input('password', 'text'))).toBe(false);
    expect(
      run({ tagName: 'DIV', type: 'password', getAttribute: () => 'password' }),
    ).toBe(false);
    expect(run(null)).toBe(false);
  });

  it('селектор едет JSON-литералом, без склейки', () => {
    expect(passwordFieldSource('a"); alert(1); ("')).toContain(
      JSON.stringify('a"); alert(1); ("'),
    );
  });
});
