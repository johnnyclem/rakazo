import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { flush } from "@rakazo/core/test-async";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createSystemVoice, VOICE_EVENT_CHANNEL } from "./system-voice.js";

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
    kill: vi.fn(),
  });
}

type FakeChild = ReturnType<typeof fakeChild>;

function setup(url = "https://app.example.com") {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const event = { sender: contents as unknown as WebContents };
  const target = { webContents: contents as unknown as WebContents, url };
  const children: FakeChild[] = [];
  const spawn = vi.fn((_language: string) => {
    const child = fakeChild();
    children.push(child);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const voice = createSystemVoice(() => target, spawn);
  const sent = () =>
    contents.send.mock.calls
      .filter(([channel]) => channel === VOICE_EVENT_CHANNEL)
      .map(([, message]) => message);
  return { contents, event, voice, spawn, children, sent };
}

describe("desktop system voice", () => {
  it.each(["http://192.168.1.20:3100", "http://server.local:3100"])(
    "refuses an insecure remote page: %s",
    (url) => {
      const { event, voice, spawn } = setup(url);
      expect(voice.speak(event, "Hello", "en-US", 1)).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["no text", "", "en-US", 1],
    ["text that is not a string", 7, "en-US", 1],
    ["more text than a reply holds", "x".repeat(200_001), "en-US", 1],
    ["a language that is not a tag", "Hello", "--flag", 1],
    ["a session that is not a positive integer", "Hello", "en-US", 0],
  ])("refuses %s", (_name, text, language, session) => {
    const { event, voice, spawn } = setup();
    expect(voice.speak(event, text, language, session)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("hands the helper the language and the text as one JSON line", () => {
    const { event, voice, spawn, children } = setup();
    expect(voice.speak(event, 'Say "hi"\nnow', "es-CL", 4)).toBe(true);
    expect(spawn).toHaveBeenCalledWith("es-CL");
    expect(children[0]!.stdin.write).toHaveBeenCalledWith('{"text":"Say \\"hi\\"\\nnow"}\n');
  });

  it("forwards the helper's states and end for the page's session, and nothing else", async () => {
    const { event, voice, children, sent } = setup();
    voice.speak(event, "Hello", "en-US", 7);
    const child = children[0]!;

    child.stdout.write('{"type":"speaking"}\n{"type":"pau');
    child.stdout.write('sed"}\nnot json\n[]\n{"type":"error","error":"rm -rf"}\n');
    child.stdout.write('{"type":"error","error":"invalid-text"}\n{"type":"end"}\n');
    await flush();
    child.emit("close", 0);

    expect(sent()).toEqual([
      { session: 7, type: "speaking" },
      { session: 7, type: "paused" },
      { session: 7, type: "error", error: "invalid-text" },
      { session: 7, type: "end" },
    ]);
  });

  it("sends pause, resume and stop to the helper only for the session that owns it", () => {
    const { event, voice, children } = setup();
    voice.speak(event, "Hello", "en-US", 2);
    const write = children[0]!.stdin.write;
    write.mockClear();

    voice.pause(event, 1);
    expect(write).not.toHaveBeenCalled();
    voice.pause(event, 2);
    voice.resume(event, 2);
    voice.stop(event, 2);
    expect(write.mock.calls).toEqual([["pause\n"], ["resume\n"], ["stop\n"]]);

    const other = { sender: new EventEmitter() as unknown as WebContents };
    voice.stop(other, 2);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("ends the reading it replaces, and tells the page when the helper cannot start", async () => {
    const { event, voice, children, sent } = setup();
    voice.speak(event, "One", "en-US", 1);
    voice.speak(event, "Two", "en-US", 2);
    expect(children[0]!.kill).toHaveBeenCalledOnce();

    children[1]!.emit("error", new Error("ENOENT"));
    await flush();
    children[1]!.emit("close", 1);
    expect(sent().filter((message) => message.session === 2)).toEqual([
      { session: 2, type: "error", error: "unavailable" },
      { session: 2, type: "end" },
    ]);
  });

  it("reports an unlaunchable helper as unavailable, then ends", async () => {
    const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
    const target = {
      webContents: contents as unknown as WebContents,
      url: "https://app.example.com",
    };
    const voice = createSystemVoice(
      () => target,
      () => {
        throw new Error("spawn failed");
      },
    );
    expect(voice.speak({ sender: contents as unknown as WebContents }, "Hi", "en-US", 3)).toBe(
      true,
    );
    await flush();
    expect(contents.send.mock.calls.map(([, message]) => message)).toEqual([
      { session: 3, type: "error", error: "unavailable" },
      { session: 3, type: "end" },
    ]);
  });

  it("stops the helper and sends nothing more once the page navigates away", async () => {
    const { contents, event, voice, children, sent } = setup();
    voice.speak(event, "Hello", "en-US", 5);
    contents.emit("did-start-navigation", {}, "https://app.example.com/other", false, true);
    expect(children[0]!.kill).toHaveBeenCalledOnce();

    children[0]!.stdout.write('{"type":"speaking"}\n');
    children[0]!.emit("close", 0);
    await flush();
    expect(sent()).toEqual([]);
  });
});
