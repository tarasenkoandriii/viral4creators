/**
 * OpenAPI фактов против НАСТОЯЩЕГО импорта платформы
 * (`sites-backend/.../openapi-import.ts`, чистый модуль): спецификация
 * импортируется без ошибок, и каждая операция классифицируется `read` —
 * иначе «Админка» не включила бы её в Э7 и требовала бы «Да» на чтение.
 */
import { parseOpenApi } from '../../../../sites-backend/src/modules/assist-admin-mode/openapi-import';
import { buildGuideOpenApi, factsServerUrl } from './guide-assist-openapi';

const SERVER = 'https://api.viral4creators.app/api/guide-assist/v1';

describe('Ш6 — OpenAPI фактов гида', () => {
  it('servers[0] собирается из API_PUBLIC_URL; без него — null', () => {
    expect(factsServerUrl('https://api.viral4creators.app/api/')).toBe(SERVER);
    expect(factsServerUrl('')).toBeNull();
    expect(factsServerUrl(undefined)).toBeNull();
  });

  it('импорт платформы: три операции, все read, параметры поддержаны', () => {
    const spec = parseOpenApi(JSON.stringify(buildGuideOpenApi(SERVER)));
    expect(spec.baseUrl).toBe(SERVER);
    expect(spec.operations.map((o) => o.operationId).sort()).toEqual([
      'getAccountSummary',
      'getProjectFacts',
      'listProjects',
    ]);
    for (const op of spec.operations) {
      expect(op.method.toUpperCase()).toBe('GET');
      expect(op.autoKind).toBe('read');
      expect(op.unsupported).toBe(false);
    }
    const facts = spec.operations.find(
      (o) => o.operationId === 'getProjectFacts',
    )!;
    expect(facts.params).toEqual([
      expect.objectContaining({
        name: 'projectId',
        in: 'path',
        required: true,
      }),
    ]);
  });

  it('в спецификации нет секретов и пользовательских данных', () => {
    const text = JSON.stringify(buildGuideOpenApi(SERVER));
    expect(text).not.toMatch(/pk_live_|sk_|Bearer [A-Za-z0-9]/);
  });
});
