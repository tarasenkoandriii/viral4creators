/**
 * Postgres unique-violation (Prisma P2002) — проверяется по структуре, а
 * не импортом `Prisma.PrismaClientKnownRequestError`: код и код ошибки
 * достаточно, и файл не тянет типы сгенерированного клиента. Вынесено
 * из `credit-ledger.service.ts` (седьмой аудит, М-1.6), где та же
 * проверка нужна и админскому возврату.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
