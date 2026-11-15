-- Sole statement so CREATE INDEX CONCURRENTLY runs outside an implicit transaction.
-- Sealing reads memory revisions oldest first, by creation time.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memory_revisions_createdAt_id_idx" ON "memory_revisions"("createdAt", "id");
