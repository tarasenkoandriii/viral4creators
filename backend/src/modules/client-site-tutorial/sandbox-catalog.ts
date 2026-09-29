/**
 * Каталог элементов полигона — что разведчик чужих сайтов ОБЯЗАН найти
 * на `landing/src/app/qa/site-sandbox` (29.09.2026).
 *
 * ## Зачем каталог для ЧУЖОГО DOM
 *
 * У мастера есть `qa-hooks.ts`, и его сила в том, что DOM наш: список
 * закрыт, а шов сверяет его с фронтендом. Для обучалки по сайту
 * заказчика такого списка нет и быть не может — сайт чужой и меняется
 * без нас, поэтому разведчик каждый раунд НАХОДИТ элементы сам.
 *
 * Именно поэтому у него нет и оракула: «нашёл три поля» — это много
 * или мало? Полигон возвращает оракул ровно тем, что его DOM наш: мы
 * знаем точный ответ и можем сравнить с ним найденное.
 *
 * ## Что этот каталог НЕ значит
 *
 * Он не описывает продукт и не участвует в его работе. Разведчик о нём
 * не знает и знать не должен: подсказать ему список элементов значило
 * бы проверять не разведку, а совпадение двух копий одного списка.
 * Каталог читают только тесты и шов.
 *
 * ## Состояния
 *
 * Полигон живёт в двух экранах и одном наложении:
 *
 *   - `start` — форма входа; поверх неё, пока не закрыта, куки-стена;
 *   - `signed-in` — личный кабинет с необратимой кнопкой.
 *
 * Элемент объявляется вместе с экраном, на котором он бывает: это
 * ровно то знание, которого не хватало каталогу мастера и из-за
 * которого десять хуков обещали экраны, где их не бывает.
 */

/** Экран полигона, на котором элемент виден. */
export type SandboxScreen = 'start' | 'signed-in' | 'any';

export interface SandboxElement {
  /** Значение `data-qa` на странице. */
  hook: string;
  screen: SandboxScreen;
  /** Что это и зачем оно в полигоне. */
  description: string;
  /**
   * Режим отказа чужого сайта, который этот элемент воспроизводит.
   * `null` — элемент служебный (заголовок, корень), сам по себе
   * ничего не проверяет.
   */
  covers: string | null;
}

export const SANDBOX_ELEMENTS: readonly SandboxElement[] = [
  {
    hook: 'sandbox-root',
    screen: 'any',
    description: 'корень страницы',
    covers: null,
  },
  {
    hook: 'sandbox-title',
    screen: 'any',
    description: 'заголовок — якорь для assertText',
    covers: null,
  },
  {
    hook: 'sandbox-cookie-banner',
    screen: 'any',
    description: 'куки-стена поверх содержимого',
    covers:
      'самый частый первый экран чужого сайта: пока баннер не закрыт, кадр показывает баннер, а не страницу',
  },
  {
    hook: 'sandbox-cookie-accept',
    screen: 'any',
    description: 'кнопка закрытия куки-стены',
    covers: 'первый осмысленный клик раунда на большинстве чужих сайтов',
  },
  {
    hook: 'sandbox-login-form',
    screen: 'start',
    description: 'форма входа',
    covers: null,
  },
  {
    hook: 'sandbox-email',
    screen: 'start',
    description: 'обычное текстовое поле',
    covers: 'заполнение поля, значение которого не секрет',
  },
  {
    hook: 'sandbox-password',
    screen: 'start',
    description: 'поле пароля',
    covers:
      'эвристика looksLikeLogin (§5.4) и путь живого входа: значение обязано уехать в credentialsEnc, а не в шаги',
  },
  {
    hook: 'sandbox-submit',
    screen: 'start',
    description: 'отправка формы',
    covers: 'переход между состояниями внутри одного origin',
  },
  {
    hook: 'sandbox-account',
    screen: 'signed-in',
    description: 'экран после входа',
    covers: 'состояние, которого до клика на странице не было вовсе',
  },
  {
    hook: 'sandbox-greeting',
    screen: 'signed-in',
    description: 'текст после входа — якорь, что вход действительно случился',
    covers: null,
  },
  {
    hook: 'sandbox-delete',
    screen: 'signed-in',
    description: 'кнопка «Удалить аккаунт»',
    covers:
      'стоп-лист опасных слов (§8.3): обязан ПРЕДУПРЕДИТЬ оператора, но не заблокировать раунд',
  },
  {
    hook: 'sandbox-late-block',
    screen: 'any',
    description: 'блок, появляющийся через секунду',
    covers:
      'кадр снимается ПОСЛЕ waitForNetworkIdle, а не сразу: иначе ленивое содержимое в ролик не попадёт',
  },
];

/** Элементы, видимые на конкретном экране. */
export function sandboxElementsOn(
  screen: Exclude<SandboxScreen, 'any'>,
): readonly SandboxElement[] {
  return SANDBOX_ELEMENTS.filter(
    (e) => e.screen === 'any' || e.screen === screen,
  );
}

/** Публичный путь полигона. Копия литерала из `landing/src/app` —
 *  держит её шов `check-docs`, как и остальные копии в этом проекте. */
export const SANDBOX_PATH = '/qa/site-sandbox';
