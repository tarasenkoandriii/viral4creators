/**
 * ПД в «знаниях об интерфейсе» «Админки» (Ш3-хвост (17)).
 *
 * Сбор (`page/collect.ts`) берёт только заголовки, меню, подписи полей и
 * кнопок, шапки таблиц и маскирует e-mail/телефоны/длинные цифры. Но на
 * «карточке сущности» (заказ, покупатель, пользователь) имя клиента стоит в
 * `h1`, в «хлебных крошках», в заголовке блока «Покупець», в `<title>` — вне
 * таблиц, и маска его не ловит. Здесь (в Node, после сбора):
 *
 *  - карточка сущности — по маршруту (`/orders/1024`, `/customers/77/edit`,
 *    `post.php?post=12&action=edit`, `user-edit.php?user_id=5`,
 *    `admin.php?page=wc-orders&id=12`, UUID/хеш в пути) или по структуре
 *    (номер записи в заголовке: `#1024`, `№ 1024`, `No. 1024`);
 *  - на карточке остаётся СТРУКТУРА: слова словаря интерфейса (разделы,
 *    подписи, действия) и бренды; всё, что похоже на собственное имя
 *    (Слово с заглавной вне словаря, ДЛИННЫЕ ЗАГЛАВНЫЕ, инициалы), числа от
 *    двух цифр и значения в кавычках — маска;
 *  - на остальных страницах — мягко: только «Имя Фамилия» (два и больше
 *    слов-имён подряд) и имя после приветствия («Howdy, …», «Привіт, …»);
 *  - обход заходит только в ОДНУ карточку каждого вида
 *    (`entityRouteKey`): структура у них одна, а каждая лишняя — это чужие
 *    ПД в браузере воркера. Ссылки из таблиц по-прежнему не обходятся
 *    (`collectInterface`).
 *
 * Чистые функции — без браузера, проверяются unit-тестами на фикстурах.
 */

export const NAME_MASK = "[ім'я]";
export const VALUE_MASK = '[значення]';
export const NUMBER_MASK = '[№]';

/** Слова из текста через пробел (словари ниже — компактно). */
function words2(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Сегмент пути/значение параметра — идентификатор записи. */
const ID_RE =
  /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|(?=[a-z0-9_-]*\d{3})[a-z0-9_-]{4,40})$/i;
/** После этих сегментов число — страница/шаг списка, а не запись. */
const NOT_ID_AFTER = new Set([
  'page',
  'p',
  'pages',
  'paged',
  'step',
  'tab',
  'sort',
  'limit',
  'per-page',
  'perpage',
  'offset',
  'v',
  'version',
  'api',
]);
/** Параметры адреса с id записи. */
const ID_QUERY =
  /^(id|post|user_id|order_id|customer_id|client_id|contact_id|lead_id|uid|cid|oid|entity_id|item_id|order|customer|user|client)$/i;
/** Параметры, которые различают ВИД карточки (а не запись). */
const KIND_QUERY =
  /^(page|action|post_type|route|controller|view|type|section|module)$/i;

/**
 * Ключ вида карточки сущности (`/admin/orders/:id`,
 * `/wp-admin/post.php?action=edit&post=:id`) или `null` — не карточка.
 */
export function entityRouteKey(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  let hit = false;
  const segs = u.pathname.split('/');
  const keySegs = segs.map((seg, i) => {
    const prev = (segs[i - 1] ?? '').toLowerCase();
    let s = seg;
    try {
      s = decodeURIComponent(seg);
    } catch {
      /* как есть */
    }
    if (s && ID_RE.test(s) && !NOT_ID_AFTER.has(prev)) {
      hit = true;
      return ':id';
    }
    return seg.toLowerCase();
  });
  const q: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (ID_QUERY.test(k) && ID_RE.test(v)) {
      hit = true;
      q.push(`${k.toLowerCase()}=:id`);
    } else if (KIND_QUERY.test(k)) {
      q.push(`${k.toLowerCase()}=${v.toLowerCase().slice(0, 40)}`);
    }
  }
  if (!hit) return null;
  q.sort();
  return `${u.host.toLowerCase()}${keySegs.join('/')}${q.length ? `?${q.join('&')}` : ''}`;
}

