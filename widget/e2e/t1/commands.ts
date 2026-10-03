/**
 * Т-1 (ТЗ §5-бис.12) — набор команд стендов фреймворков: 4 стенда × 20
 * команд × 3 языка (uk/ru/en) = 240. Каждая команда — файл ожиданий в
 * одном месте: стенд и стартовая страница, тексты команды на трёх языках,
 * «ожидаемый план» (цели по `data-assist-id` или видимому тексту — им же
 * отвечает подделка модели на уровне «транскрипт»; живую модель сравнивают
 * с ним на уровне «транскрипт-живой» у владельца), ожидаемое конечное
 * состояние стенда и запрещённое.
 *
 * Голосовые фикстуры (синтез/шум/записи дикторов) ссылаются сюда по `id`
 * (`e2e/t1/fixtures.ts`, `scripts/t1/*`).
 */
import type { ModelStep } from '../stand/ui-plan-mock';

export type Stand = 'react' | 'vue' | 'jquery' | 'mpa';
export type Lang = 'uk' | 'ru' | 'en';

export interface Expect {
  /** Путь страницы после команды (регулярное выражение по pathname). */
  path?: string;
  /** Элемент с текстом (селектор, подстрока). */
  text?: [string, string];
  /** Значение поля (селектор, значение или значение по языку) — и после blur. */
  value?: [string, string | Record<Lang, string>];
  checked?: string;
  /** Товаров в кошике (window.__stand.cart или сервер стенда для MPA). */
  cart?: number;
  /** Отправленных форм. */
  submits?: number;
  /** Подстрока query страницы (фильтр MPA). */
  search?: string;
}

export interface T1Command {
  id: string;
  stand: Stand;
  /** Стартовый путь стенда (без query). */
  start: string;
  text: Record<Lang, string>;
  /** «Ответ модели» — цели описанием (разметка/видимый текст), значения — по языку. */
  plan: Array<
    Omit<ModelStep, 'value'> & { value?: string | Record<Lang, string> }
  >;
  expect: Expect;
  /** Негативная команда: план не должен ничего изменить (запрещённое). */
  negative?: boolean;
  /**
   * Ожидаемое «натисніть самі» по правилу §5-бис.5 (последний шаг плана —
   * `manual`/`never`, цель не нажата): `unmarked` — только без разметки
   * («Купити» снимает лишь `data-assist-id="add-to-cart"`), `always` — и с
   * ней (цель шага «после перехода» неизвестна при построении плана —
   * риск не понижается). Состояние стенда тогда — `manualExpect`.
   */
  manual?: 'unmarked' | 'always';
  manualExpect?: Expect;
}

const nav = (
  stand: Stand,
  id: string,
  start: string,
  page: string,
  label: string,
  t: Record<Lang, string>
): T1Command => ({
  id,
  stand,
  start,
  text: t,
  plan: [{ kind: 'click', find: { assistId: `nav-${page}`, text: label } }],
  expect: { path: `/${page}$` },
});

