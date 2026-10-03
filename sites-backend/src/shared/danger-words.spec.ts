// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/modules/client-site-tutorial/danger-words.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

/**
 * Стоп-лист необратимых действий (§8.3 ТЗ, этап 112).
 *
 * Тут ровно две вещи, которые могут пойти не так, и обе одинаково
 * плохи: пропустить «Оплатить» (визард молча оформит настоящий заказ на
 * сайте заказчика) и срабатывать на всё подряд (предупреждение, которое
 * горит всегда, перестают читать — и тогда оно не работает вовсе).
 */

import { DANGER_KINDS, dangerKindsFor, dangerWarningFor } from './danger-words';

describe('ловит настоящие необратимые действия', () => {
  const dangerous = [
    'Оплатить',
    'Оплатить заказ',
    'Сплатити',
    'Pay now',
    'Proceed to checkout',
    'Удалить',
    'Видалити',
    'Delete account',
    'Remove item',
    'Оформить заказ',
    'Підтвердити замовлення',
    'Place order',
    'Buy now',
    'Купить в один клик',
    'Отменить подписку',
    'Unsubscribe',
  ];

  it.each(dangerous)('«%s» — предупреждение', (text) => {
    expect(dangerWarningFor(text)).toBeDefined();
  });

  it('текст предупреждения объясняет, ЧТО именно случится', () => {
    const warning = dangerWarningFor('Оплатить');
    expect(warning).toContain('оплата');
    // Главное, что должен понять человек: это не репетиция.
    expect(warning).toContain('по-настоящему');
  });

  it('регистр не важен — кнопки бывают КАПСОМ', () => {
    expect(dangerWarningFor('УДАЛИТЬ')).toBeDefined();
  });

  it('несколько совпадений перечисляются, но не дублируются', () => {
    const warning = dangerWarningFor('Удалить и оплатить заново, удалить');
    expect(warning).toContain('оплата');
    expect(warning).toContain('удаление');
    expect(warning?.match(/удаление/g)).toHaveLength(1);
  });
});

describe('не срабатывает на обычных кнопках', () => {
  const safe = [
    'Войти',
    'Далее',
    'Сохранить',
    'Продолжить',
    'Личный кабинет',
    'Каталог',
    'Search',
    'Sign in',
    'Add to cart',
    'Подробнее',
  ];

  it.each(safe)('«%s» — тишина', (text) => {
    expect(dangerWarningFor(text)).toBeUndefined();
  });

  it('совпадение в СЕРЕДИНЕ слова не считается', () => {
    // «Неоплаченные заказы» — обычный пункт меню. Без привязки к началу
    // слова он давал бы «похоже на оплату» на каждом раунде.
    expect(dangerWarningFor('Неоплаченные заказы')).toBeUndefined();
    expect(dangerWarningFor('Repayment history')).toBeUndefined();
  });
});

describe('вход с чужой страницы не должен ничего ронять', () => {
  it('пустой текст и undefined — тишина, а не исключение', () => {
    expect(dangerWarningFor(undefined)).toBeUndefined();
    expect(dangerWarningFor('')).toBeUndefined();
  });

  it('километровый текст обрабатывается и не вешает регулярки', () => {
    const long = `${'а'.repeat(50_000)} оплатить`;
    // Проверка идёт по первым 300 символам — «оплатить» в хвосте
    // километрового абзаца это не кнопка, а промах селектора.
    expect(dangerWarningFor(long)).toBeUndefined();
    expect(dangerWarningFor(`Оплатить ${'а'.repeat(50_000)}`)).toBeDefined();
  });
});

/**
 * Аудит 1.2 ТЗ помощника §5-бис.5: экспорт категорий для стоп-листа кликов
 * голосового управления — БЕЗ изменения поведения `dangerWarningFor`.
 */
describe('dangerKindsFor — категории для стоп-листа кликов помощника', () => {
  it.each([
    ['Оплатить заказ', ['оплата']],
    ['Видалити', ['удаление']],
    ['Купити', ['оформление заказа']],
    ['Place order', ['оформление заказа']],
    ['Отправить заявку', ['отправка сообщения']],
    ['Скасувати підписку', ['отмена подписки']],
    ['Удалить и оплатить, удалить', ['оплата', 'удаление']],
  ])('«%s» → %j', (text, kinds) => {
    expect(dangerKindsFor(text)).toEqual(kinds);
  });

  it('пусто, undefined и обычные кнопки — пустой список', () => {
    expect(dangerKindsFor(undefined)).toEqual([]);
    expect(dangerKindsFor('')).toEqual([]);
    expect(dangerKindsFor('Неоплаченные заказы')).toEqual([]);
    expect(dangerKindsFor('Add to cart')).toEqual([]);
  });

  it('категории — ровно словарь DANGER_KINDS', () => {
    expect([...DANGER_KINDS]).toEqual([
      'оплата',
      'удаление',
      'оформление заказа',
      'отправка сообщения',
      'отмена подписки',
    ]);
  });

  it('dangerWarningFor не изменился: тот же текст, что и до экспорта категорий', () => {
    expect(dangerWarningFor('Удалить и оплатить заново, удалить')).toBe(
      'Похоже на необратимое действие на сайте заказчика (оплата, удаление). Шаг выполнится по-настоящему — убедитесь, что это тестовые данные.',
    );
    for (const t of ['Оплатить', 'Купить', 'Unsubscribe', 'Send message']) {
      const kinds = dangerKindsFor(t);
      expect(dangerWarningFor(t)).toBe(
        `Похоже на необратимое действие на сайте заказчика (${kinds.join(', ')}). Шаг выполнится по-настоящему — убедитесь, что это тестовые данные.`,
      );
    }
  });
});
