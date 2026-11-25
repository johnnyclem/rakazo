import type { JobPublisher } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { MeetingEmulator } from "../providers/meeting/emulator/meeting-emulator.js";
import { MeetingService } from "./meeting-service.js";

it("refuses to send a paused bot into a meeting", async () => {
  const findFirst = vi.fn().mockResolvedValue({ id: "bot-1", name: "Atlas", pausedAt: new Date() });
  const prisma = { bot: { findFirst } } as unknown as PrismaClient;
  const service = new MeetingService({
    prisma,
    jobs: {} as JobPublisher,
    provider: new MeetingEmulator(),
    events: {} as ThreadEvents,
  });
  const actor = { userId: "user-1", spaceId: "space-1" } as Actor;

  await expect(
    service.join(actor, "bot-1", "https://meet.google.com/abc-defg-hij"),
  ).rejects.toMatchObject({ kind: "CONFLICT", code: "bot_paused" });
});
