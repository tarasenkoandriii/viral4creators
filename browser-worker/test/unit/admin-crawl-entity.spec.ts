/**
 * ПД в «знаниях об интерфейсе» «Админки» (Ш3-хвост (17)): карточка
 * сущности — только структура; прочие страницы — «Имя Фамилия» и имя после
 * приветствия. Строки — в том виде, в каком их отдаёт `collectInterface`
 * для разметки WooCommerce и Хорошоп-подобной админки (сама разметка —
 * в e2e на настоящем Chromium).
 */
import {
  NAME_MASK,
  entityRouteKey,
  isEntityPage,
  maskNames,
  sanitizeAdminPage,
} from '../../src/jobs/admin-crawl-entity';

const N = NAME_MASK;

describe('карточка сущности: распознавание', () => {
  it.each([
    ['https://a.test/admin/orders/1024', 'a.test/admin/orders/:id'],
    ['https://a.test/adminka/orders/1024/', 'a.test/adminka/orders/:id/'],
    [
      'https://a.test/admin/customers/77/edit',
      'a.test/admin/customers/:id/edit',
    ],
    [
      'https://a.test/crm/clients/3f2a9c1e-7b4d-4e8a-9f00-1a2b3c4d5e6f',
      'a.test/crm/clients/:id',
    ],
    ['https://a.test/admin/orders/ORD-10023', 'a.test/admin/orders/:id'],
    [
      'https://a.test/wp-admin/post.php?post=1024&action=edit',
      'a.test/wp-admin/post.php?action=edit&post=:id',
    ],
    [
      'https://a.test/wp-admin/admin.php?page=wc-orders&action=edit&id=1024',
      'a.test/wp-admin/admin.php?action=edit&id=:id&page=wc-orders',
    ],
    [
      'https://a.test/wp-admin/user-edit.php?user_id=5',
      'a.test/wp-admin/user-edit.php?user_id=:id',
    ],
    [
      'https://a.test/index.php?route=sale/order.info&order_id=17',
      'a.test/index.php?order_id=:id&route=sale/order.info',
    ],
  ])('%s → %s', (url, key) => {
    expect(entityRouteKey(url)).toBe(key);
  });

  it.each([
    'https://a.test/admin/orders',
    'https://a.test/admin/orders/page/2',
    'https://a.test/admin/orders?page=3',
    'https://a.test/wp-admin/edit.php?post_type=shop_order&paged=2',
    'https://a.test/admin/settings/general',
    'https://a.test/wp-admin/admin.php?page=wc-settings&tab=shipping',
  ])('не карточка: %s', (url) => {
    expect(entityRouteKey(url)).toBeNull();
  });

  it('два заказа — один вид; заказ и покупатель — разные виды', () => {
    expect(entityRouteKey('https://a.test/admin/orders/1024')).toBe(
      entityRouteKey('https://a.test/admin/orders/1025'),
    );
    expect(entityRouteKey('https://a.test/admin/orders/1024')).not.toBe(
      entityRouteKey('https://a.test/admin/customers/77'),
    );
  });

  it('по структуре: номер записи в заголовке, адрес без id', () => {
    expect(
      isEntityPage(
        'https://a.test/admin/order-view',
        'Замовлення',
        '# Замовлення №1024',
      ),
    ).toBe(true);
    expect(
      isEntityPage('https://a.test/x', 'Order #1024 details ‹ Shop', ''),
    ).toBe(true);
    expect(
      isEntityPage(
        'https://a.test/admin/orders',
        'Замовлення',
        '# Замовлення\nколонка: №',
      ),
    ).toBe(false);
  });
});

describe('маска имён', () => {
  it('строго (карточка): имена, инициалы, числа, кавычки; структура остаётся', () => {
    expect(maskNames('Замовлення №1024 — Іван Петренко', true)).toBe(
      `Замовлення №[№] — ${N}`,
    );
    expect(maskNames('Отримувач: Петренко І. В.', true)).toBe(
      `Отримувач: ${N}`,
    );
    expect(maskNames('Покупець', true)).toBe('Покупець');
    expect(maskNames('Order #1024 details', true)).toBe('Order #[№] details');
    expect(maskNames('Billing Address', true)).toBe('Billing Address');
    expect(maskNames('Коментар «Передзвоніть після шостої»', true)).toBe(
      'Коментар «[значення]»',
    );
    expect(maskNames('Нова Пошта: Київ, відділення №12', true)).toBe(
      `Нова Пошта: ${N}, відділення №[№]`,
    );
    // Одно слово-имя в начале заголовка блока («Іван»).
    expect(maskNames('Іван', true)).toBe(N);
    // Фамилия, похожая на слово словаря (Новак ≠ «нова»).
    expect(maskNames('Новак', true)).toBe(N);
    // ДЛИННЫЕ ЗАГЛАВНЫЕ — имя; короткие аббревиатуры — нет.
    expect(maskNames('ПЕТРЕНКО ТТН SKU', true)).toBe(`${N} ТТН SKU`);
  });

  it('мягко (не карточка): только «Имя Фамилия» и приветствие', () => {
    expect(maskNames('Останній коментар від Марія Коваленко', false)).toBe(
      `Останній коментар від ${N}`,
    );
    expect(maskNames('Howdy, olena.melnyk', false)).toBe(`Howdy, ${N}`);
    expect(maskNames('Привіт, Андрій!', false)).toBe(`Привіт, ${N}!`);
    expect(maskNames('Welcome to WordPress', false)).toBe(
      'Welcome to WordPress',
    );
    // Одиночное слово с заглавной на обычной странице — структура.
    expect(maskNames('Налаштування WooCommerce', false)).toBe(
      'Налаштування WooCommerce',
    );
    expect(maskNames('Shipping Zones', false)).toBe('Shipping Zones');
    expect(maskNames('Google Analytics', false)).toBe('Google Analytics');
    expect(maskNames('Замовлення 1024', false)).toBe('Замовлення 1024');
  });
});

