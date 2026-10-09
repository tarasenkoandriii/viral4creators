/**
 * `configureApp` — глобальная настройка backend, которую включает
 * `main.ts` (заход 12, аудит P3-1): тест поднимает приложение с пробным
 * контроллером и ТОЙ ЖЕ функцией. Удаление `app.use(defaultEmptyBody)`
 * (или вызова `configureApp` из `main.ts`) должно ронять этот файл.
 * Заодно — ошибки body-parser (413/415) и 404 без query (P3-3, P3-4).
 */
import { Body, Controller, Get, Logger, Post } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import * as request from 'supertest';
import { configureApp } from './app.setup';

@Controller('probe')
class ProbeController {
  @Post('raw')
  raw(@Body() body: unknown) {
    return {
      kind: body === undefined ? 'undefined' : typeof body,
      body: body ?? null,
    };
  }

  @Get('ok')
  ok() {
    return { ok: true };
  }
}

describe('configureApp (backend): то, что включает main.ts', () => {
  let app: INestApplication;
  let errors: jest.SpyInstance;
  let warns: jest.SpyInstance;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = mod.createNestApplication();
    configureApp(app, { cors: { origins: ['https://app.example.com'] } });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POST без тела на @Body() unknown — {} (defaultEmptyBody), а не undefined', async () => {
    const res = await request(app.getHttpServer()).post('/api/probe/raw');
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ kind: 'object', body: {} });
  });

  it('text/plain на JSON-маршрут — тоже {}', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe/raw')
      .set('Content-Type', 'text/plain')
      .send('hello');
    expect(res.body.data).toEqual({ kind: 'object', body: {} });
  });

  it('JSON — разобранное тело; префикс api и конверт на месте', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe/raw')
      .send({ a: 1 });
    expect(res.body).toMatchObject({
      success: true,
      data: { kind: 'object', body: { a: 1 } },
    });
  });

  it('helmet и CORS с credentials для своего origin', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/probe/ok')
      .set('Origin', 'https://app.example.com');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['access-control-allow-origin']).toBe(
      'https://app.example.com',
    );
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('JSON больше лимита — 413 PAYLOAD_TOO_LARGE в конверте, без ERROR в логе', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe/raw')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ x: 'a'.repeat(150 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(warns).toHaveBeenCalled();
  });

  it('неподдержанная Content-Encoding — 415, без ERROR в логе', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe/raw')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'bogus')
      .send('{"a":1}');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(errors).not.toHaveBeenCalled();
  });

  it('битый JSON — 400 (как раньше)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe/raw')
      .set('Content-Type', 'application/json')
      .send('{"a":');
    expect(res.status).toBe(400);
  });

  it('404 неизвестного маршрута — без query в тексте, meta.path и warn-логе', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/no/such?code=ONE-TIME-SECRET&state=x',
    );
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('ONE-TIME-SECRET');
    expect(res.body.error.message).toBe('Cannot GET /api/no/such');
    expect(res.body.meta.path).toBe('/api/no/such');
    const logged = warns.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('/api/no/such');
    expect(logged).not.toContain('ONE-TIME-SECRET');
  });

  it('main.ts зовёт configureApp(app, config) до listen()', () => {
    const src = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
    const call = src.indexOf('configureApp(app, config);');
    const listen = src.indexOf('app.listen(');
    expect(call).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(call);
  });
});
