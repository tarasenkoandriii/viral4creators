-- Э-С, шаг Ш2 (docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md §3.2
-- «Модель хранения учётных данных входа», «Тестовые учётные записи сайта»;
-- П-Т12 docs-tz/SECURITY-PROPOSALS-2026-10-02.md): реестр тестовых учётных
-- записей сайта, общий для обучалки генератора и QA, хранилище их секретов,
-- аренда на прогон, личные записи режима B и журнал доступа.
--
-- Пишется РУКАМИ; CI сверяет со schema.prisma (`migrate diff --exit-code`).
-- Предыдущие миграции не трогаем.
--
--  * site_test_accounts — тестовый пользователь сайта (кабинет — тенант;
--    составной FK (siteId, accountId) → site_sites, каскад при удалении
--    сайта/кабинета);
--  * site_credentials — секреты учётки (только шифротекст AES-256-GCM,
--    версия ключа, AAD — modules/site-credentials/credential-crypto.ts);
--  * site_credential_leases — одноразовая аренда на прогон с коротким сроком;
--  * user_site_sessions / user_site_secrets — режим B: личная запись
--    пользователя генератора (решение владельца 02.10.2026), без кабинета
--    и без аренды для QA;
--  * site_credential_audit — журнал доступа без секретов, только
--    дописывается (триггер ниже), цепочка prevHash → hash.
--
-- Роли assist_public прав НЕ выдаётся ни на одну таблицу (спек роли
-- src/prisma/assist-public-role.spec.ts проверяет отказ).

-- CreateTable
CREATE TABLE "site_test_accounts" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT,
    "plan" TEXT,
    "username" TEXT,
    "loginMethod" TEXT NOT NULL DEFAULT 'password',
    "hostIds" TEXT[],
    "products" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdBy" TEXT NOT NULL,
    "clientRef" TEXT,
    "confirmedTestAccountAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_test_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_credentials" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "testAccountId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_credential_leases" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "testAccountId" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "runRef" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_credential_leases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_site_sessions" (
    "id" TEXT NOT NULL,
    "ownerRef" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "registrableDomain" TEXT,
    "label" TEXT,
    "products" TEXT[] DEFAULT ARRAY['tutorial']::TEXT[],
    "clientRef" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_site_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_site_secrets" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "keyVersion" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_site_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_credential_audit" (
    "seq" BIGSERIAL NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "accountId" TEXT,
    "subjectId" TEXT,
    "ownerRef" TEXT,
    "product" TEXT,
    "hostId" TEXT,
    "runRef" TEXT,
    "purpose" TEXT,
    "result" TEXT NOT NULL,
    "prevHash" TEXT,
    "hash" TEXT NOT NULL,

    CONSTRAINT "site_credential_audit_pkey" PRIMARY KEY ("seq")
);

-- CreateIndex
CREATE INDEX "site_test_accounts_siteId_idx" ON "site_test_accounts"("siteId");

-- CreateIndex
CREATE INDEX "site_test_accounts_expiresAt_idx" ON "site_test_accounts"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "site_test_accounts_id_accountId_key" ON "site_test_accounts"("id", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "site_test_accounts_accountId_clientRef_key" ON "site_test_accounts"("accountId", "clientRef");

-- CreateIndex
CREATE INDEX "site_credentials_accountId_idx" ON "site_credentials"("accountId");

-- CreateIndex
CREATE INDEX "site_credentials_keyVersion_idx" ON "site_credentials"("keyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "site_credentials_testAccountId_purpose_key" ON "site_credentials"("testAccountId", "purpose");

-- CreateIndex
CREATE INDEX "site_credential_leases_accountId_idx" ON "site_credential_leases"("accountId");

-- CreateIndex
CREATE INDEX "site_credential_leases_testAccountId_idx" ON "site_credential_leases"("testAccountId");

-- CreateIndex
CREATE INDEX "site_credential_leases_expiresAt_idx" ON "site_credential_leases"("expiresAt");

-- CreateIndex
CREATE INDEX "user_site_sessions_ownerRef_idx" ON "user_site_sessions"("ownerRef");

-- CreateIndex
CREATE INDEX "user_site_sessions_expiresAt_idx" ON "user_site_sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_site_sessions_ownerRef_clientRef_key" ON "user_site_sessions"("ownerRef", "clientRef");

-- CreateIndex
CREATE INDEX "user_site_secrets_keyVersion_idx" ON "user_site_secrets"("keyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "user_site_secrets_sessionId_purpose_key" ON "user_site_secrets"("sessionId", "purpose");

-- CreateIndex
CREATE INDEX "site_credential_audit_accountId_at_idx" ON "site_credential_audit"("accountId", "at");

-- CreateIndex
CREATE INDEX "site_credential_audit_subjectId_idx" ON "site_credential_audit"("subjectId");

-- CreateIndex
CREATE INDEX "site_credential_audit_ownerRef_idx" ON "site_credential_audit"("ownerRef");

-- AddForeignKey
ALTER TABLE "site_test_accounts" ADD CONSTRAINT "site_test_accounts_siteId_accountId_fkey" FOREIGN KEY ("siteId", "accountId") REFERENCES "site_sites"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_credentials" ADD CONSTRAINT "site_credentials_testAccountId_accountId_fkey" FOREIGN KEY ("testAccountId", "accountId") REFERENCES "site_test_accounts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_credential_leases" ADD CONSTRAINT "site_credential_leases_testAccountId_accountId_fkey" FOREIGN KEY ("testAccountId", "accountId") REFERENCES "site_test_accounts"("id", "accountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_secrets" ADD CONSTRAINT "user_site_secrets_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "user_site_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Журнал доступа только дописывается: UPDATE запрещён всегда, DELETE — кроме
-- чистки по сроку, которую крон site-credentials-retention делает в
-- транзакции с `set_config('sites.credential_audit_purge', 'on', true)`.
-- TRUNCATE (только владелец схемы, руками) триггер не ловит — и не должен.
CREATE OR REPLACE FUNCTION "site_credential_audit_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('sites.credential_audit_purge', true), '') = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'site_credential_audit: журнал только дописывается (%)', TG_OP
    USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER "site_credential_audit_append_only"
  BEFORE UPDATE OR DELETE ON "site_credential_audit"
  FOR EACH ROW EXECUTE FUNCTION "site_credential_audit_append_only"();
