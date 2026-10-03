/**
 * Чистые модули «Админки» (Э7): шифрование секретов (версия ключа, AAD),
 * employee-JWT (приёмка: чужая подпись / истёкший / `aud` другого сайта —
 * отказ), импорт и классификация OpenAPI 3.x (§5.2).
 */
import { randomBytes } from 'crypto';
import {
  AdminSecretsError,
  loadAdminKeyring,
  openAdminSecret,
  sealAdminSecret,
  secretTail,
} from './admin-secrets-crypto';
import {
  IdentityJwtError,
  signEmployeeJwt,
  verifyEmployeeJwt,
} from './identity-jwt';
import {
  OpenApiImportError,
  canSetKind,
  classifyOperation,
  parseOpenApi,
} from './openapi-import';

const KEY = randomBytes(32).toString('base64');
const AAD = {
  accountId: 'acc1',
  siteId: 'site1',
  ownerId: 'conn1',
  purpose: 'connector-secret' as const,
};

describe('admin-secrets-crypto', () => {
  it('нет ключа — not_configured (секрет не пишется открытым текстом)', () => {
    expect(() => loadAdminKeyring({})).toThrow(AdminSecretsError);
  });

  it('шифр с версией и AAD: перестановка в чужую строку/назначение не расшифровывается', () => {
    const ring = loadAdminKeyring({ ASSIST_SECRETS_KEY: KEY });
    const s = sealAdminSecret('tok-1234567890', AAD, ring);
    expect(s.ciphertext).toMatch(/^as1\.v1\./);
    expect(s.ciphertext).not.toContain('tok-1234567890');
    expect(openAdminSecret(s, AAD, ring)).toBe('tok-1234567890');
    for (const bad of [
      { ...AAD, ownerId: 'conn2' },
      { ...AAD, siteId: 'site2' },
      { ...AAD, accountId: 'acc2' },
      { ...AAD, purpose: 'identity-secret' as const },
    ]) {
      expect(() => openAdminSecret(s, bad, ring)).toThrow(
        expect.objectContaining({ code: 'tampered' }),
      );
    }
    expect(() =>
      openAdminSecret({ ...s, keyVersion: 'v2' }, AAD, ring),
    ).toThrow(expect.objectContaining({ code: 'version_mismatch' }));
  });

  it('ротация: новый ключ v2 шифрует, старый v1 из ASSIST_SECRETS_KEYS_OLD расшифровывает', () => {
    const old = loadAdminKeyring({ ASSIST_SECRETS_KEY: KEY });
    const s1 = sealAdminSecret('old-secret-1', AAD, old);
    const KEY2 = randomBytes(32).toString('base64');
    const ring = loadAdminKeyring({
      ASSIST_SECRETS_KEY: KEY2,
      ASSIST_SECRETS_KEY_VERSION: 'v2',
      ASSIST_SECRETS_KEYS_OLD: `v1:${KEY}`,
    });
    expect(openAdminSecret(s1, AAD, ring)).toBe('old-secret-1');
    expect(sealAdminSecret('x-new-secret', AAD, ring).keyVersion).toBe('v2');
    expect(() =>
      openAdminSecret(
        s1,
        AAD,
        loadAdminKeyring({
          ASSIST_SECRETS_KEY: KEY2,
          ASSIST_SECRETS_KEY_VERSION: 'v2',
        }),
      ),
    ).toThrow(expect.objectContaining({ code: 'unknown_key' }));
  });

  it('хвост секрета — только 4 символа и только у длинных', () => {
    expect(secretTail('abcdefgh1a2b')).toBe('1a2b');
    expect(secretTail('short')).toBe('');
  });
});

