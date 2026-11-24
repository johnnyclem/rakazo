import type { RakazoDesktopVoiceEvent } from "@rakazo/contracts";
import { flush } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickBrowserVoice, SystemVoice } from "./system-voice.js";

vi.mock("@lingui/core", () => ({ i18n: { locale: "es" } }));

function fakeBridge(started: () => Promise<boolean> = async () => true) {
  const listeners = new Set<(event: RakazoDesktopVoiceEvent) => void>();
  const bridge = {
    speak: vi.fn((_text: string, _language: string, _session: number) => started()),
    pause: vi.fn(async (_session: number) => undefined),
    resume: vi.fn(async (_session: number) => undefined),
    stop: vi.fn(async (_session: number) => undefined),
    onEvent: vi.fn((listener: (event: RakazoDesktopVoiceEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  const emit = (event: RakazoDesktopVoiceEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = () => bridge.speak.mock.calls.at(-1)?.[2] ?? 0;
  return { bridge, emit, session, listeners };
}

class FakeUtterance {
  voice: unknown = null;
  lang = "";
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeSynthesis(voices: Array<{ name: string; lang: string }> = []) {
  const spoken: FakeUtterance[] = [];
  const synthesis = {
    getVoices: () => voices,
    speak: vi.fn((utterance: FakeUtterance) => spoken.push(utterance)),
    cancel: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  };
  return { synthesis, spoken };
}

function useWindow(parts: { rakazoDesktop?: unknown; speechSynthesis?: unknown }) {
  vi.stubGlobal("window", parts);
  vi.stubGlobal("navigator", { language: "en-US" });
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
}

afterEach(() => vi.unstubAllGlobals());

describe("SystemVoice in the desktop app", () => {
  let desktop: ReturnType<typeof fakeBridge>;
  let voice: SystemVoice;

  beforeEach(() => {
    desktop = fakeBridge();
    useWindow({ rakazoDesktop: { platform: "darwin", systemVoice: desktop.bridge } });
    voice = new SystemVoice();
  });

  it("reads in the interface language and follows the helper's states to the end", () => {
    voice.speak("Hola", "message-1");
    expect(desktop.bridge.speak).toHaveBeenCalledWith("Hola", "es", desktop.session());
    expect(voice.state).toEqual({ status: "speaking", messageId: "message-1" });

    const session = desktop.session();
    desktop.emit({ session, type: "paused" });
    expect(voice.state).toEqual({ status: "paused", messageId: "message-1" });
    desktop.emit({ session, type: "speaking" });
    expect(voice.state.status).toBe("speaking");
    desktop.emit({ session, type: "end" });
    expect(voice.state).toEqual({ status: "idle" });
    expect(desktop.listeners.size).toBe(0);
  });

  it("pauses, resumes and stops through the helper", () => {
    voice.speak("Hola", "message-1");
    const session = desktop.session();
    voice.pause();
    expect(desktop.bridge.pause).toHaveBeenCalledWith(session);
    expect(voice.state.status).toBe("paused");
    voice.resume();
    expect(desktop.bridge.resume).toHaveBeenCalledWith(session);
    expect(voice.state.status).toBe("speaking");
    voice.stop();
    expect(desktop.bridge.stop).toHaveBeenCalledWith(session);
    expect(voice.state).toEqual({ status: "idle" });
  });

  it("ignores events from a reading it has replaced", () => {
    voice.speak("One", "message-1");
    const first = desktop.session();
    voice.speak("Two", "message-2");
    desktop.emit({ session: first, type: "end" });
    expect(voice.state).toEqual({ status: "speaking", messageId: "message-2" });
  });

  it("has no browser voice to fall back to, so it goes idle when the helper cannot run", () => {
    voice.speak("Hola", "message-1");
    desktop.emit({ session: desktop.session(), type: "error", error: "unavailable" });
    expect(voice.state).toEqual({ status: "idle" });
  });
});

describe("SystemVoice falling back to the browser's voices", () => {
  it("reads there when the helper reports it is unavailable, then follows that utterance", () => {
    const desktop = fakeBridge();
    const browser = fakeSynthesis();
    useWindow({
      rakazoDesktop: { platform: "darwin", systemVoice: desktop.bridge },
      speechSynthesis: browser.synthesis,
    });
    const voice = new SystemVoice();
    voice.speak("Hola", "message-1");
    desktop.emit({ session: desktop.session(), type: "error", error: "unavailable" });

    expect(browser.spoken.map((utterance) => utterance.text)).toEqual(["Hola"]);
    expect(voice.state).toEqual({ status: "speaking", messageId: "message-1" });
    // The helper's own end for the session no longer counts.
    desktop.emit({ session: desktop.session(), type: "end" });
    expect(voice.state.status).toBe("speaking");
    browser.spoken[0]!.onend?.();
    expect(voice.state).toEqual({ status: "idle" });
  });

  it("reads there when the page is refused the helper", async () => {
    const desktop = fakeBridge(async () => false);
    const browser = fakeSynthesis();
    useWindow({
      rakazoDesktop: { platform: "darwin", systemVoice: desktop.bridge },
      speechSynthesis: browser.synthesis,
    });
    new SystemVoice().speak("Hola", "message-1");
    await flush();
    expect(browser.spoken).toHaveLength(1);
  });
});

describe("SystemVoice in a browser", () => {
  it("is available only with speech synthesis", () => {
    useWindow({});
    expect(new SystemVoice().available).toBe(false);
    useWindow({ speechSynthesis: fakeSynthesis().synthesis });
    expect(new SystemVoice().available).toBe(true);
  });

  it("reads with a Siri voice for the language, and pauses, resumes and stops the synthesis", () => {
    const browser = fakeSynthesis([
      { name: "Siri Voice 1", lang: "en-US" },
      { name: "Siri Voice 2", lang: "es-MX" },
      { name: "Monica", lang: "es-ES" },
    ]);
    useWindow({ speechSynthesis: browser.synthesis });
    const voice = new SystemVoice();
    voice.speak("Hola", "message-1");

    expect(browser.spoken[0]!.lang).toBe("es");
    expect(browser.spoken[0]!.voice).toMatchObject({ name: "Siri Voice 2" });
    voice.pause();
    expect(browser.synthesis.pause).toHaveBeenCalledOnce();
    expect(voice.state.status).toBe("paused");
    voice.resume();
    expect(browser.synthesis.resume).toHaveBeenCalledOnce();
    voice.stop();
    expect(browser.synthesis.cancel).toHaveBeenCalledTimes(2);
    expect(voice.state).toEqual({ status: "idle" });
    // The cancelled utterance reports its end late; it must not touch what comes next.
    voice.speak("Otra", "message-2");
    browser.spoken[0]!.onerror?.();
    expect(voice.state).toEqual({ status: "speaking", messageId: "message-2" });
  });

  it("leaves the browser's default voice when it lists no Siri voice for the language", () => {
    const voices = [{ name: "Monica", lang: "es-ES" }] as SpeechSynthesisVoice[];
    expect(pickBrowserVoice(voices, "es")).toBeUndefined();
  });
});
