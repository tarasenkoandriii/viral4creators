-- Приватность и модерация библиотеки разборов (ТЗ §21.1/§21.3, этап 25).
-- Написана вручную (нет доступа к binaries.prisma.sh); соответствует schema.prisma.

-- CreateEnum
CREATE TYPE "LibraryVisibility" AS ENUM ('PUBLIC', 'PRIVATE', 'HIDDEN');

-- AlterTable
ALTER TABLE "analysis_library"
ADD COLUMN "visibility" "LibraryVisibility" NOT NULL DEFAULT 'PUBLIC',
ADD COLUMN "hiddenReason" TEXT,
ADD COLUMN "moderatedAt" TIMESTAMP(3),
ADD COLUMN "moderatedById" TEXT;

-- Существующие записи из загруженных файлов приватны задним числом:
-- у них нет публичного источника (ТЗ §21.3).
UPDATE "analysis_library" SET "visibility" = 'PRIVATE' WHERE "sourceType" = 'upload';

-- CreateIndex
CREATE INDEX "analysis_library_visibility_idx" ON "analysis_library"("visibility");

-- AddForeignKey
ALTER TABLE "analysis_library" ADD CONSTRAINT "analysis_library_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
