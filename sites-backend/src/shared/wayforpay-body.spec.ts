// СГЕНЕРИРОВАНО scripts/sync-sites-shared.mjs — не править.
// Источник: backend/src/common/wayforpay-body.spec.ts. Правка — в источнике, затем
// `node scripts/sync-sites-shared.mjs`; CI сверяет копию флагом --check.

import { wayforpayBody } from './wayforpay-body';

describe('wayforpayBody: тело вебхука WayForPay в один вид', () => {
  const ev = {
    merchantAccount: 'm',
    orderReference: 'ORD-1',
    amount: 10,
    currency: 'UAH',
    transactionStatus: 'Approved',
    reasonCode: 1100,
    merchantSignature: 'sig',
  };

  it('JSON-объект — как есть', () => {
    expect(wayforpayBody(ev)).toEqual(ev);
  });

  it('форма с JSON строкой-ключом и пустым значением — разбирается', () => {
    expect(wayforpayBody({ [JSON.stringify(ev)]: '' })).toEqual(ev);
  });

  it('форма с битым JSON-ключом — {}', () => {
    expect(wayforpayBody({ '{"orderReference":': '' })).toEqual({});
  });

  it('JSON-ключ, в котором не объект (массив/число) — {}', () => {
    expect(wayforpayBody({ '[1,2]': '' })).toEqual({ '[1,2]': '' });
    expect(wayforpayBody('[1,2]')).toEqual({});
    expect(wayforpayBody('42')).toEqual({});
  });

  it('строка (text/plain) с JSON — разбирается, мусор — {}', () => {
    expect(wayforpayBody(JSON.stringify(ev))).toEqual(ev);
    expect(wayforpayBody('not json')).toEqual({});
  });

  it('без тела: undefined / null / {} / пустая строка — {}', () => {
    expect(wayforpayBody(undefined)).toEqual({});
    expect(wayforpayBody(null)).toEqual({});
    expect(wayforpayBody({})).toEqual({});
    expect(wayforpayBody('')).toEqual({});
  });

  it('массив и число — {}', () => {
    expect(wayforpayBody([ev])).toEqual({});
    expect(wayforpayBody(42)).toEqual({});
  });
});
