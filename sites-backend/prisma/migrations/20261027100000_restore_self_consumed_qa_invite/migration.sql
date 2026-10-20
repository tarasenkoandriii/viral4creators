-- Owner-authorized repair of one QA-viewer invitation accidentally consumed
-- by its creator while already the sole owner. No new token/row, no expiry
-- extension, no role changes. Do nothing if any guard no longer holds.
UPDATE "site_account_invites" AS i
SET "usedAt" = NULL, "usedByTelegramId" = NULL
WHERE i."tokenHash" = 'c45d1024146e064de72e1eb751c2e2673ca521495b1fc33541e184c71712469e'
  AND i."createdByTelegramId" = 7427343290
  AND i."usedByTelegramId" = i."createdByTelegramId"
  AND i."usedAt" IS NOT NULL
  AND i."expiresAt" > CURRENT_TIMESTAMP
  AND i."role" = 'operator'
  AND i."productRoles"->>'qa' = 'viewer'
  AND EXISTS (
    SELECT 1 FROM "site_account_members" m
    WHERE m."accountId" = i."accountId"
      AND m."telegramId" = i."createdByTelegramId" AND m."role" = 'owner'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "site_account_members" m
    WHERE m."accountId" = i."accountId"
      AND m."telegramId" <> i."createdByTelegramId"
  );
