/**
 * Изображает СГЕНЕРИРОВАННОГО клиента Prisma для одного теста
 * (`src/common/prisma-client-shim.spec.ts`): шим обязан отдать этот
 * модуль как есть, ничего не подменяя. Настоящий файл на диске, а не
 * виртуальный мок jest — почему именно так, разобрано в шапке
 * `prisma-client-shim.ts`.
 */
module.exports = {
  MARKER: 'real',
  Prisma: { DbNull: 'real-dbnull' },
};
