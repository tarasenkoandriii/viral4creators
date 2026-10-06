/**
 * Каталог элементов демо-витрины `/qa/demo-shop` (лендинг) — КОНТРАКТ между
 * сценарным путём раннера (валидация селекторов демо-семейства
 * `site-tutorial-demo-*`) и страницей витрины. Решение владельца 06.10.2026:
 * демо обучающего лендинга снимается на нашей витрине (путь А), сценарии
 * С3 «Условия доставки», С2 «Оформить заказ», С4 «Запись на консультацию»
 * (`doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`).
 *
 * Шов «каталог = страница»: `landing/scripts/demo-shop.test.ts` читает этот
 * файл и проверяет, что каждый id есть на странице витрины ровно одним
 * `data-qa`, а на странице нет `data-qa` вне каталога. Меняется каталог —
 * меняется и страница, иначе CI красный.
 */
export const DEMO_SHOP_HOOKS = [
  'demo-shop-root',
  // С3 — условия доставки
  'demo-shop-nav-delivery',
  'demo-shop-delivery-courier',
  'demo-shop-delivery-pickup',
  'demo-shop-delivery-terms',
  // С2 — оформить заказ
  'demo-shop-product-mug-add',
  'demo-shop-nav-cart',
  'demo-shop-cart',
  'demo-shop-checkout-name',
  'demo-shop-checkout-phone',
  'demo-shop-checkout-pickup',
  'demo-shop-checkout-submit',
  'demo-shop-order-confirmed',
  // С4 — запись на консультацию
  'demo-shop-nav-booking',
  'demo-shop-booking-open',
  'demo-shop-booking-slot-mon-10',
  'demo-shop-booking-name',
  'demo-shop-booking-email',
  'demo-shop-booking-submit',
  'demo-shop-booking-confirmed',
] as const;

export type DemoShopHook = (typeof DEMO_SHOP_HOOKS)[number];

/** Маршруты полигона для `goto.route` демо-семейства (только `/qa/`). */
export const POLYGON_ROUTES = {
  'qa-demo-shop': '/qa/demo-shop',
} as const;

/** Префикс, под которым живут ВСЕ маршруты полигона. Замок второго
 *  уровня: даже если в таблицу выше однажды попадёт путь не под `/qa/`,
 *  резолвер его не откроет (`polygon-scenario.ts`). */
export const POLYGON_PATH_PREFIX = '/qa/';

export type PolygonRouteName = keyof typeof POLYGON_ROUTES;

/** Элемент витрины из каталога — точным совпадением, не префиксом. */
export function isDemoShopHook(id: string): id is DemoShopHook {
  return (DEMO_SHOP_HOOKS as readonly string[]).includes(id);
}

/**
 * Витрина ожила (гидратация React прошла): до этого кнопки уже видны в
 * серверной разметке, но клик по ним ничего не делает. Страница ставит
 * `data-demo-ready="true"` на корень сама, без таймера; раннер ждёт его
 * после каждого `goto` на полигон (`polygon-scenario.ts`), а не случайную
 * паузу.
 */
export const DEMO_SHOP_READY_SELECTOR =
  '[data-qa="demo-shop-root"][data-demo-ready="true"]';
