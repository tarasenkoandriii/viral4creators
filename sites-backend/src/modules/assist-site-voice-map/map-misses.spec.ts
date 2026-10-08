/**
 * Заход 9 (Э6-тер (12)): промахи Т-4 по целям карты — «нажмите сами»,
 * «цель не найдена», «не туда» (стоп человеком ≤ 5 с после шага цели),
 * «промах карты» (`mapMiss` с ключом названной цели — пишет план) и
 * страницы таких промахов — чистая свёртка журнала.
 */
import { mapMissStats, type MapMissRow } from './map-misses';

const T0 = Date.parse('2026-10-08T10:00:00Z');
let n = 0;
function row(
  p: Partial<MapMissRow> & { planId: string; dt?: number },
): MapMissRow {
  n++;
  return {
    action: 'click',
    result: 'done',
    reason: null,
    mapKey: null,
    mapMiss: false,
    url: 'https://shop.ua/product/1',
    createdAt: new Date(T0 + (p.dt ?? n * 10)),
    ...p,
  };
}

describe('промахи Т-4 по целям голосовой карты', () => {
  it('«нажмите сами», «цель не найдена», «выполнено» — по ключу цели; без проблем — не в списке', () => {
    const v = mapMissStats([
      row({
        planId: 'p1',
        mapKey: 'cart',
        result: 'manual',
        reason: 'not_trusted',
      }),
      row({
        planId: 'p2',
        mapKey: 'cart',
        result: 'failed',
        reason: 'no_target',
      }),
      row({ planId: 'p3', mapKey: 'cart', result: 'done' }),
      row({ planId: 'p4', mapKey: 'ok', result: 'done' }),
      // Служебные строки плана с ключом не считаются шагом цели.
      row({ planId: 'p5', mapKey: 'cart', action: 'plan', result: 'manual' }),
    ]);
    expect(v.items).toEqual([
      expect.objectContaining({
        key: 'cart',
        self: 1,
        notFound: 1,
        wrong: 0,
        done: 1,
        page: '/product/1',
      }),
    ]);
  });

  it('«не туда»: стоп человеком ≤ 5 с после исполненного шага цели — этой цели; позже или не человеком — нет', () => {
    const v = mapMissStats([
      row({ planId: 'a', mapKey: 'delivery', result: 'done', dt: 0 }),
      row({
        planId: 'a',
        action: 'stop',
        result: 'stopped',
        reason: 'click',
        dt: 3_000,
      }),
      row({ planId: 'b', mapKey: 'delivery', result: 'done', dt: 10_000 }),
      row({
        planId: 'b',
        action: 'stop',
        result: 'stopped',
        reason: 'esc',
        dt: 17_000,
      }),
      row({ planId: 'c', mapKey: 'delivery', result: 'done', dt: 20_000 }),
      row({
        planId: 'c',
        action: 'stop',
        result: 'stopped',
        reason: 'timeout',
        dt: 21_000,
      }),
    ]);
    expect(v.items).toEqual([
      expect.objectContaining({ key: 'delivery', wrong: 1, done: 3 }),
    ]);
  });

  it('`mapMiss` с ключом — «промах карты» этой цели (и в списке без других бед); страницы — по числу промахов, старые строки без ключа — только страница', () => {
    const v = mapMissStats([
      row({
        planId: 'x',
        action: 'plan',
        mapMiss: true,
        url: 'https://shop.ua/cart?id=1',
      }),
      row({
        planId: 'y',
        action: 'plan',
        mapMiss: true,
        url: 'https://shop.ua/cart',
      }),
      row({
        planId: 'z',
        action: 'plan',
        mapMiss: true,
        url: 'https://shop.ua/',
      }),
    ]);
    expect(v.pages.map((p) => [p.page, p.misses])).toEqual([
      ['/cart', 2],
      ['/', 1],
    ]);
    expect(v.items).toEqual([]);
    expect(v.days).toBe(7);
    const k = mapMissStats([
      row({
        planId: 'k1',
        action: 'plan',
        mapMiss: true,
        mapKey: 'delivery',
        url: 'https://shop.ua/cart',
      }),
      row({ planId: 'k2', action: 'plan', mapMiss: true, mapKey: 'delivery' }),
    ]);
    expect(k.items).toEqual([
      expect.objectContaining({ key: 'delivery', missed: 2, self: 0 }),
    ]);
    expect(k.pages.map((p) => p.misses).reduce((a, b) => a + b)).toBe(2);
  });
});
