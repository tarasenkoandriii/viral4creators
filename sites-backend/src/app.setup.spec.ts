import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import * as request from 'supertest';
import { configureApp } from './app.setup';
import { INTERNAL_ERROR_MESSAGE } from './common/filters/http-exception.filter';
import { HealthController } from './health/health.controller';
import { PrismaService } from './prisma/prisma.service';
import { loadConfiguration } from './config/configuration';

class EchoDto {
  @IsString()
  name!: string;
}

/** Контроллер-проба: голые данные и типичные отказы. */
@Controller('probe')
class ProbeController {
  @Get('ok')
  ok() {
    return { hello: 'мир' };
  }

  @Get('conflict')
  conflict() {
    throw new ConflictException({
      code: 'HOST_DUPLICATE',
      message: 'Этот хост уже есть в кабинете',
      secret: 'не должен утечь',
    });
  }

  @Get('crash')
  crash() {
    throw new Error('connect ECONNREFUSED 10.0.0.5:6543 — внутренний адрес');
  }

  @Get('bad')
  bad() {
    throw new BadRequestException('Неверная ссылка');
  }

  @Post('echo')
  echo(@Body() dto: EchoDto) {
    return dto;
  }

  /** Заход 12: тело без DTO-класса — как у сотни обработчиков `body: unknown`. */
  @Post('nobody')
  nobody(@Body() body: { x?: unknown }) {
    return { type: typeof body, x: body.x ?? null };
  }

  @Get('query')
  query(@Query() q: Record<string, unknown>) {
    return { ...q };
  }
}

/** Проба маршрута загрузки картинок кабинета (потолок JSON 300 КБ). */
@Controller('assist/sites')
class AssetProbeController {
  @Post(':id/widget/assets')
  upload(@Body() body: { dataBase64?: string }) {
    return { length: body?.dataBase64?.length ?? 0 };
  }

  @Post(':id/widget/draft')
  draft(@Body() body: { dataBase64?: string }) {
    return { length: body?.dataBase64?.length ?? 0 };
  }
}

/** Э3: пробы сырого тела вебхука целей и text/plain от sendBeacon. */
@Controller()
class RawBodyProbeController {
  @Post('assist/v1/sites/:id/goal-events')
  webhook(@Body() body: unknown) {
    return { type: typeof body, body };
  }

  @Post('widget/v1/event')
  event(@Body() body: unknown) {
    return { type: typeof body, body };
  }
}

