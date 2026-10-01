import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  INestApplication,
  Logger,
  Post,
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
}

describe('приложение: конверт, ошибки, валидация, CORS, /health', () => {
  let app: INestApplication;
  const queryRaw = jest.fn();

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController, ProbeController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(
      app,
      loadConfiguration({
        CORS_ORIGIN: 'https://tma.example,*.vercel.app',
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
});
