/**
 * «Только чтение» под сессией учётки (заход 11, Р-З11-Г1…Г4): методы,
 * доказанное чтение GraphQL, «выход» и разрушительные адреса из скрипта.
 */
import {
  GRAPHQL_BODY_MAX,
  graphqlDefinitions,
  graphqlDocIsRead,
  graphqlGetIsWrite,
  graphqlPath,
  graphqlPostIsRead,
  jsonHasDuplicateKeys,
  writeRefusal,
  type GuardedRequest,
} from '../../src/safety/write-guard';

const req = (r: Partial<GuardedRequest>): GuardedRequest => ({
  method: 'GET',
  url: 'https://admin.shop.test/admin',
  resourceType: 'fetch',
  ownNavigation: false,
  contentType: null,
  body: () => null,
  ...r,
});

const gql = (body: unknown, url = 'https://admin.shop.test/api/graphql') =>
  req({
    method: 'POST',
    url,
    contentType: 'application/json; charset=utf-8',
    body: () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });

describe('write-guard: методы', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('%s — чтение', (method) => {
    expect(writeRefusal(req({ method }))).toBeNull();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'PROPFIND', 'MKCOL'])(
    '%s — обрыв (method)',
    (method) => {
      expect(writeRefusal(req({ method, body: () => '{}' }))).toBe('method');
    },
  );

  it('beacon и отправка формы (POST-переход) — обрыв', () => {
    expect(
      writeRefusal(
        req({
          method: 'POST',
          resourceType: 'ping',
          contentType: 'text/plain;charset=UTF-8',
          body: () => 'seen=1',
        }),
      ),
    ).toBe('method');
    expect(
      writeRefusal(
        req({
          method: 'POST',
          resourceType: 'document',
          ownNavigation: false,
          contentType: 'application/x-www-form-urlencoded',
          body: () => 'status=paid',
        }),
      ),
    ).toBe('method');
  });

  it('POST с телом «как GraphQL», но не на путь GraphQL — обрыв', () => {
    expect(
      writeRefusal(gql({ query: '{ me { id } }' }, 'https://a.test/api/save')),
    ).toBe('method');
  });

  it('битый адрес — обрыв', () => {
    expect(writeRefusal(req({ url: 'not a url' }))).toBe('method');
  });
});