describe('employee-JWT', () => {
  const SECRET = 'site-secret-' + 'x'.repeat(32);
  const now = Date.UTC(2026, 9, 3, 12, 0, 0);
  const t = now / 1000;
  const good = {
    sub: 'emp-17',
    role: 'manager',
    name: 'Оля',
    aud: 'site1',
    iat: t,
    exp: t + 600,
  };

  it('правильная подпись — сотрудник', () => {
    const id = verifyEmployeeJwt(
      signEmployeeJwt(good, SECRET),
      SECRET,
      'site1',
      now,
    );
    expect(id).toMatchObject({ sub: 'emp-17', role: 'manager', name: 'Оля' });
  });

  it.each([
    ['чужая подпись', signEmployeeJwt(good, 'other-secret'), 'signature'],
    [
      'истёкший',
      signEmployeeJwt({ ...good, iat: t - 1200, exp: t - 300 }, SECRET),
      'expired',
    ],
    [
      'aud другого сайта',
      signEmployeeJwt({ ...good, aud: 'site2' }, SECRET),
      'audience',
    ],
    ['без exp', signEmployeeJwt({ ...good, exp: undefined }, SECRET), 'claims'],
    [
      'дольше 15 минут',
      signEmployeeJwt({ ...good, exp: t + 3600 }, SECRET),
      'ttl_too_long',
    ],
    [
      'iat из будущего',
      signEmployeeJwt({ ...good, iat: t + 600, exp: t + 900 }, SECRET),
      'not_yet_valid',
    ],
    ['alg none', signEmployeeJwt(good, SECRET, { alg: 'none' }), 'alg'],
    ['alg HS512', signEmployeeJwt(good, SECRET, { alg: 'HS512' }), 'alg'],
    [
      'аудит Э7: crit в заголовке',
      signEmployeeJwt(good, SECRET, { alg: 'HS256', crit: ['exp'] }),
      'alg',
    ],
    [
      'аудит Э7: ключ из токена (jwk)',
      signEmployeeJwt(good, SECRET, { alg: 'HS256', jwk: { kty: 'oct' } }),
      'alg',
    ],
    [
      'аудит Э7: nbf не число',
      signEmployeeJwt({ ...good, nbf: 'later' }, SECRET),
      'claims',
    ],
    ['без sub', signEmployeeJwt({ ...good, sub: '' }, SECRET), 'claims'],
    ['мусор', 'a.b', 'malformed'],
  ])('%s — отказ', (_n, token, code) => {
    expect(() => verifyEmployeeJwt(token, SECRET, 'site1', now)).toThrow(
      expect.objectContaining({ code }),
    );
    let err: unknown = null;
    try {
      verifyEmployeeJwt(token, SECRET, 'site1', now);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IdentityJwtError);
    // В тексте ошибки нет самого токена.
    expect((err as Error).message).not.toContain(token.slice(0, 20));
  });
});

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Shop API' },
  servers: [{ url: 'https://api.shop.example/v1' }],
  components: {
    parameters: {
      OrderId: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string' },
      },
    },
  },
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        summary: 'Список заказов',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['new', 'paid'] },
          },
        ],
      },
      post: { operationId: 'createOrder', summary: 'Создать заказ' },
    },
    '/orders/{id}': {
      parameters: [{ $ref: '#/components/parameters/OrderId' }],
      get: { operationId: 'getOrder', summary: 'Заказ по номеру' },
      patch: { operationId: 'updateOrder' },
      delete: { operationId: 'deleteOrder' },
    },
    '/orders/{id}/refund': {
      parameters: [{ $ref: '#/components/parameters/OrderId' }],
      post: { operationId: 'refundOrder', summary: 'Возврат денег' },
    },
    '/orders/bulk-status': {
      post: {
        operationId: 'setStatuses',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { orderIds: { type: 'array' } },
              },
            },
          },
        },
      },
    },
    '/refunds': {
      get: { operationId: 'listRefunds', summary: 'Список возвратов' },
    },
    '/sync': {
      get: { operationId: 'syncNow', description: 'Creates a sync job' },
    },
    '/secure': {
      get: {
        operationId: 'needsHeader',
        parameters: [{ name: 'X-Tenant', in: 'header', required: true }],
      },
    },
  },
};

