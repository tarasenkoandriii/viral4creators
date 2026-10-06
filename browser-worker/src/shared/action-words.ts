// СГЕНЕРИРОВАНО scripts/sync-worker-shared.mjs — не править.
// Источник: sites-backend/src/modules/assist-ui-core/action-words.ts. Правка — в источнике, затем
// `node scripts/sync-worker-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Словарь действий голосового управления (§5-бис.5, аудит 1.2) — класс
 * риска цели по её ВИДИМОМУ тексту, `data-assist-id` и адресу.
 *
 * Основа — категории стоп-листа обучалки (`dangerKindsFor`, копия
 * `backend/.../client-site-tutorial/danger-words.ts`, поведение
 * `dangerWarningFor` не меняется): оплата, удаление, оформление заказа,
 * отмена подписки → «никогда»; отправка сообщения → «с подтверждением».
 * Свой словарь дополняет: отмена заказа, возврат, платная подписка (рядом с
 * ценой), списание/начисление, массовые действия, «оформить»/checkout.
 *
 * Известный ложный срабатыватель: «Купити» в украинских магазинах часто
 * добавляет в корзину — стоп-лист побеждает, снимает запрет ТОЛЬКО разметка
 * `data-assist-id="add-to-cart"` (шаблон платформы — Э6-тер); правило из
 * кабинета стоп-лист не снимает (1.4, В-52).
 */
import { dangerKindsFor } from './danger-words';
import { normText } from './normalize';

export type ActionKind =
  | 'оплата'
  | 'удаление'
  | 'оформление заказа'
  | 'отправка сообщения'
  | 'отмена подписки'
  | 'отмена заказа'
  | 'возврат'
  | 'платная подписка'
  | 'подписка'
  | 'списание'
  | 'массовое действие';

/** Категории, которые кликом не исполняются никогда (§5-бис.5). */
export const NEVER_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'оплата',
  'удаление',
  'оформление заказа',
  'отмена подписки',
  'отмена заказа',
  'возврат',
  'платная подписка',
  'списание',
  'массовое действие',
]);

/** Категории «с подтверждением» (обычная отправка формы). */
export const CONFIRM_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'отправка сообщения',
  'подписка',
]);

/** Свой словарь (вдобавок к danger-words) — с начала слова, uk/ru/en. */
const OWN: Array<{ re: RegExp; kind: ActionKind }> = [
  {
    re: /(?:^|[^\p{L}])(отменить заказ|отмените заказ|отмена заказа|скасувати замовлення|скасуйте замовлення|скасування замовлення|cancel order)/iu,
    kind: 'отмена заказа',
  },
  {
    re: /(?:^|[^\p{L}])(возврат|вернуть деньги|оформить возврат|повернення|повернути кошти|refund|return order)/iu,
    kind: 'возврат',
  },
  {
    re: /(?:^|[^\p{L}])(списать|списание|списати|списання|начислить|нарахувати|charge|payout|withdraw|вывести средства|вивести кошти)/iu,
    kind: 'списание',
  },
  {
    re: /(?:^|[^\p{L}])(выбрать все|выделить все|отметить все|вибрати все|виділити все|позначити все|select all|check all)/iu,
    kind: 'массовое действие',
  },
  // «Оформить» без «заказ» — это и есть переход к оформлению (checkout).
  {
    re: /(?:^|[^\p{L}])(оформ(?:ить|ити|ление|лення|и)|до оформлення|к оформлению|proceed to checkout|checkout)/iu,
    kind: 'оформление заказа',
  },
  {
    re: /(?:^|[^\p{L}])(подписаться|подпишись|оформить подписку|підписатися|підпишись|оформити підписку|subscribe)/iu,
    kind: 'подписка',
  },
];

/** Цена рядом: «99 грн», «$5», «/міс», «per month». */
const PRICE =
  /(\d[\d\s.,]*\s?(грн|₴|uah|\$|usd|€|eur|руб|₽|zł))|((грн|₴|\$|€)\s?\d)|(\/\s?(міс|мес|mo|month))|(в месяц|на місяць|per month)/iu;

/**
 * Категории цели. `context` — заголовок раздела (цена «рядом» с кнопкой
 * «Подписаться» делает подписку платной).
 */
export function actionKindsFor(
  text: string,
  context: string | null = null,
): ActionKind[] {
  const probe = text.slice(0, 300);
  const out = new Set<ActionKind>(dangerKindsFor(probe) as ActionKind[]);
  for (const r of OWN) if (r.re.test(probe)) out.add(r.kind);
  if (
    out.has('подписка') &&
    (PRICE.test(probe) || (context !== null && PRICE.test(context)))
  ) {
    out.delete('подписка');
    out.add('платная подписка');
  }
  return [...out];
}