describe('write-guard: GraphQL', () => {
  it('доказанное чтение проходит: query, краткая форма, фрагменты, пакет', () => {
    expect(writeRefusal(gql({ query: 'query Menu { menu { title } }' }))).toBe(
      null,
    );
    expect(writeRefusal(gql({ query: '{ me { id } }' }))).toBeNull();
    expect(
      writeRefusal(
        gql({
          operationName: 'Orders',
          variables: { first: 10, filter: { status: 'NEW' } },
          query: `# список заказов
            query Orders($first: Int = 10, $filter: OrderFilter = {status: "NEW"}) {
              orders(first: $first, filter: $filter) @connection(key: "o") {
                edges { node { ...OrderRow } }
              }
            }
            fragment OrderRow on Order { id title(lang: "uk") }`,
          extensions: { tracing: true },
        }),
      ),
    ).toBeNull();
    expect(
      writeRefusal(gql([{ query: '{ a }' }, { query: 'query B { b }' }])),
    ).toBeNull();
    // `application/graphql` — сырой документ; путь `/query` (gqlgen).
    expect(
      writeRefusal(
        req({
          method: 'POST',
          url: 'https://a.test/query',
          contentType: 'application/graphql',
          body: () => '{ shop { name } }',
        }),
      ),
    ).toBeNull();
    // Shopify-подобный путь.
    expect(
      writeRefusal(
        gql(
          { query: '{ shop { name } }' },
          'https://a.test/admin/api/2024-01/graphql.json',
        ),
      ),
    ).toBeNull();
  });

  it.each([
    ['мутация', { query: 'mutation { markSeen(id: 1) }' }],
    ['подписка', { query: 'subscription { orderAdded { id } }' }],
    [
      'мутация в документе рядом с запросом',
      { query: 'query A { a } mutation B { del }', operationName: 'A' },
    ],
    ['мутация в пакете', [{ query: '{ a }' }, { query: 'mutation { b }' }]],
    [
      'только хеш persisted query',
      { extensions: { persistedQuery: { version: 1, sha256Hash: 'ab' } } },
    ],
    ['чужое поле тела', { query: '{ a }', action: 'delete' }],
    ['пустой пакет', []],
    ['не объект', 'null'],
    ['битый JSON', '{"query":'],
    ['незакрытая скобка', { query: '{ a { b }' }],
    ['незакрытая строка', { query: '{ a(s: "x) }' }],
    ['SDL', { query: 'type Query { a: Int }' }],
    ['одни фрагменты', { query: 'fragment F on T { a }' }],
    ['слово операции в заголовке', { query: 'query mutation { a }' }],
    ['определение без набора полей', { query: 'query Q' }],
    ['чужой символ', { query: '{ a } ;' }],
  ])('%s — обрыв (graphql)', (_name, body) => {
    expect(writeRefusal(gql(body))).toBe('graphql');
  });

  it('тело больше потолка, multipart, без типа — не доказано', () => {
    const big = `{ a${' '.repeat(GRAPHQL_BODY_MAX)} }`;
    expect(writeRefusal(gql({ query: big }))).toBe('graphql');
    const u = new URL('https://a.test/graphql');
    const body = () => JSON.stringify({ query: '{ a }' });
    expect(graphqlPostIsRead(u, 'multipart/form-data; boundary=x', body)).toBe(
      false,
    );
    expect(graphqlPostIsRead(u, null, body)).toBe(false);
    expect(graphqlPostIsRead(u, 'text/plain', body)).toBe(false);
    expect(graphqlPostIsRead(u, 'application/graphql+json', body)).toBe(true);
    expect(
      graphqlPostIsRead(u, 'application/json', () => {
        throw new Error('binary');
      }),
    ).toBe(false);
  });

  it('строки, блочные строки и комментарии не путают разбор', () => {
    expect(
      graphqlDocIsRead(
        '{ a(s: "mutation { x }", t: """ } mutation \\""" """) }',
      ),
    ).toBe(true);
    expect(graphqlDocIsRead('# mutation { x }\n{ a }')).toBe(true);
    expect(
      graphqlDefinitions('query A { a } fragment F on Mutation { b }'),
    ).toEqual(['query', 'fragment']);
    expect(graphqlDefinitions('{ a } { b }')).toEqual(['anon', 'anon']);
    expect(graphqlDefinitions('{ a ]')).toBeNull();
    expect(graphqlDefinitions('"""открыта')).toBeNull();
  });

  it('GET/HEAD: мутация в `?query=` — обрыв; на пути GraphQL — и неразобранный документ, и повтор параметра', () => {
    const g = (q: string, path = '/graphql') =>
      new URL(`https://a.test${path}?query=${encodeURIComponent(q)}`);
    expect(graphqlGetIsWrite(g('mutation { del(id: 1) }'))).toBe(true);
    expect(graphqlGetIsWrite(g('subscription S { x }'))).toBe(true);
    expect(graphqlGetIsWrite(g('{ a }'))).toBe(false);
    // Аудит P3-1: операция с именем `query` после `mutation` — лексер
    // «не доказал», на пути GraphQL это обрыв.
    expect(graphqlGetIsWrite(g('mutation query { deleteAll }'))).toBe(true);
    expect(graphqlGetIsWrite(g('mutation'))).toBe(true);
    expect(
      graphqlGetIsWrite(
        new URL(
          `https://a.test/graphql?query=${encodeURIComponent('{ a }')}&query=${encodeURIComponent('{ b }')}`,
        ),
      ),
    ).toBe(true);
    // Вне пути GraphQL `?query=` — поиск: только разобранная мутация.
    expect(graphqlGetIsWrite(g('mutation', '/search'))).toBe(false);
    expect(graphqlGetIsWrite(g('mutation query { x }', '/search'))).toBe(false);
    expect(graphqlGetIsWrite(g('mutation { del }', '/search'))).toBe(true);
    expect(
      graphqlGetIsWrite(new URL('https://a.test/search?query=shoes')),
    ).toBe(false);
    for (const method of ['GET', 'HEAD']) {
      expect(
        writeRefusal(
          req({
            method,
            url: g('mutation { del(id: 1) }').toString(),
            resourceType: 'xhr',
          }),
        ),
      ).toBe('graphql');
    }
  });

  it('аудит P2-2: POST с параметрами операции в адресе — обрыв (адрес главнее тела)', () => {
    for (const q of [
      `query=${encodeURIComponent('mutation { deleteAll }')}`,
      'operationName=Del',
      'extensions=%7B%7D',
      'documentId=abc',
      'id=abc',
      'doc_id=1',
    ]) {
      expect(
        writeRefusal(gql({ query: '{ a }' }, `https://a.test/graphql?${q}`)),
      ).toBe('graphql');
    }
    // Посторонний параметр адреса — не мешает.
    expect(
      writeRefusal(gql({ query: '{ a }' }, 'https://a.test/graphql?lang=uk')),
    ).toBeNull();
  });

  it('аудит P3-2: повтор ключа (и через \\u-экранирование), persisted query с текстом — обрыв', () => {
    expect(
      writeRefusal(gql('{"query":"mutation { x }","query":"{ a }"}')),
    ).toBe('graphql');
    expect(
      writeRefusal(gql('{"query":"mutation { x }","\\u0071uery":"{ a }"}')),
    ).toBe('graphql');
    expect(
      writeRefusal(
        gql({
          query: '{ a }',
          extensions: { persistedQuery: { version: 1, sha256Hash: 'ab' } },
        }),
      ),
    ).toBe('graphql');
    expect(writeRefusal(gql({ query: '{ a }', extensions: 'x' }))).toBe(
      'graphql',
    );
    // Одинаковые ключи в РАЗНЫХ объектах — не повтор.
    expect(
      writeRefusal(
        gql({ query: '{ a }', variables: { a: { id: 1 }, b: { id: 2 } } }),
      ),
    ).toBeNull();
    expect(
      jsonHasDuplicateKeys('{"a":1,"b":{"a":2},"c":[{"a":1},{"a":2}]}'),
    ).toBe(false);
    expect(jsonHasDuplicateKeys('{"a":1,"b":{"x":1,"x":2}}')).toBe(true);
    expect(jsonHasDuplicateKeys('{"a":"\\"a\\"","a":1}')).toBe(true);
    expect(jsonHasDuplicateKeys('{"a":')).toBeNull();
  });

  it('аудит P3-3: путь GraphQL — сегмент, не подстрока', () => {
    const u = (p: string) => new URL(`https://a.test${p}`);
    for (const p of [
      '/graphql',
      '/api/graphql',
      '/gql',
      '/v1/gql/',
      '/admin/api/2024-01/graphql.json',
      '/api/graphql-proxy',
      '/query',
    ])
      expect(graphqlPath(u(p))).toBe(true);
    for (const p of ['/api/sgqlx/save', '/gqlx', '/api/notgql', '/query/run'])
      expect(graphqlPath(u(p))).toBe(false);
    expect(
      writeRefusal(gql({ query: '{ a }' }, 'https://a.test/api/sgqlx/save')),
    ).toBe('method');
  });
});

