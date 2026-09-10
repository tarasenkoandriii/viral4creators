-- Режимы сервиса lite/standard/premium (ТЗ §23, этап 29).
-- Написана вручную (нет доступа к binaries.prisma.sh); соответствует schema.prisma.

-- CreateEnum
CREATE TYPE "UserPlan" AS ENUM ('LITE', 'STANDARD', 'PREMIUM');

-- AlterTable
ALTER TABLE "users" ADD COLUMN "plan" "UserPlan" NOT NULL DEFAULT 'LITE',
ADD COLUMN "planSince" TIMESTAMP(3);