describe('приложение: конверт, ошибки, валидация, CORS, /health', () => {
  let app: INestApplication;
  const queryRaw = jest.fn();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [
        HealthController,
        ProbeController,
        AssetProbeController,
        RawBodyProbeController,
      ],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(
      app,
      loadConfiguration({
        CORS_ORIGIN: 'https://tma.example,*.vercel.app',
        ASSIST_WIDGET_ORIGIN: 'https://w.widget.example',
      } as NodeJS.ProcessEnv),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  it('контроллер отдаёт голые данные — конверт добавляет перехватчик', async () => {
    const res = await request(app.getHttpServer()).get('/probe/ok').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({ hello: 'мир' });
    expect(typeof res.body.meta.requestId).toBe('string');
    expect(typeof res.body.meta.timestamp).toBe('string');
  });

  it('GET /health без префикса: база отвечает — ok', async () => {
    queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.data).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('GET /health: база недоступна — degraded, без подробностей наружу', async () => {
    queryRaw.mockRejectedValueOnce(
      new Error('password authentication failed for postgresql://u:SECRET@h'),
    );
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.data).toMatchObject({
      status: 'degraded',
      database: 'down',
    });
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
  });

  it('наш отказ: текст и машинный код уходят, прочие поля — нет', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/conflict')
      .expect(409);
    expect(res.body).toMatchObject({
      success: false,
      error: {
        message: 'Этот хост уже есть в кабинете',
        details: { code: 'HOST_DUPLICATE' },
      },
      meta: { path: '/probe/conflict' },
    });
    expect(JSON.stringify(res.body)).not.toContain('не должен утечь');
  });

  it('строковый отказ — код по статусу', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/bad')
      .expect(400);
    expect(res.body.error).toEqual({
      code: 'BAD_REQUEST',
      message: 'Неверная ссылка',
    });
  });

  it('авария: одна общая фраза, внутренний адрес не утекает', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/crash')
      .expect(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_SERVER_ERROR',
      message: INTERNAL_ERROR_MESSAGE,
    });
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
  });

  it('путь в ответе — без query-строки (там бывают секреты)', async () => {
    const res = await request(app.getHttpServer())
      .get('/probe/bad?secret=xyz')
      .expect(400);
    expect(res.body.meta.path).toBe('/probe/bad');
  });

  it('валидация: лишнее поле — отказ 400, а не тихое игнорирование', async () => {
    await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ name: 'a', extra: 1 })
      .expect(400);
    const ok = await request(app.getHttpServer())
      .post('/probe/echo')
      .send({ name: 'a' })
      .expect(201);
    expect(ok.body.data).toEqual({ name: 'a' });
  });

  it('CORS: разрешённый и превью-origin проходят, чужой — нет', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://tma.example');
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://tma.example',
    );
    const preview = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://pr-1.vercel.app');
    expect(preview.headers['access-control-allow-origin']).toBe(
      'https://pr-1.vercel.app',
    );
    const foreign = await request(app.getHttpServer())
      .get('/probe/ok')
      .set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('CORS Э2: конфиг, пинг и картинки виджета — любому сайту, без cookie', async () => {
    for (const path of [
      '/widget/v1/config?pk=x',
      '/widget/v1/ping?pk=x',
      '/widget/v1/asset/abc',
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Origin', 'https://any-shop.example');
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    }
  });

  it('CORS Э2: остальной виджет — только origin виджета, с credentials; чужой — без заголовков и не 500', async () => {
    const own = await request(app.getHttpServer())
      .post('/widget/v1/session')
      .set('Origin', 'https://w.widget.example');
    expect(own.headers['access-control-allow-origin']).toBe(
      'https://w.widget.example',
    );
    expect(own.headers['access-control-allow-credentials']).toBe('true');
    const foreign = await request(app.getHttpServer())
      .post('/widget/v1/chat')
      .set('Origin', 'https://tma.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.status).toBeLessThan(500);
    const frame = await request(app.getHttpServer())
      .get('/w/v1/frame?pk=x')
      .set('Origin', 'https://evil.example');
    expect(frame.headers['access-control-allow-origin']).toBeUndefined();
    expect(frame.status).toBeLessThan(500);
  });

  it('CORS Э3: события, цели и выбор цели — со страницы любого сайта, без cookie (допуск — гвард)', async () => {
    for (const path of [
      '/widget/v1/event',
      '/widget/v1/goal',
      '/widget/v1/goal-picker/session',
      '/widget/v1/goal-picker/pick',
    ]) {
      const pre = await request(app.getHttpServer())
        .options(path)
        .set('Origin', 'https://any-shop.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(pre.headers['access-control-allow-origin']).toBe(
        'https://any-shop.example',
      );
      expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    }
    // Чат по-прежнему только с origin виджета.
    const chat = await request(app.getHttpServer())
      .post('/widget/v1/chat')
      .set('Origin', 'https://any-shop.example');
    expect(chat.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Э3: вебхук целей получает СЫРОЕ тело строкой (подпись по байтам); sendBeacon text/plain — строкой, JSON — объектом', async () => {
    const raw = '{"b":1,  "a":"тест"}';
    const hook = await request(app.getHttpServer())
      .post('/assist/v1/sites/s1/goal-events')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(201);
    expect(hook.body.data).toEqual({ type: 'string', body: raw });
    const beacon = await request(app.getHttpServer())
      .post('/widget/v1/event')
      .set('Content-Type', 'text/plain;charset=UTF-8')
      .send('{"pk":"x"}')
      .expect(201);
    expect(beacon.body.data).toEqual({ type: 'string', body: '{"pk":"x"}' });
    const asJson = await request(app.getHttpServer())
      .post('/widget/v1/event')
      .send({ pk: 'x' })
      .expect(201);
    expect(asJson.body.data).toEqual({ type: 'object', body: { pk: 'x' } });
    const tooBig = await request(app.getHttpServer())
      .post('/assist/v1/sites/s1/goal-events')
      .set('Content-Type', 'application/json')
      .send('x'.repeat(5 * 1024));
    expect(tooBig.status).toBe(413);
  });

  it('Э2: картинка бренда 200 КБ (≈273 КБ base64) проходит только в маршрут загрузки; прочим — потолок по умолчанию', async () => {
    const dataBase64 = Buffer.alloc(200 * 1024, 7).toString('base64');
    const ok = await request(app.getHttpServer())
      .post('/assist/sites/s1/widget/assets')
      .send({ kind: 'logo', mime: 'image/png', dataBase64 })
      .expect(201);
    expect(ok.body.data.length).toBe(dataBase64.length);
    const other = await request(app.getHttpServer())
      .post('/assist/sites/s1/widget/draft')
      .send({ dataBase64 });
    expect(other.status).toBe(413);
    expect(other.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const tooBig = await request(app.getHttpServer())
      .post('/assist/sites/s1/widget/assets')
      .send({ dataBase64: 'A'.repeat(320 * 1024) });
    expect(tooBig.status).toBe(413);
    const broken = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(broken.status).toBe(400);
    expect(broken.body.error.code).toBe('BAD_REQUEST');
  });

  it('Express 5 (заход 12): без тела и с чужим Content-Type — {} как в Express 4, не 500', async () => {
    const none = await request(app.getHttpServer())
      .post('/probe/nobody')
      .expect(201);
    expect(none.body.data).toEqual({ type: 'object', x: null });
    const wrongType = await request(app.getHttpServer())
      .post('/probe/nobody')
      .set('Content-Type', 'text/plain')
      .send('x=1')
      .expect(201);
    expect(wrongType.body.data).toEqual({ type: 'object', x: null });
    const json = await request(app.getHttpServer())
      .post('/probe/nobody')
      .send({ x: 5 })
      .expect(201);
    expect(json.body.data).toEqual({ type: 'object', x: 5 });
    // Сырой путь с пустым телом (Content-Length: 0) — пустая строка от
    // своего text-парсера, как и в Express 4: подпись сверится с ''.
    const hook = await request(app.getHttpServer())
      .post('/assist/v1/sites/s1/goal-events')
      .expect(201);
    expect(hook.body.data).toEqual({ type: 'string', body: '' });
  });

  it('заход 12 (аудит P3-3/P3-4): 404 — без query в тексте; Content-Encoding не та — 415, не 500', async () => {
    const warn = Logger.prototype.warn as unknown as jest.Mock;
    warn.mockClear();
    const nf = await request(app.getHttpServer())
      .get('/no/such?code=ONE-TIME-SECRET')
      .expect(404);
    expect(nf.body.error.message).toBe('Cannot GET /no/such');
    expect(JSON.stringify(nf.body)).not.toContain('ONE-TIME-SECRET');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ONE-TIME-SECRET');
    const enc = await request(app.getHttpServer())
      .post('/probe/nobody')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'bogus')
      .send('{"x":1}')
      .expect(415);
    expect(enc.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('Express 5 (заход 12): query — простой разбор: повтор ключа — массив, скобки — не объект', async () => {
    const r = await request(app.getHttpServer())
      .get('/probe/query?a=1&a=2&b[c]=1&d=%D1%82')
      .expect(200);
    expect(r.body.data).toEqual({ a: ['1', '2'], 'b[c]': '1', d: 'т' });
  });

  it('CORS: чужой Origin на общем пути (лендинг) — 403 ORIGIN_DENIED в конверте, не 500, до обработчика', async () => {
    const res = await request(app.getHttpServer())
      .post('/public/landing/event')
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'text/plain')
      .send('{"events":[{"name":"x"}]}');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      success: false,
      error: { code: 'ORIGIN_DENIED' },
      meta: { path: '/public/landing/event' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await request(app.getHttpServer())
      .options('/public/landing/event')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.status).toBe(403);
    const probe = await request(app.getHttpServer())
      .post('/probe/echo')
      .set('Origin', 'https://evil.example')
      .send({ name: 'a' });
    expect(probe.status).toBe(403);
  });
});