describe('write-guard: адреса из скрипта', () => {
  it('«выход» — обрыв для fetch, картинки и перехода страницы; код и стили — нет', () => {
    expect(writeRefusal(req({ url: 'https://a.test/logout' }))).toBe('logout');
    expect(
      writeRefusal(
        req({
          url: 'https://a.test/account/sign-out?x=1',
          resourceType: 'image',
        }),
      ),
    ).toBe('logout');
    expect(
      writeRefusal(
        req({ url: 'https://a.test/uk/вийти', resourceType: 'document' }),
      ),
    ).toBe('logout');
    expect(
      writeRefusal(
        req({
          url: 'https://a.test/js/logout-button.js',
          resourceType: 'script',
        }),
      ),
    ).toBeNull();
  });

  it('разрушительный адрес или платёжный путь — обрыв для активных видов', () => {
    expect(
      writeRefusal(req({ url: 'https://a.test/api/orders/9/cancel' })),
    ).toBe('danger');
    expect(
      writeRefusal(
        req({
          url: 'https://a.test/orders/9/delete',
          resourceType: 'document',
        }),
      ),
    ).toBe('danger');
    expect(
      writeRefusal(
        req({ url: 'https://a.test/checkout/pay', resourceType: 'xhr' }),
      ),
    ).toBe('danger');
    // Картинка «delete.svg» — не действие.
    expect(
      writeRefusal(
        req({ url: 'https://a.test/icons/delete.svg', resourceType: 'image' }),
      ),
    ).toBeNull();
    expect(
      writeRefusal(req({ url: 'https://a.test/api/orders?page=2' })),
    ).toBeNull();
  });

  it('аудит P3-4: camelCase и archive/restore/confirm', () => {
    for (const p of [
      '/api/deleteOrder?id=5',
      '/api/orders/5/archive',
      '/api/orders/5/restore',
      '/api/orders/5/confirm',
      '/api/removeItem',
    ])
      expect(writeRefusal(req({ url: `https://a.test${p}` }))).toBe('danger');
    expect(writeRefusal(req({ url: 'https://a.test/api/logoutAll' }))).toBe(
      'logout',
    );
    expect(writeRefusal(req({ url: 'https://a.test/api/logoutUser' }))).toBe(
      'logout',
    );
    // Слово внутри слова — не действие.
    for (const p of ['/api/orderDetails', '/api/archives', '/api/confirmed'])
      expect(writeRefusal(req({ url: `https://a.test${p}` }))).toBeNull();
  });

  it('переход самого воркера (адрес уже проверен стоп-листом) — без проверки адреса', () => {
    expect(
      writeRefusal(
        req({
          url: 'https://a.test/admin/export-center',
          resourceType: 'document',
          ownNavigation: true,
        }),
      ),
    ).toBeNull();
    // Но метод решает всегда.
    expect(
      writeRefusal(
        req({
          method: 'POST',
          url: 'https://a.test/admin',
          resourceType: 'document',
          ownNavigation: true,
          body: () => 'a=1',
        }),
      ),
    ).toBe('method');
  });

  it('доказанное чтение GraphQL на «разрушительный» адрес — всё равно обрыв', () => {
    expect(
      writeRefusal(gql({ query: '{ a }' }, 'https://a.test/graphql?op=delete')),
    ).toBe('danger');
  });
});
