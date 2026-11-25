import { randomUUID } from "node:crypto";
import { createAdapterContext, MeetingJoinRejected } from "@rakazo/adapter-kit";
import { createDb, createThreadEvents, runAsSystem, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { MeetingEmulator } from "../providers/meeting/emulator/meeting-emulator.js";
import { GraphileJobPublisher } from "../runs/wakeups/wakeup.js";
import { createArtifactStore } from "../storage/artifact-store-factory.js";
import { listChatTranscripts, readChatMeeting, recentChatMeetings } from "./meeting-chat.js";
import { MeetingService } from "./meeting-service.js";

const databaseUrl = process.env.VERIFY_DATABASE === "1" ? process.env.DATABASE_URL : undefined;

describe.skipIf(!databaseUrl)("meeting transcript recovery in PostgreSQL", () => {
  it("commits a pending transcript and its Graphile backup together", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const jobs = new GraphileJobPublisher(pool);
    const provider = new MeetingEmulator();
    const request = vi
      .spyOn(provider, "requestTranscript")
      .mockImplementation(async (recordingId) => ({
        id: `transcript-${recordingId}`,
        ready: false,
      }));
    const events = createThreadEvents(prisma);
    const publish = vi.spyOn(events, "publishSpaceChange");
    const service = new MeetingService({ prisma, jobs, provider, events });
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const email = "fixture@meeting.example.test";
    const actor = { userId, spaceId, email, isDeploymentOwner: false };
    const teammate = { spaceId, userId: randomUUID() };
    const outsider = { spaceId: randomUUID(), userId: randomUUID() };
    const artifactStore = createArtifactStore(".", prisma, {});
    try {
      await runAsSystem("seed meeting recovery fixture", async () => {
        const now = new Date();
        await prisma.user.create({ data: { id: userId, email, name: "Fixture" } });
        await prisma.organization.create({
          data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: now },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
        await prisma.member.create({
          data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: now },
        });
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId,
            spaceId,
            role: "owner",
            createdAt: now,
          },
        });
        await prisma.bot.create({
          data: { id: botId, userId, spaceId, color: "ink", name: "Atlas" },
        });
      });
      const sessionId = await runAsTenant(actor, async () => {
        await service.join(actor, botId, "https://meet.google.com/abc-defg-hij", true);
        const { meetings } = await service.list(actor, botId);
        const sessionId = meetings[0]!.id;
        await service.leave(actor, sessionId);
        expect(publish).not.toHaveBeenCalledWith(spaceId, "artifacts");
        const pending = await prisma.meetingSession.findUniqueOrThrow({ where: { id: sessionId } });
        expect(pending.transcriptId).toBe(`transcript-recording-${sessionId}`);
        expect(pending.status).toBe("processing");
        const recents = await recentChatMeetings(prisma, { ...actor, botId });
        expect(recents).toMatchObject([
          { id: sessionId, status: "processing", sharedArtifact: null },
        ]);
        expect(await readChatMeeting(prisma, { ...actor, botId }, sessionId, 0)).toBeNull();

        request.mockImplementation(async (recordingId) => ({
          id: `transcript-${recordingId}`,
          ready: true,
        }));
        // A completion webhook is optional once Graphile holds the deadline check.
        await service.work({ sessionId, action: "transcript-check" });
        expect(publish).toHaveBeenCalledWith(spaceId, "artifacts");
        const result = await service.transcript(actor, sessionId);
        expect(result.turns[0]?.speaker).toBe("Alex Rivera");
        return sessionId;
      });
      await runAsTenant(teammate, async () => {
        const recents = await recentChatMeetings(prisma, { ...teammate, botId });
        expect(recents).toMatchObject([{ id: sessionId, status: "ready" }]);
        const catalog = await listChatTranscripts(prisma, { ...teammate, botId });
        expect(catalog.meetings).toMatchObject([{ meeting_id: sessionId }]);
        await expect(
          listChatTranscripts(prisma, { ...teammate, botId }, catalog.meetings[0]),
        ).resolves.toEqual({ meetings: [], next_before: null });
        const result = await readChatMeeting(prisma, { ...teammate, botId }, sessionId, 0);
        const artifact = await prisma.artifact.findUniqueOrThrow({
          where: { meetingSessionId: sessionId },
        });
        const bytes = await artifactStore.get(
          artifact.storageKey,
          createAdapterContext(teammate, botId, "read-meeting-file"),
        );
        expect(Buffer.from(bytes).toString("utf8")).toBe(result?.transcript);
        expect(result?.transcript).toContain("Alex Rivera");
        await expect(
          service.deleteTranscript({ ...actor, ...teammate }, sessionId),
        ).rejects.toMatchObject({ kind: "NOT_FOUND" });
      });
      await runAsTenant(outsider, async () => {
        await expect(listChatTranscripts(prisma, { ...outsider, botId })).resolves.toEqual({
          meetings: [],
          next_before: null,
        });
        await expect(
          prisma.meetingSession.findUnique({ where: { id: sessionId } }),
        ).resolves.toBeNull();
        await expect(
          prisma.artifact.findUnique({ where: { meetingSessionId: sessionId } }),
        ).resolves.toBeNull();
      });
      await runAsTenant(actor, async () => {
        await service.deleteTranscript(actor, sessionId);
        await expect(
          prisma.artifact.findUnique({ where: { meetingSessionId: sessionId } }),
        ).resolves.toBeNull();
        await expect(
          readChatMeeting(prisma, { ...actor, botId }, sessionId, 0),
        ).resolves.toBeNull();
      });
      const privateSession = await runAsTenant(actor, async () => {
        await service.join(actor, botId, "https://meet.google.com/abc-defg-hij");
        const { meetings } = await service.list(actor, botId);
        const id = meetings[0]!.id;
        await service.leave(actor, id);
        expect((await service.transcript(actor, id)).artifactAvailable).toBe(false);
        expect(await recentChatMeetings(prisma, { ...actor, botId })).toEqual([]);
        return id;
      });
      await runAsTenant(teammate, () =>
        expect(
          prisma.meetingSession.findUnique({ where: { id: privateSession } }),
        ).resolves.toBeNull(),
      );
      await runAsTenant(actor, async () => {
        await service.shareTranscript(actor, privateSession);
        await service.shareTranscript(actor, privateSession);
        expect(await prisma.artifact.count({ where: { meetingSessionId: privateSession } })).toBe(
          1,
        );
      });
      await runAsTenant(teammate, () =>
        expect(
          readChatMeeting(prisma, { ...teammate, botId }, privateSession, 0),
        ).resolves.toMatchObject({
          transcript: expect.stringContaining("Alex Rivera"),
        }),
      );
      await runAsTenant(teammate, () =>
        prisma.artifact.delete({ where: { meetingSessionId: privateSession } }),
      );
      await runAsTenant(actor, async () => {
        expect((await service.transcript(actor, privateSession)).artifactAvailable).toBe(false);
        await service.shareTranscript(actor, privateSession);
        expect((await service.transcript(actor, privateSession)).artifactAvailable).toBe(true);
      });
    } finally {
      await jobs.close();
      await pool.end();
    }
  });

  it("fails a join that was waiting to retry when its bot was paused", async () => {
    const { prisma, pool } = createDb(databaseUrl!);
    const jobs = new GraphileJobPublisher(pool);
    const provider = new MeetingEmulator();
    const join = vi.spyOn(provider, "join").mockRejectedValue(new MeetingJoinRejected(60_000));
    const service = new MeetingService({
      prisma,
      jobs,
      provider,
      events: createThreadEvents(prisma),
    });
    const organizationId = randomUUID();
    const userId = randomUUID();
    const spaceId = randomUUID();
    const botId = randomUUID();
    const actor = {
      userId,
      spaceId,
      email: "paused@meeting.example.test",
      isDeploymentOwner: false,
    };
    try {
      await runAsSystem("seed paused meeting fixture", async () => {
        const now = new Date();
        await prisma.user.create({ data: { id: userId, email: actor.email, name: "Fixture" } });
        await prisma.organization.create({
          data: { id: organizationId, name: "Fixture", slug: organizationId, createdAt: now },
        });
        await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
        await prisma.member.create({
          data: { id: randomUUID(), organizationId, userId, role: "owner", createdAt: now },
        });
        await prisma.spaceMember.create({
          data: {
            id: randomUUID(),
            organizationId,
            userId,
            spaceId,
            role: "owner",
            createdAt: now,
          },
        });
        await prisma.bot.create({
          data: { id: botId, userId, spaceId, color: "ink", name: "Atlas" },
        });
      });
      const sessionId = await runAsTenant(actor, async () => {
        await service.join(actor, botId, "https://meet.google.com/abc-defg-hij");
        const { meetings } = await service.list(actor, botId);
        return meetings[0]!.id;
      });
      expect(join).toHaveBeenCalledTimes(1);
      await runAsSystem("pause the bot", () =>
        prisma.bot.update({ where: { id: botId }, data: { pausedAt: new Date() } }),
      );

      await service.work({ sessionId, action: "join" });

      expect(join).toHaveBeenCalledTimes(1);
      await expect(
        runAsSystem("read the session", () =>
          prisma.meetingSession.findUniqueOrThrow({ where: { id: sessionId } }),
        ),
      ).resolves.toMatchObject({ status: "failed" });
    } finally {
      await runAsSystem("clean paused meeting fixture", async () => {
        await prisma.organization.deleteMany({ where: { id: organizationId } });
        await prisma.user.deleteMany({ where: { id: userId } });
      });
      await jobs.close();
      await pool.end();
    }
  });
});
