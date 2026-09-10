import axios from 'axios';
import { createHmac } from 'crypto';
import { WayForPayService } from './wayforpay.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const configState = {
  wayforpayMerchantAccount: 'merchant_test',
  wayforpayMerchantSecret: 'secret_test',
  wayforpayDomain: 'example.com',
};
jest.mock('../../config/configuration', () => ({
  loadConfiguration: () => ({ billing: configState }),
}));

function expectedSignature(fields: string[]): string {
  return createHmac('md5', configState.wayforpayMerchantSecret)
    .update(fields.join(';'), 'utf8')
    .digest('hex');
}

describe('WayForPayService', () => {
  let service: WayForPayService;

  beforeEach(() => {
    jest.clearAllMocks();
    configState.wayforpayMerchantAccount = 'merchant_test';
    configState.wayforpayMerchantSecret = 'secret_test';
    configState.wayforpayDomain = 'example.com';
    service = new WayForPayService();
  });

  describe('configured', () => {
    it('true, когда все три поля заданы', () => {
      expect(service.configured()).toBe(true);
    });

    it('false, если чего-то не хватает', () => {
      configState.wayforpayMerchantSecret = '';
      expect(service.configured()).toBe(false);
    });
  });

  describe('buildPurchaseForm', () => {
    it('строит поля формы с подписью по документированному порядку полей', () => {
      const form = service.buildPurchaseForm({
        orderReference: 'order-1',
        amount: 799,
        currency: 'UAH',
        productName: 'Standard — месяц',
        returnUrl: 'https://tma.example/return',
        serviceUrl: 'https://api.example/billing/webhook/wayforpay',
      });
      expect(form.url).toBe('https://secure.wayforpay.com/pay');
      expect(form.fields.merchantAccount).toBe('merchant_test');
      expect(form.fields.merchantDomainName).toBe('example.com');
      expect(form.fields.orderReference).toBe('order-1');
      expect(form.fields.amount).toBe('799');
      expect(form.fields.currency).toBe('UAH');
      expect(form.fields['productName[]']).toBe('Standard — месяц');
      expect(form.fields['productCount[]']).toBe('1');
      expect(form.fields['productPrice[]']).toBe('799');

      // Подпись сверяется независимым вычислением по документированному
      // порядку: merchantAccount;merchantDomainName;orderReference;
      // orderDate;amount;currency;productName;productCount;productPrice.
      const expected = expectedSignature([
        'merchant_test',
        'example.com',
        'order-1',
        form.fields.orderDate,
        '799',
        'UAH',
        'Standard — месяц',
        '1',
        '799',
      ]);
      expect(form.fields.merchantSignature).toBe(expected);
    });
  });

  describe('verifyServiceCallback', () => {
    it('принимает корректную подпись вебхука (порядок полей serviceUrl)', () => {
      const body = {
        merchantAccount: 'merchant_test',
        orderReference: 'order-1',
        amount: 799,
        currency: 'UAH',
        authCode: 'auth1',
        cardPan: '4242XXXXXXXX4242',
        transactionStatus: 'Approved',
        reasonCode: 1100,
      };
      const signature = expectedSignature([
        body.merchantAccount,
        body.orderReference,
        String(body.amount),
        body.currency,
        body.authCode,
        body.cardPan,
        body.transactionStatus,
        String(body.reasonCode),
      ]);
      expect(
        service.verifyServiceCallback({
          ...body,
          merchantSignature: signature,
        }),
      ).toBe(true);
    });

    it('отклоняет поддельную подпись', () => {
      expect(
        service.verifyServiceCallback({
          merchantAccount: 'merchant_test',
          orderReference: 'order-1',
          amount: 799,
          currency: 'UAH',
          transactionStatus: 'Approved',
          reasonCode: 1100,
          merchantSignature: 'wrong',
        }),
      ).toBe(false);
    });
  });

  describe('buildWebhookAck', () => {
    it('возвращает квитанцию с status:accept и подписью по orderReference;status;time', () => {
      const ack = service.buildWebhookAck('order-1');
      expect(ack.orderReference).toBe('order-1');
      expect(ack.status).toBe('accept');
      const expected = expectedSignature([
        'order-1',
        'accept',
        String(ack.time),
      ]);
      expect(ack.signature).toBe(expected);
    });
  });

  describe('chargeRecToken', () => {
    it('шлёт CHARGE с recToken и возвращает ok:true при Approved', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          transactionStatus: 'Approved',
          reasonCode: 1100,
          recToken: 'rt-1',
        },
      });
      const result = await service.chargeRecToken({
        recToken: 'rt-1',
        orderReference: 'renew-1',
        amount: 799,
        currency: 'UAH',
        productName: 'Standard — месяц',
      });
      expect(result.ok).toBe(true);
      expect(result.transactionStatus).toBe('Approved');
      const [calledUrl, body] = mockedAxios.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(calledUrl).toBe('https://api.wayforpay.com/api');
      expect(body.transactionType).toBe('CHARGE');
      expect(body.recToken).toBe('rt-1');
    });

    it('ok:false при Declined', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { transactionStatus: 'Declined', reasonCode: 1101 },
      });
      const result = await service.chargeRecToken({
        recToken: 'rt-1',
        orderReference: 'renew-1',
        amount: 799,
        currency: 'UAH',
        productName: 'Standard — месяц',
      });
      expect(result.ok).toBe(false);
    });
  });
});
