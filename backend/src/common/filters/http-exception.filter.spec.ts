/**
 * Фильтр — единственная точка, где текст исключения встречается с
 * клиентом (этап 54, Б-3.6). Проверяем границу: своё уходит, чужое нет.
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  redactStoryToken,
  HttpExceptionFilter,
  INTERNAL_ERROR_MESSAGE,
} from './http-exception.filter';

function run(exception: unknown, headers?: Record<string, string>) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ url: '/api/x', method: 'POST', headers }),
    }),
  };
  new HttpExceptionFilter().catch(exception, host as never);
  return {
    status: status.mock.calls[0][0] as number,
    body: json.mock.calls[0][0] as {
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      meta: { requestId: string };
    },
  };
}

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe('HttpExceptionFilter', () => {
  it('текст HttpException написан для пользователя и уходит как есть', () => {
    const r = run(new ConflictException('Генерация уже идёт'));
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({
      code: 'Conflict',
      message: 'Генерация уже идёт',
    });
  });

  it('массив сообщений ValidationPipe склеивается в строку, а не уходит массивом', () => {
    const r = run(
      new BadRequestException(['fileName should not be empty', 'x too big']),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(
      'fileName should not be empty; x too big',
    );
  });

  it('чужая ошибка: адрес базы и имя таблицы наружу не уходят, requestId уходит', () => {
    const r = run(
      new Error(
        'connect ECONNREFUSED 10.0.0.5:6543 — relation "sessions" does not exist',
      ),
    );
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(r.body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(r.body.error.message).not.toContain('10.0.0.5');
    expect(r.body.meta.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // Тот же код — в логе, иначе по жалобе запись не найти.
    const logged = (Logger.prototype.error as jest.Mock).mock.calls.at(-1)[0];
    expect(logged).toContain(r.body.meta.requestId);
    expect(logged).toContain('10.0.0.5');
  });

  it('не-Error (строка, объект) — тот же 500 без утечки', () => {
    const r = run('что-то бросили строкой');
    expect(r.status).toBe(500);
    expect(r.body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
  });

  it('Г-5.2: текст ошибки 500 идёт по Accept-Language, а не всегда по-русски', () => {
    const ru = run(new Error('boom'), { 'accept-language': 'ru' });
    expect(ru.body.error.message).toBe(INTERNAL_ERROR_MESSAGE);

    const en = run(new Error('boom'), { 'accept-language': 'en' });
    expect(en.body.error.message).not.toBe(INTERNAL_ERROR_MESSAGE);
    expect(en.body.error.message).toMatch(/internal server error/i);

    // Незнакомая/отсутствующая локаль — прежнее поведение, русский текст.
    const unknown = run(new Error('boom'), { 'accept-language': 'xx' });
    expect(unknown.body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
  });
});

describe('HttpExceptionFilter — машинный код отказа (CONTRACT5)', () => {
  it('`code` из тела исключения уходит в error.details.code вместе с текстом', () => {
    const r = run(
      new NotFoundException({
        code: 'PERSONA_DISABLED',
        message: 'Режим «Я в кадре» недоступен',
      }),
    );
    expect(r.status).toBe(404);
    expect(r.body.error.message).toBe('Режим «Я в кадре» недоступен');
    expect(r.body.error.details).toEqual({ code: 'PERSONA_DISABLED' });
  });

  it('`code` рядом с другими пропускаемыми полями (quota) — оба на месте', () => {
    const r = run(
      new HttpException(
        { code: 'SKETCH_QUOTA', message: 'Лимит', quota: { dayLeft: 0 } },
        429,
      ),
    );
    expect(r.body.error.details).toEqual({
      code: 'SKETCH_QUOTA',
      quota: { dayLeft: 0 },
    });
  });

  it('`code` не-идентификатор (пробелы, объект, длинная строка) не пропускается', () => {
    for (const code of [
      'SELECT * FROM users',
      { nested: 1 },
      'A'.repeat(65),
      '',
    ]) {
      const r = run(new ConflictException({ code, message: 'x' }));
      expect(r.body.error.details).toBeUndefined();
    }
  });

  it('нет `code` — details нет (формат прежних ответов не меняется)', () => {
    const r = run(new ConflictException({ message: 'Генерация уже идёт' }));
    expect(r.body.error.details).toBeUndefined();
  });
});

describe('HttpExceptionFilter — details sites-backend (P-R-ADM, вкладка «Reddit»)', () => {
  it('`upstreamDetails` разворачивается в error.details как есть; сам ключ наружу не уходит', () => {
    const r = run(
      new HttpException(
        {
          message: 'Объект изменился',
          error: 'PUB_CONFLICT',
          upstreamDetails: { reason: 'revision', currentRevision: 4 },
        },
        409,
      ),
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toEqual({
      code: 'PUB_CONFLICT',
      message: 'Объект изменился',
      details: { reason: 'revision', currentRevision: 4 },
    });
  });

  it('`upstreamDetails` не объект (массив, строка) — игнорируется; прочие ключи по-прежнему не уходят', () => {
    for (const upstreamDetails of [['x'], 'x', null]) {
      const r = run(
        new HttpException(
          { message: 'm', error: 'E', upstreamDetails, secretField: 's' },
          400,
        ),
      );
      expect(r.body.error.details).toBeUndefined();
    }
  });
});

describe('Story‑Tales bearer link redaction', () => {
  it('keeps a public gift token out of application error messages and paths', () => {
    expect(redactStoryToken('/api/story-gift/secret-token/audio')).toBe(
      '/api/story-gift/[redacted]/audio',
    );
    expect(
      redactStoryToken('Cannot GET /api/story-gift/secret-token/unknown'),
    ).not.toContain('secret-token');
    expect(redactStoryToken('/api/story-gifts/owner-id')).toBe(
      '/api/story-gifts/owner-id',
    );
  });
});

describe('ST2-S-06: тексты Story не попадают в журнал сервера', () => {
  const storyRun = (exception: unknown, url: string) => {
    const warn = jest.mocked(Logger.prototype.warn);
    const error = jest.mocked(Logger.prototype.error);
    warn.mockClear();
    error.mockClear();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    new HttpExceptionFilter().catch(exception, {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ url, path: url, method: 'POST', headers: {} }),
      }),
    } as never);
    return {
      body: json.mock.calls[0][0],
      logged: JSON.stringify([...warn.mock.calls, ...error.mock.calls]),
    };
  };
  const pair =
    'Произношение: «Бармалей» не похоже на «Миланочка». Укажите то же слово';

  it('пары произношения: клиенту — текст, в лог — только статус и код', () => {
    const r = storyRun(
      new BadRequestException(pair),
      '/api/story-gifts/g1/video/quote',
    );
    expect(r.body.error.message).toBe(pair);
    expect(r.logged).not.toContain('Миланочка');
    expect(r.logged).not.toContain('Бармалей');
    expect(r.logged).toContain('→ 400 Bad Request');
    expect(r.logged).toContain('[текст Story скрыт]');
  });

  it('преамбула/реплика/образ: все маршруты Story, машинный код остаётся; 5xx — без текста и в стеке', () => {
    for (const url of [
      '/api/story-gifts/g1/video',
      '/api/story-gift/abc/audio',
      '/api/story-render-input/tok/intro',
      '/api/admin/story-tales/renders/r1/close',
      '/api/brand-manifests/m1/narrator-looks',
    ]) {
      const r = storyRun(
        new ConflictException({
          code: 'STORY_PROMISE',
          message: 'Вступление «Папа вернётся завтра» содержит обещание',
        }),
        url,
      );
      expect(r.logged).not.toContain('Папа');
      expect(r.logged).toContain('STORY_PROMISE');
    }
    const e = storyRun(
      new HttpException('Милана: сбой', 503),
      '/api/story-gifts/g1',
    );
    expect(e.logged).not.toContain('Милана');
    expect(e.logged).toContain('at ');
  });

  it('прочие маршруты логируют текст как раньше', () => {
    const r = storyRun(
      new BadRequestException('Неверный формат'),
      '/api/brand-manifests/m1',
    );
    expect(r.logged).toContain('Неверный формат');
  });
});
