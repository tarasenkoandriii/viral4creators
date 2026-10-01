/**
 * Ядро авторизации двух ботов (ТЗ помощника §4.1): выбор токена по
 * приложению без перебора, чужое приложение, срок auth_date, подпись,
 * дев-вход только вне production.
 */

import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  AuthEnv,
  HeaderBag,
  INIT_DATA_MAX_AGE_SECONDS,
  TelegramAuthRejected,
  authenticateTelegramRequest,
  botTokenFor,
} from './authenticate';
import {
  TEST_ASSIST_TOKEN,
  TEST_QA_TOKEN,
  signInitData,
} from './test-init-data';

const ENV: AuthEnv = {
  ASSIST_BOT_TOKEN: TEST_ASSIST_TOKEN,
  QA_BOT_TOKEN: TEST_QA_TOKEN,
  NODE_ENV: 'test',
};

function h(app: string | undefined, initData?: string, dev?: string) {
  const bag: HeaderBag = {};
  if (app !== undefined) bag['x-telegram-app'] = app;
  if (initData !== undefined) bag['x-telegram-init-data'] = initData;
  if (dev !== undefined) bag['x-dev-user-id'] = dev;
  return bag;
}

/** Отказ → HTTP-исключение, которое увидит клиент. */
function rejection(fn: () => unknown): TelegramAuthRejected {
  try {
    fn();
  } catch (err) {
    if (err instanceof TelegramAuthRejected) return err;
    throw err;
  }
  throw new Error('ожидался отказ, а запрос прошёл');
}

const assistInit = () => signInitData({ botToken: TEST_ASSIST_TOKEN });
const qaInit = () => signInitData({ botToken: TEST_QA_TOKEN, userId: 888 });

describe('authenticateTelegramRequest — свой бот', () => {
  it('initData бота помощника + X-Telegram-App: assist → личность assist', () => {
    const { identity, via } = authenticateTelegramRequest(
      h('assist', assistInit()),
      ['assist'],
      ENV,
    );
    expect(via).toBe('initData');
    expect(identity).toEqual({
      app: 'assist',
      telegramId: BigInt(777),
      username: 'tester',
      firstName: 'Андрій',
      languageCode: 'uk',
    });
  });

  it('initData бота QA + X-Telegram-App: qa → личность qa', () => {
    const { identity } = authenticateTelegramRequest(
      h('qa', qaInit()),
      ['qa'],
      ENV,
    );
    expect(identity.app).toBe('qa');
    expect(identity.telegramId).toBe(BigInt(888));
  });

  it('`any` пускает оба приложения', () => {
    expect(
      authenticateTelegramRequest(h('assist', assistInit()), ['any'], ENV)
        .identity.app,
    ).toBe('assist');
    expect(
      authenticateTelegramRequest(h('qa', qaInit()), ['any'], ENV).identity.app,
    ).toBe('qa');
  });
});

describe('authenticateTelegramRequest — перебор токенов запрещён', () => {
  it('initData помощника с заголовком qa на маршруте any — 401 (подпись проверяется токеном QA)', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('qa', assistInit()), ['any'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    expect(r.logReason).toMatch(/hash mismatch/);
  });

  it('initData QA с заголовком assist на маршруте any — 401', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('assist', qaInit()), ['any'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
  });

  it('нет токена своего бота — 503, а не проверка токеном другого', () => {
    const env = { ...ENV, QA_BOT_TOKEN: '' };
    const r = rejection(() =>
      // Подпись помощника «подошла» бы к ASSIST_BOT_TOKEN — нельзя.
      authenticateTelegramRequest(h('qa', assistInit()), ['any'], env),
    );
    expect(r.httpError).toBeInstanceOf(ServiceUnavailableException);
    expect(r.logReason).toBe('QA_BOT_TOKEN не задан');
  });

  it('botTokenFor: у каждого приложения — только свой токен', () => {
    expect(botTokenFor('assist', ENV)).toBe(TEST_ASSIST_TOKEN);
    expect(botTokenFor('qa', ENV)).toBe(TEST_QA_TOKEN);
    expect(botTokenFor('qa', { ASSIST_BOT_TOKEN: 'x' })).toBeUndefined();
  });
});

describe('authenticateTelegramRequest — чужое приложение', () => {
  it('initData помощника не открывает маршрут @AllowApps(qa) — 403', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('assist', assistInit()), ['qa'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(ForbiddenException);
  });

  it('initData QA не открывает маршрут @AllowApps(assist) — 403', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('qa', qaInit()), ['assist'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(ForbiddenException);
  });

  it.each([undefined, '', 'admin', 'ASSIST, qa'])(
    'заголовок приложения %p — 401, бота «по умолчанию» нет',
    (app) => {
      const r = rejection(() =>
        authenticateTelegramRequest(h(app, assistInit()), ['any'], ENV),
      );
      expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    },
  );
});

