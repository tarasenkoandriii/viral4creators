/**
 * Заход 9 (Э6-тер (12)): промахи Т-4 по целям карты — «нажмите сами»,
 * «цель не найдена», «не туда» (стоп человеком ≤ 5 с после шага цели),
 * «промах карты» (`mapMiss` с ключом названной цели — пишет план) и
 * страницы таких промахов — чистая свёртка журнала.
 */
import { mapMissStats, mapMissWrongs, type MapMissRow } from './map-misses';

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
  it('заход 11 (№113): `all` — и цели только с «выполнено» (тепловые значки); без `all` — прежний список', () => {
    const rows = [
      row({ planId: 'h1', mapKey: 'cart', result: 'manual', reason: 'x' }),
      row({ planId: 'h2', mapKey: 'ok', result: 'done' }),
      row({ planId: 'h3', mapKey: 'ok', result: 'done' }),
    ];
    expect(mapMissStats(rows).items.map((i) => i.key)).toEqual(['cart']);
    const all = mapMissStats(rows, { all: true }).items;
    expect(all.map((i) => [i.key, i.done, i.self])).toEqual([
      ['cart', 0, 1],
      ['ok', 2, 0],
    ]);
  });

  it('заход 11 (№113): `mapMissWrongs` — план и цель «не туда» (те же правила, что счётчик `wrong`)', () => {
    const rows = [
      row({ planId: 'w1', mapKey: 'footer', result: 'done', dt: 1_000 }),
      row({ planId: 'w1', action: 'stop', reason: 'click', dt: 3_000 }),
      row({ planId: 'w2', mapKey: 'footer', result: 'done', dt: 10_000 }),
      row({ planId: 'w2', action: 'stop', reason: 'click', dt: 16_000 }),
      row({ planId: 'w3', mapKey: 'menu', result: 'done', dt: 20_000 }),
      row({ planId: 'w3', action: 'stop', reason: 'timeout', dt: 21_000 }),
    ];
    expect(mapMissWrongs(rows)).toEqual([
      { key: 'footer', planId: 'w1', multi: false },
    ]);
    // Аудит P3-9 (г): план нескольких целей карты — `multi` (фраза не про одну цель).
    const two = [
      row({ planId: 'm1', mapKey: 'cart', result: 'done', dt: 30_000 }),
      row({ planId: 'm1', mapKey: 'pay', result: 'done', dt: 31_000 }),
      row({ planId: 'm1', action: 'stop', reason: 'esc', dt: 32_000 }),
    ];
    expect(mapMissWrongs(two)).toEqual([
      { key: 'pay', planId: 'm1', multi: true },
    ]);
    expect(mapMissStats(rows).items.map((i) => [i.key, i.wrong])).toEqual([
      ['footer', 1],
    ]);
  });
});
