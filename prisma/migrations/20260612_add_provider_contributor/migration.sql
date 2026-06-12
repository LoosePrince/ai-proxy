-- AlterTable
ALTER TABLE "Provider" ADD COLUMN "contributor" TEXT;

-- Backfill contributor identity and use stable internal names for contributed providers.
UPDATE "Provider"
SET "contributor" = "name"
WHERE "isContributed" = true AND "contributor" IS NULL;

UPDATE "Provider"
SET "name" = 'contrib-' || substr(md5("apiKey"), 1, 16)
WHERE "isContributed" = true
  AND "contributor" IS NOT NULL
  AND "name" = "contributor";