/** Хорошоп-подобная карточка заказа: строки `collectInterface`. */
const HOROSHOP_ORDER = [
  '# Замовлення №1024 — Іван Петренко',
  '# Статус замовлення',
  '# Покупець',
  '# Іван Петренко',
  '# Доставка',
  '# Нова Пошта: Київ, відділення №12',
  '# Товари',
  'меню: Замовлення',
  'меню: Каталог',
  'меню: Покупці',
  'меню: Головна',
  'меню: №1024 Іван Петренко',
  'колонка: Назва',
  'колонка: Кількість',
  'колонка: Ціна',
  'поле: Статус',
  'поле: Отримувач',
  'поле: Номер ТТН',
  'кнопка: Менеджер: Тарас Шевчук',
  'кнопка: Зберегти',
  'кнопка: Ще дії',
].join('\n');

/** WooCommerce: редактирование заказа. */
const WOO_ORDER = [
  '# Edit order',
  '# Order #1024 details',
  '# General',
  '# Billing Edit',
  '# Shipping Edit',
  '# Items',
  '# Order notes',
  '# Order actions',
  'меню: Howdy, Олена Мельник',
  'меню: Orders',
  'меню: Settings',
  'колонка: Item',
  'колонка: Cost',
  'колонка: Qty',
  'колонка: Total',
  'поле: Date created:',
  'поле: Status:',
  'поле: Customer: View other orders → Profile →',
  'поле: Add note',
  'кнопка: Add item(s)',
  'кнопка: Refund',
  'кнопка: Add',
  'кнопка: Update',
].join('\n');

describe('страница целиком', () => {
  it('Хорошоп: карточка заказа — структура без имён покупателя и менеджера', () => {
    const r = sanitizeAdminPage(
      'https://a.test/adminka/orders/1024/',
      'Замовлення №1024 — Іван Петренко | Хорошоп',
      HOROSHOP_ORDER,
    );
    expect(r.entity).toBe(true);
    const all = `${r.title}\n${r.text}`;
    expect(all).not.toMatch(/Іван|Петренко|Тарас|Шевчук|Київ|1024/);
    expect(r.title).toBe(`Замовлення №[№] — ${N} | Хорошоп`);
    for (const line of [
      '# Статус замовлення',
      '# Покупець',
      '# Доставка',
      '# Товари',
      'колонка: Кількість',
      'поле: Отримувач',
      'поле: Номер ТТН',
      'кнопка: Зберегти',
      `кнопка: Менеджер: ${N}`,
      `# ${N}`,
      'меню: Покупці',
    ])
      expect(r.text.split('\n')).toContain(line);
  });

  it('WooCommerce: карточка заказа по post.php — структура цела, приветствие маскировано', () => {
    const r = sanitizeAdminPage(
      'https://a.test/wp-admin/post.php?post=1024&action=edit',
      'Edit order ‹ Срібна крамниця — WordPress',
      WOO_ORDER,
    );
    expect(r.entity).toBe(true);
    expect(r.text).not.toMatch(/Олена|Мельник|1024/);
    for (const line of [
      '# Edit order',
      '# Order #[№] details',
      '# Billing Edit',
      '# Order notes',
      'поле: Date created:',
      'поле: Customer: View other orders → Profile →',
      'кнопка: Refund',
      `меню: Howdy, ${N}`,
    ])
      expect(r.text.split('\n')).toContain(line);
  });

  it('обычная страница: структура и бренды целы, «Имя Фамилия» — маска, повторы убраны', () => {
    const r = sanitizeAdminPage(
      'https://a.test/adminka/orders/',
      'Замовлення | Хорошоп',
      [
        '# Замовлення',
        '# Останній коментар від Марія Коваленко',
        '# Останній коментар від Олег Бойко',
        'меню: Howdy, Олена Мельник',
        'колонка: Клієнт',
        'кнопка: Фільтр',
      ].join('\n'),
    );
    expect(r.entity).toBe(false);
    expect(r.text).not.toMatch(/Марія|Коваленко|Олег|Бойко|Олена|Мельник/);
    expect(r.text.split('\n')).toEqual([
      '# Замовлення',
      `# Останній коментар від ${N}`,
      `меню: Howdy, ${N}`,
      'колонка: Клієнт',
      'кнопка: Фільтр',
    ]);
    expect(r.title).toBe('Замовлення | Хорошоп');
  });
});
