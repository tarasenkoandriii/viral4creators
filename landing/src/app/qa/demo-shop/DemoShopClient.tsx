"use client";

import { useEffect, useState } from "react";
import {
  DEMO_SHOP_COPY,
  DEMO_SHOP_DELIVERY_FEE,
  DEMO_SHOP_ORDER_NUMBER,
  DEMO_SHOP_PRODUCTS,
  DEMO_SHOP_SLOTS,
  fill,
  type DemoShopLang,
  type DemoShopProductId,
} from "./demo-shop-copy";
import { DEMO_SHOP_CSS } from "./demo-shop-styles";

/**
 * Клиентская часть демо-витрины — см. доккомментарий `page.tsx`.
 *
 * Одна страница, разделы переключаются состоянием (`view`), без
 * переходов по URL, сети, таймеров и анимаций: каждый клик раннера —
 * мгновенный новый кадр.
 *
 * `data-qa` здесь — РОВНО каталог-контракт
 * `backend/src/modules/tutorial-runner/polygon-catalog.ts`
 * (`DEMO_SHOP_HOOKS`): каждый id записан литералом ровно один раз, иных
 * `data-qa` нет (шов — `landing/scripts/demo-shop.test.ts`). Поэтому
 * элементы с хуком, у которых есть «соседи» без хука (кружка среди
 * товаров, слот «Пн, 10:00» среди слотов, «Самовивіз» рядом с
 * «Доставкою»), написаны отдельной веткой, а не через `map` с
 * вычисленным атрибутом. Вспомогательные пометки — `data-demo-*`.
 *
 * Раздел консультации — один и тот же блок: на главной он стоит под
 * каталогом (С4 черновика начинается с «Записатися» сразу после `goto`),
 * а по «Консультація» в шапке показывается один. В DOM он всегда в
 * одном экземпляре.
 */

type View = "catalog" | "cart" | "delivery" | "booking";
type Method = "pickup" | "delivery";
type DeliveryTab = "courier" | "pickup";

/**
 * Контуры иконок товаров — строками путей, а не JSX: JSX на уровне модуля
 * вычислялся бы при импорте, раньше, чем тест (`renderToStaticMarkup`)
 * успевает выставить глобальный `React`.
 */
const ICON_PATHS: Record<DemoShopProductId, string[]> = {
  mug: [
    "M14 10h26v24a6 6 0 0 1-6 6H20a6 6 0 0 1-6-6z",
    "M40 15h4a5 5 0 0 1 0 10h-4",
    "M22 30l5-9 5 9z",
  ],
  notebook: [
    "M17 6h22a3 3 0 0 1 3 3v30a3 3 0 0 1-3 3H17a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3z",
    "M21 6v36M26 16h11M26 22h11M26 28h11M26 34h7",
  ],
  tote: [
    "M10 18h36l-4 24H14z",
    "M20 18v-4a8 8 0 0 1 16 0v4",
    "M28 25l6 6-6 6-6-6z",
  ],
  postcards: [
    "M10 14h24a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V16a2 2 0 0 1 2-2z",
    "M20 10h26v20",
    "M14 30l6-9 6 9z",
  ],
};

