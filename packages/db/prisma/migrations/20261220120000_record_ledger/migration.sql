-- Additive: the previous release never reads these tables.
CREATE TABLE "record_ledger_streams" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT,
    "sealedSeq" INTEGER NOT NULL DEFAULT 0,
    "shippedSeq" INTEGER NOT NULL DEFAULT 0,
    "shippedDigest" TEXT,
    "shippedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_ledger_streams_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "record_ledger_entries" (
    "id" TEXT NOT NULL,
    "streamId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "payload" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_ledger_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "record_ledger_cursors" (
    "source" TEXT NOT NULL,
    "lastCreatedAt" TIMESTAMP(3) NOT NULL,
    "lastId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "record_ledger_cursors_pkey" PRIMARY KEY ("source")
);

CREATE UNIQUE INDEX "record_ledger_streams_subject_key" ON "record_ledger_streams"("subject");
CREATE UNIQUE INDEX "record_ledger_streams_botId_key" ON "record_ledger_streams"("botId");
CREATE INDEX "record_ledger_streams_spaceId_idx" ON "record_ledger_streams"("spaceId");
CREATE UNIQUE INDEX "record_ledger_entries_streamId_seq_key" ON "record_ledger_entries"("streamId", "seq");
CREATE UNIQUE INDEX "record_ledger_entries_kind_sourceId_key" ON "record_ledger_entries"("kind", "sourceId");

ALTER TABLE "record_ledger_streams" ADD CONSTRAINT "record_ledger_streams_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_ledger_streams" ADD CONSTRAINT "record_ledger_streams_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "record_ledger_entries" ADD CONSTRAINT "record_ledger_entries_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "record_ledger_streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Sealing and shipping read across Spaces, so only system steps touch these tables.
ALTER TABLE "record_ledger_streams" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_streams_system ON "record_ledger_streams"
  USING ((SELECT app_rls_bypass()));
ALTER TABLE "record_ledger_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_entries_system ON "record_ledger_entries"
  USING ((SELECT app_rls_bypass()));
ALTER TABLE "record_ledger_cursors" ENABLE ROW LEVEL SECURITY;
CREATE POLICY record_ledger_cursors_system ON "record_ledger_cursors"
  USING ((SELECT app_rls_bypass()));