/** Номер записи в заголовке: «Замовлення №1024», «Order #1024», «No. 77». */
const ID_MARKER = /(?:^|[\s(—–-])(?:#|№|No\.?|N°|Nr\.?)\s?\d{2,}/i;

// ── словарь интерфейса ─────────────────────────────────────────────────────
// Основы слов (сравнение по началу слова, ≥ 4 букв) — разделы, подписи и
// действия админок магазинов (WooCommerce, Хорошоп, OpenCart, Prom, CRM) на
// украинском, русском и английском. Слово с заглавной ВНЕ словаря на
// карточке считается собственным именем.
const STEMS = words2(
  // uk
  `замовлен клієнт покуп адрес достав оплат статус дата створ змін сума суми
разом підсум назв товар кільк ціна ціни вартіст податк знижк купон примітк
нотатк коментар загальн редаг перегля додат нови нова нове новий зберег
оновл онови видал скасув назад профіл обліков акаунт користувач контакт
інформац істор налашт панел звіт аналіт маркет каталог категор склад залиш
відправ відвантаж трек рахун поверн експорт імпорт телефон ім'я імя прізвищ
батькові компан країн місто міст област район індекс вулиц будин квартир
відділен поштомат повідомл відгук атрибут варіац зображ фото галере опис
заголов сторінк запис медіа модул вигляд інструм довідк допомог головн
пошук фільтр застос скинут обрат вибра вибер більше менше показ прихов
відкри закри детал огляд публік чернетк очіку обробк обробл викона заверш
відмін кошик мітк бренд виробник артикул сайт магазин мова валют курс
прайс акці банер слайдер меню посилан файл документ спосіб метод джерел
менеджер відповідальн призначен канал вага розмір обсяг номер дані загалом
платник отримувач одержувач відправник перевізник накладн сплач оплачен
підтвердж друк друку роздрук надісл копі копію дублю архів картк покупці
послуг знайти шукати увійти вийти вхід вихід реєстрац пароль логін безпек
доступ роль ролі права дозвол інтеграц оновлен основн додатков спільн
останн наступн попередн перш всього кошторис платіж платеж рахунок чек
знижок бонус промокод зворотн дзвін дзвон лист розсил шаблон тип вид дія
дії дій код тег теги усі всі нові ще так ні від для або та і й на по до за` +
    ' ' +
    // ru
    `заказ назван клиент покупател доставк стоимост налог скидк примечан заметк
комментар действ общ общий общие общая общее редакт просмотр добав новы
сохран обнов удал удали удален отмен профил учетн учётн аккаунт пользоват
информац истор настро отчет отчёт аналит остат счет счёт возврат имя фамил
отчеств стран город улиц отделен почтомат сообщ отзыв вариац изображ
описан страниц внешн справк помощ главн поиск примен сброс выбр больше
меньше скры откры закры детал обзор черновик ожида обработ выполн корзин
метк производ язык баннер ссылк способ источник ответствен объем объём
данные плательщик получател отправител перевозчик оплачен печат распечат
отправ архив карточк покупатели услуг найти войти выйти вход выход
регистрац безопасн интеграц основн дополнит последн следующ предыдущ всего
платеж платёж бонус промокод звон письм рассыл итог количеств цена цены
товар статус дата сумм все еще ещё да нет вид тип код от для или и на по
до за` +
    ' ' +
    // en
    `order detail customer client billing shipping ship address payment method
status date created creat modified total subtotal product item quantit qty
price cost tax discount coupon note action general edit view add new save
update delete remov cancel back profile account user contact information
info summary history activit setting dashboard report analytic marketing
catalog categor inventor stock warehouse deliver tracking track invoice
refund return download export import email e-mail phone name first last
company country city state postcode post zip region street comment message
review attribut variation image gallery description short title page media
plugin theme appearance tool help home search filter apply reset select
more less show hide open close all overview preview publish draft pending
processing complet on-hold hold fail cancel trash paid unpaid number type
source manager assign weight size dimension sku id code tag brand vendor
store shop site language currenc role permission password login log sign
security integration customers orders items fee fees line recalculat
subscription notification template next previous prev other primary main
additional provided customer’s customer's via for to of and or in on at by with from
the a an my your yes no choose chose paid net gross transaction ip agent
note private public send resend print pdf csv bulk quick screen options
option custom field block library librar zone gateway checkout cart widget
menu header footer sidebar layout design color colour font style permalink
reading writing discussion privacy health reusable pattern extension addon
add-on marketplace insight revenue sale sales tax taxes log logs scheduled
webhook api key keys legacy advanced feature sell selling buy purchase
coupon mail list lists group segment campaign audience automation workflow
task lead deal pipeline stage ticket support chat inbox call calls balance
wallet bank card cash credit debit cod free flat rate local pickup method
methods` +
    ' ' +
    // uk/ru: ещё разделы CRM и магазинов
    `угод сделк воронк етап этап завданн задач лід лид сегмент кампан аудитор
автомат тікет тикет підтримк поддержк чат вхідн входящ дзвінк звонк баланс
гаманец кошел банк картк карт готівк наличн кредит накладен наложен
безкоштовн бесплатн самовивіз самовывоз кур'єр курьер адресн`,
);
/** Бренды и сервисы — не имена людей. */
const BRANDS = words2(
  `woocommerce wordpress хорошоп horoshop shopify opencart prestashop magento
prom rozetka розетка нова пошта nova poshta укрпошта ukrposhta meest
monobank liqpay fondy wayforpay paypal stripe google facebook instagram
telegram viber tiktok youtube apple android ios elementor yoast visa
mastercard приватбанк приват24 privatbank checkbox вчасно bitrix бітрікс
битрикс keycrm salesdrive retailcrm gutenberg jetpack akismet mailchimp
binotel ringostat esputnik sendpulse turbosms smsfly`,
);

/** Окончания, при которых короткая основа ещё «слово словаря». */
const ENDINGS = new Set([
  '',
  ...words2(
    `а и і у ю е є я ї й ь ом ою ам ами ах ях ів ей ов ого ому ий ій ої их х о
им ими ки ку ці s es ed d ing er ers ion ions al ly y ies e ment ments`,
  ),
]);
/** Слова приветствий — само приветствие не имя («Howdy, [ім'я]»). */
const GREETING_WORDS = words2(
  `howdy hello hi hey welcome привіт вітаємо вітаю привет здравствуйте
ласкаво просимо добро пожаловать`,
);
const EXACT = new Set<string>([...BRANDS, ...GREETING_WORDS]);
/** Длинные основы — по началу слова; короткие — только с окончанием. */
const LONG: string[] = [];
const SHORT: string[] = [];
for (const s of STEMS) {
  const n = [...s].length;
  const latin = /^[a-z]/.test(s);
  if (n <= 2) EXACT.add(s);
  else if (n >= (latin ? 6 : 5)) LONG.push(s);
  else SHORT.push(s);
}

function known(word: string): boolean {
  const w = word.toLowerCase().replace(/[’ʼ`]/g, "'");
  if (EXACT.has(w)) return true;
  for (const p of LONG) if (w.startsWith(p)) return true;
  for (const p of SHORT)
    if (w.startsWith(p) && ENDINGS.has(w.slice(p.length))) return true;
  for (const b of BRANDS) if (b.length >= 5 && w.startsWith(b)) return true;
  return false;
}

const WORD_RE = /[\p{L}\p{M}](?:[\p{L}\p{M}'’ʼ-]*[\p{L}\p{M}])?/gu;
const isUpper = (ch: string) =>
  ch !== ch.toLowerCase() && ch === ch.toUpperCase();

interface Word {
  start: number;
  end: number;
  text: string;
  cand: boolean;
}

function words(s: string): Word[] {
  const out: Word[] = [];
  for (const m of s.matchAll(WORD_RE)) {
    const text = m[0];
    const start = m.index ?? 0;
    const end = start + text.length;
    const chars = [...text];
    const title = isUpper(chars[0]) && /\p{Ll}/u.test(chars.slice(1).join(''));
    const caps =
      chars.length >= 2 &&
      text === text.toUpperCase() &&
      text !== text.toLowerCase();
    // Инициал: «І.», «J.» — одна заглавная с точкой.
    const initial = chars.length === 1 && isUpper(chars[0]) && s[end] === '.';
    const cand =
      initial || ((title || (caps && chars.length >= 5)) && !known(text));
    out.push({ start, end, text, cand });
  }
  return out;
}

const GREETING =
  /((?<![\p{L}])(?:привіт|вітаємо|вітаю|привет|здравствуйте|hello|hi|hey|howdy|welcome|ласкаво просимо|добро пожаловать)[,!]?\s+)([^\s,!?;:|()[\]]+(?:\s+\p{Lu}[^\s,!?;:|()[\]]*)?)/giu;
const GREETING_STOP = new Set(['to', 'back', 'в', 'у', 'до', 'на', 'в', 'the']);

/**
 * Маска собственных имён в строке интерфейса. `strict` — карточка
 * сущности (любое слово-имя), иначе — только «Имя Фамилия» подряд и имя
 * после приветствия.
 */
export function maskNames(input: string, strict: boolean): string {
  let s = input.replace(GREETING, (all, lead: string, who: string) =>
    GREETING_STOP.has(who.split(/\s+/)[0].toLowerCase())
      ? all
      : `${lead}${NAME_MASK}`,
  );
  if (strict) {
    s = s
      .replace(
        /«[^»]{1,120}»|"[^"]{1,120}"|“[^”]{1,120}”|„[^“”]{1,120}[“”]/g,
        (q) => `${q[0]}${VALUE_MASK}${q[q.length - 1]}`,
      )
      .replace(/\d+(?:[.,:/-]\d+)*/g, (n) =>
        n.replace(/\D/g, '').length >= 2 ? NUMBER_MASK : n,
      );
  }
  const ws = words(s);
  const mask = new Array<boolean>(ws.length).fill(false);
  // Соседи «подряд» — между словами только пробелы/точки инициалов/дефис.
  const adjacent = (a: Word, b: Word) =>
    /^[\s.\-–]*$/.test(s.slice(a.end, b.start)) &&
    s.slice(a.end, b.start).length <= 3;
  for (let i = 0; i < ws.length; i++) {
    if (!ws[i].cand) continue;
    if (strict) {
      mask[i] = true;
      continue;
    }
    let j = i;
    while (j + 1 < ws.length && ws[j + 1].cand && adjacent(ws[j], ws[j + 1]))
      j += 1;
    if (j > i) for (let k = i; k <= j; k++) mask[k] = true;
    i = j;
  }
  if (!mask.some(Boolean)) return s;
  let out = '';
  let pos = 0;
  for (let i = 0; i < ws.length; i++) {
    if (!mask[i]) continue;
    // Слить подряд идущие маски в одну.
    let j = i;
    while (j + 1 < ws.length && mask[j + 1] && adjacent(ws[j], ws[j + 1]))
      j += 1;
    let end = ws[j].end;
    if (s[end] === '.' && [...ws[j].text].length === 1) end += 1;
    out += s.slice(pos, ws[i].start) + NAME_MASK;
    pos = end;
    i = j;
  }
  return out + s.slice(pos);
}

/** Префиксы строк `collectInterface`. */
const LINE_PREFIX = /^(# |меню: |колонка: |поле: |кнопка: )/;

/** Карточка сущности: по маршруту или по номеру записи в заголовке. */
export function isEntityPage(
  url: string,
  title: string,
  text: string,
): boolean {
  if (entityRouteKey(url)) return true;
  if (ID_MARKER.test(title)) return true;
  return text
    .split('\n')
    .some((l) => l.startsWith('# ') && ID_MARKER.test(l.slice(2)));
}

/**
 * Итог страницы «Админки» без ПД: на карточке сущности — только структура,
 * на остальных — мягкая маска имён. Повторы строк после маски — убираются.
 */
export function sanitizeAdminPage(
  url: string,
  title: string,
  text: string,
): { title: string; text: string; entity: boolean } {
  const entity = isEntityPage(url, title, text);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_PREFIX.exec(line);
    const prefix = m ? m[1] : '';
    const body = maskNames(line.slice(prefix.length), entity);
    const out = `${prefix}${body}`;
    if (!body.trim() || seen.has(out)) continue;
    seen.add(out);
    lines.push(out);
  }
  return { title: maskNames(title, entity), text: lines.join('\n'), entity };
}
