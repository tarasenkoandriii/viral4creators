/**
 * Данные и тексты демо-витрины `/qa/demo-shop` — вымышленная «Лавка
 * „Полігон“» для роликов обучающего лендинга (решение владельца
 * 06.10.2026, путь А; сценарии С3/С2/С4 —
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`).
 *
 * Словарь страницы живёт ЗДЕСЬ, а не в общих словарях лендинга
 * (`src/dictionaries/*.json`): витрина — служебный полигон вне
 * `[locale]`, её тексты не должны попадать ни в симметрию локалей
 * лендинга, ни в его переводы. Язык выбирается параметром `?lang=`
 * (по умолчанию `uk`), чтобы ролик на каждом из пяти языков показывал
 * сайт на том же языке, что и озвучка.
 *
 * Всё вымышлено: бренд, товары, цены, сроки, адрес «м. Демо, вул.
 * Полігонна, 1» (из черновика сценариев). Никаких настоящих брендов,
 * служб доставки, людей и адресов.
 *
 * Полноту словаря для пяти языков (одинаковая форма, непустые строки,
 * одинаковые подстановки `{…}`) держит `landing/scripts/demo-shop.test.ts`.
 */

export const DEMO_SHOP_LANGS = ["uk", "ru", "en", "de", "es"] as const;
export type DemoShopLang = (typeof DEMO_SHOP_LANGS)[number];
export const DEMO_SHOP_DEFAULT_LANG: DemoShopLang = "uk";

/** `?lang=` → язык витрины; всё, чего нет в списке, — язык по умолчанию. */
export function resolveDemoShopLang(
  raw: string | string[] | undefined | null,
): DemoShopLang {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  return (DEMO_SHOP_LANGS as readonly string[]).includes(value ?? "")
    ? (value as DemoShopLang)
    : DEMO_SHOP_DEFAULT_LANG;
}

/** Номер тестового заказа — всегда один и тот же: ролик не должен меняться от прогона к прогону. */
export const DEMO_SHOP_ORDER_NUMBER = "DEMO-0001";

/** Стоимость доставки курьером, грн (та же цифра стоит в текстах условий). */
export const DEMO_SHOP_DELIVERY_FEE = 70;

export type DemoShopProductId = "mug" | "notebook" | "tote" | "postcards";

export const DEMO_SHOP_PRODUCTS: ReadonlyArray<{
  id: DemoShopProductId;
  price: number;
}> = [
  { id: "mug", price: 290 },
  { id: "notebook", price: 180 },
  { id: "tote", price: 350 },
  { id: "postcards", price: 120 },
];

export type DemoShopDay = "mon" | "wed" | "fri";

/**
 * Слоты записи — статичные, БЕЗ дат: настоящий календарь устарел бы
 * через неделю, и ролик начал бы показывать прошлое (черновик, С4).
 */
export const DEMO_SHOP_SLOTS: ReadonlyArray<{
  id: string;
  day: DemoShopDay;
  time: string;
}> = [
  { id: "mon-10", day: "mon", time: "10:00" },
  { id: "mon-14", day: "mon", time: "14:00" },
  { id: "wed-11", day: "wed", time: "11:00" },
  { id: "fri-16", day: "fri", time: "16:00" },
];

/** Подставляет `{name}` в строку словаря. */
export function fill(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}

