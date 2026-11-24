// @vitest-environment jsdom

import type { Bot, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useReadAloud } from "./use-read-aloud";

const speakerMock = vi.hoisted(() => ({
  speak: vi.fn(async () => undefined),
  stop: vi.fn(),
  subscribe: (listener: (snapshot: { status: string }) => void) => {
    listener({ status: "idle" });
    return () => {};
  },
  isSpeaking: () => false,
}));
const speak = speakerMock.speak;

const NOT_READY = "Add a voice provider key and pick a voice in Voice settings.";
vi.mock("../../../lib/calls/tts", () => ({
  speaker: speakerMock,
  voiceNotReadyText: () => NOT_READY,
}));
const deviceVoice = vi.hoisted(() => {
  const state: { status: string; messageId?: string } = { status: "idle" };
  return {
    state,
    speak: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    subscribe: (listener: (snapshot: typeof state) => void) => {
      listener(state);
      return () => {};
    },
  };
});
vi.mock("../../../lib/calls/system-voice", () => ({ systemVoice: deviceVoice }));
const toastError = vi.hoisted(() => vi.fn());
const toastDismiss = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/ui-web", () => ({ toast: { error: toastError, dismiss: toastDismiss } }));

const speaking: Bot = { id: "bot-b", autoSpeak: true } as unknown as Bot;

function message(id: string, text: string): ThreadMessage {
  return { id, role: "bot", blocks: [{ kind: "text", text }] } as unknown as ThreadMessage;
}

function snapshot(messages: ThreadMessage[]): ThreadSnapshot {
  return { botId: "bot-b", messages } as unknown as ThreadSnapshot;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latest: ReturnType<typeof useReadAloud>;

type ReadProps = {
  snapshot: ThreadSnapshot;
  callBotId?: string;
  providerVoiceReady?: boolean;
  openVoiceSettings?: () => void;
};

function renderRead(props: ReadProps) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  rerenderRead(props);
}

function rerenderRead({
  snapshot,
  callBotId,
  providerVoiceReady = true,
  openVoiceSettings = () => {},
}: ReadProps) {
  act(() => {
    root?.render(
      <ReadHarness
        active={speaking}
        snapshot={snapshot}
        callBotId={callBotId}
        providerVoiceReady={providerVoiceReady}
        openVoiceSettings={openVoiceSettings}
      />,
    );
  });
}

function ReadHarness({
  active,
  snapshot,
  callBotId,
  providerVoiceReady,
  openVoiceSettings,
}: {
  active: Bot;
  snapshot: ThreadSnapshot;
  callBotId?: string;
  providerVoiceReady: boolean;
  openVoiceSettings: () => void;
}) {
  latest = useReadAloud({
    active,
    snapshot,
    callBotId,
    activeBotId: { current: active.id },
    providerVoiceReady,
    openVoiceSettings,
  });
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  deviceVoice.state.status = "idle";
  deviceVoice.state.messageId = undefined;
});

it("does not auto-speak a reply while a call with another bot is active", () => {
  const first = snapshot([message("m1", "first reply")]);
  renderRead({ snapshot: first });
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
    callBotId: "bot-a",
  });
  expect(speak).not.toHaveBeenCalled();
  // The reply that arrived during the call stays marked spoken, not queued.
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
  });
  expect(speak).not.toHaveBeenCalled();
});

it("auto-speaks a new reply when no call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
  });
  expect(speak).toHaveBeenCalledWith("second reply", { botId: "bot-b", messageId: "m2" });
});

it("does not start a manual read while a call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), callBotId: "bot-a" });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(speak).not.toHaveBeenCalled();
});

it("reads a message on request when no call is active", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(speak).toHaveBeenCalledWith("spoken words", { botId: "bot-b", messageId: "m2" });
});

type ToastOptions = { id: string; action?: { label: string; onClick: () => void } };

