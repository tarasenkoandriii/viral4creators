/**
 * Фильтр — единственная точка, где текст исключения встречается с
 * клиентом (этап 54, Б-3.6). Проверяем границу: своё уходит, чужое нет.
 */
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import {
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
      error: { code: string; message: string };
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