/** React и Vue — одна структура SPA (каталог, доставка, контакти, кошик). */
function spa(stand: 'react' | 'vue'): T1Command[] {
  const p = stand === 'react' ? 'r' : 'v';
  const base = `/vc/${stand}`;
  return [
    nav(stand, `${stand}-01`, `${base}/catalog`, 'delivery', 'Доставка', {
      uk: 'відкрий доставку',
      ru: 'открой доставку',
      en: 'open delivery',
    }),
    nav(stand, `${stand}-02`, `${base}/catalog`, 'contacts', 'Контакти', {
      uk: 'відкрий контакти',
      ru: 'открой контакты',
      en: 'open contacts',
    }),
    {
      ...nav(stand, `${stand}-03`, `${base}/catalog`, 'cart', 'Кошик (0)', {
        uk: 'відкрий кошик',
        ru: 'открой корзину',
        en: 'open cart',
      }),
    },
    nav(stand, `${stand}-04`, `${base}/delivery`, 'catalog', 'Каталог', {
      uk: 'відкрий каталог',
      ru: 'открой каталог',
      en: 'open catalog',
    }),
    {
      id: `${stand}-05`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'знайди футболку',
        ru: 'найди футболку',
        en: 'find футболку',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'search', text: 'Пошук товарів' },
          value: 'футболку',
        },
      ],
      expect: { value: [`#${p}-q`, 'футболку'] },
    },
    {
      id: `${stand}-06`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'вибери розмір M',
        ru: 'выбери размер M',
        en: 'select size M',
      },
      plan: [
        {
          kind: 'select',
          find: { assistId: 'size', text: 'Розмір' },
          value: 'M',
        },
      ],
      expect: { value: [`#${p}-size`, 'M'] },
    },
    {
      id: `${stand}-07`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'постав лише в наявності',
        ru: 'поставь только в наличии',
        en: 'check in stock only',
      },
      plan: [
        {
          kind: 'check',
          find: { assistId: 'in-stock', text: 'Лише в наявності' },
        },
      ],
      expect: { checked: `#${p}-stock` },
    },
    {
      id: `${stand}-08`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'додай синю футболку в кошик',
        ru: 'добавь синюю футболку в корзину',
        en: 'add the blue t-shirt to cart',
      },
      plan: [
        {
          kind: 'click',
          find: {
            assistId: 'add-to-cart',
            text: 'Додати в кошик: Синя футболка',
          },
        },
      ],
      expect: { cart: 1 },
    },
    {
      id: `${stand}-09`,
      stand,
      start: `${base}/delivery`,
      text: {
        uk: 'вибери нова пошта',
        ru: 'выбери новая почта',
        en: 'choose нова пошта',
      },
      plan: [{ kind: 'click', find: { text: 'Нова Пошта', role: 'tab' } }],
      expect: { text: [`#${p}-tab`, 'Нова Пошта — обрано'] },
    },
    {
      id: `${stand}-10`,
      stand,
      start: `${base}/delivery`,
      text: {
        uk: 'вибери укрпошту',
        ru: 'выбери укрпочту',
        en: 'choose укрпошта',
      },
      plan: [{ kind: 'click', find: { text: 'Укрпошта', role: 'tab' } }],
      expect: { text: [`#${p}-tab`, 'Укрпошта — обрано'] },
    },
    {
      id: `${stand}-11`,
      stand,
      start: `${base}/contacts`,
      text: {
        uk: "введи ім'я Олена",
        ru: 'введи имя Олена',
        en: 'enter name Olena',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'name', text: "Ім'я" },
          value: { uk: 'Олена', ru: 'Олена', en: 'Olena' },
        },
      ],
      expect: {
        value: [`#${p}-name`, { uk: 'Олена', ru: 'Олена', en: 'Olena' }],
      },
    },
    {
      id: `${stand}-12`,
      stand,
      start: `${base}/contacts`,
      text: {
        uk: 'введи повідомлення потрібна консультація',
        ru: 'введи сообщение нужна консультация',
        en: 'type message need advice',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'message', text: 'Повідомлення' },
          value: {
            uk: 'потрібна консультація',
            ru: 'нужна консультация',
            en: 'need advice',
          },
        },
      ],
      expect: {
        value: [
          `#${p}-msg`,
          {
            uk: 'потрібна консультація',
            ru: 'нужна консультация',
            en: 'need advice',
          },
        ],
      },
    },
    {
      id: `${stand}-13`,
      stand,
      start: `${base}/contacts`,
      text: {
        uk: 'надішли заявку',
        ru: 'отправь заявку',
        en: 'send the request',
      },
      plan: [
        {
          kind: 'click',
          find: { assistId: 'send-request', text: 'Надіслати заявку' },
        },
      ],
      expect: { submits: 1 },
    },
    {
      id: `${stand}-14`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'відкрий доставку і вибери нова пошта',
        ru: 'открой доставку и выбери новая почта',
        en: 'open delivery and choose нова пошта',
      },
      plan: [
        { kind: 'click', find: { assistId: 'nav-delivery', text: 'Доставка' } },
        { kind: 'click', after: { text: 'Нова Пошта', role: 'tab' } },
      ],
      expect: {
        path: '/delivery$',
        text: [`#${p}-tab`, 'Нова Пошта — обрано'],
      },
    },
    {
      id: `${stand}-15`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'знайди синю і додай у кошик',
        ru: 'найди синюю и добавь в корзину',
        en: 'find синя and add to cart',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'search', text: 'Пошук товарів' },
          value: { uk: 'синю', ru: 'синюю', en: 'синя' },
        },
        {
          kind: 'click',
          find: {
            assistId: 'add-to-cart',
            text: 'Додати в кошик: Синя футболка',
          },
        },
      ],
      expect: { cart: 1 },
    },
    nav(stand, `${stand}-16`, `${base}/contacts`, 'delivery', 'Доставка', {
      uk: 'перейди на доставку',
      ru: 'перейди на доставку',
      en: 'go to delivery',
    }),
    nav(stand, `${stand}-17`, `${base}/delivery`, 'contacts', 'Контакти', {
      uk: 'перейди в контакти',
      ru: 'перейди в контакты',
      en: 'go to contacts',
    }),
    {
      id: `${stand}-18`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'вибери розмір L',
        ru: 'выбери размер L',
        en: 'select size L',
      },
      plan: [
        {
          kind: 'select',
          find: { assistId: 'size', text: 'Розмір' },
          value: 'L',
        },
      ],
      expect: { value: [`#${p}-size`, 'L'] },
    },
    {
      id: `${stand}-19`,
      stand,
      start: `${base}/catalog`,
      text: { uk: 'покажи пошук', ru: 'покажи поиск', en: 'show search' },
      plan: [
        {
          kind: 'highlight',
          find: { assistId: 'search', text: 'Пошук товарів' },
        },
      ],
      expect: { value: [`#${p}-q`, ''] },
    },
    {
      id: `${stand}-20`,
      stand,
      start: `${base}/catalog`,
      text: {
        uk: 'оплати замовлення',
        ru: 'оплати заказ',
        en: 'pay for the order',
      },
      plan: [{ kind: 'click', find: { text: 'Оплатити' } }],
      expect: { cart: 0 },
      negative: true,
    },
  ];
}