it("offers Voice settings from the toast when a manual read finds no voice connected", async () => {
  speak.mockResolvedValueOnce(NOT_READY as never);
  const openVoiceSettings = vi.fn();
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), openVoiceSettings });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  const [text, options] = toastError.mock.calls[0] as [string, ToastOptions];
  expect(text).toBe(NOT_READY);
  expect(options.action?.label).toBe("Open Voice settings");
  options.action?.onClick();
  expect(openVoiceSettings).toHaveBeenCalledTimes(1);
});

it("offers Voice settings when an automatic read finds no voice connected", async () => {
  speak.mockResolvedValueOnce(NOT_READY as never);
  const openVoiceSettings = vi.fn();
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), openVoiceSettings });
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply"), message("m2", "second reply")]),
    openVoiceSettings,
  });
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  const [, options] = toastError.mock.calls[0] as [string, ToastOptions];
  options.action?.onClick();
  expect(openVoiceSettings).toHaveBeenCalledTimes(1);
});

it("opens Voice settings through the latest callback when the toast is clicked after a rerender", async () => {
  speak.mockResolvedValueOnce(NOT_READY as never);
  const stale = vi.fn();
  const latestCallback = vi.fn();
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), openVoiceSettings: stale });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  rerenderRead({
    snapshot: snapshot([message("m1", "first reply")]),
    openVoiceSettings: latestCallback,
  });
  const [, options] = toastError.mock.calls[0] as [string, ToastOptions];
  options.action?.onClick();
  expect(stale).not.toHaveBeenCalled();
  expect(latestCallback).toHaveBeenCalledTimes(1);
});

it("keeps other read-aloud failures as a plain toast", async () => {
  speak.mockResolvedValueOnce("Could not play that clip." as never);
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), openVoiceSettings: vi.fn() });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
  const [text, options] = toastError.mock.calls[0] as [string, ToastOptions];
  expect(text).toBe("Could not play that clip.");
  // Set explicitly: the shared toast id keeps an earlier toast's action unless it is cleared.
  expect(options).toHaveProperty("action", undefined);
});

it("dismisses its toast when the shell unmounts", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  act(() => root?.unmount());
  root = null;
  expect(toastDismiss).toHaveBeenCalledWith("read-aloud-error");
});

it("reads a message in the device's voice when no voice provider is connected", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), providerVoiceReady: false });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(deviceVoice.speak).toHaveBeenCalledWith("spoken words", "m2");
  expect(speakerMock.stop).toHaveBeenCalled();
  expect(speak).not.toHaveBeenCalled();
});

it("prefers a connected voice provider over the device's voice", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(speak).toHaveBeenCalledWith("spoken words", { botId: "bot-b", messageId: "m2" });
  expect(deviceVoice.speak).not.toHaveBeenCalled();
  // The provider's own voice takes over from a device reading.
  expect(deviceVoice.stop).toHaveBeenCalled();
});

it("pauses the message the device is reading, resumes it, and reads another", () => {
  deviceVoice.state.status = "speaking";
  deviceVoice.state.messageId = "m2";
  renderRead({ snapshot: snapshot([message("m1", "first reply")]), providerVoiceReady: false });
  expect(latest.speakingMessageId).toBe("m2");
  expect(latest.readerState).toEqual({ paused: false, pausable: true });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(deviceVoice.pause).toHaveBeenCalledOnce();

  deviceVoice.state.status = "paused";
  rerenderRead({ snapshot: snapshot([message("m1", "first reply")]), providerVoiceReady: false });
  expect(latest.readerState).toEqual({ paused: true, pausable: true });
  act(() => latest.onSpeak(message("m2", "spoken words")));
  expect(deviceVoice.resume).toHaveBeenCalledOnce();

  act(() => latest.onSpeak(message("m3", "other words")));
  expect(deviceVoice.speak).toHaveBeenCalledWith("other words", "m3");
});

it("stops a device reading when a call starts", () => {
  renderRead({ snapshot: snapshot([message("m1", "first reply")]) });
  deviceVoice.stop.mockClear();
  rerenderRead({ snapshot: snapshot([message("m1", "first reply")]), callBotId: "bot-a" });
  expect(deviceVoice.stop).toHaveBeenCalledOnce();
});
