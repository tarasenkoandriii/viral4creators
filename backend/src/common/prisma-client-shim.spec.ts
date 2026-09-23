/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any -- проверяем модуль-подмену */

import * as path from 'path';

/**
 * Подмена `@prisma/client` (`test/prisma-client-shim.ts`) включается
 * маппингом в конфиге jest и потому действует на ВСЕ наборы. Тем
 * важнее доказать её главное обещание: когда настоящий клиент есть —
 * в CI он есть всегда, — подмена не меняет ничего.
 */
describe('prisma-client-shim', () => {
  const SHIM = '../../test/prisma-client-shim';
  const saved = process.env.PRISMA_CLIENT_SHIM_MODULE;

  afterEach(() => {
    if (saved === undefined) delete process.env.PRISMA_CLIENT_SHIM_MODULE;
    else process.env.PRISMA_CLIENT_SHIM_MODULE = saved;
  });

  it('настоящий клиент есть — реэкспортируется как есть', () => {
    process.env.PRISMA_CLIENT_SHIM_MODULE = path.join(
      __dirname,
      '../../test/prisma-client-fake.js',
    );
    jest.isolateModules(() => {
      const shim = require(SHIM);
      expect(shim.MARKER).toBe('real');
      expect(shim.Prisma.DbNull).toBe('real-dbnull');
    });
  });

  it('клиента нет — перечисление отдаёт имя свойства', () => {
    // Ровно семантика перечислений Prisma: `WorkflowKind.SINGLE` — это
    // строка `'SINGLE'`. Список перечислений здесь не хранится
    // намеренно: он устарел бы к следующей миграции.
    process.env.PRISMA_CLIENT_SHIM_MODULE = path.join(
      __dirname,
      'нет-такого-модуля',
    );
    jest.isolateModules(() => {
      const shim = require(SHIM);
      expect(shim.WorkflowKind.SINGLE).toBe('SINGLE');
      expect(shim.SharedVideoStatus.PUBLISHED).toBe('PUBLISHED');
      expect(typeof shim.Prisma.DbNull).toBe('symbol');
      expect(shim.Prisma.DbNull).toBe(shim.Prisma.DbNull);
    });
  });
});