function jquery(): T1Command[] {
  const s = 'jquery';
  const base = '/vc/jquery';
  const L = {
    uk: 'Застосувати фільтр',
    ru: 'Застосувати фільтр',
    en: 'Застосувати фільтр',
  };
  void L;
  const filter = (
    id: string,
    size: string,
    t: Record<Lang, string>
  ): T1Command => ({
    id,
    stand: s,
    start: `${base}/catalog`,
    text: t,
    plan: [
      {
        kind: 'select',
        find: { assistId: 'size', text: 'Розмір' },
        value: size,
      },
      {
        kind: 'click',
        find: { assistId: 'apply-filter', text: 'Застосувати фільтр' },
      },
    ],
    expect: { path: '/catalog$', search: `size=${size}` },
  });
  return [
    nav(s, 'jquery-01', `${base}/catalog`, 'delivery', 'Доставка', {
      uk: 'відкрий доставку',
      ru: 'открой доставку',
      en: 'open delivery',
    }),
    nav(s, 'jquery-02', `${base}/delivery`, 'catalog', 'Каталог', {
      uk: 'відкрий каталог',
      ru: 'открой каталог',
      en: 'open catalog',
    }),
    nav(s, 'jquery-03', `${base}/catalog`, 'cart', 'Кошик (0)', {
      uk: 'відкрий кошик',
      ru: 'открой корзину',
      en: 'open cart',
    }),
    nav(s, 'jquery-04', `${base}/delivery`, 'cart', 'Кошик (0)', {
      uk: 'перейди в кошик',
      ru: 'перейди в корзину',
      en: 'go to cart',
    }),
    nav(s, 'jquery-05', `${base}/cart`, 'catalog', 'Каталог', {
      uk: 'перейди в каталог',
      ru: 'перейди в каталог',
      en: 'go to catalog',
    }),
    nav(s, 'jquery-06', `${base}/cart`, 'delivery', 'Доставка', {
      uk: 'перейди на доставку',
      ru: 'перейди на доставку',
      en: 'go to delivery',
    }),
    {
      id: 'jquery-07',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'вибери розмір M',
        ru: 'выбери размер M',
        en: 'select size M',
      },
      plan: [
        {
          kind: 'select',
          find: { assistId: 'size', text: 'Розмір' },
          value: 'M',
        },
      ],
      expect: { value: ['#j-size', 'M'], text: ['.nice-box', 'M'] },
    },
    {
      id: 'jquery-08',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'вибери розмір S',
        ru: 'выбери размер S',
        en: 'select size S',
      },
      plan: [
        {
          kind: 'select',
          find: { assistId: 'size', text: 'Розмір' },
          value: 'S',
        },
      ],
      expect: { value: ['#j-size', 'S'], text: ['.nice-box', 'S'] },
    },
    {
      id: 'jquery-09',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'вибери розмір L',
        ru: 'выбери размер L',
        en: 'select size L',
      },
      plan: [
        {
          kind: 'select',
          find: { assistId: 'size', text: 'Розмір' },
          value: 'L',
        },
      ],
      expect: { value: ['#j-size', 'L'], text: ['.nice-box', 'L'] },
    },
    filter('jquery-10', 'M', {
      uk: 'вибери розмір M і застосуй фільтр',
      ru: 'выбери размер M и примени фильтр',
      en: 'select size M and apply filter',
    }),
    filter('jquery-11', 'L', {
      uk: 'вибери розмір L і застосуй фільтр',
      ru: 'выбери размер L и примени фильтр',
      en: 'select size L and apply filter',
    }),
    {
      id: 'jquery-12',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'додай синю футболку в кошик',
        ru: 'добавь синюю футболку в корзину',
        en: 'add the blue t-shirt to cart',
      },
      plan: [
        {
          kind: 'click',
          find: { assistId: 'add-to-cart', text: 'Купити синю футболку' },
        },
      ],
      expect: { path: '/cart$', cart: 1 },
      manual: 'unmarked',
      manualExpect: { path: '/catalog$', cart: 0 },
    },
    {
      id: 'jquery-13',
      stand: s,
      start: `${base}/catalog`,
      text: { uk: 'покажи фільтр', ru: 'покажи фильтр', en: 'show the filter' },
      plan: [
        {
          kind: 'highlight',
          find: { assistId: 'apply-filter', text: 'Застосувати фільтр' },
        },
      ],
      expect: { path: '/catalog$' },
    },
    {
      id: 'jquery-14',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'відкрий доставку і покажи каталог',
        ru: 'открой доставку и покажи каталог',
        en: 'open delivery and show catalog',
      },
      plan: [
        { kind: 'click', find: { assistId: 'nav-delivery', text: 'Доставка' } },
        { kind: 'highlight', after: { text: 'Каталог', role: 'link' } },
      ],
      expect: { path: '/delivery$' },
    },
    nav(s, 'jquery-15', `${base}/delivery`, 'delivery', 'Доставка', {
      uk: 'відкрий доставку ще раз',
      ru: 'открой доставку снова',
      en: 'open delivery again',
    }),
    {
      id: 'jquery-16',
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'прокрути до кошика',
        ru: 'прокрути к корзине',
        en: 'scroll to cart',
      },
      plan: [
        { kind: 'scroll', find: { assistId: 'nav-cart', text: 'Кошик (0)' } },
      ],
      expect: { path: '/catalog$' },
    },
    filter('jquery-17', 'S', {
      uk: 'вибери розмір S і застосуй фільтр',
      ru: 'выбери размер S и примени фильтр',
      en: 'select size S and apply filter',
    }),
    nav(s, 'jquery-18', `${base}/catalog`, 'catalog', 'Каталог', {
      uk: 'відкрий каталог знову',
      ru: 'открой каталог снова',
      en: 'open catalog again',
    }),
    {
      id: 'jquery-19',
      stand: s,
      start: `${base}/cart`,
      text: {
        uk: 'покажи доставку',
        ru: 'покажи доставку',
        en: 'show delivery',
      },
      plan: [
        {
          kind: 'highlight',
          find: { assistId: 'nav-delivery', text: 'Доставка' },
        },
      ],
      expect: { path: '/cart$' },
    },
    {
      id: 'jquery-20',
      stand: s,
      start: `${base}/catalog`,
      text: { uk: 'видали кошик', ru: 'удали корзину', en: 'delete the cart' },
      plan: [{ kind: 'click', find: { text: 'Видалити все' } }],
      expect: { cart: 0 },
      negative: true,
    },
  ];
}

