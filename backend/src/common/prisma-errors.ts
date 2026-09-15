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

/**
 * Postgres "record not found" (Prisma P2025) — тот же структурный приём,
 * что и `isUniqueConstraintViolation` выше. Нужна `purgeSoftDeletedItems`
 * (этап 89, `project.service.ts`): родительский проект мог быть физически
 * удалён тем же крон-проходом (`purgeSoftDeletedProjects`, каскад БД), и
 * тогда `productItem.delete()` для уже унесённого каскадом товара падает
 * с P2025 — это не сбой, а «уже нечего удалять».
 */
export function isRecordNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2025'
  );
}
