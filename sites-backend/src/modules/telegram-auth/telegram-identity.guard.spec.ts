/**
 * Гвард двух ботов через настоящий HTTP: глобальная регистрация модулем,
 * закрытость маршрута без декоратора, `req.identity`, конверт ошибок.
 * Приёмка Э0: «initData бота Помощника не открывает QA-маршруты и наоборот».
 */

import { Controller, Get, INestApplication, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { HttpExceptionFilter } from '../../common/filters/http-exception.filter';
import { AllowApps, PublicRoute } from './allow-apps.decorator';
import type { IdentifiedRequest } from './identity';
import { TelegramAuthModule } from './telegram-auth.module';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from './test-init-data';

function who(req: IdentifiedRequest) {
  const { identity } = req;
  return { ...identity, telegramId: identity.telegramId.toString() };
}

@Controller('t')
class ProbeController {
  @Get('assist')
  @AllowApps('assist')
  assist(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('qa')
  @AllowApps('qa')
  qa(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('any')
  @AllowApps('any')
  any(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('forgot')
  forgot() {
    return { opened: true };
  }

  @Get('public')
  @PublicRoute('проверка открытого маршрута')
  open(@Req() req: Partial<IdentifiedRequest>) {
    return { identity: req.identity ?? null };
  }

  @Get('both')
  @PublicRoute('противоречие')
  @AllowApps('any')
  both() {
    return { opened: true };
  }
}

@Controller('cls')
@AllowApps('qa')
class ClassScopedController {
  @Get('inherit')
  inherit(@Req() req: IdentifiedRequest) {
    return who(req);
  }

  @Get('override')
  @AllowApps('assist')
  override(@Req() req: IdentifiedRequest) {
    return who(req);
  }
}

describe('TelegramIdentityGuard (HTTP)', () => {
  let app: INestApplication;
  const saved = { ...process.env };

  beforeAll(async () => {
    process.env.ASSIST_BOT_TOKEN = TEST_ASSIST_TOKEN;
    process.env.QA_BOT_TOKEN = TEST_QA_TOKEN;
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_DEV_AUTH;
    const moduleRef = await Test.createTestingModule({
      imports: [TelegramAuthModule],
      controllers: [ProbeController, ClassScopedController],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = saved;
  });

  const server = () => app.getHttpServer();
  const assistInit = () => signInitData({ botToken: TEST_ASSIST_TOKEN });
  const qaInit = () => signInitData({ botToken: TEST_QA_TOKEN, userId: 888 });

  it('свой бот → 200 и req.identity', async () => {
    const res = await request(server())
      .get('/t/assist')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(200);
    expect(res.body).toEqual({
      app: 'assist',
      telegramId: '777',
      username: 'tester',
      firstName: 'Андрій',
      languageCode: 'uk',
    });
  });

  it('initData бота помощника не открывает QA-маршрут (честный заголовок) — 403', async () => {
    const res = await request(server())
      .get('/t/qa')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(403);
    expect(res.body.success).toBe(false);
  });

  it('initData бота помощника не открывает QA-маршрут (подделанный заголовок qa) — 401', async () => {
    await request(server())
      .get('/t/qa')
      .set('X-Telegram-App', 'qa')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(401);
  });

  it('и наоборот: initData QA не открывает маршрут помощника', async () => {
    await request(server())
      .get('/t/assist')
      .set('X-Telegram-App', 'qa')
      .set('X-Telegram-Init-Data', qaInit())
      .expect(403);
    await request(server())
      .get('/t/assist')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', qaInit())
      .expect(401);
  });

  it('`any` пускает оба бота', async () => {
    const a = await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(200);
    const q = await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'qa')
      .set('X-Telegram-Init-Data', qaInit())
      .expect(200);
    expect([a.body.app, q.body.app]).toEqual(['assist', 'qa']);
  });

  it('просроченный auth_date — 401', async () => {
    const old = Math.floor(Date.now() / 1000) - 2 * 86400;
    await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'assist')
      .set(
        'X-Telegram-Init-Data',
        signInitData({ botToken: TEST_ASSIST_TOKEN, authDate: old }),
      )
      .expect(401);
  });

  it('неверный HMAC — 401, токена и initData в ответе нет', async () => {
    const init = new URLSearchParams(assistInit());
    init.set('hash', 'ab'.repeat(32));
    const res = await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', init.toString())
      .expect(401);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(TEST_ASSIST_TOKEN);
    expect(body).not.toContain('ab'.repeat(32));
  });

  it('без initData и без дев-входа — 401', async () => {
    await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'assist')
      .expect(401);
  });

  it('дев-заголовок без ALLOW_DEV_AUTH — 401', async () => {
    await request(server())
      .get('/t/any')
      .set('X-Telegram-App', 'assist')
      .set('X-Dev-User-Id', '123')
      .expect(401);
  });

  it('дев-вход с ALLOW_DEV_AUTH=true вне production — 200', async () => {
    process.env.ALLOW_DEV_AUTH = 'true';
    try {
      const res = await request(server())
        .get('/t/qa')
        .set('X-Telegram-App', 'qa')
        .set('X-Dev-User-Id', '123')
        .expect(200);
      expect(res.body).toMatchObject({ app: 'qa', telegramId: '123' });
    } finally {
      delete process.env.ALLOW_DEV_AUTH;
    }
  });

  it('маршрут без @AllowApps закрыт даже для валидной initData — 403', async () => {
    await request(server())
      .get('/t/forgot')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(403);
  });

  it('@PublicRoute открыт без Telegram, личности нет', async () => {
    const res = await request(server()).get('/t/public').expect(200);
    expect(res.body).toEqual({ identity: null });
  });

  it('@PublicRoute и @AllowApps вместе — 403 (противоречие не решается в пользу открытости)', async () => {
    await request(server())
      .get('/t/both')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(403);
  });

  it('декоратор контроллера наследуется, метод его переопределяет', async () => {
    await request(server())
      .get('/cls/inherit')
      .set('X-Telegram-App', 'qa')
      .set('X-Telegram-Init-Data', qaInit())
      .expect(200);
    await request(server())
      .get('/cls/inherit')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(403);
    await request(server())
      .get('/cls/override')
      .set('X-Telegram-App', 'assist')
      .set('X-Telegram-Init-Data', assistInit())
      .expect(200);
  });
});

describe('@AllowApps / @PublicRoute — ошибки объявления ловятся при загрузке', () => {
  it('пустой @AllowApps() — ошибка', () => {
    expect(() => AllowApps()).toThrow(/хотя бы одно/);
  });

  it('неизвестное приложение — ошибка', () => {
    expect(() => AllowApps('admin' as never)).toThrow(/неизвестное/);
  });

  it('@PublicRoute без причины — ошибка', () => {
    expect(() => PublicRoute('')).toThrow(/причину/);
  });
});
