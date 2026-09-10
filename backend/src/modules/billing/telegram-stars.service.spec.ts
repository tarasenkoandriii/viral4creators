import axios from 'axios';
import { TelegramStarsService } from './telegram-stars.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TelegramStarsService', () => {
  let service: TelegramStarsService;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-1';
    service = new TelegramStarsService();
  });

  afterAll(() => {
    process.env.TELEGRAM_BOT_TOKEN = originalToken;
  });

  describe('configured', () => {
    it('true, когда TELEGRAM_BOT_TOKEN задан', () => {
      expect(service.configured()).toBe(true);
    });

    it('false без токена', () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect(new TelegramStarsService().configured()).toBe(false);
    });
  });

  describe('createInvoiceLink', () => {
    it('строит инвойс с валютой XTR и пустым provider_token', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: 'https://t.me/invoice/abc' },
      });
      const url = await service.createInvoiceLink({
        title: 'Пакет: 5 роликов',
        description: '5 кредитов на генерацию',
        payload: 'signed-payload',
        amount: 250,
      });
      expect(url).toBe('https://t.me/invoice/abc');
      const [calledUrl, body] = mockedAxios.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(calledUrl).toContain('bot-token-1/createInvoiceLink');
      expect(body.currency).toBe('XTR');
      expect(body.provider_token).toBe('');
      expect(body.prices).toEqual([{ label: 'Пакет: 5 роликов', amount: 250 }]);
      expect(body.subscription_period).toBeUndefined();
    });

    it('subscription=true добавляет subscription_period (30 дней)', async () => {
      mockedAxios.post.mockResolvedValueOnce({
        data: { ok: true, result: 'https://t.me/invoice/sub' },
      });
      await service.createInvoiceLink({
        title: 'Standard — месяц',
        description: 'Подписка',
        payload: 'signed-payload',
        amount: 1000,
        subscription: true,
      });
      const [, body] = mockedAxios.post.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(body.subscription_period).toBe(30 * 24 * 60 * 60);
    });

    it('бросает, если Telegram не вернул ссылку', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: false } });
      await expect(
        service.createInvoiceLink({
          title: 't',
          description: 'd',
          payload: 'p',
          amount: 1,
        }),
      ).rejects.toThrow(/не выдал ссылку/);
    });

    it('без токена бросает понятную ошибку', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await expect(
        new TelegramStarsService().createInvoiceLink({
          title: 't',
          description: 'd',
          payload: 'p',
          amount: 1,
        }),
      ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/);
    });
  });

  describe('answerPreCheckoutQuery', () => {
    it('отвечает ok:true без сообщения об ошибке', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      await service.answerPreCheckoutQuery('query-1', true);
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('answerPreCheckoutQuery'),
        { pre_checkout_query_id: 'query-1', ok: true },
      );
    });

    it('отвечает ok:false с текстом ошибки', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      await service.answerPreCheckoutQuery(
        'query-1',
        false,
        'Пакет снят с продажи',
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.stringContaining('answerPreCheckoutQuery'),
        {
          pre_checkout_query_id: 'query-1',
          ok: false,
          error_message: 'Пакет снят с продажи',
        },
      );
    });

    it('без токена — no-op, не бросает', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      await expect(
        new TelegramStarsService().answerPreCheckoutQuery('q', true),
      ).resolves.toBeUndefined();
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('refundStarPayment', () => {
    it('возвращает true при успешном возврате', async () => {
      mockedAxios.post.mockResolvedValueOnce({ data: { ok: true } });
      expect(await service.refundStarPayment('tg-1', 'charge-1')).toBe(true);
    });

    it('best-effort: false, а не исключение, при сбое', async () => {
      mockedAxios.post.mockRejectedValueOnce(new Error('network down'));
      await expect(service.refundStarPayment('tg-1', 'charge-1')).resolves.toBe(
        false,
      );
    });

    it('без токена — false, не бросает', async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      expect(
        await new TelegramStarsService().refundStarPayment('tg-1', 'c'),
      ).toBe(false);
    });
  });
});
