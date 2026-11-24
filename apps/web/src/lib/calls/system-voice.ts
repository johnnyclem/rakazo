import { i18n } from "@lingui/core";
import { desktopBridge } from "../platform/desktop.js";

export type SystemVoiceStatus = "idle" | "speaking" | "paused";

export interface SystemVoiceSnapshot {
  status: SystemVoiceStatus;
  messageId?: string;
}

const IDLE: SystemVoiceSnapshot = { status: "idle" };

let sessions = 0;

function browserSynthesis(): SpeechSynthesis | undefined {
  return typeof window === "undefined" ? undefined : window.speechSynthesis;
}

/** A Siri voice for the language when the browser lists one; otherwise its own default. */
export function pickBrowserVoice(
  voices: readonly SpeechSynthesisVoice[],
  language: string,
): SpeechSynthesisVoice | undefined {
  const base = language.toLowerCase().split("-")[0];
  return voices.find(
    (voice) => voice.lang.toLowerCase().split(/[-_]/)[0] === base && /siri/i.test(voice.name),
  );
}

/** Reads one message at a time: the desktop app's system voice (Personal, Siri, default), else the browser's. */
export class SystemVoice {
  private snapshot: SystemVoiceSnapshot = IDLE;
  private watchers = new Set<(s: SystemVoiceSnapshot) => void>();
  private session = 0;
  private unsubscribe: (() => void) | null = null;

  subscribe(fn: (s: SystemVoiceSnapshot) => void): () => void {
    this.watchers.add(fn);
    fn(this.snapshot);
    return () => {
      this.watchers.delete(fn);
    };
  }

  get state(): SystemVoiceSnapshot {
    return this.snapshot;
  }

  /** Whether this device has any voice to read with. */
  get available(): boolean {
    return Boolean(desktopBridge()?.systemVoice) || browserSynthesis() !== undefined;
  }

  private set(next: SystemVoiceSnapshot) {
    this.snapshot = next;
    for (const watcher of [...this.watchers]) watcher(next);
  }

  /** Ends whatever is being read and starts `text`. */
  speak(text: string, messageId: string) {
    this.stop();
    const session = ++sessions;
    this.session = session;
    this.set({ status: "speaking", messageId });
    const language = i18n.locale || navigator.language || "en";
    const bridge = desktopBridge()?.systemVoice;
    if (!bridge) return this.speakInBrowser(text, language, session);
    // The helper cannot run, or refuses this page: the browser's voices read it instead.
    const fallBack = () => {
      if (this.session !== session) return;
      this.release();
      this.speakInBrowser(text, language, session);
    };
    this.unsubscribe = bridge.onEvent((event) => {
      if (event.session !== session || this.session !== session) return;
      if (event.type === "speaking") this.set({ status: "speaking", messageId });
      else if (event.type === "paused") this.set({ status: "paused", messageId });
      else if (event.type === "error") fallBack();
      else this.finish(session);
    });
    bridge.speak(text, language, session).then((started) => {
      if (!started) fallBack();
    }, fallBack);
  }

  pause() {
    if (this.snapshot.status !== "speaking") return;
    this.set({ ...this.snapshot, status: "paused" });
    const bridge = desktopBridge()?.systemVoice;
    if (this.unsubscribe && bridge) void bridge.pause(this.session);
    else browserSynthesis()?.pause();
  }

  resume() {
    if (this.snapshot.status !== "paused") return;
    this.set({ ...this.snapshot, status: "speaking" });
    const bridge = desktopBridge()?.systemVoice;
    if (this.unsubscribe && bridge) void bridge.resume(this.session);
    else browserSynthesis()?.resume();
  }

  stop() {
    const session = this.session;
    if (this.snapshot.status === "idle") return;
    const bridge = desktopBridge()?.systemVoice;
    if (this.unsubscribe && bridge) void bridge.stop(session);
    else browserSynthesis()?.cancel();
    this.finish(session);
  }

  private speakInBrowser(text: string, language: string, session: number) {
    const synthesis = browserSynthesis();
    if (!synthesis) return this.finish(session);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = language;
    const voice = pickBrowserVoice(synthesis.getVoices(), language);
    if (voice) utterance.voice = voice;
    // Cancelling an earlier utterance ends it too; only the current session's end counts.
    utterance.onend = utterance.onerror = () => this.finish(session);
    synthesis.cancel();
    synthesis.speak(utterance);
  }

  private release() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private finish(session: number) {
    if (this.session !== session) return;
    this.release();
    this.session = 0;
    this.set(IDLE);
  }
}

export const systemVoice = new SystemVoice();
