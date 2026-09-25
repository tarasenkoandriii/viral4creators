/**
 * Контракт `POST /api/me/environment` (аудит этапа 156).
 *
 * Поднимает настоящий Nest с ОДНИМ контроллером и ходит по HTTP —
 * единственный способ проверить то, чего не видит ни один модульный
 * тест: что гвард закрывает маршрут и что ГЛОБАЛЬНАЯ валидация
 * пропускает тело целиком.
 *
 * Последнее здесь важнее всего и требует объяснения. По всему проекту
 * тело запроса — это DTO, а `VALIDATION_PIPE_OPTIONS` с
 * `forbidNonWhitelisted` отказывает на любом лишнем поле; на этом
 * держится «дайджест считает сервер» из «Тонкой красной линии» §5.5.
 * Этот маршрут — сознательное исключение, и вот почему.
 *
 * Полей окружения полтора десятка, каждое необязательно по
 * отдельности, и часть из них — вложенные объекты. DTO с декораторами
 * повторил бы `normalizeEnvironment()` слово в слово и стал бы вторым
 * источником правды о форме снимка: разошлись бы они молча. Хуже
 * другое: ОТКАЗ на лишнем поле здесь — неправильное поведение. Мини-апп
 * у тестировщика обновляется тогда, когда он сам перезапустит его, и
 * сборка, приславшая одно новое поле, потеряла бы ВСЁ окружение вместо
 * того, чтобы отдать известную часть. Поэтому лишнее здесь тихо
 * отбрасывается (`normalizeEnvironment` собирает новый объект из
 * известных ключей), а не отвергается.
 *
 * Отсюда и этот тест: исключение держится на том, что `ValidationPipe`
 * пропускает нетипизированное тело мимо себя. Это поведение Nest, а не
 * наше решение, — значит оно обязано быть закреплено, иначе смена
 * версии превратит каждое окружение в `{}`, и узнать об этом будет
 * неоткуда: маршрут и тогда ответит 200.
 */

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { EnvironmentController } from './environment.controller';
import { EnvironmentService } from './environment.service';
import { TelegramIdentityGuard } from '../telegram-auth/telegram-identity.guard';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';

const service = { record: jest.fn().mockResolvedValue({ stored: true }) };

async function boot(identified: boolean): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [EnvironmentController],
    providers: [{ provide: EnvironmentService, useValue: service }],
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
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  // ТЕ ЖЕ настройки, что в `main.ts`, а не их копия.
  app.useGlobalPipes(new ValidationPipe(VALIDATION_PIPE_OPTIONS));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  await app.init();
  return app;
}

const snapshot = {
  surface: 'TMA',
  deviceKind: 'TABLET',
  osFamily: 'ios',
  theme: 'dark',
  maxTouchPoints: 5,
  screen: { w: 1024, h: 1366, dpr: 2 },
};

describe('POST /api/me/environment (e2e, один контроллер)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await boot(true);
  });
  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('тело доезжает до сервиса целиком, вложенные поля включительно', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/me/environment')
      .send(snapshot)
      .expect(201);
    expect(res.body).toMatchObject({ success: true, data: { stored: true } });
    expect(service.record).toHaveBeenCalledWith('u1', snapshot);
  });

  it('незнакомое поле не отвергает снимок, а доезжает вместе с ним', async () => {
    // Сборка мини-аппа у тестировщика старше или новее сервера — это
    // норма, а не повод потерять окружение целиком.
    await request(app.getHttpServer())
      .post('/api/me/environment')
      .send({ ...snapshot, поле: 'из завтрашней сборки' })
      .expect(201);
    expect(service.record).toHaveBeenCalledWith('u1', {
      ...snapshot,
      поле: 'из завтрашней сборки',
    });
  });

  it('без личности маршрут закрыт', async () => {
    const anon = await boot(false);
    await request(anon.getHttpServer())
      .post('/api/me/environment')
      .send(snapshot)
      .expect(403);
    expect(service.record).not.toHaveBeenCalled();
    await anon.close();
  });
});
