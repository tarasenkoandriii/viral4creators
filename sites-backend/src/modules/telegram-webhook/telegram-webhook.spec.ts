/**
 * Вебхуки двух ботов: у каждого свой маршрут и свой секрет (ТЗ помощника
 * §4.1); глобальный гвард двух ботов их не закрывает (`@PublicRoute`), а
 * секрет одного бота не открывает вебхук другого.
 */

import {
  INestApplication,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { TelegramAuthModule } from '../telegram-auth/telegram-auth.module';
import { TelegramWebhookModule } from './telegram-webhook.module';
import { isStartCommand } from './telegram-webhook.controller';
import { assertBotWebhookSecret } from './webhook-secret';

const ASSIST_SECRET = 'assist-webhook-secret_A1';
const QA_SECRET = 'qa-webhook-secret_B2';
const ENV = {
  ASSIST_WEBHOOK_SECRET: ASSIST_SECRET,
  QA_WEBHOOK_SECRET: QA_SECRET,
};

describe('assertBotWebhookSecret', () => {
  it('свой секрет — пропускает', () => {
    expect(() =>
      assertBotWebhookSecret('assist', ASSIST_SECRET, ENV),
    ).not.toThrow();
    expect(() => assertBotWebhookSecret('qa', QA_SECRET, ENV)).not.toThrow();
  });

  it('секрет другого бота — 401', () => {
    expect(() => assertBotWebhookSecret('qa', ASSIST_SECRET, ENV)).toThrow(
      UnauthorizedException,
    );
    expect(() => assertBotWebhookSecret('assist', QA_SECRET, ENV)).toThrow(
      UnauthorizedException,
    );
  });

  it('нет заголовка, пустой, массив, другая длина — 401', () => {
    for (const v of [undefined, '', [ASSIST_SECRET], `${ASSIST_SECRET}x`]) {
      expect(() => assertBotWebhookSecret('assist', v, ENV)).toThrow(
        UnauthorizedException,
      );
    }
  });

  it('секрет в env не задан — 503 (fail-closed), даже с пустым заголовком', () => {
    expect(() => assertBotWebhookSecret('qa', '', {})).toThrow(
      ServiceUnavailableException,
    );
    expect(() =>
      assertBotWebhookSecret('qa', 'x', { QA_WEBHOOK_SECRET: '  ' }),
    ).toThrow(ServiceUnavailableException);
  });

  it('текст ошибки не содержит секрета', () => {
    let message = '';
    try {
      assertBotWebhookSecret('assist', 'wrong', ENV);
    } catch (err) {
      message = JSON.stringify((err as UnauthorizedException).getResponse());
    }
    expect(message).toMatch(/секрет/);
    expect(message).not.toContain(ASSIST_SECRET);
  });
});

describe('isStartCommand', () => {
  it.each([
    ['/start', true],
    ['/start ref_123', true],
    ['/start@v4c_assist_bot', true],
    ['/started', false],
    ['привет /start', false],
    ['/help', false],
  ])('%p → %p', (text, expected) => {
    expect(isStartCommand({ update_id: 1, message: { text } })).toBe(expected);
  });

  it('не сообщение — не /start', () => {
    expect(isStartCommand(null)).toBe(false);
    expect(isStartCommand({ callback_query: {} })).toBe(false);
    expect(isStartCommand({ message: { text: 5 } })).toBe(false);
  });
});

describe('POST /assist|qa/webhook/telegram (HTTP)', () => {
  let app: INestApplication;
  const saved = { ...process.env };
  const logs: string[] = [];

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      // Гвард двух ботов — глобальный, как в AppModule: вебхук обязан
      // пройти мимо него без initData.
      imports: [TelegramAuthModule, TelegramWebhookModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    await app.init();
    jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => void logs.push(String(m)));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    process.env = saved;
  });

  const start = {
    update_id: 42,
    message: { message_id: 1, chat: { id: 555 }, text: '/start' },
  };

  it.each([
    ['assist', ASSIST_SECRET],
    ['qa', QA_SECRET],
  ])(
    '%s: свой секрет → 200, /start в логе без chat id',
    async (bot, secret) => {
      logs.length = 0;
      await request(app.getHttpServer())
        .post(`/${bot}/webhook/telegram`)
        .set('X-Telegram-Bot-Api-Secret-Token', secret)
        .send(start)
        .expect(200);
      expect(logs).toEqual([`[${bot}] /start, update 42`]);
    },
  );

  it('секрет помощника не открывает вебхук QA (и наоборот) — 401', async () => {
    await request(app.getHttpServer())
      .post('/qa/webhook/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', ASSIST_SECRET)
      .send(start)
      .expect(401);
    await request(app.getHttpServer())
      .post('/assist/webhook/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', QA_SECRET)
      .send(start)
      .expect(401);
  });

  it('без секрета — 401, и /start не обработан', async () => {
    logs.length = 0;
    await request(app.getHttpServer())
      .post('/assist/webhook/telegram')
      .send(start)
      .expect(401);
    expect(logs).toEqual([]);
  });

  it('незнакомое обновление с лишними полями — 200 (не отвергается как DTO)', async () => {
    await request(app.getHttpServer())
      .post('/assist/webhook/telegram')
      .set('X-Telegram-Bot-Api-Secret-Token', ASSIST_SECRET)
      .send({ update_id: 43, my_chat_member: { new_field: true } })
      .expect(200);
  });

  it('секрет не настроен — 503', async () => {
    const s = process.env.QA_WEBHOOK_SECRET;
    delete process.env.QA_WEBHOOK_SECRET;
    try {
      await request(app.getHttpServer())
        .post('/qa/webhook/telegram')
        .set('X-Telegram-Bot-Api-Secret-Token', 'anything')
        .send(start)
        .expect(503);
    } finally {
      process.env.QA_WEBHOOK_SECRET = s;
    }
  });
});