function ProductIcon({ id }: { id: DemoShopProductId }) {
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {ICON_PATHS[id].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <path
        d="M14 2l10.4 6v12L14 26 3.6 20V8z"
        fill="currentColor"
        opacity="0.18"
      />
      <path
        d="M14 2l10.4 6v12L14 26 3.6 20V8zM14 2v24M3.6 8L24.4 20M24.4 8L3.6 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function DemoShopClient({ lang }: { lang: DemoShopLang }) {
  const t = DEMO_SHOP_COPY[lang];
  const money = (amount: number) => fill(t.price, { amount });

  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("catalog");
  const [cart, setCart] = useState<Partial<Record<DemoShopProductId, number>>>(
    {},
  );
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<Method | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [order, setOrder] = useState<{ method: Method; total: number } | null>(
    null,
  );
  const [deliveryTab, setDeliveryTab] = useState<DeliveryTab>("pickup");
  const [bookingOpen, setBookingOpen] = useState(false);
  const [slot, setSlot] = useState<string | null>(null);
  const [bookingName, setBookingName] = useState("");
  const [bookingEmail, setBookingEmail] = useState("");
  const [bookingError, setBookingError] = useState(false);
  const [booked, setBooked] = useState(false);

  // Пометка «гидратация прошла» — без таймера: раннер и проверки ждут
  // её, а не случайную паузу, прежде чем кликать.
  useEffect(() => setReady(true), []);

  const lines = DEMO_SHOP_PRODUCTS.filter((p) => (cart[p.id] ?? 0) > 0);
  const count = lines.reduce((sum, p) => sum + (cart[p.id] ?? 0), 0);
  const subtotal = lines.reduce(
    (sum, p) => sum + p.price * (cart[p.id] ?? 0),
    0,
  );

  function go(next: View) {
    setView(next);
    // Мгновенно, а не плавно: `globals.css` лендинга включает
    // `scroll-behavior: smooth`, и прокрутка стала бы анимацией в кадре.
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }

  function add(id: DemoShopProductId) {
    setCart((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
    setOrder(null);
  }

  function remove(id: DemoShopProductId) {
    setCart((prev) => ({ ...prev, [id]: 0 }));
  }

  function submitOrder() {
    if (!name.trim() || !phone.trim() || !method) {
      setCheckoutError(t.checkout.error);
      return;
    }
    if (method === "delivery" && !address.trim()) {
      setCheckoutError(t.checkout.errorAddress);
      return;
    }
    setCheckoutError(null);
    setOrder({
      method,
      total: subtotal + (method === "delivery" ? DEMO_SHOP_DELIVERY_FEE : 0),
    });
    setCart({});
    setName("");
    setPhone("");
    setAddress("");
    setMethod(null);
  }

  function submitBooking() {
    if (!slot || !bookingName.trim() || !bookingEmail.includes("@")) {
      setBookingError(true);
      return;
    }
    setBookingError(false);
    setBooked(true);
  }

  const slotLabel = (id: string) => {
    const s = DEMO_SHOP_SLOTS.find((x) => x.id === id);
    return s
      ? fill(t.booking.slot, { day: t.booking.days[s.day], time: s.time })
      : "";
  };

  const slotProps = (id: string) => ({
    type: "button" as const,
    className: "ds-option",
    "aria-pressed": slot === id,
    "data-demo-slot": id,
    onClick: () => {
      setSlot(id);
      setBookingError(false);
    },
  });

  const navProps = (target: View) => ({
    type: "button" as const,
    className: "ds-nav-btn",
    "aria-current": view === target ? ("page" as const) : undefined,
    onClick: () => go(target),
  });

  const booking = (
    <div className="ds-panel" data-demo-block="booking">
      <h2 className="ds-h2">{t.booking.title}</h2>
      <p className="ds-lead">{t.booking.lead}</p>
      {booked ? (
        <div
          className="ds-success"
          role="status"
          data-qa="demo-shop-booking-confirmed"
        >
          <p className="ds-success-title">{t.booking.confirmed}</p>
          <p>
            {fill(t.booking.details, {
              slot: slotLabel(slot ?? ""),
              name: bookingName.trim(),
            })}
          </p>
        </div>
      ) : (
        <>
          <button
            type="button"
            className="ds-btn"
            aria-expanded={bookingOpen}
            data-qa="demo-shop-booking-open"
            onClick={() => setBookingOpen(true)}
          >
            {t.booking.open}
          </button>
          {bookingOpen && (
            <div className="ds-step" data-demo-block="booking-form">
              <h3 className="ds-label" id="ds-slots-title">
                {t.booking.slotsTitle}
              </h3>
              <div
                className="ds-slots"
                role="group"
                aria-labelledby="ds-slots-title"
              >
                <button
                  data-qa="demo-shop-booking-slot-mon-10"
                  {...slotProps("mon-10")}
                >
                  <span className="ds-dot" aria-hidden="true" />
                  <span className="ds-option-text">{slotLabel("mon-10")}</span>
                </button>
                {DEMO_SHOP_SLOTS.filter((s) => s.id !== "mon-10").map((s) => (
                  <button key={s.id} {...slotProps(s.id)}>
                    <span className="ds-dot" aria-hidden="true" />
                    <span className="ds-option-text">{slotLabel(s.id)}</span>
                  </button>
                ))}
              </div>
              <p className="ds-muted">{t.booking.slotsNote}</p>
              {slot && (
                <form
                  className="ds-step"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitBooking();
                  }}
                >
                  <div className="ds-field">
                    <label className="ds-label" htmlFor="ds-booking-name">
                      {t.booking.name}
                    </label>
                    <input
                      id="ds-booking-name"
                      className="ds-input"
                      type="text"
                      autoComplete="off"
                      value={bookingName}
                      onChange={(e) => setBookingName(e.target.value)}
                      data-qa="demo-shop-booking-name"
                    />
                  </div>
                  <div className="ds-field">
                    <label className="ds-label" htmlFor="ds-booking-email">
                      {t.booking.email}
                    </label>
                    <input
                      id="ds-booking-email"
                      className="ds-input"
                      type="email"
                      autoComplete="off"
                      value={bookingEmail}
                      onChange={(e) => setBookingEmail(e.target.value)}
                      data-qa="demo-shop-booking-email"
                    />
                  </div>
                  {bookingError && (
                    <p className="ds-error" role="alert">
                      {t.booking.error}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="ds-btn ds-btn-block"
                    data-qa="demo-shop-booking-submit"
                  >
                    {t.booking.submit}
                  </button>
                </form>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  return (
    <div
      className="ds-root"
      lang={lang}
      data-qa="demo-shop-root"
      data-demo-view={view}
      data-demo-ready={ready ? "true" : "false"}
    >
      <style dangerouslySetInnerHTML={{ __html: DEMO_SHOP_CSS }} />
      <header className="ds-header">
        <div className="ds-header-inner">
          <button
            type="button"
            className="ds-brand"
            data-demo-nav="home"
            onClick={() => go("catalog")}
          >
            <Logo />
            <span>{t.brand}</span>
          </button>
          <button
            type="button"
            className="ds-cart-btn"
            aria-label={fill(t.nav.cartLabel, { count })}
            aria-current={view === "cart" ? "page" : undefined}
            data-qa="demo-shop-nav-cart"
            data-demo-cart-count={count}
            onClick={() => go("cart")}
          >
            <span>{t.nav.cart}</span>
            <span className="ds-badge" aria-hidden="true">
              {count}
            </span>
          </button>
          <nav className="ds-nav" aria-label={t.nav.label}>
            <button {...navProps("catalog")} data-demo-nav="catalog">
              {t.nav.catalog}
            </button>
            <button {...navProps("delivery")} data-qa="demo-shop-nav-delivery">
              {t.nav.delivery}
            </button>
            <button {...navProps("booking")} data-qa="demo-shop-nav-booking">
              {t.nav.booking}
            </button>
          </nav>
        </div>
      </header>

      <main className="ds-main">
        {view === "catalog" && (
          <>
            <p className="ds-notice">{t.notice}</p>
            <h1 className="ds-h1">{t.catalog.title}</h1>
            <div className="ds-grid">
              {DEMO_SHOP_PRODUCTS.map((p) => {
                const inCart = cart[p.id] ?? 0;
                const addProps = {
                  type: "button" as const,
                  className: "ds-btn ds-btn-block",
                  "data-demo-added": inCart > 0 ? "true" : "false",
                  onClick: () => add(p.id),
                };
                const label =
                  inCart > 0
                    ? fill(t.catalog.added, { count: inCart })
                    : t.catalog.add;
                return (
                  <div className="ds-card" key={p.id} data-demo-product={p.id}>
                    <div className="ds-thumb">
                      <ProductIcon id={p.id} />
                    </div>
                    <p className="ds-card-name">{t.products[p.id].name}</p>
                    <p className="ds-card-note">{t.products[p.id].note}</p>
                    <p className="ds-card-price">{money(p.price)}</p>
                    {p.id === "mug" ? (
                      <button data-qa="demo-shop-product-mug-add" {...addProps}>
                        {label}
                      </button>
                    ) : (
                      <button {...addProps}>{label}</button>
                    )}
                  </div>
                );
              })}
            </div>
            {booking}
          </>
        )}

        {view === "booking" && booking}

        {view === "delivery" && (
          <div className="ds-panel">
            <h1 className="ds-h1">{t.delivery.title}</h1>
            <p className="ds-lead">{t.delivery.lead}</p>
            <div
              className="ds-tabs"
              role="tablist"
              aria-label={t.delivery.tabsLabel}
            >
              <button
                type="button"
                role="tab"
                id="ds-tab-courier"
                className="ds-tab"
                aria-selected={deliveryTab === "courier"}
                aria-controls="ds-terms"
                data-demo-tab="courier"
                data-qa="demo-shop-delivery-courier"
                onClick={() => setDeliveryTab("courier")}
              >
                {t.delivery.courier}
              </button>
              <button
                type="button"
                role="tab"
                id="ds-tab-pickup"
                className="ds-tab"
                aria-selected={deliveryTab === "pickup"}
                aria-controls="ds-terms"
                data-demo-tab="pickup"
                data-qa="demo-shop-delivery-pickup"
                onClick={() => setDeliveryTab("pickup")}
              >
                {t.delivery.pickup}
              </button>
            </div>
            <div
              id="ds-terms"
              role="tabpanel"
              aria-labelledby={`ds-tab-${deliveryTab}`}
              data-demo-terms={deliveryTab}
              data-qa="demo-shop-delivery-terms"
            >
              <dl className="ds-terms">
                {deliveryTab === "courier" ? (
                  <>
                    <dt>{t.delivery.termLabel}</dt>
                    <dd>{t.delivery.courierTerm}</dd>
                    <dt>{t.delivery.priceLabel}</dt>
                    <dd>{t.delivery.courierPrice}</dd>
                    <dt>{t.delivery.paymentLabel}</dt>
                    <dd>{t.delivery.courierPayment}</dd>
                  </>
                ) : (
                  <>
                    <dt>{t.delivery.placeLabel}</dt>
                    <dd>{t.delivery.pickupPlace}</dd>
                    <dt>{t.delivery.termLabel}</dt>
                    <dd>{t.delivery.pickupTerm}</dd>
                    <dt>{t.delivery.priceLabel}</dt>
                    <dd>{t.delivery.pickupPrice}</dd>
                    <dt>{t.delivery.paymentLabel}</dt>
                    <dd>{t.delivery.pickupPayment}</dd>
                  </>
                )}
              </dl>
            </div>
          </div>
        )}

        {view === "cart" &&
          (order ? (
            <div
              className="ds-success"
              role="status"
              data-qa="demo-shop-order-confirmed"
            >
              <p className="ds-success-title">
                {fill(t.order.confirmed, { order: DEMO_SHOP_ORDER_NUMBER })}
              </p>
              <p>
                {fill(t.order.details, {
                  method:
                    order.method === "pickup"
                      ? t.checkout.pickup
                      : t.checkout.delivery,
                  total: money(order.total),
                })}
              </p>
              <p>{t.order.noPayment}</p>
              <button
                type="button"
                className="ds-btn ds-btn-secondary"
                onClick={() => {
                  setOrder(null);
                  go("catalog");
                }}
              >
                {t.order.toCatalog}
              </button>
            </div>
          ) : (
            <div className="ds-cart-layout" data-qa="demo-shop-cart">
              <div className="ds-panel">
                <h1 className="ds-h1">{t.cart.title}</h1>
                {lines.length === 0 ? (
                  <>
                    <p className="ds-lead">{t.cart.empty}</p>
                    <button
                      type="button"
                      className="ds-btn ds-btn-secondary"
                      onClick={() => go("catalog")}
                    >
                      {t.cart.toCatalog}
                    </button>
                  </>
                ) : (
                  <>
                    {lines.map((p) => (
                      <div className="ds-line" key={p.id} data-demo-line={p.id}>
                        <span className="ds-line-name">
                          {t.products[p.id].name}
                        </span>
                        <span className="ds-line-qty">
                          {fill(t.cart.qty, { count: cart[p.id] ?? 0 })}
                        </span>
                        <span>{money(p.price * (cart[p.id] ?? 0))}</span>
                        <button
                          type="button"
                          className="ds-link-btn"
                          onClick={() => remove(p.id)}
                        >
                          {t.cart.remove}
                        </button>
                      </div>
                    ))}
                    <p className="ds-total">
                      <span>{t.cart.total}</span>
                      <span>{money(subtotal)}</span>
                    </p>
                  </>
                )}
              </div>
              {lines.length > 0 && (
                <form
                  className="ds-panel"
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitOrder();
                  }}
                >
                  <h2 className="ds-h2">{t.checkout.title}</h2>
                  <div className="ds-field">
                    <label className="ds-label" htmlFor="ds-checkout-name">
                      {t.checkout.name}
                    </label>
                    <input
                      id="ds-checkout-name"
                      className="ds-input"
                      type="text"
                      autoComplete="off"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      data-qa="demo-shop-checkout-name"
                    />
                  </div>
                  <div className="ds-field">
                    <label className="ds-label" htmlFor="ds-checkout-phone">
                      {t.checkout.phone}
                    </label>
                    <input
                      id="ds-checkout-phone"
                      className="ds-input"
                      type="tel"
                      autoComplete="off"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      data-qa="demo-shop-checkout-phone"
                    />
                  </div>
                  <div className="ds-fieldset">
                    <span className="ds-label" id="ds-method-label">
                      {t.checkout.method}
                    </span>
                    <div
                      className="ds-options"
                      role="radiogroup"
                      aria-labelledby="ds-method-label"
                    >
                      <button
                        type="button"
                        role="radio"
                        className="ds-option"
                        aria-checked={method === "pickup"}
                        data-demo-method="pickup"
                        data-qa="demo-shop-checkout-pickup"
                        onClick={() => setMethod("pickup")}
                      >
                        <span className="ds-dot" aria-hidden="true" />
                        <span className="ds-option-text">
                          {t.checkout.pickup}
                          <span className="ds-option-hint">
                            {t.checkout.pickupHint}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        className="ds-option"
                        aria-checked={method === "delivery"}
                        data-demo-method="delivery"
                        onClick={() => setMethod("delivery")}
                      >
                        <span className="ds-dot" aria-hidden="true" />
                        <span className="ds-option-text">
                          {t.checkout.delivery}
                          <span className="ds-option-hint">
                            {t.checkout.deliveryHint}
                          </span>
                        </span>
                      </button>
                    </div>
                  </div>
                  {method === "delivery" && (
                    <div className="ds-field">
                      <label className="ds-label" htmlFor="ds-checkout-address">
                        {t.checkout.address}
                      </label>
                      <input
                        id="ds-checkout-address"
                        className="ds-input"
                        type="text"
                        autoComplete="off"
                        value={address}
                        onChange={(e) => setAddress(e.target.value)}
                        data-demo-field="address"
                      />
                    </div>
                  )}
                  {checkoutError && (
                    <p className="ds-error" role="alert">
                      {checkoutError}
                    </p>
                  )}
                  <button
                    type="submit"
                    className="ds-btn ds-btn-block"
                    data-qa="demo-shop-checkout-submit"
                  >
                    {t.checkout.submit}
                  </button>
                  <p className="ds-note">{t.checkout.noPayment}</p>
                </form>
              )}
            </div>
          ))}
      </main>

      <div className="ds-footer">{t.footer}</div>
    </div>
  );
}
