-- Additive and backward compatible: existing rows keep NULL dimensions.
ALTER TABLE "landing_visits" ADD COLUMN "source" VARCHAR(12), ADD COLUMN "traffic" VARCHAR(12);
ALTER TABLE "landing_visits" ADD CONSTRAINT "landing_visit_dimensions" CHECK (
  ("source" IS NULL AND "traffic" IS NULL) OR
  ("source" IS NOT NULL AND "traffic" IS NOT NULL AND "source" IN ('linkedin', 'unknown') AND "traffic" IN ('test', 'unmarked'))
);
