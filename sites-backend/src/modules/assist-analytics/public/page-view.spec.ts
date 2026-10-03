/**
 * Э3-бис: итог просмотра (§5-тер.8, К-11, §5-тер.16 п.13) — строгий белый
 * список полей, нормализация пути и источника, без отпечатка.
 */
import { WIDGET_PK_LIVE_PREFIX } from '../../../brand';
import {
  normalizePath,
  parsePageView,
  sourceCategory,
  uaFamily,
} from './page-view';

const ok = {
  pk: `${WIDGET_PK_LIVE_PREFIX}x`,
  pv: 'pv_1234567890ab',
  v: 'visit_1234567890abcd',
  p: '/catalog/123/item?utm_source=x#top',
  d: 'm',
  sc: 80,
  ac: 12_000,
  to: 30_000,
  ck: 5,
  rg: 1,
  er: 1,
  eg: [{ h: 'ab12', m: 'TypeError at ivan@example.com', s: 'cdn.example.com' }],
  fs: 1,
  fb: 0,
  fa: 'phone',
  fi: 2,
  bk: 0,
  l: 2300,
  i: 180,
  c: 0.04,
  ch: 1,
};

describe('итог просмотра (Э3-бис, К-11)', () => {
  it('годный итог: путь без query, :id вместо номеров, маска в ошибке', () => {
    const r = parsePageView(ok);
    expect(r).not.toBeNull();
    expect(r!.path).toBe('/catalog/:id/item');
    expect(r!.errorGroups[0].m).not.toContain('ivan@');
    expect(r!.formAbandonField).toBe('phone');
  });

  it('неизвестное поле (значение поля, клавиши, координаты, UA) — отказ целиком', () => {
    for (const extra of [
      { value: '4111 1111 1111 1111' },
      { keys: 'qwerty' },
      { x: 10, y: 20 },
      { ua: 'Mozilla/5.0' },
      { gclid: 'abc' },
    ]) {
      expect(parsePageView({ ...ok, ...extra })).toBeNull();
    }
  });

  it('без ключа визита (нет согласия) — отказ; кривые типы — отказ', () => {
    const { v: _v, ...noVisit } = ok;
    expect(parsePageView(noVisit)).toBeNull();
    expect(parsePageView({ ...ok, sc: 101 })).toBeNull();
    expect(parsePageView({ ...ok, fa: 'name"><img' })).toBeNull();
    expect(parsePageView({ ...ok, d: 'phone' })).toBeNull();
  });

  it('путь: UUID/хеши → :id; не путь — null', () => {
    expect(normalizePath('/order/3f2a9c1e-1234-4abc-9def-0123456789ab')).toBe(
      '/order/:id',
    );
    expect(normalizePath('https://evil.example/')).toBeNull();
  });

  it('аудит: ПД в пути (e-mail, %40, телефон, номер заказа) → :id; обычные слова — как есть', () => {
    expect(normalizePath('/unsubscribe/ivan.petrenko@example.com')).toBe(
      '/unsubscribe/:id',
    );
    expect(normalizePath('/u/ivan%40example.com/orders')).toBe('/u/:id/orders');
    expect(normalizePath('/call/+38(050)123-45-67')).toBe('/call/:id');
    expect(normalizePath('/order-1234567/thanks')).toBe('/:id/thanks');
    expect(normalizePath('/catalog/iphone-15-pro')).toBe(
      '/catalog/iphone-15-pro',
    );
  });

  it('источник и семейство UA без версий', () => {
    expect(sourceCategory('www.google.com', null, 'shop.ua')).toBe('search');
    expect(sourceCategory('t.me', null, 'shop.ua')).toBe('messenger');
    expect(sourceCategory('shop.ua', null, 'shop.ua')).toBe('direct');
    expect(sourceCategory('blog.ua', 'cpc', 'shop.ua')).toBe('ads');
    expect(
      uaFamily(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ os: 'ios', browser: 'safari' });
  });
});
