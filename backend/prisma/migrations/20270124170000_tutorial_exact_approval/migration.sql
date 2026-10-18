ALTER TABLE "tutorial_video_assets" ADD COLUMN "reviewApproval" JSONB;

-- Legacy approvals are not re-granted or silently re-hashed. Any subsequent
-- replacement invalidates them, including writers outside the application.
CREATE FUNCTION tutorial_exact_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."blobUrl" IS DISTINCT FROM OLD."blobUrl" OR
    NEW."activeVersionId" IS DISTINCT FROM OLD."activeVersionId" OR
    NEW."tempoManifest" IS DISTINCT FROM OLD."tempoManifest" OR
    NEW."contentHash" IS DISTINCT FROM OLD."contentHash" OR
    NEW."assemblyStatus" IS DISTINCT FROM OLD."assemblyStatus"
  ) THEN
    NEW."reviewed" := false;
    NEW."reviewApproval" := NULL;
    RETURN NEW;
  END IF;
  IF NOT NEW."reviewed" THEN
    NEW."reviewApproval" := NULL;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR NOT OLD."reviewed" OR
     NEW."reviewApproval" IS DISTINCT FROM OLD."reviewApproval" THEN
    IF NEW."assemblyStatus" IS DISTINCT FROM 'complete' OR NEW."blobUrl" IS NULL OR
       NEW."reviewApproval" IS NULL OR
       NEW."reviewApproval"->>'schema' IS DISTINCT FROM '1' OR
       NEW."reviewApproval"->>'blobUrl' IS DISTINCT FROM NEW."blobUrl" OR
       NEW."reviewApproval"->>'versionId' IS DISTINCT FROM NEW."activeVersionId" OR
       COALESCE(NEW."reviewApproval"->>'sha256','') !~ '^[a-f0-9]{64}$' OR
       COALESCE(NEW."reviewApproval"->>'provenanceSha256','') !~ '^[a-f0-9]{64}$' OR
       COALESCE(NEW."reviewApproval"->>'approvedBy','') = '' THEN
      RAISE EXCEPTION 'Tutorial approval must identify the exact complete file and version' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tutorial_exact_approval_guard BEFORE INSERT OR UPDATE ON "tutorial_video_assets"
FOR EACH ROW EXECUTE FUNCTION tutorial_exact_approval_guard();

REVOKE ALL ON FUNCTION tutorial_exact_approval_guard() FROM PUBLIC;
