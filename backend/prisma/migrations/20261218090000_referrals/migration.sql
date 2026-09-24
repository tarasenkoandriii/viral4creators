-- Приглашения («Условно бесплатный Lite» §5, этап 134).

CREATE TYPE "ReferralStatus" AS ENUM ('IDENTIFIED', 'GENERATED');

CREATE TABLE "referral_codes" (
  "id"     TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "code"   TEXT NOT NULL,
  -- Переходы — числом, а не строками: у клика нет ключа, а список в
  -- кабинете не должен забиваться анонимными «кто-то перешёл».
  "visitCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referral_codes_userId_key" ON "referral_codes" ("userId");
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes" ("code");

ALTER TABLE "referral_codes"
  ADD CONSTRAINT "referral_codes_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "referrals" (
  "id"        TEXT NOT NULL,
  "inviterId" TEXT NOT NULL,
  -- Одно приглашение на одного приглашённого, навсегда: уникальность и
  -- есть вся защита от повторного засчёта.
  "inviteeId" TEXT NOT NULL,
  "status"    "ReferralStatus" NOT NULL DEFAULT 'IDENTIFIED',
  "identifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "generatedAt"  TIMESTAMP(3),
  "revokedAt"     TIMESTAMP(3),
  "revokedReason" TEXT,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "referrals_inviteeId_key" ON "referrals" ("inviteeId");
CREATE INDEX "referrals_inviterId_status_idx"
  ON "referrals" ("inviterId", "status");

ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_inviterId_fkey"
  FOREIGN KEY ("inviterId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "referrals"
  ADD CONSTRAINT "referrals_inviteeId_fkey"
  FOREIGN KEY ("inviteeId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
