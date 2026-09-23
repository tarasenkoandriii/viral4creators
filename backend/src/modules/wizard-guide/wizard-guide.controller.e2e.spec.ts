/**
 * Контракт маршрутов советника — «Тонкая красная линия» §5.3, §8, §6.3.
 *
 * Поднимает настоящий Nest с ОДНИМ контроллером и подменёнными
 * сервисами и ходит по HTTP. Это единственное место, где проверяется то,
 * чего не видит ни один модульный тест: что маршрут вообще существует,
 * что его закрывает гвард, что валидация тела работает так, как обещано
 * в ТЗ, и что ответ заворачивается в тот же конверт, который разбирает
 * мини-апп.
 *
 * Главная из этих проверок — §13: «дайджест считает сервер». Она
 * держится не на коде сервиса, а на глобальном `ValidationPipe` с
 * `forbidNonWhitelisted`, то есть на настройке в `main.ts`, которую
 * никакой модульный тест не видит.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { WizardGuideController } from './wizard-guide.controller';
import { WizardGuideService } from './wizard-guide.service';
import { WizardHintService } from './wizard-hint.service';
import { WizardTelemetryService } from './wizard-telemetry.service';
import { ExperienceService } from './experience.service';
import { SiblingsService } from './siblings.service';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { RateLimitGuard } from '../../common/rate-limit';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';

const doubles = {
  guide: {
    stateOf: jest.fn().mockResolvedValue({
      enabled: false,
      canEnable: true,
      available: true,
    }),
    setEnabled: jest.fn(),
    scenarioOf: jest.fn().mockResolvedValue('CLIENT_SITE'),
  },
  hints: {
    hint: jest
      .fn()
      .mockResolvedValue({ hint: 'совет', actions: [], source: 'model' }),
  },
  telemetry: { record: jest.fn().mockResolvedValue(1) },
  experience: { addCandidate: jest.fn().mockResolvedValue({ id: 'c1' }) },
  siblings: { classify: jest.fn().mockResolvedValue(null) },
};

async function boot(identified: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [WizardGuideController],
    providers: [
      { provide: WizardGuideService, useValue: doubles.guide },
      { provide: WizardHintService, useValue: doubles.hints },
      { provide: WizardTelemetryService, useValue: doubles.telemetry },
      { provide: ExperienceService, useValue: doubles.experience },
      { provide: SiblingsService, useValue: doubles.siblings },
    ],
  })
    .overrideGuard(TelegramIdentityGuard)
    .useValue({
      canActivate: (ctx: {
        switchToHttp: () => { getRequest: () => { telegramUserId?: string } };
      }) => {
        if (!identified) return false;
        ctx.switchToHttp().getRequest().telegramUserId = 'u1';
        return true;
      },
    })
    // Частотный лимит живёт в базе; здесь проверяется контракт маршрута,
    // а не счётчики окон — у них свой тест.
    .overrideGuard(RateLimitGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  // ТЕ ЖЕ настройки, что в `main.ts`, а не их копия: копия была бы
  // зелёной и при выключенном `forbidNonWhitelisted` на проде.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

describe('маршруты советника (e2e, один контроллер)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await boot(true);
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('подсказка приходит в общем конверте', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/hint')
      .send({ stepId: 'record', locale: 'ru' })
      .expect(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { hint: 'совет', source: 'model' },
    });
    expect(doubles.hints.hint).toHaveBeenCalledWith('u1', 'p1', 'record', 'ru');
  });

  it('дайджест состояния принять снаружи нельзя', async () => {
    // §13 дословно. Проверка держится на `forbidNonWhitelisted` в
    // `main.ts`, то есть на настройке, которую не видит ни один
    // модульный тест: без неё лишнее поле просто игнорировалось бы, и
    // однажды кто-нибудь начал бы его читать.
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/hint')
      .send({ stepId: 'record', locale: 'ru', stateDigest: 'подделка' })
      .expect(400);
    expect(doubles.hints.hint).not.toHaveBeenCalled();
  });

  it('незнакомая локаль отвергается', async () => {
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/hint')
      .send({ stepId: 'record', locale: 'fr' })
      .expect(400);
  });

  it('события пишутся пачкой, сценарий добавляет сервер', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/events')
      .send({
        events: [
          { stepId: 'url', kind: 'enter' },
          { stepId: 'url', kind: 'error', detail: 'http-500' },
        ],
      })
      .expect(200);
    expect(res.body.data).toEqual({ recorded: 1 });
    const written = doubles.telemetry.record.mock.calls[0][0];
    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({ scenario: 'CLIENT_SITE' });
  });

  it('сценарий из тела не принимается', async () => {
    // Иначе клиент мог бы приписать событие чужому сценарию, и частоты,
    // по которым потом заводят записи опыта, поехали бы молча.
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/events')
      .send({ events: [{ stepId: 'url', kind: 'enter', scenario: 'ЧУЖОЙ' }] })
      .expect(400);
  });

  it('незнакомый вид события отвергается на входе', async () => {
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/events')
      .send({ events: [{ stepId: 'url', kind: 'выдумка' }] })
      .expect(400);
  });

  it('пачка длиннее двадцати не принимается', async () => {
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/events')
      .send({
        events: Array.from({ length: 21 }, () => ({
          stepId: 'url',
          kind: 'enter',
        })),
      })
      .expect(400);
  });

  it('жалоба без слов считается, но кандидата не заводит', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/complaint')
      .send({ stepId: 'record', locale: 'de' })
      .expect(200);
    expect(res.body.data).toEqual({ accepted: true });
    expect(doubles.telemetry.record).toHaveBeenCalled();
    expect(doubles.experience.addCandidate).not.toHaveBeenCalled();
  });

  it('жалоба со словами заводит кандидата на его языке', async () => {
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/complaint')
      .send({ stepId: 'record', locale: 'de', text: 'unklar' })
      .expect(200);
    expect(doubles.experience.addCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'de', origin: 'COMPLAINT' }),
    );
    // И сразу уходит на сведение дублей — фона у serverless нет.
    expect(doubles.siblings.classify).toHaveBeenCalledWith('c1');
  });

  it('состояние чекбокса отдаётся признаками, без бухгалтерии', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/projects/p1/wizard-guide')
      .expect(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'available',
      'canEnable',
      'enabled',
    ]);
  });
});

describe('маршруты советника без личности', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await boot(false);
  });
  afterAll(() => app.close());

  it('закрыты гвардом целиком', async () => {
    // Все три платных и полуплатных маршрута — за одной дверью.
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/hint')
      .send({ stepId: 'record', locale: 'ru' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/projects/p1/wizard-guide/events')
      .send({ events: [] })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/projects/p1/wizard-guide')
      .expect(403);
  });
});
