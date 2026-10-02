/**
 * AssistPaymentProviders.charge — разбор ответа host2host `Charge`
 * WayForPay (аудит Э4): нет `transactionStatus` — исход неизвестен, это
 * НЕ терминальный отказ (иначе крон пометит платёж failed и следующая
 * попытка пойдёт новым orderReference — риск второго списания).
 */
import { AssistPaymentProviders, CHARGE_STATUS_UNKNOWN } from './providers';
import { WFP_TERMINAL_FAILURES } from './payments.service';

const CFG = {
  merchantAccount: 'm',
  merchantSecret: 'secret-secret',
  domain: 'e4.example.com',
};
const INPUT = {
  recToken: 'rt',
  orderReference: 'ren_acc_1_1',
  amountMinor: 78850,
  currency: 'UAH',
  productName: 'Помощник start — продление 30 дней',
};

function withResponse(json: () => Promise<unknown>) {
  const p = new AssistPaymentProviders();
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  p.fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return { ok: true, status: 200, json };
  };
  return { p, calls };
}

describe('AssistPaymentProviders.charge — статус ответа', () => {
  it('Approved — ok, recToken из ответа', async () => {
    const { p, calls } = withResponse(async () => ({
      transactionStatus: 'Approved',
      reasonCode: 1100,
      recToken: 'rt2',
    }));
    const r = await p.charge(CFG, INPUT);
    expect(r).toMatchObject({
      ok: true,
      transactionStatus: 'Approved',
      recToken: 'rt2',
    });
    expect(calls[0].body).toMatchObject({
      transactionType: 'CHARGE',
      orderReference: INPUT.orderReference,
      amount: '788.5',
    });
  });

  it('Declined — терминальный отказ', async () => {
    const { p } = withResponse(async () => ({
      transactionStatus: 'Declined',
      reasonCode: 1101,
    }));
    const r = await p.charge(CFG, INPUT);
    expect(r.ok).toBe(false);
    expect(WFP_TERMINAL_FAILURES.has(r.transactionStatus)).toBe(true);
  });

  it.each([
    [
      'ошибка запроса без transactionStatus (Duplicate Order ID)',
      async () => ({ reason: 'Duplicate Order ID', reasonCode: 1112 }),
    ],
    [
      'тело не JSON (502 шлюза)',
      async () => {
        throw new SyntaxError('bad json');
      },
    ],
    ['пустой transactionStatus', async () => ({ transactionStatus: '' })],
  ])('%s — исход неизвестен, не терминальный отказ', async (_name, json) => {
    const { p } = withResponse(json);
    const r = await p.charge(CFG, INPUT);
    expect(r.ok).toBe(false);
    expect(r.transactionStatus).toBe(CHARGE_STATUS_UNKNOWN);
    expect(WFP_TERMINAL_FAILURES.has(r.transactionStatus)).toBe(false);
  });
});
