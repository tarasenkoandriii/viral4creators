/**
 * Правило доступа к вебхуку Resemble (этап 73, TODO п.32) — тот же дух,
 * что telegram-webhook-secret.spec.ts, но секрет сравнивается по
 * query-параметру, не заголовку, и есть отдельная функция сборки URL.
 */
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  assertResembleWebhookSecret,
  resembleWebhookUrl,
} from './resemble-webhook-secret';

describe('assertResembleWebhookSecret', () => {
  it('нет переменной — 503, а не открытый маршрут', () => {
    expect(() => assertResembleWebhookSecret('x', {})).toThrow(
      ServiceUnavailableException,
    );
    expect(() =>
      assertResembleWebhookSecret(undefined, { RESEMBLE_WEBHOOK_SECRET: '  ' }),
    ).toThrow(ServiceUnavailableException);
  });

  it('заданный секрет требует точного совпадения query-параметра', () => {
    const env = { RESEMBLE_WEBHOOK_SECRET: 'abc123' };
    expect(() => assertResembleWebhookSecret('abc123', env)).not.toThrow();
    expect(() => assertResembleWebhookSecret('abc124', env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertResembleWebhookSecret('abc', env)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertResembleWebhookSecret(undefined, env)).toThrow(
      UnauthorizedException,
    );
  });
});

describe('resembleWebhookUrl', () => {
  it('без API_PUBLIC_URL или без секрета — undefined (poll-фоллбек берёт на себя)', () => {
    expect(resembleWebhookUrl({})).toBeUndefined();
    expect(
      resembleWebhookUrl({ API_PUBLIC_URL: 'https://app.example' }),
    ).toBeUndefined();
    expect(
      resembleWebhookUrl({ RESEMBLE_WEBHOOK_SECRET: 's' }),
    ).toBeUndefined();
  });

  it('с обоими значениями — собирает URL с секретом в query, без хвостового слэша базы', () => {
    expect(
      resembleWebhookUrl({
        API_PUBLIC_URL: 'https://app.example/',
        RESEMBLE_WEBHOOK_SECRET: 's3cr3t',
      }),
    ).toBe('https://app.example/voices/webhook/resemble?secret=s3cr3t');
  });

  it('секрет кодируется в query', () => {
    expect(
      resembleWebhookUrl({
        API_PUBLIC_URL: 'https://app.example',
        RESEMBLE_WEBHOOK_SECRET: 'a b&c',
      }),
    ).toBe('https://app.example/voices/webhook/resemble?secret=a%20b%26c');
  });
});
