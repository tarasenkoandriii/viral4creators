-- Optional, backwards-compatible narrator selection and approved recording.
ALTER TABLE "brand_manifests" ADD COLUMN "narratorCharacterId" TEXT;
ALTER TABLE "brand_manifests" ADD COLUMN "tutorialPreamble" JSONB;
ALTER TABLE "client_site_tutorial_drafts" ADD COLUMN "preambleSnapshot" JSONB;
