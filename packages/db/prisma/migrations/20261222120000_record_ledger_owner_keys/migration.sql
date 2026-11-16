-- Additive: the previous release never reads this table or column.
CREATE TABLE "record_ledger_recipients" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_ledger_recipients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "record_ledger_recipients_spaceId_recipient_key" ON "record_ledger_recipients"("spaceId", "recipient");

ALTER TABLE "record_ledger_recipients" ADD CONSTRAINT "record_ledger_recipients_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "record_ledger_streams" ADD COLUMN "recipientsDigest" TEXT;

-- Sealing reads recipients across Spaces, so only system steps touch the table.
ALTER TABLE "record_ledger_recipients" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_recipients_system ON "record_ledger_recipients"
  USING ((SELECT app_rls_bypass()));
