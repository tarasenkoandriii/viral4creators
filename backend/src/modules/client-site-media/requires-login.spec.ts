/**
 * «Ролик за логином» с закрытым отказом (ТЗ помощника §4.3-бис, У-7,
 * §4.11): любое сомнение — «за логином».
 */
import {
  draftRequiresLogin,
  draftStepHosts,
  stepsShowLogin,
} from './requires-login';

/**
 * Реалистичная строка публичного черновика (аудит Э6, Д1): так она
 * выглядит в жизни после нескольких раундов БЕЗ входа — `secretsUsedAt`
 * ставит каждый раунд, куки первой стороны (аналитика, корзина, язык)
 * пишутся каждым раундом, при хранилище Ш2 заполнена ссылка на запись.
 */
const publicDraft = {
  baseUrl: 'https://shop.example.com/',
  lastUrl: 'https://shop.example.com/cart',
  steps: [
    { kind: 'goto', route: 'https://shop.example.com/catalog' },
    { kind: 'click', selector: '#buy' },
    { kind: 'fill', selector: 'input[name="q"]', value: 'чайник' },
  ],
  credentialsEnc: null,
  cookiesEnc: 'v1:куки-первой-стороны',
  requiresLiveLoginReplay: false,
  secretsUsedAt: new Date('2027-01-20T10:00:00Z'),
  siteTestAccountId: null,
  userSiteSessionId: 'user-1',
  storeHasCredentials: false,
  loginUsedAt: null,
};

describe('draftRequiresLogin', () => {
  it('публичный сценарий: secretsUsedAt стоит, куки есть, входа не было — НЕ за логином', () => {
    expect(draftRequiresLogin(publicDraft)).toBe(false);
  });

  it.each([
    [
      'куки в колонке (до хранилища)',
      { cookiesEnc: 'enc', userSiteSessionId: null },
    ],
    [
      'учётка реестра (Ш2, режим A)',
      { siteTestAccountId: 'ta1', userSiteSessionId: null },
    ],
    ['личная запись (Ш2, режим B)', { userSiteSessionId: 'us1' }],
    ['secretsUsedAt только что', { secretsUsedAt: new Date() }],
  ])('%s без входа — не за логином', (_n, over) => {
    expect(draftRequiresLogin({ ...publicDraft, ...over })).toBe(false);
  });

  it.each([
    ['липкий признак входа', { loginUsedAt: new Date() }],
    [
      'признак входа после стирания кроном (кук и кред нет)',
      { loginUsedAt: new Date(), cookiesEnc: null, userSiteSessionId: null },
    ],
    ['креды в колонке', { credentialsEnc: 'enc' }],
    ['живой вход', { requiresLiveLoginReplay: true }],
    ['поля входа в хранилище', { storeHasCredentials: true }],
    ['шагов нет (старая версия)', { steps: [] }],
    ['шаги не массив', { steps: null }],
    ['шаг без вида', { steps: [{ selector: '#a' }] }],
    [
      'секретное поле /login (пустое значение)',
      { steps: [{ kind: 'fill', selector: '#email', value: '' }] },
    ],
    [
      'fill без значения — сомнение',
      { steps: [{ kind: 'fill', selector: '#email' }] },
    ],
    [
      'ввод в поле пароля/кода',
      {
        steps: [
          { kind: 'fill', selector: 'input[type="password"]', value: 'x' },
        ],
      },
    ],
    [
      'ввод в поле OTP',
      { steps: [{ kind: 'fill', selector: '#otp-code', value: '1' }] },
    ],
  ])('%s — за логином', (_n, over) => {
    expect(draftRequiresLogin({ ...publicDraft, ...over })).toBe(true);
  });
});

describe('stepsShowLogin', () => {
  it('клики и обычный ввод — не вход; секретное поле и пароль — вход', () => {
    expect(stepsShowLogin(publicDraft.steps)).toBe(false);
    expect(stepsShowLogin(null)).toBe(false);
    expect(
      stepsShowLogin([{ kind: 'fill', selector: '#login', value: '' }]),
    ).toBe(true);
    expect(
      stepsShowLogin([{ kind: 'fill', selector: '#pwd', value: 'x' }]),
    ).toBe(true);
  });
});

describe('draftStepHosts', () => {
  it('хосты базы, последнего адреса и goto-шагов; маршруты продукта — не адреса', () => {
    expect(
      draftStepHosts({
        ...publicDraft,
        steps: [
          { kind: 'goto', route: 'https://Admin.Shop.example.com/x' },
          { kind: 'goto', route: 'catalog' },
        ],
      }).sort(),
    ).toEqual(['admin.shop.example.com', 'shop.example.com']);
  });
});
