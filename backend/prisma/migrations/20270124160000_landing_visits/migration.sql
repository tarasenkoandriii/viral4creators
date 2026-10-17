CREATE TABLE "landing_visits" (
 "id" UUID NOT NULL,
 "landing" VARCHAR(20) NOT NULL,
 "locale" VARCHAR(5) NOT NULL,
 "visitorHash" VARCHAR(64),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "landing_visits_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "landing_visits_createdAt_landing_locale_idx" ON "landing_visits"("createdAt", "landing", "locale");
ALTER TABLE "landing_visits" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "landing_visits" FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE "landing_visits" FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

