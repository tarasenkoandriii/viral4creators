/**
 * Граница «мажорные ↔ минорные единицы» — единственное место, через
 * которое проходит КАЖДАЯ денежная величина аукциона: стартовая цена,
 * резерв, «купить сейчас», сама ставка, сумма AuctionPayment, комиссия.
 *
 * Зачем тесты именно здесь (docs-tz/AUDIT-Auction-Money-Currency.md):
 * до того аудита цены были Float в мажорных единицах, и ошибка
 * округления накапливалась на сравнениях ставок. Перевод на Int в
 * минорных единицах эту проблему снял, но ровно до тех пор, пока
 * конвертация на границе остаётся корректной — а наивная реализация
 * (`Math.floor(x * 100)` или `parseInt`) выглядит правильной и
 * ошибается на ценах вида 19.99, где двоичное представление даёт
 * 1998.9999999999998.
 */

import { toMajorUnits, toMinorUnits } from './money';

describe('toMinorUnits — мажорные → минорные', () => {
  it('целые и «круглые» суммы переводятся точно', () => {
    expect(toMinorUnits(0)).toBe(0);
    expect(toMinorUnits(1)).toBe(100);
    expect(toMinorUnits(1500)).toBe(150_000);
    expect(toMinorUnits(1234.56)).toBe(123_456);
  });

  it('цены с .99 не теряют копейку — классический промах Math.floor', () => {
    // 19.99 * 100 === 1998.9999999999998 в двоичной плавающей точке:
    // floor дал бы 1998, то есть лот, выставленный за 19.99, хранился бы
    // как 19.98 и ставка ровно в 19.99 «перебивала» бы старт ошибочно.
    expect(toMinorUnits(19.99)).toBe(1999);
    expect(toMinorUnits(4.99)).toBe(499);
    expect(toMinorUnits(1.1)).toBe(110);
    expect(toMinorUnits(2.2)).toBe(220);
    expect(toMinorUnits(8.22)).toBe(822);
  });

  it('третий знак округляется, а не отбрасывается молча', () => {
    // Наружу цены с долями копейки не выставляются (форма их не
    // принимает), но API — открытая граница: важно, что такой ввод
    // превращается в целое число минорных единиц, а не в дробное,
    // которое Prisma отвергнет на уровне Int-колонки.
    expect(Number.isInteger(toMinorUnits(10.123))).toBe(true);
    expect(toMinorUnits(10.126)).toBe(1013);
    expect(toMinorUnits(10.124)).toBe(1012);
  });

  it('результат всегда целый — на этом держится Int-колонка в БД', () => {
    for (const major of [0.01, 0.07, 3.33, 7.07, 19.99, 99.95, 12_345.67]) {
      expect(Number.isInteger(toMinorUnits(major))).toBe(true);
    }
  });
});

describe('toMajorUnits — минорные → мажорные', () => {
  it('переводит обратно ровно', () => {
    expect(toMajorUnits(0)).toBe(0);
    expect(toMajorUnits(1)).toBe(0.01);
    expect(toMajorUnits(1999)).toBe(19.99);
    expect(toMajorUnits(123_456)).toBe(1234.56);
  });
});

describe('круговой ход мажорные → минорные → мажорные', () => {
  it('возвращает исходную цену для любой суммы с двумя знаками', () => {
    for (const major of [
      0, 0.01, 0.99, 1, 19.99, 49.5, 100, 4999.95, 123_456.78,
    ]) {
      expect(toMajorUnits(toMinorUnits(major))).toBe(major);
    }
  });

  it('сложение в минорных единицах не накапливает ошибку, в мажорных — накапливает', () => {
    // Это и есть причина миграции на Int: сравнение ставок и подсчёт
    // комиссии идут суммированием/умножением, и во Float результат
    // «уезжает» от ожидаемого настолько, что строгое `>` даёт неверный
    // ответ на равных по смыслу суммах.
    const steps = Array(10).fill(0.1) as number[];

    const naiveFloatSum = steps.reduce((a, b) => a + b, 0);
    expect(naiveFloatSum).toBe(0.9999999999999999); // не 1 — так считалось до аудита
    expect(naiveFloatSum < 1).toBe(true); // строгое `>` на такой сумме отвечает неверно

    const minorSum = steps.map(toMinorUnits).reduce((a, b) => a + b, 0);
    expect(minorSum).toBe(100);
    expect(toMajorUnits(minorSum)).toBe(1);
  });
});