export type DemoShopCopy = {
  meta: { title: string };
  brand: string;
  notice: string;
  footer: string;
  /** Цена: `{amount}` — число. */
  price: string;
  nav: {
    label: string;
    catalog: string;
    delivery: string;
    booking: string;
    cart: string;
    /** Доступное имя кнопки корзины; начинается с видимой подписи. */
    cartLabel: string;
  };
  catalog: { title: string; add: string; added: string };
  products: Record<DemoShopProductId, { name: string; note: string }>;
  cart: {
    title: string;
    empty: string;
    toCatalog: string;
    qty: string;
    remove: string;
    total: string;
  };
  checkout: {
    title: string;
    name: string;
    phone: string;
    method: string;
    pickup: string;
    pickupHint: string;
    delivery: string;
    deliveryHint: string;
    address: string;
    submit: string;
    noPayment: string;
    error: string;
    errorAddress: string;
  };
  order: {
    confirmed: string;
    details: string;
    noPayment: string;
    toCatalog: string;
  };
  delivery: {
    title: string;
    lead: string;
    tabsLabel: string;
    courier: string;
    pickup: string;
    termLabel: string;
    priceLabel: string;
    paymentLabel: string;
    placeLabel: string;
    courierTerm: string;
    courierPrice: string;
    courierPayment: string;
    pickupPlace: string;
    pickupTerm: string;
    pickupPrice: string;
    pickupPayment: string;
  };
  booking: {
    title: string;
    lead: string;
    open: string;
    slotsTitle: string;
    slotsNote: string;
    /** `{day}`, `{time}`. */
    slot: string;
    days: Record<DemoShopDay, string>;
    name: string;
    email: string;
    submit: string;
    error: string;
    confirmed: string;
    /** `{slot}`, `{name}`. */
    details: string;
  };
};

