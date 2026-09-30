-- Этапы E–G ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md (§4, §6):
-- режим «Я в кадре» — персона автора, её образы, голос, личный бренд-бук и
-- ведущий-образ в поздравлении. Всё за флагом PERSONA_ENABLED; выпуск людям —
-- после юридического шлюза §4.10.
--
-- Только аддитивные изменения: новые таблицы, новый enum, необязательные
-- колонки. Существующие бренд-буки становятся COMPANY значением по умолчанию.

CREATE TYPE "BrandManifestKind" AS ENUM ('COMPANY', 'PERSONAL');

CREATE TABLE "personas" (
  "id"                 TEXT NOT NULL,
  "userId"             TEXT NOT NULL,
  "consentGivenAt"     TIMESTAMP(3) NOT NULL,
  "consentText"        TEXT NOT NULL,
  "consentTextVersion" TEXT NOT NULL,
  "selfiePathname"     TEXT,
  "livenessPathname"   TEXT,
  "livenessCheckedAt"  TIMESTAMP(3),
  "verifyResult"       JSONB,
  "ageMin"             INTEGER,
  "ageMax"             INTEGER,
  "ageEstimatedAt"     TIMESTAMP(3),
  "sourcesPurgedAt"    TIMESTAMP(3),
  "revokedAt"          TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "personas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "personas_userId_key" ON "personas"("userId");
ALTER TABLE "personas"
  ADD CONSTRAINT "personas_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "persona_looks" (
  "id"             TEXT NOT NULL,
  "personaId"      TEXT NOT NULL,
  "label"          TEXT NOT NULL,
  "preset"         TEXT,
  "prompt"         TEXT,
  "targetAge"      INTEGER,
  "sourceLookId"   TEXT,
  "isBase"         BOOLEAN NOT NULL DEFAULT false,
  "photoPathname"  TEXT,
  "photoUrl"       TEXT,
  "activeSketchId" TEXT,
  "status"         TEXT NOT NULL DEFAULT 'pending',
  "error"          TEXT,
  "deletedAt"      TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "persona_looks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "persona_looks_activeSketchId_key" ON "persona_looks"("activeSketchId");
CREATE INDEX "persona_looks_personaId_deletedAt_idx" ON "persona_looks"("personaId", "deletedAt");
ALTER TABLE "persona_looks"
  ADD CONSTRAINT "persona_looks_personaId_fkey" FOREIGN KEY ("personaId")
  REFERENCES "personas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "persona_looks"
  ADD CONSTRAINT "persona_looks_activeSketchId_fkey" FOREIGN KEY ("activeSketchId")
  REFERENCES "image_sketches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "user_voices" ADD COLUMN "personaId" TEXT;
CREATE INDEX "user_voices_personaId_idx" ON "user_voices"("personaId");
ALTER TABLE "user_voices"
  ADD CONSTRAINT "user_voices_personaId_fkey" FOREIGN KEY ("personaId")
  REFERENCES "personas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "brand_manifests"
  ADD COLUMN "kind"          "BrandManifestKind" NOT NULL DEFAULT 'COMPANY',
  ADD COLUMN "personaId"     TEXT,
  ADD COLUMN "defaultLookId" TEXT,
  ADD COLUMN "signature"     TEXT,
  ADD COLUMN "defaultTone"   TEXT,
  ADD COLUMN "cardStyle"     JSONB;
ALTER TABLE "brand_manifests"
  ADD CONSTRAINT "brand_manifests_personaId_fkey" FOREIGN KEY ("personaId")
  REFERENCES "personas"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "brand_manifests"
  ADD CONSTRAINT "brand_manifests_defaultLookId_fkey" FOREIGN KEY ("defaultLookId")
  REFERENCES "persona_looks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "greeting_briefs"
  ADD COLUMN "presenterLookId"  TEXT,
  ADD COLUMN "presenterVariant" TEXT;
CREATE INDEX "greeting_briefs_presenterLookId_idx" ON "greeting_briefs"("presenterLookId");
ALTER TABLE "greeting_briefs"
  ADD CONSTRAINT "greeting_briefs_presenterLookId_fkey" FOREIGN KEY ("presenterLookId")
  REFERENCES "persona_looks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