/**
 * Разметка обратимого действия посетителя над СВОИМ состоянием (§5-бис.5,
 * аудит 1.2): «В корзину», «В избранное», «Сравнить», «Применить фильтр» —
 * сразу, если цель связана с командой. Только `data-assist-id` (правило
 * заказчика и шаблон платформы — Э6-тер); текст кнопки сам по себе — нет.
 */
export const REVERSIBLE_ASSIST_IDS: ReadonlySet<string> = new Set([
  'add-to-cart',
  'add-to-wishlist',
  'wishlist',
  'add-to-compare',
  'compare',
  'apply-filter',
]);

/** Разметка, которая снимает «оформление заказа» со слов «Купить/Купити». */
export const ADD_TO_CART_ID = 'add-to-cart';

/**
 * Синонимы стандартной разметки для проверки «цель ↔ команда»
 * (`data-assist-id` по-английски, команда — по-украински/по-русски).
 */
export const ASSIST_ID_SYNONYMS: Record<string, string> = {
  'add-to-cart': 'cart корзина кошик basket купить купити',
  'add-to-wishlist': 'wishlist избранное обране обраного',
  wishlist: 'wishlist избранное обране обраного',
  'add-to-compare': 'compare сравнить сравнение порівняти порівняння',
  compare: 'compare сравнить сравнение порівняти порівняння',
  'apply-filter': 'filter фильтр фільтр применить застосувати',
  search: 'search поиск пошук найти знайти',
  'nav-delivery': 'delivery доставка',
  'nav-cart': 'cart корзина кошик basket',
  'nav-contacts': 'contacts контакты контакти',
  'nav-catalog': 'catalog каталог',
  'cookie-accept': 'cookie куки кукі баннер банер accept принять прийняти',
  'cookie-close': 'cookie куки кукі баннер банер close закрыть закрити',
};

/** Путь похож на страницу оплаты/платёжный шлюз (§5-бис.5: «никогда»). */
export function paymentPath(path: string): boolean {
  return /(^|[/_.-])(checkout|payment|payments|pay|oplata|оплата|kasa|kassa|gateway|liqpay|wayforpay|fondy|stripe|paypal)([/_.-]|$)/iu.test(
    path,
  );
}

// ── Подтверждение и «стоп» голосом (§5-бис.5) — закрытые списки ─────────

const YES = new Set(
  [
    'да',
    'так',
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'ок',
    'окей',
    'давай',
    'давайте',
    'підтверджую',
    'подтверждаю',
    'confirm',
    'звісно',
    'конечно',
    'sure',
    'ага',
  ].map(normText),
);
const NO = new Set(
  [
    'нет',
    'ні',
    'no',
    'nope',
    'не',
    'не надо',
    'не треба',
    'отмена',
    'скасуй',
    'скасувати',
    'отмени',
    'cancel',
    'не нужно',
    'не потрібно',
  ].map(normText),
);
const STOP_WORDS = new Set(
  [
    'стоп',
    'хватит',
    'зупинись',
    'зупини',
    'зупиніть',
    'stop',
    'досить',
    'остановись',
    'остановите',
    'стій',
    'стой',
    'halt',
    'пауза',
    'pause',
  ].map(normText),
);

function words(raw: string): string[] {
  return normText(raw)
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);
}

/**
 * «Да»/«Нет»/«Стоп» — фраза целиком из закрытого списка (до трёх слов,
 * первое — из списка, остальные — повтор или «пожалуйста»). Иначе — не
 * ответ, а новая команда: ложно распознанная фраза не подтверждает.
 */
export function replyKind(raw: string): 'yes' | 'no' | 'stop' | null {
  const w = words(raw);
  if (!w.length || w.length > 3) return null;
  const tail = (set: ReadonlySet<string>) =>
    w
      .slice(1)
      .every(
        (x) =>
          set.has(x) || ['будь', 'ласка', 'пожалуйста', 'please'].includes(x),
      );
  const two = w.slice(0, 2).join(' ');
  if (STOP_WORDS.has(w[0]) && tail(STOP_WORDS)) return 'stop';
  if (NO.has(two) && w.length <= 3) return 'no';
  if (NO.has(w[0]) && tail(NO)) return 'no';
  if (YES.has(w[0]) && tail(YES)) return 'yes';
  return null;
}
