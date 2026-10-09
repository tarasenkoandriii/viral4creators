/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

/**
 * `POST /api/billing/webhook/wayforpay` на нестандартном теле (заход 12,
 * аудит P2-3). Раньше без тела, с `text/plain` или с формой
 * `x-www-form-urlencoded` сверка подписи падала TypeError в `safeEqual`
 * (`merchantSignature` нет) → 500, WayForPay повторял доставку, а оплата
 * не зачитывалась. Здесь — настоящие контроллер, BillingService и
 * WayForPayService (подпись считается секретом из env), подмены — только
 * у базы и соседних сервисов.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { defaultEmptyBody } from '../../common/express-body-default';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { wayforpayCallbackSignature } from '../../common/wayforpay-signature';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { WayForPayService } from './wayforpay.service';

const SECRET = 'wfp-test-secret';
const URL = '/api/billing/webhook/wayforpay';

describe('POST /api/billing/webhook/wayforpay — тело в любом виде: квитанция или 400, не 500', () => {
  let app: INestApplication;
  const envBefore = { ...process.env };
  const prisma: any = {
    payment: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const notify = { alert: jest.fn(), stat: jest.fn(), report: jest.fn() };

  beforeAll(async () => {
    process.env.WAYFORPAY_MERCHANT_SECRET = SECRET;
    process.env.WAYFORPAY_MERCHANT_ACCOUNT = 'shop';
    process.env.PAYMENT_TOKEN_KEY = 'a'.repeat(43) + '=';
    const wayforpay = new WayForPayService();
    const service = new BillingService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      wayforpay,
      notify as any,
      {} as any,
      {} as any,
    );
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(defaultEmptyBody);
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...envBefore };
  });

  beforeEach(() => {
    prisma.payment.findUnique.mockClear();
    notify.alert.mockClear();
  });

  const event = (over: Record<string, unknown> = {}) => {
    const ev = {
      merchantAccount: 'shop',
      orderReference: 'ORD-77',
      amount: 100,
      currency: 'UAH',
      authCode: '',
      cardPan: '',
      transactionStatus: 'Approved',
      reasonCode: 1100,
      ...over,
    };
    return {
      ...ev,
      merchantSignature: wayforpayCallbackSignature(ev as any, SECRET),
    };
  };

  it('без тела — 400 (нет orderReference), не 500', async () => {
    const res = await request(app.getHttpServer()).post(URL);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('text/plain с JSON — 400 (маршрут не разбирает текст), не 500', async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .set('Content-Type', 'text/plain')
      .send(JSON.stringify(event()));
    expect(res.status).toBe(400);
  });

  it('форма с JSON строкой-ключом — разобрана, подпись сошлась, квитанция', async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(encodeURIComponent(JSON.stringify(event())));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderReference: 'ORD-77',
      status: 'accept',
    });
    expect(res.body).not.toHaveProperty('success');
    // Подпись прошла — дошло до поиска платежа (неизвестный → тревога).
    expect(prisma.payment.findUnique).toHaveBeenCalledTimes(1);
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:unknown-order',
      expect.any(String),
    );
  });

  it('форма без подписи (обычные поля) — квитанция и тревога «неверная подпись», не 500', async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .type('form')
      .send({ orderReference: 'ORD-78', transactionStatus: 'Approved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderReference: 'ORD-78',
      status: 'accept',
    });
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:bad-signature',
      expect.any(String),
    );
    expect(prisma.payment.findUnique).not.toHaveBeenCalled();
  });

  it('JSON с подписью-не-строкой — квитанция и тревога, не 500', async () => {
    const res = await request(app.getHttpServer())
      .post(URL)
      .send({ ...event(), merchantSignature: 12345 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('accept');
    expect(notify.alert).toHaveBeenCalledWith(
      'billing:wayforpay:bad-signature',
      expect.any(String),
    );
  });

  it('обычный JSON с верной подписью — квитанция (поведение не изменилось)', async () => {
    const res = await request(app.getHttpServer()).post(URL).send(event());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderReference: 'ORD-77',
      status: 'accept',
    });
    expect(prisma.payment.findUnique).toHaveBeenCalledTimes(1);
  });
});
