-- Additive: the previous release never reads this table.
CREATE TABLE "record_ledger_provisions" (
    "spaceId" TEXT NOT NULL,
    "ownerKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "destination" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_ledger_provisions_pkey" PRIMARY KEY ("spaceId")
);

CREATE INDEX "record_ledger_provisions_state_updatedAt_idx" ON "record_ledger_provisions"("state", "updatedAt");

ALTER TABLE "record_ledger_provisions" ADD CONSTRAINT "record_ledger_provisions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The reconciler reads provisions across Spaces, so only system steps touch the table.
ALTER TABLE "record_ledger_provisions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_provisions_system ON "record_ledger_provisions"
  USING ((SELECT app_rls_bypass()));
