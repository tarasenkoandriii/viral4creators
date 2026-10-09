import {
  bodyParserMessage,
  bodyParserStatus,
  stripRouteNotFoundQuery,
} from './http-error-helpers';

describe('bodyParserStatus: ошибки разбора тела — свой 4xx, не 500', () => {
  const err = (status: number, type: string, expose = true) =>
    Object.assign(new Error('x'), { status, type, expose });

  it('413 entity.too.large, 415 encoding.unsupported, 400 entity.parse.failed', () => {
    expect(bodyParserStatus(err(413, 'entity.too.large'))).toBe(413);
    expect(bodyParserStatus(err(415, 'encoding.unsupported'))).toBe(415);
    expect(bodyParserStatus(err(415, 'charset.unsupported'))).toBe(415);
    expect(bodyParserStatus(err(400, 'entity.parse.failed'))).toBe(400);
    expect(bodyParserStatus(err(400, 'request.aborted'))).toBe(400);
  });

  it('не body-parser: без expose, 5xx, чужой type, не объект — null', () => {
    expect(bodyParserStatus(err(413, 'entity.too.large', false))).toBeNull();
    expect(bodyParserStatus(err(500, 'entity.too.large'))).toBeNull();
    expect(bodyParserStatus(err(400, 'prisma.error'))).toBeNull();
    expect(bodyParserStatus(new TypeError('boom'))).toBeNull();
    expect(bodyParserStatus(null)).toBeNull();
    expect(bodyParserStatus('entity.too.large')).toBeNull();
  });

  it('фраза — своя по статусу', () => {
    expect(bodyParserMessage(413)).toBe('Тело запроса слишком большое');
    expect(bodyParserMessage(415)).toBe('Неверное тело запроса');
  });
});

describe('stripRouteNotFoundQuery: 404 Nest без query', () => {
  it('Cannot GET /x?code=… → Cannot GET /x', () => {
    expect(
      stripRouteNotFoundQuery('Cannot GET /api/no/such?code=SECRET&state=1'),
    ).toBe('Cannot GET /api/no/such');
    expect(stripRouteNotFoundQuery('Cannot POST /hook?secret=a\nb')).toBe(
      'Cannot POST /hook',
    );
  });

  it('без query и чужие тексты — без изменений', () => {
    expect(stripRouteNotFoundQuery('Cannot GET /api/no/such')).toBe(
      'Cannot GET /api/no/such',
    );
    expect(stripRouteNotFoundQuery('Проект не найден?')).toBe(
      'Проект не найден?',
    );
    expect(stripRouteNotFoundQuery('cannot get /x?y')).toBe('cannot get /x?y');
  });
});