describe('authenticateTelegramRequest — подпись и срок', () => {
  it('подменённое поле (другой user) — 401', () => {
    const init = new URLSearchParams(assistInit());
    init.set('user', JSON.stringify({ id: 1, first_name: 'Чужой' }));
    const r = rejection(() =>
      authenticateTelegramRequest(h('assist', init.toString()), ['any'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    expect(r.logReason).toMatch(/hash mismatch/);
  });

  it('испорченный hash — 401', () => {
    const init = new URLSearchParams(assistInit());
    init.set('hash', '0'.repeat(64));
    const r = rejection(() =>
      authenticateTelegramRequest(h('assist', init.toString()), ['any'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
  });

  it('auth_date старше суток — 401 (защита от повтора)', () => {
    const old = Math.floor(Date.now() / 1000) - INIT_DATA_MAX_AGE_SECONDS - 120;
    const init = signInitData({ botToken: TEST_ASSIST_TOKEN, authDate: old });
    const r = rejection(() =>
      authenticateTelegramRequest(h('assist', init), ['any'], ENV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    expect(r.logReason).toMatch(/too old/);
  });

  it('auth_date чуть моложе суток — пускает (граница не съехала)', () => {
    const fresh =
      Math.floor(Date.now() / 1000) - INIT_DATA_MAX_AGE_SECONDS + 120;
    const init = signInitData({ botToken: TEST_ASSIST_TOKEN, authDate: fresh });
    expect(
      authenticateTelegramRequest(h('assist', init), ['any'], ENV).identity.app,
    ).toBe('assist');
  });

  it('срок — ровно сутки, как у backend', () => {
    expect(INIT_DATA_MAX_AGE_SECONDS).toBe(86400);
  });

  it('ни токен, ни initData не попадают в причину и текст отказа', () => {
    const init = assistInit();
    const r = rejection(() =>
      authenticateTelegramRequest(h('qa', init), ['any'], ENV),
    );
    const visible = `${r.logReason} ${JSON.stringify(r.httpError.getResponse())}`;
    for (const secret of [TEST_ASSIST_TOKEN, TEST_QA_TOKEN, init]) {
      expect(visible).not.toContain(secret);
    }
  });
});

describe('authenticateTelegramRequest — дев-вход', () => {
  const DEV = { ...ENV, ALLOW_DEV_AUTH: 'true', NODE_ENV: 'development' };

  it('ALLOW_DEV_AUTH=true вне production: X-Dev-User-Id → личность', () => {
    const { identity, via } = authenticateTelegramRequest(
      h('qa', undefined, '123'),
      ['qa'],
      DEV,
    );
    expect(via).toBe('dev');
    expect(identity).toEqual({
      app: 'qa',
      telegramId: BigInt(123),
      username: null,
      firstName: null,
      languageCode: null,
    });
  });

  it('в production дев-заголовок не работает даже с ALLOW_DEV_AUTH=true', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('qa', undefined, '123'), ['qa'], {
        ...DEV,
        NODE_ENV: 'production',
      }),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
  });

  it('без ALLOW_DEV_AUTH=true дев-заголовок не работает', () => {
    for (const flag of [undefined, 'false', '1', 'TRUE']) {
      const r = rejection(() =>
        authenticateTelegramRequest(h('qa', undefined, '123'), ['qa'], {
          ...DEV,
          ALLOW_DEV_AUTH: flag,
        }),
      );
      expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    }
  });

  it('дев-вход не обходит ни выбор приложения, ни @AllowApps', () => {
    expect(
      rejection(() =>
        authenticateTelegramRequest(
          h(undefined, undefined, '123'),
          ['any'],
          DEV,
        ),
      ).httpError,
    ).toBeInstanceOf(UnauthorizedException);
    expect(
      rejection(() =>
        authenticateTelegramRequest(h('qa', undefined, '123'), ['assist'], DEV),
      ).httpError,
    ).toBeInstanceOf(ForbiddenException);
  });

  it('неверная initData не падает в дев-вход', () => {
    const r = rejection(() =>
      authenticateTelegramRequest(h('qa', 'hash=00', '123'), ['qa'], DEV),
    );
    expect(r.httpError).toBeInstanceOf(UnauthorizedException);
  });

  it.each(['0', '-5', 'abc', '12a', '99999999999999999999'])(
    'дев-id %p — не положительное целое → 401',
    (id) => {
      const r = rejection(() =>
        authenticateTelegramRequest(h('qa', undefined, id), ['qa'], DEV),
      );
      expect(r.httpError).toBeInstanceOf(UnauthorizedException);
    },
  );
});
