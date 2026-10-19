import {
  ConflictException,
  ForbiddenException,
  HttpStatus,
  MethodNotAllowedException,
  HttpException,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { setupError } from '../../modules/assist-site-setup/errors';
import { codeFromStatus, HttpExceptionFilter } from './http-exception.filter';

interface Out {
  status: number;
  body: {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  };
}

function run(exception: unknown): Out {
  const out = { status: 0 } as Out;
  const res = {
    status(code: number) {
      out.status = code;
      return this;
    },
    json(body: Out['body']) {
      out.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'GET', url: '/x', originalUrl: '/x' }),
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return out;
}

describe('HttpExceptionFilter: код ошибки', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  it('фраза статуса Nest из одного слова («Forbidden») — не код: код по статусу', () => {
    expect(run(new ForbiddenException('нет доступа')).body.error.code).toBe(
      'FORBIDDEN',
    );
    expect(run(new ConflictException('занято')).body.error.code).toBe(
      'CONFLICT',
    );
  });

  it('свой машинный код в `error` (UPPER_SNAKE) — сохраняется', () => {
    const e = new HttpException(
      { error: 'KNOWLEDGE_BUSY', message: 'Сборка идёт' },
      409,
    );
    const r = run(e);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({
      code: 'KNOWLEDGE_BUSY',
      message: 'Сборка идёт',
    });
  });

  it('кабинет Э2: `errors[]` полей доходит до клиента в details (контракт §6), лишние ключи — нет', () => {
    const e = setupError(400, 'WIDGET_CONFIG_INVALID', 'Неверная настройка', {
      errors: [{ path: 'colors.accent', code: 'color' }],
    });
    (e.getResponse() as Record<string, unknown>).internal = 'секрет';
    const r = run(e);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('WIDGET_CONFIG_INVALID');
    expect(r.body.error.details).toEqual({
      code: 'WIDGET_CONFIG_INVALID',
      errors: [{ path: 'colors.accent', code: 'color' }],
    });
  });

  it('IA-D1-01 = IA-C-03: 405 (GET раскрытия контакта) — METHOD_NOT_ALLOWED, не INTERNAL_SERVER_ERROR; лог — warn', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn');
    const error = jest.spyOn(Logger.prototype, 'error');
    warn.mockClear();
    error.mockClear();
    const r = run(
      new MethodNotAllowedException(
        'раскрытие контакта и заметок — только POST из кабинета',
      ),
    );
    expect(r.status).toBe(405);
    expect(r.body.error).toEqual({
      code: 'METHOD_NOT_ALLOWED',
      message: 'раскрытие контакта и заметок — только POST из кабинета',
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('→ 405 METHOD_NOT_ALLOWED'),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('Р-IA-FXC-1: ни один 4xx не получает INTERNAL_SERVER_ERROR; незнакомый 4xx — CLIENT_ERROR', () => {
    const fourXx = Object.values(HttpStatus).filter(
      (v): v is number => typeof v === 'number' && v >= 400 && v < 500,
    );
    for (const status of [...fourXx, 431, 451, 499]) {
      const code = run(new HttpException('отказ', status)).body.error.code;
      expect({ status, code }).not.toEqual({
        status,
        code: 'INTERNAL_SERVER_ERROR',
      });
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
    expect(codeFromStatus(499)).toBe('CLIENT_ERROR');
    // Прежние коды, по которым ветвятся клиенты, — без изменений.
    expect(codeFromStatus(422)).toBe('VALIDATION_ERROR');
    expect(codeFromStatus(429)).toBe('RATE_LIMIT_EXCEEDED');
    expect(codeFromStatus(503)).toBe('SERVICE_UNAVAILABLE');
    // 5xx: известные — свой код, незнакомый — INTERNAL_SERVER_ERROR.
    expect(codeFromStatus(502)).toBe('BAD_GATEWAY');
    expect(codeFromStatus(500)).toBe('INTERNAL_SERVER_ERROR');
    expect(codeFromStatus(599)).toBe('INTERNAL_SERVER_ERROR');
  });

  it('свой машинный код в `error` у 402/502 по-прежнему главнее кода по статусу', () => {
    const e = new HttpException(
      {
        error: 'EDITOR_SUGGEST_BUDGET',
        code: 'EDITOR_SUGGEST_BUDGET',
        message: 'лимит',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
    expect(run(e).body.error.code).toBe('EDITOR_SUGGEST_BUDGET');
  });

  it('Н-D1-1: ответ-ошибка без своего Cache-Control получает private, no-store (401 глобального входа); заданный маршрутом — не трогается', () => {
    const headers: Record<string, string> = {};
    const res = {
      headersSent: false,
      getHeader: (k: string) => headers[k],
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      status() {
        return this;
      },
      json() {
        return this;
      },
    };
    const host = (r: typeof res) =>
      ({
        switchToHttp: () => ({
          getResponse: () => r,
          getRequest: () => ({ method: 'GET', url: '/publisher/products' }),
        }),
      }) as unknown as ArgumentsHost;
    new HttpExceptionFilter().catch(
      new HttpException('Unauthorized', 401),
      host(res),
    );
    expect(headers['Cache-Control']).toBe('private, no-store');
    headers['Cache-Control'] = 'public, s-maxage=60';
    new HttpExceptionFilter().catch(new HttpException('нет', 404), host(res));
    expect(headers['Cache-Control']).toBe('public, s-maxage=60');
  });
});
