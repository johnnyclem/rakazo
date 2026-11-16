-- Additive: the previous release never reads this column.
ALTER TABLE "record_ledger_streams" ADD COLUMN "keyId" TEXT;
