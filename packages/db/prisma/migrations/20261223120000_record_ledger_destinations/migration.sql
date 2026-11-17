-- Additive: the previous release never reads this table or column.
CREATE TABLE "record_ledger_destinations" (
    "spaceId" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_ledger_destinations_pkey" PRIMARY KEY ("spaceId")
);

ALTER TABLE "record_ledger_destinations" ADD CONSTRAINT "record_ledger_destinations_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_ledger_streams" ADD COLUMN "destinationSynced" TEXT;

-- Shipping reads destinations across Spaces, so only system steps touch the table.
ALTER TABLE "record_ledger_destinations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_destinations_system ON "record_ledger_destinations"
  USING ((SELECT app_rls_bypass()));
