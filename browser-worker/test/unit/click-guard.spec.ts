import { firstPartyCookies } from '../../src/jobs/admin-crawl';
import {
  clickRefusal,
  linkRefusal,
  toggleLinkRefusal,
} from '../../src/safety/click-guard';

const H = ['admin.shop.test'];
const t = (
  text: string,
  extra: Partial<{
    hidden: string | null;
    submit: boolean;
    inForm: boolean;
  }> = {},
) => ({
  text,
  hidden: null,
  submit: false,
  inForm: false,
  ...extra,
});

describe('стоп-лист кликов и переходов воркера', () => {
  it.each([
    'Видалити',
    'Удалить товар',
    'Оплатити',
    'Оформити замовлення',
    'Скасувати замовлення',
    'Повернення коштів',
    'Delete',
    'Виділити все',
    'Надіслати заявку',
    'Підписатися',
  ])('опасная цель «%s» — отказ', (text) => {
    expect(clickRefusal(t(text))).toBe('danger');
  });

  it('скрытое имя тоже проверяется (иконка-корзина с aria-label)', () => {
    expect(clickRefusal(t('', { hidden: 'Видалити замовлення' }))).toBe(
      'danger',
    );
  });

  it('раскрывашки меню — можно; в форме и отправка — нельзя; без имени — нельзя', () => {
    expect(clickRefusal(t('Меню'))).toBeNull();
    expect(clickRefusal(t('Звіти'))).toBeNull();
    expect(clickRefusal(t('Ще', { inForm: true }))).toBe('form');
    expect(clickRefusal(t('Далі', { submit: true, inForm: true }))).toBe(
      'form',
    );
    expect(clickRefusal(t(''))).toBe('unnamed');
  });

  it.each([
    ['https://admin.shop.test/admin/orders', 'Замовлення', null],
    ['https://admin.shop.test/logout', 'Вийти', 'logout'],
    ['https://admin.shop.test/account', 'Вийти', 'logout'],
    ['https://admin.shop.test/user/sign-out', 'Профіль', 'logout'],
    ['https://admin.shop.test/admin/orders/5/delete', 'Прибрати', 'danger'],
    [
      'https://admin.shop.test/admin/orders?action=delete&id=5',
      'Деталі',
      'danger',
    ],
    ['https://admin.shop.test/checkout/pay', 'Деталі', 'danger'],
    ['https://admin.shop.test/admin/items', 'Видалити всі', 'danger'],
    ['https://other.test/admin', 'Зовнішній', 'offhost'],
    ['https://u:p@admin.shop.test/', 'Логін в адресі', 'scheme'],
    ['javascript:alert(1)', 'js', 'scheme'],
    // Аудит 06.10.2026: выжившие мутации стоп-листа — нейтральный текст,
    // опасный путь; закодированный путь; платёжные шлюзы.
    ['https://admin.shop.test/orders/5/refund', 'Деталі', 'danger'],
    ['https://admin.shop.test/payments/7/void', 'Деталі', 'danger'],
    ['https://admin.shop.test/reviews/3/approve', 'Деталі', 'danger'],
    ['https://admin.shop.test/reviews/3/reject', 'Деталі', 'danger'],
    ['https://admin.shop.test/news/unsubscribe', 'Деталі', 'danger'],
    ['https://admin.shop.test/tables/logs/truncate', 'Деталі', 'danger'],
    ['https://admin.shop.test/orders/5/%64elete', 'Деталі', 'danger'],
    ['https://admin.shop.test/liqpay/redirect', 'Деталі', 'danger'],
    ['https://admin.shop.test/wayforpay/return', 'Деталі', 'danger'],
    ['https://admin.shop.test/fondy/callback', 'Деталі', 'danger'],
    ['https://admin.shop.test/stripe/session', 'Деталі', 'danger'],
    ['https://admin.shop.test/paypal/redirect', 'Деталі', 'danger'],
    ['https://admin.shop.test/admin/approvals-history', 'Деталі', null],
  ])('%s «%s» → %s', (href, text, want) => {
    expect(linkRefusal(href, text, H)).toBe(want);
  });

  it('cookie сессии — только регистрируемого домена хоста задания', () => {
    const raw = JSON.stringify([
      { name: 'sid', value: 'a', domain: '.shop.test', path: '/' },
      { name: 'host', value: 'b', domain: 'admin.shop.test' },
      { name: 'sso', value: 'c', domain: '.google.com' },
      { name: 'evil', value: 'd', domain: 'evilshop.test' },
    ]);
    const out = firstPartyCookies(raw, 'admin.shop.test');
    expect(out.map((c) => c.name)).toEqual(['sid', 'host']);
    expect(firstPartyCookies('not json', 'admin.shop.test')).toEqual([]);
  });

  describe('раскрывашка-ссылка (аудит Ш3)', () => {
    const here = 'https://admin.shop.test/admin';
    it.each([
      ['https://admin.shop.test/admin/orders/7/delete', 'Ще', 'danger'],
      ['https://admin.shop.test/logout', 'Профіль', 'logout'],
      ['https://other.example/menu', 'Меню', 'offhost'],
      ['/admin/orders?do=remove&id=3', 'Ще', 'danger'],
    ])('%s («%s») — %s', (href, text, why) => {
      expect(toggleLinkRefusal(href, here, text, H)).toBe(why);
    });

    it('не переход — решает clickRefusal', () => {
      expect(toggleLinkRefusal(null, here, 'Меню', H)).toBeNull();
      expect(toggleLinkRefusal(`${here}#`, here, 'Меню', H)).toBeNull();
      expect(toggleLinkRefusal(`${here}#more`, here, 'Меню', H)).toBeNull();
      expect(
        toggleLinkRefusal('javascript:void(0)', here, 'Меню', H),
      ).toBeNull();
      // Обычная ссылка своего хоста — как ссылка обхода: можно.
      expect(toggleLinkRefusal('/admin/reports', here, 'Звіти', H)).toBeNull();
    });
  });
});
