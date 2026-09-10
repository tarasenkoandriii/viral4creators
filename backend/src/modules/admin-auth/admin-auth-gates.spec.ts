/**
 * Два предохранителя входа в админку — оба чистые функции, оба до сих
 * пор не исполнялись ни разу в тестах.
 *
 * `isOriginAllowed` — единственное, что блокирует CSRF: cookie админки
 * ставится с SameSite=None (админка и API — разные домены в проде), и
 * браузер отправит её вместе с cross-site form-POST без preflight. CORS
 * тут не помогает: он запрещает ЧИТАТЬ ответ, а не отправлять запрос.
 *
 * `isDevAuthAllowed` — предохранитель dev-входа, выдающего сессию с
 * полными правами оператора. Условий два, и второе (`NODE_ENV`) —
 * страховка ровно на случай, если первое утечёт в прод.
 *
 * Таблицами, а не отдельными `it`: правило целиком должно читаться
 * одним взглядом, вместе со всеми исключениями.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { isOriginAllowed } from './admin-session.guard';
import { isDevAuthAllowed } from './dev-login';

const ALLOWLIST = 'https://admin.example.com,https://admin.staging.example.com';

describe('isOriginAllowed — CSRF-проверка админской cookie', () => {
  it.each<[string, string, string | undefined, string | undefined, boolean]>([
    // [что доказываем, метод, Origin, CORS_ORIGIN, пропустить?]
    [
      'свой домен пишет — пускаем',
      'POST',
      'https://admin.example.com',
      ALLOWLIST,
      true,
    ],
    [
      'второй домен из списка — тоже свой',
      'POST',
      'https://admin.staging.example.com',
      ALLOWLIST,
      true,
    ],
    [
      'чужой сайт отправил форму с нашей cookie — это и есть CSRF',
      'POST',
      'https://зло.example',
      ALLOWLIST,
      false,
    ],
    [
      'схема имеет значение: http вместо https — другой источник',
      'POST',
      'http://admin.example.com',
      ALLOWLIST,
      false,
    ],
    [
      'поддомен не наследует права родителя',
      'POST',
      'https://evil.admin.example.com',
      ALLOWLIST,
      false,
    ],
    [
      'хвостовой слэш — это опечатка в настройке, а не другой домен',
      'POST',
      'https://admin.example.com/',
      ALLOWLIST,
      true,
    ],
    [
      'пробелы вокруг записи в переменной не должны ломать вход',
      'POST',
      'https://admin.example.com',
      ' https://admin.example.com , https://other.example.com ',
      true,
    ],
    [
      'DELETE проверяется так же, как POST: он тоже меняет состояние',
      'DELETE',
      'https://зло.example',
      ALLOWLIST,
      false,
    ],
    ['PATCH — тоже', 'PATCH', 'https://зло.example', ALLOWLIST, false],
    [
      'GET не меняет состояние — CSRF на нём ничего не даёт',
      'GET',
      'https://зло.example',
      ALLOWLIST,
      true,
    ],
    [
      'OPTIONS — preflight, не запрос',
      'OPTIONS',
      'https://зло.example',
      ALLOWLIST,
      true,
    ],
    ['HEAD — тот же GET', 'HEAD', 'https://зло.example', ALLOWLIST, true],
    [
      'метод в нижнем регистре — тот же безопасный метод',
      'get',
      'https://зло.example',
      ALLOWLIST,
      true,
    ],
    [
      'Origin отсутствует — это curl или скрипт, которому cookie взять неоткуда',
      'POST',
      undefined,
      ALLOWLIST,
      true,
    ],
    [
      'CORS_ORIGIN не задан — на dev-стенде проверка выключена целиком',
      'POST',
      'https://зло.example',
      undefined,
      true,
    ],
    [
      'пустая CORS_ORIGIN равносильна незаданной',
      'POST',
      'https://зло.example',
      '   ',
      true,
    ],
  ])('%s', (_name, method, origin, corsEnv, expected) => {
    expect(isOriginAllowed(method, origin, corsEnv)).toBe(expected);
  });

  // Б-3.2: барьер, который выключался сам.
  //
  // `CORS_ORIGIN` забыли в проде — CORS при этом выглядит настроенным (у
  // него есть умолчание `localhost:5173`), а CSRF-проверка молча
  // пропускала всё. Молчание — худшая часть: ни одна страница админки не
  // ломалась, и узнать об этом было неоткуда.
  describe('пустой список в проде — отказ, а не пропуск', () => {
    it.each<[string, string | undefined, string, boolean]>([
      ['прод без списка не пускает чужой POST', undefined, 'production', false],
      ['прод с пустой строкой — то же самое', '   ', 'production', false],
      ['вне прода поведение прежнее', undefined, 'development', true],
      ['в тестах тоже прежнее', undefined, 'test', true],
    ])('%s', (_name, corsEnv, nodeEnv, expected) => {
      expect(
        isOriginAllowed('POST', 'https://зло.example', corsEnv, { nodeEnv }),
      ).toBe(expected);
    });

    it('safe-метод в проде без списка проходит: читать не запрещаем', () => {
      expect(
        isOriginAllowed('GET', 'https://зло.example', undefined, {
          nodeEnv: 'production',
        }),
      ).toBe(true);
    });

    it('заданный список в проде работает как обычно', () => {
      expect(
        isOriginAllowed('POST', 'https://admin.example.com', ALLOWLIST, {
          nodeEnv: 'production',
        }),
      ).toBe(true);
      expect(
        isOriginAllowed('POST', 'https://зло.example', ALLOWLIST, {
          nodeEnv: 'production',
        }),
      ).toBe(false);
    });
  });
});

describe('isDevAuthAllowed — предохранитель dev-входа в админку', () => {
  it.each<[string, string | undefined, string | undefined, boolean]>([
    // [что доказываем, ALLOW_DEV_AUTH, NODE_ENV, разрешён?]
    [
      'разработчик включил его осознанно на локальном стенде',
      'true',
      'development',
      true,
    ],
    [
      'NODE_ENV не выставлен — тот же локальный запуск',
      'true',
      undefined,
      true,
    ],
    ['в тестах он тоже доступен', 'true', 'test', true],
    [
      'на проде закрыт, даже если флаг случайно уехал в окружение',
      'true',
      'production',
      false,
    ],
    ['без флага не открывается и вне прода', undefined, 'development', false],
    ['«false» — это выключено', 'false', 'development', false],
    [
      'только точное «true»: «1» не включает вход с полными правами оператора',
      '1',
      'development',
      false,
    ],
    [
      '«TRUE» в другом регистре — тоже не включает',
      'TRUE',
      'development',
      false,
    ],
    ['пустая строка — не включает', '', 'development', false],
  ])('%s', (_name, allowDevAuth, nodeEnv, expected) => {
    expect(
      isDevAuthAllowed({ ALLOW_DEV_AUTH: allowDevAuth, NODE_ENV: nodeEnv }),
    ).toBe(expected);
  });

  it('оба условия независимы: ни одно из них по отдельности вход не открывает', () => {
    // Смысл второго условия именно в независимости — на проде NODE_ENV
    // выставляет платформа, и утёкший ALLOW_DEV_AUTH ничего не даёт.
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true' })).toBe(true);
    expect(isDevAuthAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(isDevAuthAllowed({})).toBe(false);
  });
});
