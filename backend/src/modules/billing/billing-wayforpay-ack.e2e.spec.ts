/**
 * Контракт `POST /api/billing/webhook/wayforpay` (аудит Э4, 2026-10-02).
 *
 * WayForPay считает доставку serviceUrl успешной, только когда в ответе
 * на ВЕРХНЕМ уровне JSON лежит квитанция `{orderReference,
 * status:'accept', time, signature}`. Глобальный `ResponseInterceptor`
 * заворачивает всё, что вернул хендлер, в `{success, data, meta}` —
 * квитанция оказывалась в `data`, провайдер её не видел и повторял
 * доставку. Тест поднимает Nest с тем же глобальным интерцептором, что
 * `main.ts`, и смотрит в сырое тело ответа.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';

const ACK = {
  orderReference: 'ord-1',
  status: 'accept' as const,
  time: 1790000000,
  signature: 'abc123',
};

describe('POST /api/billing/webhook/wayforpay — квитанция мимо конверта', () => {
  let app: INestApplication;
  const service = {
    handleWayForPayWebhook: jest.fn().mockResolvedValue(ACK),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController],
      providers: [{ provide: BillingService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
    app.useGlobalFilters(new HttpExceptionFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('200 и квитанция на верхнем уровне JSON, без success/data/meta', async () => {
    const body = { merchantAccount: 'm', orderReference: 'ord-1' };
    const res = await request(app.getHttpServer())
      .post('/api/billing/webhook/wayforpay')
      .send(body)
      .expect(200);
    expect(res.body).toEqual(ACK);
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('data');
    expect(service.handleWayForPayWebhook).toHaveBeenCalledWith(
      expect.objectContaining(body),
    );
  });

  it('ошибка обработки — НЕ квитанция (провайдер повторит), а ошибка через фильтр', async () => {
    service.handleWayForPayWebhook.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app.getHttpServer())
      .post('/api/billing/webhook/wayforpay')
      .send({ orderReference: 'ord-2' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body).not.toHaveProperty('status', 'accept');
  });
});
