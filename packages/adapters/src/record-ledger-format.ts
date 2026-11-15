import type { ContentLocation } from "@rakazo/db";
import { z } from "zod";

/**
 * What a stream holds, shared by the sealer that writes it and the restore that reads it back.
 *
 * Everything needed to open a stream travels inside it, so the ledger and the deployment's
 * master keys are enough to read it after the database is gone:
 *
 * - `space.key` (in the clear): a Space key as the database stores it, wrapped by a master key.
 *   Only someone holding the master key can open it.
 * - `stream.opened` (sealed): which bot or Space the stream is for.
 * - `memory.revision` and `audit.event` (sealed): the records themselves.
 *
 * Each sealed entry is bound to its stream and position, never to a database row, so it opens
 * wherever it is read and fails to open if it is moved.
 */
export const SPACE_KEY_KIND = "space.key";
export const STREAM_OPENED_KIND = "stream.opened";
export const MEMORY_REVISION_KIND = "memory.revision";
export const AUDIT_EVENT_KIND = "audit.event";

/** Where a sealed entry sits, which is all its encryption is bound to. */
export function entryLocation(stream: string, seq: number): ContentLocation {
  return {
    table: "record_ledger_entries",
    column: "payload",
    rowId: `${stream}:${seq}`,
    owner: stream,
  };
}

/** A Space key still wrapped by its master key, as `space_keys` stores it. */
export const spaceKeyEnvelopeSchema = z.object({
  type: z.literal(SPACE_KEY_KIND),
  id: z.string().min(1),
  spaceId: z.string().min(1),
  version: z.number().int().min(1),
  masterKeyId: z.string().min(1),
  wrappedKey: z.string().min(1),
});
export type SpaceKeyEnvelope = z.infer<typeof spaceKeyEnvelopeSchema>;

/** `bot:<id>` for a bot's own stream, `space:<id>` for what no single bot owns. */
export const streamHeaderSchema = z.object({
  type: z.literal(STREAM_OPENED_KIND),
  subject: z.string().regex(/^(bot|space):.+$/),
  spaceId: z.string().min(1),
  botId: z.string().min(1).nullable(),
  organizationId: z.string().min(1),
  spaceName: z.string(),
  botName: z.string().nullable(),
  openedAt: z.string(),
});
export type StreamHeader = z.infer<typeof streamHeaderSchema>;

export const memoryRevisionRecordSchema = z.object({
  type: z.literal(MEMORY_REVISION_KIND),
  /** The revision row's id, kept when a stream is restored in place. */
  id: z.string().min(1),
  documentId: z.string().min(1),
  spaceId: z.string().min(1),
  userId: z.string().min(1),
  botId: z.string().min(1).nullable(),
  scope: z.string().min(1),
  path: z.string(),
  revision: z.number().int().min(1),
  /** Absent when the record was too large for the ledger; `contentOmitted` says what it held. */
  content: z.string().optional(),
  contentOmitted: z.object({ bytes: z.number().int().min(0), sha256: z.string() }).optional(),
  sourceRunId: z.string().nullable(),
  sourceThreadId: z.string().nullable(),
  createdAt: z.string(),
});
export type MemoryRevisionRecord = z.infer<typeof memoryRevisionRecordSchema>;

/** An audit event as the audit log stores it. */
export const auditEventRecordSchema = z.object({
  type: z.literal(AUDIT_EVENT_KIND),
  id: z.string().min(1),
  createdAt: z.string(),
  organizationId: z.string().min(1),
  spaceId: z.string().nullable(),
  spaceName: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  targetLabel: z.string().nullable(),
  outcome: z.string(),
  runId: z.string().nullable(),
  threadId: z.string().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export type AuditEventRecord = z.infer<typeof auditEventRecordSchema>;

/** What stands in for a record too large for the ledger, whatever its kind: only its size and digest. */
export const omittedRecordSchema = z.object({
  type: z.string().min(1),
  id: z.string().min(1),
  createdAt: z.string(),
  omitted: z.object({ bytes: z.number().int().min(0), sha256: z.string() }),
});
export type OmittedRecord = z.infer<typeof omittedRecordSchema>;
