/**
 * Курсы валют аукциона. Таблица статичная и обновляется вручную — тесты
 * намеренно НЕ закрепляют конкретные числа курсов (иначе обновление
 * курса ломало бы сборку), а закрепляют свойства, нарушение которых
 * показывает оператору или покупателю неверную сумму:
 *
 *  - конверсия в саму себя ничего не меняет и не округляет;
 *  - туда-обратно даёт исходную сумму;
 *  - у КАЖДОЙ валюты из COUNTRY_CURRENCY есть курс. Это не теория:
 *    таблица стран и таблица курсов лежат в одном файле, но никак не
 *    связаны типом через значения — добавить страну с валютой, которой
 *    нет в UAH_PER_UNIT, компилятор не мешает, а результат — NaN в
 *    цене на витрине.
 */

import {
  COUNTRY_CURRENCY,
  convertForDisplay,
  toUahMinorUnits,
} from './fx-rates';
import type { AuctionCurrencyValue } from './types/marketplace.types';

const CURRENCIES: AuctionCurrencyValue[] = ['UAH', 'USD', 'EUR'];

describe('convertForDisplay', () => {
  it('конверсия валюты в саму себя возвращает исходную сумму без округления', () => {
    // Важно именно «без округления»: toAdminView отдаёт null для UAH, но
    // сам хелпер вызывается и из других мест — грубое округление до
    // копейки на тождественной конверсии было бы тихой потерей точности.
    expect(convertForDisplay(1234.567, 'UAH', 'UAH')).toBe(1234.567);
    expect(convertForDisplay(99.99, 'USD', 'USD')).toBe(99.99);
  });

  it('USD → UAH и обратно возвращает исходную сумму', () => {
    const uah = convertForDisplay(100, 'USD', 'UAH');
    expect(uah).toBeGreaterThan(100); // гривна слабее доллара — иначе таблица перевёрнута
    expect(convertForDisplay(uah, 'UAH', 'USD')).toBeCloseTo(100, 1);
  });

  it('результат округлён до двух знаков — не показываем ложную точность', () => {
    for (const from of CURRENCIES) {
      for (const to of CURRENCIES) {
        if (from === to) continue;
        const value = convertForDisplay(1, from, to);
        expect(Number.isFinite(value)).toBe(true);
        expect(Math.round(value * 100) / 100).toBe(value);
      }
    }
  });

  it('ноль остаётся нулём в любой паре', () => {
    for (const from of CURRENCIES) {
      for (const to of CURRENCIES) {
        expect(convertForDisplay(0, from, to)).toBe(0);
      }
    }
  });
});

describe('toUahMinorUnits', () => {
  it('UAH переводится в копейки один к одному', () => {
    expect(toUahMinorUnits(10, 'UAH')).toBe(1000);
    expect(toUahMinorUnits(19.99, 'UAH')).toBe(1999);
  });

  it('иностранная валюта пересчитывается по курсу и даёт целое число копеек', () => {
    for (const currency of CURRENCIES) {
      const minor = toUahMinorUnits(37.37, currency);
      expect(Number.isInteger(minor)).toBe(true);
      expect(minor).toBeGreaterThan(0);
    }
    expect(toUahMinorUnits(10, 'USD')).toBeGreaterThan(
      toUahMinorUnits(10, 'UAH'),
    );
  });
});

describe('COUNTRY_CURRENCY', () => {
  it('у каждой валюты из таблицы стран есть курс — иначе на витрине окажется NaN', () => {
    for (const [country, currency] of Object.entries(COUNTRY_CURRENCY)) {
      const converted = convertForDisplay(100, currency, 'UAH');
      expect(Number.isFinite(converted)).toBe(true);
      expect(Number.isNaN(converted)).toBe(false);
      // toUahMinorUnits ходит в ту же таблицу другим путём — проверяем оба.
      expect(Number.isFinite(toUahMinorUnits(100, currency))).toBe(true);
      expect(CURRENCIES).toContain(currency);
      expect(country).toMatch(/^[A-Z]{2}$/); // ISO-2, как в заголовке x-vercel-ip-country
    }
  });

  it('Украина, США и страна еврозоны разложены по ожидаемым валютам', () => {
    expect(COUNTRY_CURRENCY.UA).toBe('UAH');
    expect(COUNTRY_CURRENCY.US).toBe('USD');
    expect(COUNTRY_CURRENCY.DE).toBe('EUR');
  });

  it('неизвестная страна не даёт валюту — вызывающий обязан иметь запасной вариант', () => {
    expect(COUNTRY_CURRENCY.ZZ).toBeUndefined();
  });
});
