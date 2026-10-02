-- Э-С, шаг Ш1 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md;
-- предложения П-Т1 и П-Т2 docs-tz/SECURITY-PROPOSALS-2026-10-02.md):
-- режимы A/B обучалки по сайту заказчика и подтверждение прав на аккаунт.
--
-- Написана руками — сеть до binaries.prisma.sh недоступна в песочнице
-- разработки (doc/CI.md), `prisma migrate diff --exit-code` в CI
-- проверит, что она не разошлась со schema.prisma.
--
-- `siteMode` ('A' | 'B') — режим черновика по статусу хоста во
-- внутреннем API sites-backend; `siteModeCheckedAt` — когда проверялся;
-- `siteHostId` — id хоста в кабинете sites-backend (без FK: другая база).
-- Без backfill: NULL читается как B до первой проверки.
ALTER TABLE "client_site_tutorial_drafts"
  ADD COLUMN "siteMode" TEXT,
  ADD COLUMN "siteModeCheckedAt" TIMESTAMP(3),
  ADD COLUMN "siteHostId" TEXT;

-- Подтверждение прав на аккаунт и согласия с условиями сайта (режим B):
-- одна строка на (пользователь, регистрируемый домен, версия текста).
-- Новая версия текста — новая строка; старые остаются журналом.
CREATE TABLE "client_site_account_consents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "registrableDomain" TEXT NOT NULL,
    "textVersion" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT,

    CONSTRAINT "client_site_account_consents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "client_site_account_consents_user_domain_version_key" ON "client_site_account_consents"("userId", "registrableDomain", "textVersion");

ALTER TABLE "client_site_account_consents" ADD CONSTRAINT "client_site_account_consents_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
