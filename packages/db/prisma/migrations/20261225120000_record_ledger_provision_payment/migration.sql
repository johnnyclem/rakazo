-- Additive: the previous release never reads these columns, and every existing row is a place made
-- at the host's expense, which is what `paid = false` says.
ALTER TABLE "record_ledger_provisions" ADD COLUMN "paid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "payment" JSONB;