function mpa(): T1Command[] {
  const s = 'mpa';
  const base = '/vc/mpa';
  const label: Record<string, string> = {
    home: 'Головна',
    catalog: 'Каталог',
    delivery: 'Доставка',
    contacts: 'Контакти',
    cart: 'Кошик',
  };
  const pages = ['home', 'catalog', 'delivery', 'contacts', 'cart'];
  const words: Record<string, Record<Lang, string>> = {
    home: { uk: 'головну', ru: 'главную', en: 'home' },
    catalog: { uk: 'каталог', ru: 'каталог', en: 'catalog' },
    delivery: { uk: 'доставку', ru: 'доставку', en: 'delivery' },
    contacts: { uk: 'контакти', ru: 'контакты', en: 'contacts' },
    cart: { uk: 'кошик', ru: 'корзину', en: 'cart' },
  };
  const out: T1Command[] = [];
  let n = 1;
  // 10 переходов между страницами (из двух стартов).
  for (const start of ['home', 'cart'])
    for (const to of pages) {
      if (to === start) continue;
      if (out.length >= 8) break;
      const w = words[to];
      out.push(
        nav(
          s,
          `mpa-${String(n++).padStart(2, '0')}`,
          `${base}/${start}`,
          to,
          label[to],
          {
            uk: `відкрий ${w.uk}`,
            ru: `открой ${w.ru}`,
            en: `open ${w.en}`,
          }
        )
      );
    }
  out.push(
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'знайди футболку',
        ru: 'найди футболку',
        en: 'find футболку',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'search', text: 'Пошук' },
          value: 'футболку',
        },
      ],
      expect: { value: ['#m-q', 'футболку'] },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'знайди футболку і натисни знайти',
        ru: 'найди футболку и нажми найти',
        en: 'find футболку and press знайти',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'search', text: 'Пошук' },
          value: 'футболку',
        },
        { kind: 'click', find: { assistId: 'apply-filter', text: 'Знайти' } },
      ],
      expect: { path: '/catalog$' },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/catalog`,
      text: { uk: 'додай у кошик', ru: 'добавь в корзину', en: 'add to cart' },
      plan: [
        { kind: 'click', find: { assistId: 'add-to-cart', text: 'Купити' } },
      ],
      expect: { path: '/cart$', cart: 1 },
      manual: 'unmarked',
      manualExpect: { path: '/catalog$', cart: 0 },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/contacts`,
      text: {
        uk: "введи ім'я Олена",
        ru: 'введи имя Олена',
        en: 'enter name Olena',
      },
      plan: [
        {
          kind: 'fill',
          find: { assistId: 'name', text: "Ім'я" },
          value: { uk: 'Олена', ru: 'Олена', en: 'Olena' },
        },
      ],
      expect: {
        value: ['#m-name', { uk: 'Олена', ru: 'Олена', en: 'Olena' }],
      },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/contacts`,
      text: {
        uk: 'надішли заявку',
        ru: 'отправь заявку',
        en: 'send the request',
      },
      plan: [
        {
          kind: 'click',
          find: { assistId: 'send-request', text: 'Надіслати заявку' },
        },
      ],
      expect: { path: '/home$', submits: 1 },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/home`,
      text: {
        uk: 'відкрий каталог і додай у кошик',
        ru: 'открой каталог и добавь в корзину',
        en: 'open catalog and add to cart',
      },
      plan: [
        { kind: 'click', find: { assistId: 'nav-catalog', text: 'Каталог' } },
        { kind: 'click', after: { text: 'Купити', role: 'button' } },
      ],
      expect: { path: '/cart$', cart: 1 },
      manual: 'always',
      manualExpect: { path: '/catalog$', cart: 0 },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/home`,
      text: {
        uk: "відкрий контакти і введи ім'я Олена",
        ru: 'открой контакты и введи имя Олена',
        en: 'open contacts and enter name Olena',
      },
      plan: [
        { kind: 'click', find: { assistId: 'nav-contacts', text: 'Контакти' } },
        {
          kind: 'fill',
          after: { text: "Ім'я", role: 'textbox' },
          value: { uk: 'Олена', ru: 'Олена', en: 'Olena' },
        },
      ],
      expect: {
        path: '/contacts$',
        value: ['#m-name', { uk: 'Олена', ru: 'Олена', en: 'Olena' }],
      },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/catalog`,
      text: { uk: 'покажи пошук', ru: 'покажи поиск', en: 'show search' },
      plan: [
        { kind: 'highlight', find: { assistId: 'search', text: 'Пошук' } },
      ],
      expect: { path: '/catalog$' },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/home`,
      text: {
        uk: 'прокрути до контактів',
        ru: 'прокрути к контактам',
        en: 'scroll to contacts',
      },
      plan: [
        {
          kind: 'scroll',
          find: { assistId: 'nav-contacts', text: 'Контакти' },
        },
      ],
      expect: { path: '/home$' },
    },
    {
      id: `mpa-${String(n++).padStart(2, '0')}`,
      stand: s,
      start: `${base}/catalog`,
      text: {
        uk: 'оплати замовлення',
        ru: 'оплати заказ',
        en: 'pay for the order',
      },
      plan: [{ kind: 'click', find: { text: 'Оплатити' } }],
      expect: { cart: 0 },
      negative: true,
    }
  );
  while (out.length < 20) {
    const k = out.length;
    out.push({ ...out[k % 8], id: `mpa-${String(n++).padStart(2, '0')}` });
  }
  return out;
}

export const T1_COMMANDS: T1Command[] = [
  ...spa('react'),
  ...spa('vue'),
  ...jquery(),
  ...mpa(),
];

/** «Ответ модели» команды на языке — для подделки модели стенда. */
export function modelFor(c: T1Command, lang: Lang): ModelStep[] {
  return c.plan.map((s) => ({
    ...s,
    value:
      s.value === undefined
        ? undefined
        : typeof s.value === 'string'
          ? s.value
          : s.value[lang],
  }));
}

/** Нормализация текста команды — как ключ подделки модели (normText сервера). */
export function key(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/u, '');
}

/**
 * Набор уровня «транскрипт» для каждого PR (§5-бис.12: 30 команд): с
 * каждого стенда — переходы, поиск/фильтр, заполнение, отправка с
 * подтверждением, шаг после перехода и негативная; языки по кругу uk/ru/en,
 * размеченные и неразмеченные. Полный — `T1_FULL=1` (240 × разметка).
 */
export function prSubset(): Array<{
  c: T1Command;
  lang: Lang;
  marked: boolean;
}> {
  const pick: Record<Stand, number[]> = {
    react: [0, 4, 5, 7, 10, 12, 13, 19],
    vue: [1, 4, 6, 8, 11, 13, 14, 19],
    jquery: [0, 6, 9, 11, 13, 19],
    mpa: [0, 8, 10, 12, 14, 15, 19],
  };
  const langs: Lang[] = ['uk', 'ru', 'en'];
  const out: Array<{ c: T1Command; lang: Lang; marked: boolean }> = [];
  let k = 0;
  for (const stand of ['react', 'vue', 'jquery', 'mpa'] as const) {
    const list = T1_COMMANDS.filter((c) => c.stand === stand);
    for (const i of pick[stand]) {
      out.push({ c: list[i], lang: langs[k % 3], marked: k % 3 !== 2 });
      k++;
    }
  }
  out.push({
    c: T1_COMMANDS.find((c) => c.id === 'jquery-12')!,
    lang: 'uk',
    marked: true,
  });
  return out.slice(0, 30);
}
