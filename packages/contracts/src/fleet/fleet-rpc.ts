import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";

/** Which bots a fleet command acts on: one bot, a group's members, or every bot in the Space. */
const FleetScopeInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bot"), botId: Id }),
  z.object({ kind: z.literal("group"), groupId: Id }),
  z.object({ kind: z.literal("space") }),
]);

const FleetScopedInput = z.object({ scope: FleetScopeInput });
/** The bots the call changed; one that was already in that state is left out. */
const FleetChangedOutput = z.object({ botIds: z.array(Id) });

export const fleetRpc = {
  fleet: {
    pause: oc.input(FleetScopedInput).output(FleetChangedOutput),
    resume: oc.input(FleetScopedInput).output(FleetChangedOutput),
  },
};