describe('импорт OpenAPI 3.x и классификация (§5.2)', () => {
  it('операции, базовый URL, классы', () => {
    const s = parseOpenApi(JSON.stringify(SPEC));
    expect(s.baseUrl).toBe('https://api.shop.example/v1');
    expect(s.title).toBe('Shop API');
    const k = Object.fromEntries(
      s.operations.map((o) => [o.operationId, o.autoKind]),
    );
    expect(k).toEqual({
      listOrders: 'read',
      createOrder: 'write',
      getOrder: 'read',
      updateOrder: 'write',
      deleteOrder: 'danger',
      refundOrder: 'danger',
      setStatuses: 'danger',
      listRefunds: 'read',
      syncNow: 'write',
      needsHeader: 'read',
    });
    const get = s.operations.find((o) => o.operationId === 'getOrder')!;
    expect(get.params).toEqual([
      { name: 'id', in: 'path', required: true, type: 'string' },
    ]);
    expect(
      s.operations.find((o) => o.operationId === 'needsHeader')!.unsupported,
    ).toBe(true);
  });

  it('класс поднимается, но не опускается', () => {
    expect(canSetKind('read', 'write')).toBe(true);
    expect(canSetKind('write', 'danger')).toBe(true);
    expect(canSetKind('write', 'read')).toBe(false);
    expect(canSetKind('danger', 'write')).toBe(false);
  });

  it('стоп-слова в изменяющих методах — danger (рус/укр/англ)', () => {
    for (const name of [
      'cancelSubscription',
      'payoutSeller',
      'повернення коштів',
      'удалить товар',
    ]) {
      expect(
        classifyOperation({
          method: 'POST',
          operationId: 'x',
          path: '/x',
          summary: name,
          description: null,
          massIds: false,
        }).kind,
      ).toBe('danger');
    }
  });

  it.each([
    ['не JSON', 'openapi: 3.0.0', 'not_json'],
    [
      'Swagger 2',
      JSON.stringify({ swagger: '2.0', paths: {} }),
      'not_openapi3',
    ],
    [
      'http-сервер',
      JSON.stringify({
        ...SPEC,
        servers: [{ url: 'http://api.shop.example' }],
      }),
      'bad_server',
    ],
    [
      'порт',
      JSON.stringify({
        ...SPEC,
        servers: [{ url: 'https://api.shop.example:8443' }],
      }),
      'bad_server',
    ],
    ['без операций', JSON.stringify({ ...SPEC, paths: {} }), 'no_operations'],
  ])('%s — отказ', (_n, text, code) => {
    expect(() => parseOpenApi(text)).toThrow(OpenApiImportError);
    expect(() => parseOpenApi(text)).toThrow(expect.objectContaining({ code }));
  });

  it('аудит Э7: GET/HEAD с глаголом-действием — не read (класс не опустить)', () => {
    const cls = (method: string, operationId: string, path: string) =>
      classifyOperation({
        method,
        operationId,
        path,
        summary: null,
        description: null,
        massIds: false,
      }).kind;
    expect(cls('GET', 'deleteUser', '/users/{id}')).toBe('danger');
    expect(cls('GET', 'x', '/orders/{id}/cancel')).toBe('danger');
    expect(cls('HEAD', 'x', '/cache/purge')).toBe('danger');
    expect(cls('GET', 'setWebhook', '/hook')).toBe('write');
    expect(cls('GET', 'get_orders_by_id_approve', '/orders/{id}/approve')).toBe(
      'write',
    );
    // Существительные и «get…» — по-прежнему чтение.
    expect(cls('GET', 'listRefunds', '/refunds')).toBe('read');
    expect(cls('GET', 'getUpdates', '/updates')).toBe('read');
    expect(cls('GET', 'getCancelledOrders', '/orders/cancelled')).toBe('read');
    const s = parseOpenApi(
      JSON.stringify({
        ...SPEC,
        paths: { '/users/{id}/delete': { get: { operationId: 'dropUser' } } },
      }),
    );
    expect(s.operations[0].autoKind).toBe('danger');
    expect(canSetKind(s.operations[0].autoKind, 'read')).toBe(false);
  });

  it('$ref на чужой URL не разрешается', () => {
    const spec = {
      ...SPEC,
      paths: {
        '/x/{id}': {
          get: {
            operationId: 'x',
            parameters: [{ $ref: 'https://evil.example/p.json' }],
          },
        },
      },
    };
    const s = parseOpenApi(JSON.stringify(spec));
    expect(s.operations[0].params).toEqual([]);
  });
});
