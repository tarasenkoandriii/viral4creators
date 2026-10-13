/**
 * AI Publisher (P-A0, проектный документ §11.4): CORS и потолки тела
 * публичных маршрутов `/public/publisher/v1/*` — тем же `configureApp`, что
 * на проде (контроллеры-пробы вместо маршрутов P-D/P-B1).
 */
import {
  Body,
  Controller,
  Get,
  INestApplication,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import {
  configureApp,
  PUBLISHER_EVENTS_PATH,
  PUBLISHER_LEADS_PATH,
} from './app.setup';
import { loadConfiguration } from './config/configuration';

@Controller('publisher/products/:pid')
class PublisherCabinetProbeController {
  @Get('ai/calls')
  calls(@Res() res: Response) {
    res
      .set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="publisher-ai-calls.csv"',
        'X-Next-Before': 'c123',
      })
      .send('callId\n');
  }
}

@Controller('public/publisher/v1')
class PublisherProbeController {
  @Get('site-config')
  config() {
    return { ok: true };
  }

  @Post('leads')
  lead(@Body() body: unknown) {
    return { type: typeof body, body };
  }

  @Post('events')
  event(@Body() body: unknown) {
    return { type: typeof body, body };
  }
}

describe('AI Publisher: CORS и потолки тела публичных маршрутов', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublisherProbeController, PublisherCabinetProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(
      app,
      loadConfiguration({
        CORS_ORIGIN: 'https://tma.example',
        ASSIST_WIDGET_ORIGIN: 'https://w.widget.example',
      } as NodeJS.ProcessEnv),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('CORS: Origin любого сайта отражается, без credentials; методы GET, POST, OPTIONS; maxAge 600', async () => {
    for (const path of [PUBLISHER_LEADS_PATH, PUBLISHER_EVENTS_PATH]) {
      const pre = await request(app.getHttpServer())
        .options(path)
        .set('Origin', 'https://ai-publisher.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(pre.headers['access-control-allow-origin']).toBe(
        'https://ai-publisher.example',
      );
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
      expect(pre.headers['access-control-allow-methods']).toBe(
        'GET,POST,OPTIONS',
      );
      expect(pre.headers['access-control-max-age']).toBe('600');
    }
    // Чужой Origin — не 403 CORS: допуск по существу решает гвард Publisher.
    const get = await request(app.getHttpServer())
      .get('/public/publisher/v1/site-config')
      .set('Origin', 'https://other.example')
      .expect(200);
    expect(get.headers['access-control-allow-origin']).toBe(
      'https://other.example',
    );
    // Сервер сборки сайта — без Origin.
    await request(app.getHttpServer())
      .get('/public/publisher/v1/site-config')
      .expect(200);
  });

  it('Р-PUB-Z2-7: кабинет /publisher/* на другом origin — X-Next-Before и Content-Disposition открыты; Origin — по общему списку', async () => {
    const res = await request(app.getHttpServer())
      .get('/publisher/products/p1/ai/calls')
      .set('Origin', 'https://tma.example')
      .expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://tma.example',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe(
      'X-Next-Before,Content-Disposition',
    );
    expect(res.headers['x-next-before']).toBe('c123');
    const denied = await request(app.getHttpServer())
      .get('/publisher/products/p1/ai/calls')
      .set('Origin', 'https://other.example');
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('ORIGIN_DENIED');
    // Прочие пути общего списка — без expose (не затронуты).
    const other = await request(app.getHttpServer())
      .get('/public/landing/event')
      .set('Origin', 'https://tma.example');
    expect(other.headers['access-control-expose-headers']).toBeUndefined();
  });

  it('прочие пути не затронуты: общий список CORS по-прежнему отвергает чужой Origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/public/landing/event')
      .set('Origin', 'https://other.example');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_DENIED');
  });

  it('заявка: JSON ≤ 8 КБ проходит; больше — 413 PUB_PAYLOAD_TOO_LARGE до маршрута; битый JSON — 400 PUB_VALIDATION', async () => {
    const ok = await request(app.getHttpServer())
      .post(PUBLISHER_LEADS_PATH)
      .send({ task: 'x'.repeat(7 * 1024) })
      .expect(201);
    expect(ok.body.data.type).toBe('object');
    const big = await request(app.getHttpServer())
      .post(PUBLISHER_LEADS_PATH)
      .send({ task: 'x'.repeat(9 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body).toMatchObject({
      success: false,
      error: { code: 'PUB_PAYLOAD_TOO_LARGE' },
      meta: { path: PUBLISHER_LEADS_PATH },
    });
    const broken = await request(app.getHttpServer())
      .post(PUBLISHER_LEADS_PATH)
      .set('Content-Type', 'application/json')
      .send('{"task":');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('PUB_VALIDATION');
  });

  it('событие: тело строкой ≤ 2 КБ при любом Content-Type (sendBeacon text/plain); больше — 413', async () => {
    const body = JSON.stringify({ name: 'content_view', eventId: 'e' });
    for (const type of ['text/plain;charset=UTF-8', 'application/json']) {
      const res = await request(app.getHttpServer())
        .post(PUBLISHER_EVENTS_PATH)
        .set('Content-Type', type)
        .send(body)
        .expect(201);
      expect(res.body.data).toEqual({ type: 'string', body });
    }
    const big = await request(app.getHttpServer())
      .post(PUBLISHER_EVENTS_PATH)
      .set('Content-Type', 'text/plain')
      .send('x'.repeat(2 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PUB_PAYLOAD_TOO_LARGE');
  });
});
