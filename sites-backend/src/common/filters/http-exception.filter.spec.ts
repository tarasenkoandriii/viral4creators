import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

interface Out {
  status: number;
  body: { error: { code: string; message: string } };
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
});
