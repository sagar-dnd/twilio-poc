import { useCallback, useEffect, useRef, useState } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import {
  backoffMs,
  classifyError,
  createMicDeadDetector,
  errorCode,
  formatTwilioErr,
  parseUserMessage,
  suggestDisposition,
} from "./twilioEvents";

function mapTwilioDevices(map) {
  if (!map) return [];
  return Array.from(map.entries()).map(([key, d]) => ({
    id: d.deviceId || key,
    label: d.label || d.deviceId || key,
  }));
}

async function fetchToken(identity, ttl) {
  const q = new URLSearchParams({ identity });
  if (ttl) q.set("ttl", String(ttl));
  const res = await fetch(`/token?${q}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `token ${res.status}`);
  }
  return res.json();
}

const EMPTY_HEALTH = {
  reconnecting: false,
  warnings: [],
  quality: null,
  inputLevel: 0,
  outputLevel: 0,
  micDead: false,
  earlyMedia: false,
  amd: null,
  transfer: null,
};

/**
 * Twilio Voice Device lifecycle for SD-7331 POC.
 * Handles every Device + Call event in Voice JS SDK v2 and the real power-dialer
 * scenarios documented in README ("Event handling scenarios").
 */
export function useTwilioDevice(identity) {
  const deviceRef = useRef(null);
  const callRef = useRef(null);
  const selectedInputRef = useRef("");
  const callEndWaiterRef = useRef(null);
  const intentionalUnregisterRef = useRef(false);
  const reRegisterAttemptRef = useRef(0);
  const reRegisterTimerRef = useRef(null);
  const ringTimerRef = useRef(null);
  const lastSampleLogRef = useRef(0);
  const callMetaRef = useRef({});
  const tokenTtlRef = useRef(null);
  const ringTimeoutSecRef = useRef(30);
  const micDetectorRef = useRef(null);
  const scheduleReRegisterRef = useRef(null);

  const [deviceState, setDeviceState] = useState("unregistered");
  const [callState, setCallState] = useState(null);
  const [activeCall, setActiveCall] = useState(null);
  const [incomingCall, setIncomingCall] = useState(null);
  const [inputDevices, setInputDevices] = useState([]);
  const [outputDevices, setOutputDevices] = useState([]);
  const [selectedInput, setSelectedInput] = useState("");
  const [selectedOutput, setSelectedOutput] = useState("");
  const [selectedRingtone, setSelectedRingtone] = useState("");
  const [micLevel, setMicLevel] = useState(0);
  const [outputSelectionSupported, setOutputSelectionSupported] =
    useState(true);
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState(null);
  const [tokenMeta, setTokenMeta] = useState(null);
  const [health, setHealth] = useState(EMPTY_HEALTH);
  const [missedCalls, setMissedCalls] = useState([]);
  const [lastEnd, setLastEnd] = useState(null);
  const [ringTimeoutSec, setRingTimeoutSecState] = useState(30);
  const [shortTtl, setShortTtl] = useState(null);

  const log = useCallback((level, msg, detail, source = "app") => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString().slice(11, 23),
      level,
      source,
      msg,
      detail:
        detail != null
          ? typeof detail === "string"
            ? detail
            : JSON.stringify(detail)
          : undefined,
    };
    setLogs((prev) => [entry, ...prev].slice(0, 500));
  }, []);

  const patchHealth = useCallback(
    (patch) => setHealth((h) => ({ ...h, ...patch })),
    [],
  );

  const refreshAudioDevices = useCallback((device) => {
    const audio = device?.audio;
    if (!audio) return { input: [], output: [] };

    const input = mapTwilioDevices(audio.availableInputDevices);
    const output = mapTwilioDevices(audio.availableOutputDevices);
    setInputDevices(input);
    setOutputDevices(output);
    setOutputSelectionSupported(Boolean(audio.isOutputSelectionSupported));
    if (audio.inputDevice?.deviceId) {
      selectedInputRef.current = audio.inputDevice.deviceId;
      setSelectedInput(audio.inputDevice.deviceId);
    }
    const speakers = audio.speakerDevices?.get?.();
    const activeOut =
      speakers && speakers.size ? Array.from(speakers)[0]?.deviceId : "";
    if (activeOut) setSelectedOutput(activeOut);
    const rings = audio.ringtoneDevices?.get?.();
    const activeRing =
      rings && rings.size ? Array.from(rings)[0]?.deviceId : "";
    if (activeRing) setSelectedRingtone(activeRing);
    return { input, output };
  }, []);

  const clearRingTimer = () => {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
  };

  const endCall = useCallback(
    (call, info) => {
      clearRingTimer();
      micDetectorRef.current?.reset();
      const meta = callMetaRef.current;
      const end = {
        ...info,
        sid: call?.parameters?.CallSid,
        direction: meta.direction,
        wasAnswered: Boolean(meta.acceptedAt),
        hungUpBy: meta.hungUpBy || (meta.acceptedAt ? "customer" : null),
        amd: meta.amd || null,
        dialResult: meta.dialResult || null,
        durationSec: meta.acceptedAt
          ? Math.round((Date.now() - meta.acceptedAt) / 1000)
          : 0,
      };
      end.disposition = suggestDisposition(end);
      setLastEnd(end);
      log(end.reason === "error" ? "error" : "info", "call ended", end);
      if (callRef.current === call) {
        callRef.current = null;
        setActiveCall(null);
        setCallState(null);
        setMuted(false);
        setHealth(EMPTY_HEALTH);
      }
      const device = deviceRef.current;
      if (device?.audio?.unsetInputDevice && !device.calls?.length) {
        device.audio.unsetInputDevice().catch(() => {});
      }
      const wait = callEndWaiterRef.current;
      callEndWaiterRef.current = null;
      wait?.(end);
    },
    [log],
  );

  const wireCall = useCallback(
    (call, direction, dialed) => {
      callRef.current = call;
      callMetaRef.current = { direction, startedAt: Date.now() };
      const peer =
        direction === "inbound"
          ? call.parameters?.From
          : dialed ||
            call.customParameters?.get?.("To") ||
            call.parameters?.To;
      setActiveCall({
        sid: call.parameters?.CallSid,
        direction,
        peer,
        status: call.status(),
      });
      setCallState(call.status());
      setHealth(EMPTY_HEALTH);
      log("info", `call ${direction}`, call.status(), "call");
      micDetectorRef.current = createMicDeadDetector({
        onChange: (dead) => {
          patchHealth({ micDead: dead });
          log(
            dead ? "warn" : "info",
            dead ? "mic looks dead (input ~0 for 5s)" : "mic input recovered",
            null,
            "call",
          );
        },
      });

      const syncStatus = () => {
        const s = call.status();
        setCallState(s);
        setActiveCall((prev) =>
          prev ? { ...prev, status: s, sid: call.parameters?.CallSid } : prev,
        );
      };

      // No-answer timeout (outbound): agent-side ring cap so the dialer moves on.
      if (direction === "outbound") {
        const sec = ringTimeoutSecRef.current;
        if (sec > 0) {
          ringTimerRef.current = setTimeout(() => {
            if (
              call.status() !== Call.State.Open &&
              call.status() !== Call.State.Closed
            ) {
              log(
                "warn",
                `no answer after ${sec}s — disconnecting`,
                null,
                "call",
              );
              callMetaRef.current.noAnswer = true;
              callMetaRef.current.hungUpBy = "timeout";
              call.disconnect();
            }
          }, sec * 1000);
        }
      }

      call.on("ringing", (hasEarlyMedia) => {
        syncStatus();
        patchHealth({ earlyMedia: Boolean(hasEarlyMedia) });
        log("info", "ringing", { hasEarlyMedia }, "call");
      });
      call.on("accept", () => {
        clearRingTimer();
        callMetaRef.current.acceptedAt = Date.now();
        syncStatus();
        setActiveCall((prev) =>
          prev ? { ...prev, answeredAt: callMetaRef.current.acceptedAt } : prev,
        );
        log(
          "info",
          "accept (media connected)",
          call.parameters?.CallSid,
          "call",
        );
      });
      call.on("disconnect", () => {
        syncStatus();
        const meta = callMetaRef.current;
        endCall(call, {
          reason: meta.noAnswer ? "no-answer-timeout" : "disconnect",
          status: call.status(),
        });
      });
      call.on("cancel", () => {
        // Inbound only: caller hung up before we answered → missed call.
        log(
          "warn",
          "cancel (caller hung up before answer)",
          call.parameters?.From,
          "call",
        );
        setIncomingCall((cur) => (cur === call ? null : cur));
        setMissedCalls((m) =>
          [
            {
              from: call.parameters?.From,
              at: new Date().toLocaleTimeString(),
            },
            ...m,
          ].slice(0, 20),
        );
        endCall(call, { reason: "cancel", status: call.status() });
      });
      call.on("reject", () => {
        log("warn", "reject", call.parameters?.From, "call");
        setIncomingCall((cur) => (cur === call ? null : cur));
        endCall(call, { reason: "reject", status: call.status() });
      });
      call.on("error", (err) => {
        const info = classifyError(err);
        const detail = formatTwilioErr(err);
        setError(`${info.label}: ${detail}`);
        log("error", `call error [${info.kind}]`, detail, "call");
        // Media errors (31401/31402) end the call; callee outcomes come with improved precision.
        if (
          call.status() === Call.State.Closed ||
          info.kind === "callee" ||
          info.kind === "mic"
        ) {
          endCall(call, {
            reason: "error",
            status: call.status(),
            code: info.code,
            error: detail,
          });
        }
      });
      call.on("mute", (isMuted) => {
        setMuted(isMuted);
        log("info", "mute", isMuted, "call");
      });
      call.on("reconnecting", (err) => {
        patchHealth({ reconnecting: true });
        log(
          "warn",
          "reconnecting (network blip)",
          formatTwilioErr(err),
          "call",
        );
      });
      call.on("reconnected", () => {
        patchHealth({ reconnecting: false });
        log("info", "reconnected", null, "call");
      });
      call.on("sample", (s) => {
        const quality = {
          mos: s.mos != null ? Number(s.mos).toFixed(2) : null,
          rtt: s.rtt,
          jitter: s.jitter,
          packetsLostFraction:
            s.packetsLostFraction != null
              ? Number(s.packetsLostFraction).toFixed(2)
              : null,
        };
        patchHealth({ quality });
        // sample fires every 1s — log every 10s to keep the panel readable
        if (Date.now() - lastSampleLogRef.current > 10000) {
          lastSampleLogRef.current = Date.now();
          log("debug", "sample", quality, "call");
        }
      });
      call.on("volume", (input, output) => {
        micDetectorRef.current?.sample(input, call.isMuted());
        setHealth((h) =>
          Math.abs(h.inputLevel - input) > 0.02 ||
          Math.abs(h.outputLevel - output) > 0.02
            ? { ...h, inputLevel: input, outputLevel: output }
            : h,
        );
      });
      call.on("warning", (name, data) => {
        setHealth((h) => ({
          ...h,
          warnings: Array.from(new Set([...h.warnings, name])),
        }));
        log(
          "warn",
          `warning: ${name}`,
          data?.value ?? data?.values ?? null,
          "call",
        );
      });
      call.on("warning-cleared", (name) => {
        setHealth((h) => ({
          ...h,
          warnings: h.warnings.filter((w) => w !== name),
        }));
        log("info", `warning cleared: ${name}`, null, "call");
      });
      call.on("messageReceived", (message) => {
        const msg = parseUserMessage(message);
        if (msg.type === "amd") {
          callMetaRef.current.amd = msg.content.answeredBy?.startsWith(
            "machine",
          )
            ? "machine"
            : msg.content.answeredBy;
          patchHealth({ amd: msg.content.answeredBy });
        } else if (msg.type === "transfer") {
          patchHealth({ transfer: msg.content.status });
        } else if (msg.type === "carrier") {
          patchHealth({ carrier: msg.content.status });
        } else if (msg.type === "dial-result") {
          callMetaRef.current.dialResult = msg.content.status;
        }
        log("info", `messageReceived: ${msg.type}`, msg.content, "call");
      });
      call.on("messageSent", (message) => {
        log("info", "messageSent", message?.voiceEventSid, "call");
      });
      call.on("audio", (remoteAudio) =>
        log(
          "debug",
          "remote audio element ready",
          remoteAudio?.tagName,
          "call",
        ),
      );
    },
    [log, endCall, patchHealth],
  );

  const scheduleReRegister = useCallback(
    (reason) => {
      if (intentionalUnregisterRef.current || reRegisterTimerRef.current)
        return;
      const attempt = reRegisterAttemptRef.current++;
      const wait = backoffMs(attempt);
      log(
        "warn",
        `re-register in ${wait}ms (attempt ${attempt + 1})`,
        reason,
        "device",
      );
      reRegisterTimerRef.current = setTimeout(async () => {
        reRegisterTimerRef.current = null;
        const device = deviceRef.current;
        if (
          !device ||
          intentionalUnregisterRef.current ||
          device.state === Device.State.Registered ||
          device.state === Device.State.Registering
        )
          return;
        // Never re-register mid-call: an active call keeps its own media/signaling; retry after it ends.
        if (callRef.current) {
          scheduleReRegisterRef.current?.("deferred: call in progress");
          return;
        }
        try {
          await device.register();
        } catch (e) {
          scheduleReRegisterRef.current?.(e.message);
        }
      }, wait);
    },
    [log],
  );
  useEffect(() => {
    scheduleReRegisterRef.current = scheduleReRegister;
  }, [scheduleReRegister]);

  const refreshToken = useCallback(
    async (why) => {
      const device = deviceRef.current;
      if (!device) return;
      try {
        const next = await fetchToken(identity, tokenTtlRef.current);
        device.updateToken(next.token);
        setTokenMeta({
          identity: next.identity,
          ttl: next.ttl,
          expiresAt: next.expiresAt,
        });
        log("info", "token updated", why, "device");
      } catch (e) {
        setError(e.message);
        log("error", "token refresh failed", e.message, "device");
      }
    },
    [identity, log],
  );

  const register = useCallback(async () => {
    setError(null);
    intentionalUnregisterRef.current = false;
    try {
      // Mic permission before Device (best practice) — catches 31401/31402 early.
      try {
        const preview = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        preview.getTracks().forEach((t) => t.stop());
        log("info", "mic permission granted");
      } catch (e) {
        const msg =
          e.name === "NotAllowedError"
            ? "Mic blocked (31401). Allow mic in site settings."
            : `Mic unavailable (31402): ${e.name}`;
        setError(msg);
        log("error", "getUserMedia failed", `${e.name}: ${e.message}`);
        throw e;
      }

      tokenTtlRef.current = shortTtl;
      const {
        token,
        identity: id,
        ttl,
        expiresAt,
      } = await fetchToken(identity, shortTtl);
      setTokenMeta({ identity: id, ttl, expiresAt });
      log("info", "token fetched", `ttl=${ttl}s identity=${id}`);

      if (deviceRef.current) {
        deviceRef.current.destroy();
        deviceRef.current = null;
      }

      const device = new Device(token, {
        logLevel: 1,
        tokenRefreshMs: 30000,
        maxCallSignalingTimeoutMs: 30000,
        enableImprovedSignalingErrorPrecision: true,
        // Let incoming arrive while busy so we can explicitly reject (and log) callbacks.
        allowIncomingWhileBusy: true,
        closeProtection: "A call is in progress. Leave anyway?",
        codecPreferences: [Call.Codec.Opus, Call.Codec.PCMU],
      });
      deviceRef.current = device;

      device.on("registering", () => {
        setDeviceState("registering");
        log("info", "registering", null, "device");
      });
      device.on("registered", () => {
        reRegisterAttemptRef.current = 0;
        setDeviceState("registered");
        log("info", "registered", null, "device");
        refreshAudioDevices(device);
      });
      device.on("unregistered", () => {
        setDeviceState("unregistered");
        log(
          "warn",
          "unregistered",
          intentionalUnregisterRef.current ? "by agent" : "unexpected",
          "device",
        );
        if (!intentionalUnregisterRef.current)
          scheduleReRegister("unexpected unregister");
      });
      device.on("error", (err) => {
        const info = classifyError(err);
        const detail = formatTwilioErr(err);
        setError(`${info.label}: ${detail}`);
        log("error", `device error [${info.kind}]`, detail, "device");
        if (info.kind === "token") refreshToken(`error ${info.code}`);
        else if (info.kind === "network")
          scheduleReRegister(`error ${info.code}`);
      });
      device.on("incoming", (call) => {
        const from = call.parameters?.From;
        const busy = Boolean(callRef.current);
        log(
          "info",
          busy ? "incoming while on a call (ringing)" : "incoming",
          from,
          "device",
        );
        setIncomingCall(call);
        if (busy) {
          // Always ring; agent decides. Don't replace the active call until accept.
          call.on("cancel", () => {
            log("warn", "cancel (caller hung up before answer)", from, "call");
            setIncomingCall((cur) => (cur === call ? null : cur));
            setMissedCalls((m) =>
              [{ from, at: new Date().toLocaleTimeString() }, ...m].slice(
                0,
                20,
              ),
            );
          });
          call.on("reject", () => {
            log("warn", "reject", from, "call");
            setIncomingCall((cur) => (cur === call ? null : cur));
          });
          return;
        }
        wireCall(call, "inbound");
      });
      device.on("tokenWillExpire", () => {
        log("warn", "tokenWillExpire", null, "device");
        refreshToken("tokenWillExpire");
      });
      device.on("destroyed", () => {
        setDeviceState("destroyed");
        log("info", "destroyed", null, "device");
      });

      // Live mic level outside calls too (AudioHelper analyses the selected input); throttled.
      let lastMicAt = 0;
      device.audio.on("inputVolume", (v) => {
        const now = Date.now();
        if (now - lastMicAt < 100) return;
        lastMicAt = now;
        setMicLevel(v);
      });
      device.audio.on("deviceChange", async (lostActiveDevices) => {
        const { input, output } = refreshAudioDevices(device);
        log(
          "info",
          "audio devices changed",
          `${input.length} in / ${output.length} out`,
          "audio",
        );
        if (lostActiveDevices?.length) {
          log(
            "warn",
            "lost active audio device",
            lostActiveDevices.map((d) => d.label || d.deviceId).join(", "),
            "audio",
          );
          const lostInput = lostActiveDevices.some(
            (d) => d.deviceId === selectedInputRef.current,
          );
          if (lostInput) {
            try {
              await device.audio.setInputDevice("default");
              selectedInputRef.current = "default";
              setSelectedInput("default");
              log("info", "fell back to default mic", null, "audio");
            } catch (e) {
              setError(`Mic unplugged and no fallback: ${formatTwilioErr(e)}`);
            }
          }
        }
      });

      await device.register();
      const { input, output } = refreshAudioDevices(device);
      if (input[0]?.id) {
        await device.audio.setInputDevice(input[0].id);
        selectedInputRef.current = input[0].id;
        setSelectedInput(input[0].id);
      }
      if (device.audio.isOutputSelectionSupported && output[0]?.id) {
        await device.audio.speakerDevices.set(output[0].id);
        await device.audio.ringtoneDevices.set(output[0].id);
        setSelectedOutput(output[0].id);
        setSelectedRingtone(output[0].id);
      }
    } catch (e) {
      setError((prev) => prev || e.message);
      log("error", "register failed", e.message);
      throw e;
    }
  }, [
    identity,
    log,
    refreshAudioDevices,
    wireCall,
    refreshToken,
    scheduleReRegister,
    shortTtl,
  ]);

  const unregister = useCallback(async () => {
    const device = deviceRef.current;
    if (!device) return;
    intentionalUnregisterRef.current = true;
    clearTimeout(reRegisterTimerRef.current);
    reRegisterTimerRef.current = null;
    try {
      if (callRef.current) {
        callMetaRef.current.hungUpBy = "agent";
        callRef.current.disconnect();
      }
      await device.unregister();
      device.destroy();
      deviceRef.current = null;
      selectedInputRef.current = "";
      setInputDevices([]);
      setOutputDevices([]);
      setSelectedInput("");
      setSelectedOutput("");
      setSelectedRingtone("");
      setMicLevel(0);
      setActiveCall(null);
      setIncomingCall(null);
    } catch (e) {
      log("error", "unregister failed", e.message);
    }
  }, [log]);

  const connect = useCallback(
    async ({ to, extraParams }) => {
      const device = deviceRef.current;
      if (!device) throw new Error("Device not registered");
      const dest = String(to || "").trim();
      if (!/^\+[1-9]\d{6,14}$/.test(dest))
        throw new Error("To must be E.164, e.g. +15551234567");
      setError(null);
      const params = { To: dest, ...(extraParams || {}) };
      log("info", "device.connect", params, "call");
      const inputId = selectedInputRef.current;
      if (inputId) await device.audio.setInputDevice(inputId);
      try {
        const call = await device.connect({ params });
        wireCall(call, "outbound", dest);
        return call;
      } catch (e) {
        const info = classifyError(e);
        setError(`${info.label}: ${formatTwilioErr(e)}`);
        log(
          "error",
          `connect failed [${info.kind}]`,
          formatTwilioErr(e),
          "call",
        );
        throw e;
      }
    },
    [log, wireCall],
  );

  const connectUntilEnd = useCallback(
    async ({ to }) => {
      const ended = new Promise((resolve) => {
        callEndWaiterRef.current = resolve;
      });
      try {
        await connect({ to });
      } catch (e) {
        callEndWaiterRef.current = null;
        const end = {
          reason: "failed",
          error: e.message || String(e),
          code: errorCode(e),
        };
        end.disposition = suggestDisposition({ ...end, reason: "error" });
        return end;
      }
      return ended;
    },
    [connect],
  );

  const hangup = useCallback(() => {
    if (!callRef.current) return;
    callMetaRef.current.hungUpBy = "agent";
    callRef.current.disconnect();
  }, []);

  const acceptIncoming = useCallback(async () => {
    if (!incomingCall) return;
    const device = deviceRef.current;
    const inputId = selectedInputRef.current;
    if (device && inputId) await device.audio.setInputDevice(inputId);
    const current = callRef.current;
    if (current && current !== incomingCall) {
      // Accepting while on a call ends the current call (one active call at a time).
      log(
        "warn",
        "accepting incoming — ending current call",
        current.parameters?.CallSid,
        "call",
      );
      callMetaRef.current.hungUpBy = "agent";
      current.disconnect();
      incomingCall.removeAllListeners("cancel");
      incomingCall.removeAllListeners("reject");
      wireCall(incomingCall, "inbound");
    }
    incomingCall.accept();
    setIncomingCall(null);
  }, [incomingCall, log, wireCall]);

  const rejectIncoming = useCallback(() => {
    incomingCall?.reject();
    setIncomingCall(null);
  }, [incomingCall]);

  const ignoreIncoming = useCallback(() => {
    // ignore(): stop ringing locally, caller keeps ringing until timeout → cancel/missed.
    incomingCall?.ignore();
    log("info", "incoming ignored", incomingCall?.parameters?.From, "call");
    setIncomingCall(null);
  }, [incomingCall, log]);

  const toggleMute = useCallback(() => {
    const call = callRef.current;
    if (!call) return;
    call.mute(!call.isMuted());
  }, []);

  const sendMessage = useCallback(async (content) => {
    const call = callRef.current;
    if (!call) return false;
    try {
      await call.sendMessage({
        content: JSON.stringify(content),
        contentType: "application/json",
        messageType: "user-defined-message",
      });
      return true;
    } catch (e) {
      log("error", "sendMessage failed", formatTwilioErr(e), "call");
      return false;
    }
  }, [log]);

  const setInputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current;
      if (!device || !deviceId) return;
      try {
        await device.audio.setInputDevice(deviceId);
        selectedInputRef.current = deviceId;
        setSelectedInput(deviceId);
        log("info", "setInputDevice", deviceId, "audio");
      } catch (e) {
        setError(`Mic switch failed (31402?): ${formatTwilioErr(e)}`);
        log("error", "setInputDevice failed", formatTwilioErr(e), "audio");
      }
    },
    [log],
  );

  const setOutputDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current;
      if (!device || !deviceId || !device.audio.isOutputSelectionSupported)
        return;
      try {
        await device.audio.speakerDevices.set(deviceId);
        setSelectedOutput(deviceId);
        log("info", "speakerDevices.set", deviceId, "audio");
      } catch (e) {
        log("error", "speakerDevices.set failed", formatTwilioErr(e), "audio");
      }
    },
    [log],
  );

  const setRingtoneDevice = useCallback(
    async (deviceId) => {
      const device = deviceRef.current;
      if (!device || !deviceId || !device.audio.isOutputSelectionSupported)
        return;
      try {
        await device.audio.ringtoneDevices.set(deviceId);
        setSelectedRingtone(deviceId);
        log("info", "ringtoneDevices.set", deviceId, "audio");
      } catch (e) {
        log("error", "ringtoneDevices.set failed", formatTwilioErr(e), "audio");
      }
    },
    [log],
  );

  const testSpeaker = useCallback(async () => {
    const device = deviceRef.current;
    if (!device) return;
    try {
      await device.audio.speakerDevices.test();
      log("info", "speakerDevices.test()", null, "audio");
    } catch (e) {
      log("error", "speaker test failed", formatTwilioErr(e), "audio");
    }
  }, [log]);

  const refreshDevices = useCallback(() => {
    const { input, output } = refreshAudioDevices(deviceRef.current);
    log(
      "info",
      "refresh audio devices",
      `${input.length} in / ${output.length} out`,
      "audio",
    );
  }, [refreshAudioDevices, log]);

  const setRingTimeoutSec = useCallback((sec) => {
    const n = Math.max(0, Number(sec) || 0);
    ringTimeoutSecRef.current = n;
    setRingTimeoutSecState(n);
  }, []);

  /** Force an invalid token to demo the token-error → refresh path */
  const simulateExpiredToken = useCallback(() => {
    const device = deviceRef.current;
    if (!device) return;
    device.updateToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid");
    log(
      "warn",
      "injected invalid token — next action should error (20101/31204)",
    );
  }, [log]);

  // Laptop sleep / network switch: on wake or back online, refresh an expired token and re-register.
  useEffect(() => {
    const onWake = (why) => {
      const device = deviceRef.current;
      if (!device || intentionalUnregisterRef.current) return;
      const exp = tokenMeta?.expiresAt
        ? new Date(tokenMeta.expiresAt).getTime()
        : 0;
      if (exp && exp - Date.now() < 60000)
        refreshToken(`${why}: token near/after expiry`);
      if (
        device.state !== Device.State.Registered &&
        device.state !== Device.State.Registering
      )
        scheduleReRegister(why);
    };
    const onVisible = () =>
      document.visibilityState === "visible" && onWake("tab visible");
    const onOnline = () => {
      log("info", "browser online", null, "network");
      onWake("online");
    };
    const onOffline = () => log("warn", "browser offline", null, "network");
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [tokenMeta, refreshToken, scheduleReRegister, log]);

  // Destroy only on real page leave — React StrictMode remount must not drop the Device
  useEffect(() => {
    const teardown = () => {
      try {
        callRef.current?.disconnect();
        deviceRef.current?.destroy();
        deviceRef.current = null;
      } catch {
        /* best-effort */
      }
    };
    window.addEventListener("pagehide", teardown);
    return () => window.removeEventListener("pagehide", teardown);
  }, []);

  return {
    deviceState,
    callState,
    activeCall,
    incomingCall,
    inputDevices,
    outputDevices,
    selectedInput,
    selectedOutput,
    selectedRingtone,
    micLevel,
    outputSelectionSupported,
    muted,
    logs,
    error,
    tokenMeta,
    health,
    missedCalls,
    lastEnd,
    ringTimeoutSec,
    shortTtl,
    setShortTtl,
    setRingTimeoutSec,
    register,
    unregister,
    connect,
    connectUntilEnd,
    hangup,
    acceptIncoming,
    rejectIncoming,
    ignoreIncoming,
    toggleMute,
    sendMessage,
    setInputDevice,
    setOutputDevice,
    setRingtoneDevice,
    testSpeaker,
    refreshDevices,
    simulateExpiredToken,
    log,
    clearLogs: () => setLogs([]),
    clearError: () => setError(null),
  };
}
