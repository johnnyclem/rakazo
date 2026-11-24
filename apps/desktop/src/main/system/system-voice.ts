import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import type { RakazoDesktopVoiceEvent } from "@rakazo/contracts";
import { secureHttpOrigin } from "@rakazo/contracts/network-host";
import type { WebContents } from "electron";
import { isLanguageTag } from "../i18n.js";
import type { IpcCaller } from "../ipc/ipc.js";
import { handleIpc } from "../ipc/ipc.js";
import type { AppTarget } from "../windows/app-frame.js";

export const VOICE_EVENT_CHANNEL = "desktop.systemVoice.event";

/** A reply is read whole, so the limit only stops a runaway page from filling the pipe. */
const MAX_TEXT_CHARS = 200_000;
const MAX_LINE_CHARS = 64 * 1024;
const HELPER_ERRORS = new Set(["language-not-supported", "invalid-text"]);

type InvokeEvent = Pick<IpcCaller, "sender">;
type Reading = {
  sender: WebContents;
  session: number;
  child: ChildProcessWithoutNullStreams;
  /** Drops the events still to come, for a page that is gone. */
  cancel: () => void;
};

/** One reading at a time, for the app window only; every session ends with `end`, even if the helper dies. */
export function createSystemVoice(
  getTarget: () => AppTarget | null,
  spawnHelper: (language: string) => ChildProcessWithoutNullStreams,
) {
  let active: Reading | null = null;
  const watched = new WeakSet<WebContents>();

  const owner = (event: InvokeEvent, session: unknown) =>
    active !== null && active.session === session && active.sender === event.sender ? active : null;

  function close(reading: Reading, pageGone = false) {
    if (active === reading) active = null;
    if (pageGone) reading.cancel();
    reading.child.kill();
  }

  /** Control lines carry no text, so the page cannot inject one. */
  const command = (event: InvokeEvent, session: unknown, line: "pause" | "resume" | "stop") => {
    owner(event, session)?.child.stdin.write(`${line}\n`);
  };

  return {
    speak(event: InvokeEvent, text: unknown, language: unknown, session: unknown): boolean {
      if (
        !secureHttpOrigin(getTarget()?.url) ||
        typeof text !== "string" ||
        text.length === 0 ||
        text.length > MAX_TEXT_CHARS ||
        !isLanguageTag(language) ||
        !Number.isSafeInteger(session) ||
        (session as number) <= 0
      )
        return false;
      if (active) close(active);
      const sender = event.sender;
      const id = session as number;
      let ended = false;
      const send = (message: RakazoDesktopVoiceEvent) => {
        if (!ended && !sender.isDestroyed()) sender.send(VOICE_EVENT_CHANNEL, message);
      };
      const end = (error?: string) => {
        if (ended) return;
        if (error) send({ session: id, type: "error", error });
        send({ session: id, type: "end" });
        ended = true;
        if (active?.child === child) active = null;
      };
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnHelper(language);
      } catch {
        // Reported after the page learns the reading started, like a helper that fails later.
        setImmediate(() => end("unavailable"));
        return true;
      }
      const reading: Reading = {
        sender,
        session: id,
        child,
        cancel: () => {
          ended = true;
        },
      };
      active = reading;
      if (!watched.has(sender)) {
        watched.add(sender);
        // A page that is gone gets no more events and no more speech.
        const stopIfActive = () => {
          if (active?.sender === sender) close(active, true);
        };
        sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) stopIfActive();
        });
        sender.once("destroyed", stopIfActive);
      }

      let pending = "";
      const read = (line: string) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof message !== "object" || message === null) return;
        const { type, error } = message as Record<string, unknown>;
        if (type === "speaking" || type === "paused") send({ session: id, type });
        else if (type === "error" && typeof error === "string" && HELPER_ERRORS.has(error))
          send({ session: id, type: "error", error });
        else if (type === "end") end();
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (ended || active !== reading) return;
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0 && newline <= MAX_LINE_CHARS) {
          read(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          if (ended || active !== reading) return;
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_LINE_CHARS) {
          pending = "";
          end("unavailable");
          close(reading);
        }
      });
      // Diagnostics only; an unread pipe would eventually block the helper.
      child.stderr.resume();
      child.stdin.on("error", () => undefined);
      // A missing or unlaunchable helper: the page falls back to the browser's own voices.
      child.on("error", () => end("unavailable"));
      child.on("close", () => end());
      child.stdin.write(`${JSON.stringify({ text })}\n`);
      return true;
    },

    pause: (event: InvokeEvent, session: unknown) => command(event, session, "pause"),
    resume: (event: InvokeEvent, session: unknown) => command(event, session, "resume"),
    stop: (event: InvokeEvent, session: unknown) => command(event, session, "stop"),
  };
}

/** Answers the page's voice calls with the helper that ships under `resources`. */
export function registerSystemVoice(getTarget: () => AppTarget | null, resources: string) {
  const helper = path.join(resources, "voice", "rakazo-voice");
  const voice = createSystemVoice(getTarget, (language) =>
    spawn(helper, [language], { stdio: "pipe" }),
  );
  handleIpc("desktop.systemVoice.speak", (event, text, language, session) =>
    voice.speak(event, text, language, session),
  );
  handleIpc("desktop.systemVoice.pause", (event, session) => voice.pause(event, session));
  handleIpc("desktop.systemVoice.resume", (event, session) => voice.resume(event, session));
  handleIpc("desktop.systemVoice.stop", (event, session) => voice.stop(event, session));
}