export const DEMO_SHOP_COPY: Record<DemoShopLang, DemoShopCopy> = {
  uk: {
    meta: { title: "Лавка „Полігон“ — тестовий магазин" },
    brand: "Лавка „Полігон“",
    notice:
      "Тестовий магазин: товари, ціни й адреси вигадані, справжніх покупок немає.",
    footer:
      "Лавка „Полігон“ — вигаданий магазин для навчальних відео. Справжніх товарів, оплат і доставок тут немає.",
    price: "{amount} грн",
    nav: {
      label: "Розділи магазину",
      catalog: "Каталог",
      delivery: "Доставка й оплата",
      booking: "Консультація",
      cart: "Кошик",
      cartLabel: "Кошик, товарів: {count}",
    },
    catalog: { title: "Каталог", add: "У кошик", added: "У кошику · {count}" },
    products: {
      mug: { name: "Кружка „Полігон“", note: "Кераміка, 330 мл" },
      notebook: { name: "Блокнот „Сітка“", note: "А5, 96 аркушів у клітинку" },
      tote: { name: "Торба „Вершина“", note: "Бавовна, щільне дно" },
      postcards: { name: "Листівки „Грані“", note: "Набір із 6 штук" },
    },
    cart: {
      title: "Кошик",
      empty: "Кошик порожній — додайте щось із каталогу.",
      toCatalog: "До каталогу",
      qty: "× {count}",
      remove: "Прибрати",
      total: "Разом",
    },
    checkout: {
      title: "Оформлення",
      name: "Ім’я",
      phone: "Телефон",
      method: "Спосіб отримання",
      pickup: "Самовивіз",
      pickupHint: "безкоштовно",
      delivery: "Доставка",
      deliveryHint: "кур’єром, 70 грн",
      address: "Адреса доставки",
      submit: "Оформити замовлення",
      noPayment: "Оплата не потрібна: це тестове замовлення.",
      error: "Вкажіть ім’я й телефон і оберіть спосіб отримання.",
      errorAddress: "Вкажіть адресу доставки.",
    },
    order: {
      confirmed: "Тестове замовлення {order} прийнято",
      details: "{method} · разом {total}",
      noPayment: "Оплата не проводилась — це тестовий магазин.",
      toCatalog: "До каталогу",
    },
    delivery: {
      title: "Доставка й оплата",
      lead: "Оберіть спосіб, щоб побачити терміни й вартість.",
      tabsLabel: "Способи отримання",
      courier: "Кур’єром",
      pickup: "Самовивіз",
      termLabel: "Терміни",
      priceLabel: "Вартість",
      paymentLabel: "Оплата",
      placeLabel: "Пункт видачі",
      courierTerm: "1–2 робочі дні по м. Демо, 2–4 дні — до інших міст",
      courierPrice: "70 грн, від 1000 грн — безкоштовно",
      courierPayment: "Карткою або готівкою кур’єру під час отримання",
      pickupPlace: "м. Демо, вул. Полігонна, 1 (вигадана адреса)",
      pickupTerm: "Наступного робочого дня, пн–пт 10:00–19:00",
      pickupPrice: "Безкоштовно",
      pickupPayment: "Карткою або готівкою в пункті видачі",
    },
    booking: {
      title: "Безкоштовна консультація",
      lead: "20 хвилин онлайн: допоможемо обрати подарунок або замовлення для команди.",
      open: "Записатися",
      slotsTitle: "Оберіть час",
      slotsNote: "Розклад тестовий, без дат.",
      slot: "{day}, {time}",
      days: { mon: "Пн", wed: "Ср", fri: "Пт" },
      name: "Ім’я",
      email: "Пошта",
      submit: "Підтвердити запис",
      error: "Вкажіть ім’я та пошту.",
      confirmed: "Ви записані (тестовий запис)",
      details: "{slot} · {name}",
    },
  },
  ru: {
    meta: { title: "Лавка «Полигон» — тестовый магазин" },
    brand: "Лавка «Полигон»",
    notice:
      "Тестовый магазин: товары, цены и адреса вымышлены, настоящих покупок нет.",
    footer:
      "Лавка «Полигон» — вымышленный магазин для обучающих роликов. Настоящих товаров, оплат и доставок здесь нет.",
    price: "{amount} грн",
    nav: {
      label: "Разделы магазина",
      catalog: "Каталог",
      delivery: "Доставка и оплата",
      booking: "Консультация",
      cart: "Корзина",
      cartLabel: "Корзина, товаров: {count}",
    },
    catalog: {
      title: "Каталог",
      add: "В корзину",
      added: "В корзине · {count}",
    },
    products: {
      mug: { name: "Кружка «Полигон»", note: "Керамика, 330 мл" },
      notebook: { name: "Блокнот «Сетка»", note: "А5, 96 листов в клетку" },
      tote: { name: "Сумка «Вершина»", note: "Хлопок, плотное дно" },
      postcards: { name: "Открытки «Грани»", note: "Набор из 6 штук" },
    },
    cart: {
      title: "Корзина",
      empty: "Корзина пуста — добавьте что-нибудь из каталога.",
      toCatalog: "В каталог",
      qty: "× {count}",
      remove: "Убрать",
      total: "Итого",
    },
    checkout: {
      title: "Оформление",
      name: "Имя",
      phone: "Телефон",
      method: "Способ получения",
      pickup: "Самовывоз",
      pickupHint: "бесплатно",
      delivery: "Доставка",
      deliveryHint: "курьером, 70 грн",
      address: "Адрес доставки",
      submit: "Оформить заказ",
      noPayment: "Оплата не нужна: это тестовый заказ.",
      error: "Укажите имя и телефон и выберите способ получения.",
      errorAddress: "Укажите адрес доставки.",
    },
    order: {
      confirmed: "Тестовый заказ {order} принят",
      details: "{method} · итого {total}",
      noPayment: "Оплата не проводилась — это тестовый магазин.",
      toCatalog: "В каталог",
    },
    delivery: {
      title: "Доставка и оплата",
      lead: "Выберите способ, чтобы увидеть сроки и стоимость.",
      tabsLabel: "Способы получения",
      courier: "Курьером",
      pickup: "Самовывоз",
      termLabel: "Сроки",
      priceLabel: "Стоимость",
      paymentLabel: "Оплата",
      placeLabel: "Пункт выдачи",
      courierTerm: "1–2 рабочих дня по г. Демо, 2–4 дня — в другие города",
      courierPrice: "70 грн, от 1000 грн — бесплатно",
      courierPayment: "Картой или наличными курьеру при получении",
      pickupPlace: "г. Демо, ул. Полигонная, 1 (вымышленный адрес)",
      pickupTerm: "На следующий рабочий день, пн–пт 10:00–19:00",
      pickupPrice: "Бесплатно",
      pickupPayment: "Картой или наличными в пункте выдачи",
    },
    booking: {
      title: "Бесплатная консультация",
      lead: "20 минут онлайн: поможем выбрать подарок или заказ для команды.",
      open: "Записаться",
      slotsTitle: "Выберите время",
      slotsNote: "Расписание тестовое, без дат.",
      slot: "{day}, {time}",
      days: { mon: "Пн", wed: "Ср", fri: "Пт" },
      name: "Имя",
      email: "Почта",
      submit: "Подтвердить запись",
      error: "Укажите имя и почту.",
      confirmed: "Вы записаны (тестовая запись)",
      details: "{slot} · {name}",
    },
  },
  en: {
    meta: { title: "Polihon Shop — a test store" },
    brand: "Polihon Shop",
    notice:
      "A test store: products, prices and addresses are made up, nothing is really sold.",
    footer:
      "Polihon Shop is a made-up store for tutorial videos. There are no real products, payments or deliveries here.",
    price: "UAH {amount}",
    nav: {
      label: "Store sections",
      catalog: "Catalog",
      delivery: "Delivery & payment",
      booking: "Consultation",
      cart: "Cart",
      cartLabel: "Cart, items: {count}",
    },
    catalog: {
      title: "Catalog",
      add: "Add to cart",
      added: "In cart · {count}",
    },
    products: {
      mug: { name: "“Polihon” mug", note: "Ceramic, 330 ml" },
      notebook: { name: "“Grid” notebook", note: "A5, 96 squared pages" },
      tote: { name: "“Summit” tote bag", note: "Cotton, sturdy base" },
      postcards: { name: "“Facets” postcards", note: "Set of 6" },
    },
    cart: {
      title: "Cart",
      empty: "Your cart is empty — add something from the catalog.",
      toCatalog: "Back to catalog",
      qty: "× {count}",
      remove: "Remove",
      total: "Total",
    },
    checkout: {
      title: "Checkout",
      name: "Name",
      phone: "Phone",
      method: "How to receive",
      pickup: "Pickup",
      pickupHint: "free",
      delivery: "Delivery",
      deliveryHint: "by courier, UAH 70",
      address: "Delivery address",
      submit: "Place order",
      noPayment: "No payment needed: this is a test order.",
      error: "Enter a name and phone and choose how to receive the order.",
      errorAddress: "Enter a delivery address.",
    },
    order: {
      confirmed: "Test order {order} placed",
      details: "{method} · total {total}",
      noPayment: "No payment was taken — this is a test store.",
      toCatalog: "Back to catalog",
    },
    delivery: {
      title: "Delivery & payment",
      lead: "Choose a method to see times and prices.",
      tabsLabel: "Delivery methods",
      courier: "By courier",
      pickup: "Pickup",
      termLabel: "Times",
      priceLabel: "Price",
      paymentLabel: "Payment",
      placeLabel: "Pickup point",
      courierTerm: "1–2 business days in Demo City, 2–4 days to other cities",
      courierPrice: "UAH 70, free from UAH 1000",
      courierPayment: "Card or cash to the courier on delivery",
      pickupPlace: "1 Polihonna St, Demo City (made-up address)",
      pickupTerm: "Next business day, Mon–Fri 10:00–19:00",
      pickupPrice: "Free",
      pickupPayment: "Card or cash at the pickup point",
    },
    booking: {
      title: "Free consultation",
      lead: "20 minutes online: we’ll help you pick a gift or a team order.",
      open: "Book",
      slotsTitle: "Pick a time",
      slotsNote: "Test schedule, no dates.",
      slot: "{day}, {time}",
      days: { mon: "Mon", wed: "Wed", fri: "Fri" },
      name: "Name",
      email: "Email",
      submit: "Confirm booking",
      error: "Enter a name and email.",
      confirmed: "You’re booked (test booking)",
      details: "{slot} · {name}",
    },
  },
  de: {
    meta: { title: "Laden „Polihon“ — ein Testshop" },
    brand: "Laden „Polihon“",
    notice:
      "Ein Testshop: Waren, Preise und Adressen sind erfunden, echte Käufe gibt es nicht.",
    footer:
      "Laden „Polihon“ ist ein erfundener Shop für Lernvideos. Echte Waren, Zahlungen und Lieferungen gibt es hier nicht.",
    price: "{amount} UAH",
    nav: {
      label: "Shop-Bereiche",
      catalog: "Katalog",
      delivery: "Lieferung & Zahlung",
      booking: "Beratung",
      cart: "Warenkorb",
      cartLabel: "Warenkorb, Artikel: {count}",
    },
    catalog: {
      title: "Katalog",
      add: "In den Warenkorb",
      added: "Im Warenkorb · {count}",
    },
    products: {
      mug: { name: "Becher „Polihon“", note: "Keramik, 330 ml" },
      notebook: { name: "Notizbuch „Raster“", note: "A5, 96 Seiten kariert" },
      tote: { name: "Beutel „Gipfel“", note: "Baumwolle, fester Boden" },
      postcards: { name: "Postkarten „Facetten“", note: "6er-Set" },
    },
    cart: {
      title: "Warenkorb",
      empty: "Der Warenkorb ist leer — legen Sie etwas aus dem Katalog hinein.",
      toCatalog: "Zum Katalog",
      qty: "× {count}",
      remove: "Entfernen",
      total: "Summe",
    },
    checkout: {
      title: "Bestellung",
      name: "Name",
      phone: "Telefon",
      method: "Erhalt",
      pickup: "Abholung",
      pickupHint: "kostenlos",
      delivery: "Lieferung",
      deliveryHint: "per Kurier, 70 UAH",
      address: "Lieferadresse",
      submit: "Bestellung aufgeben",
      noPayment: "Keine Zahlung nötig: Das ist eine Testbestellung.",
      error: "Bitte Name und Telefon angeben und eine Erhaltsart wählen.",
      errorAddress: "Bitte eine Lieferadresse angeben.",
    },
    order: {
      confirmed: "Testbestellung {order} angenommen",
      details: "{method} · Summe {total}",
      noPayment: "Es wurde nichts bezahlt — das ist ein Testshop.",
      toCatalog: "Zum Katalog",
    },
    delivery: {
      title: "Lieferung & Zahlung",
      lead: "Wählen Sie eine Art, um Fristen und Preise zu sehen.",
      tabsLabel: "Erhaltsarten",
      courier: "Per Kurier",
      pickup: "Abholung",
      termLabel: "Fristen",
      priceLabel: "Preis",
      paymentLabel: "Zahlung",
      placeLabel: "Abholstelle",
      courierTerm: "1–2 Werktage in Demo-Stadt, 2–4 Tage in andere Städte",
      courierPrice: "70 UAH, ab 1000 UAH kostenlos",
      courierPayment: "Mit Karte oder bar beim Kurier",
      pickupPlace: "Polihonna-Str. 1, Demo-Stadt (erfundene Adresse)",
      pickupTerm: "Am nächsten Werktag, Mo–Fr 10:00–19:00",
      pickupPrice: "Kostenlos",
      pickupPayment: "Mit Karte oder bar an der Abholstelle",
    },
    booking: {
      title: "Kostenlose Beratung",
      lead: "20 Minuten online: Wir helfen bei einem Geschenk oder einer Teambestellung.",
      open: "Termin buchen",
      slotsTitle: "Zeit wählen",
      slotsNote: "Testplan, ohne Datum.",
      slot: "{day}, {time}",
      days: { mon: "Mo", wed: "Mi", fri: "Fr" },
      name: "Name",
      email: "E-Mail",
      submit: "Termin bestätigen",
      error: "Bitte Name und E-Mail angeben.",
      confirmed: "Termin gebucht (Testbuchung)",
      details: "{slot} · {name}",
    },
  },
  es: {
    meta: { title: "Tienda «Polihon» — una tienda de prueba" },
    brand: "Tienda «Polihon»",
    notice:
      "Tienda de prueba: productos, precios y direcciones son inventados; no hay compras reales.",
    footer:
      "Tienda «Polihon» es una tienda inventada para vídeos tutoriales. Aquí no hay productos, pagos ni envíos reales.",
    price: "{amount} UAH",
    nav: {
      label: "Secciones de la tienda",
      catalog: "Catálogo",
      delivery: "Envío y pago",
      booking: "Asesoría",
      cart: "Carrito",
      cartLabel: "Carrito, artículos: {count}",
    },
    catalog: {
      title: "Catálogo",
      add: "Añadir al carrito",
      added: "En el carrito · {count}",
    },
    products: {
      mug: { name: "Taza «Polihon»", note: "Cerámica, 330 ml" },
      notebook: {
        name: "Cuaderno «Cuadrícula»",
        note: "A5, 96 hojas cuadriculadas",
      },
      tote: { name: "Bolsa «Cumbre»", note: "Algodón, base resistente" },
      postcards: { name: "Postales «Facetas»", note: "Juego de 6" },
    },
    cart: {
      title: "Carrito",
      empty: "El carrito está vacío: añade algo del catálogo.",
      toCatalog: "Al catálogo",
      qty: "× {count}",
      remove: "Quitar",
      total: "Total",
    },
    checkout: {
      title: "Pedido",
      name: "Nombre",
      phone: "Teléfono",
      method: "Forma de entrega",
      pickup: "Recogida",
      pickupHint: "gratis",
      delivery: "Envío",
      deliveryHint: "por mensajero, 70 UAH",
      address: "Dirección de envío",
      submit: "Realizar pedido",
      noPayment: "No hace falta pagar: es un pedido de prueba.",
      error: "Indica nombre y teléfono y elige la forma de entrega.",
      errorAddress: "Indica la dirección de envío.",
    },
    order: {
      confirmed: "Pedido de prueba {order} recibido",
      details: "{method} · total {total}",
      noPayment: "No se ha cobrado nada: es una tienda de prueba.",
      toCatalog: "Al catálogo",
    },
    delivery: {
      title: "Envío y pago",
      lead: "Elige una forma para ver plazos y precios.",
      tabsLabel: "Formas de entrega",
      courier: "Por mensajero",
      pickup: "Recogida",
      termLabel: "Plazos",
      priceLabel: "Precio",
      paymentLabel: "Pago",
      placeLabel: "Punto de recogida",
      courierTerm:
        "1–2 días laborables en Ciudad Demo, 2–4 días a otras ciudades",
      courierPrice: "70 UAH, gratis desde 1000 UAH",
      courierPayment: "Con tarjeta o en efectivo al mensajero",
      pickupPlace: "C. Polihonna, 1, Ciudad Demo (dirección inventada)",
      pickupTerm: "El siguiente día laborable, lun–vie 10:00–19:00",
      pickupPrice: "Gratis",
      pickupPayment: "Con tarjeta o en efectivo en el punto de recogida",
    },
    booking: {
      title: "Asesoría gratuita",
      lead: "20 minutos en línea: te ayudamos a elegir un regalo o un pedido para tu equipo.",
      open: "Reservar",
      slotsTitle: "Elige una hora",
      slotsNote: "Horario de prueba, sin fechas.",
      slot: "{day}, {time}",
      days: { mon: "Lun", wed: "Mié", fri: "Vie" },
      name: "Nombre",
      email: "Correo",
      submit: "Confirmar cita",
      error: "Indica nombre y correo.",
      confirmed: "Cita reservada (reserva de prueba)",
      details: "{slot} · {name}",
    },
  },
};
