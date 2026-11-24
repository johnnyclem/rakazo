import { t } from "@lingui/core/macro";
import type { Bot, ThreadMessage, ThreadSnapshot } from "@rakazo/contracts";
import { speechFromBlocks } from "@rakazo/core";
import { toast } from "@rakazo/ui-web";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { systemVoice } from "../../../lib/calls/system-voice";
import { speaker, voiceNotReadyText } from "../../../lib/calls/tts";

const READ_ALOUD_TOAST = "read-aloud-error";

/**
 * Chat read-aloud has no caption to carry a failure, so it surfaces as a toast. With no voice
 * connected, the toast opens Voice settings through the latest callback, since it can outlive the
 * render that started the read.
 */
function readAloud(
  text: string,
  opts: { botId: string; messageId: string },
  openVoiceSettings: RefObject<() => void>,
) {
  systemVoice.stop();
  void speaker.speak(text, opts).then((error) => {
    if (!error) return;
    toast.error(error, {
      id: READ_ALOUD_TOAST,
      // The toast id is shared and an update keeps unset options, so other failures clear the action.
      action:
        error === voiceNotReadyText()
          ? { label: t`Open Voice settings`, onClick: () => openVoiceSettings.current() }
          : undefined,
    });
  });
}

/** Reads bot replies aloud, on request or automatically; without a voice provider the device's voice reads. */
export function useReadAloud({
  active,
  snapshot,
  callBotId,
  activeBotId,
  providerVoiceReady,
  openVoiceSettings,
}: {
  active: Bot | undefined;
  snapshot: ThreadSnapshot | null;
  callBotId: string | undefined;
  activeBotId: RefObject<string | undefined>;
  providerVoiceReady: boolean;
  openVoiceSettings: () => void;
}) {
  const openVoiceSettingsRef = useRef(openVoiceSettings);
  openVoiceSettingsRef.current = openVoiceSettings;
  // A space switch remounts the shell, so its toast would act on a shell that is gone.
  useEffect(
    () => () => {
      toast.dismiss(READ_ALOUD_TOAST);
    },
    [],
  );
  const [providerMessageId, setProviderMessageId] = useState<string | null>(null);
  const [device, setDevice] = useState(systemVoice.state);
  const autoSpoken = useRef<string | null>(null);
  const autoSpokenBotId = useRef<string | null>(null);

  useEffect(() => {
    const unsubSpeech = speaker.subscribe((state) => {
      setProviderMessageId(state.status === "idle" ? null : (state.messageId ?? null));
    });
    const unsubDevice = systemVoice.subscribe(setDevice);
    return () => {
      unsubSpeech();
      unsubDevice();
    };
  }, []);
  // An active call owns the speaker, so a reading on the device gives way to it.
  useEffect(() => {
    if (callBotId !== undefined) systemVoice.stop();
  }, [callBotId]);
  const speakingMessageId =
    device.status === "idle" ? providerMessageId : (device.messageId ?? null);

  useEffect(() => {
    if (!active || !snapshot || snapshot.botId !== active.id) return;
    const lastBot = [...snapshot.messages].reverse().find((message) => message.role === "bot");
    if (autoSpokenBotId.current !== active.id) {
      autoSpokenBotId.current = active.id;
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    // An active call owns the speaker; another chat's replies must not cut into it.
    if (callBotId !== undefined || !active.autoSpeak) {
      autoSpoken.current = lastBot?.id ?? null;
      return;
    }
    if (snapshot.run && ["running", "queued", "leased"].includes(snapshot.run.status)) return;
    if (!lastBot || lastBot.id === autoSpoken.current) return;
    const text = speechFromBlocks(lastBot.blocks);
    if (!text) return;
    autoSpoken.current = lastBot.id;
    readAloud(text, { botId: active.id, messageId: lastBot.id }, openVoiceSettingsRef);
  }, [
    snapshot?.messages,
    snapshot?.run?.status,
    snapshot?.botId,
    active?.autoSpeak,
    active?.id,
    callBotId,
  ]);

  const speakingMessageIdRef = useRef(speakingMessageId);
  speakingMessageIdRef.current = speakingMessageId;
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const providerVoiceReadyRef = useRef(providerVoiceReady);
  providerVoiceReadyRef.current = providerVoiceReady;
  const callBotIdRef = useRef(callBotId);
  callBotIdRef.current = callBotId;
  const speakMessage = useCallback((message: ThreadMessage) => {
    if (speakingMessageIdRef.current === message.id) {
      const reading = deviceRef.current;
      if (reading.status === "speaking") systemVoice.pause();
      else if (reading.status === "paused") systemVoice.resume();
      else speaker.stop();
      return;
    }
    // An active call owns the speaker; a manual read must not cut into it.
    if (callBotIdRef.current !== undefined) return;
    const text = speechFromBlocks(message.blocks);
    if (!text) return;
    if (providerVoiceReadyRef.current) {
      const id = message.botId ?? activeBotId.current;
      if (id) readAloud(text, { botId: id, messageId: message.id }, openVoiceSettingsRef);
      return;
    }
    speaker.stop();
    systemVoice.speak(text, message.id);
  }, []);

  // The transcript's props: the provider's voice reads on request, and so can the device's own.
  return {
    voiceReady: providerVoiceReady || systemVoice.available,
    speakingMessageId,
    /** Only the device's own voice can pause. */
    readerState: { paused: device.status === "paused", pausable: device.status !== "idle" },
    callHoldsSpeaker: callBotId !== undefined,
    onSpeak: speakMessage,
  };
}
