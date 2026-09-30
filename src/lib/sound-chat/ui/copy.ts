/**
 * Every user-visible string in Sound Chat, in one place.
 *
 * Three rules shape this file, and they are the reason the copy is data rather
 * than markup scattered through components:
 *
 * 1. **Say what the protocol proves.** A pairing confirmation proves "these two
 *    devices share the code and can hear each other right now". It proves
 *    nothing about who is holding the other device, because the acoustic
 *    handshake is a key check, not an identity check. `PAIRING_CONFIRMATION_COPY`
 *    and `describePairingFailure` already say that; they are reused verbatim
 *    rather than reworded, so there is exactly one honest sentence per case.
 * 2. **Never claim more speed, range or privacy than the medium gives.** No
 *    instant delivery, no distance promises, no confidentiality of the
 *    transmission itself. Anyone with a microphone in the room can record the
 *    tone; what a recording cannot do is read the note or re-enter a later
 *    session.
 * 3. **Never be quiet about a failure.** A refused microphone, a codec that
 *    died and an internal frame contract that broke are three different
 *    sentences, because they have three different causes and three different
 *    fixes. `SOUND_CHAT_COPY` below is the only place a sentence may live.
 *
 * `copy.test.ts` machine-checks the two mechanical rules (no emoji, and none of
 * the words that would claim the channel is inaudible) across every string here
 * and across the rendered markup of every state.
 */

import {
  MAX_MESSAGE_ASCII_CHARACTERS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
} from "../protocol";
import { PAIRING_CONFIRMATION_COPY, describePairingFailure } from "../pairing";
import type { PairingFailureReason, PairingRole } from "../pairing";
import type { OutboundStatus } from "../protocol";
import type { SoundChatBlock, SoundChatFatal } from "./controller";
import type { SendRefusal } from "../session";
import type { TransportState } from "../transport-machine";
import { MAX_PENDING_MESSAGES } from "../session";
import { BLOCK_DURATION_MS, MAX_MESSAGE_BLOCKS_ALLOWED, secondsLabel } from "./budget";

export { PAIRING_CONFIRMATION_COPY, describePairingFailure };

/** The one-line MIT notice, reachable from the Sound Chat screen itself. */
export const ATTRIBUTION_LINE =
  "Sound encoding by ggwave (MIT), copyright (c) 2020 Georgi Gerganov.";

export const SOUND_CHAT_COPY = {
  /** Pre-prompt, before the browser's own microphone prompt is triggered. */
  permission: {
    title: "Sound Chat talks through sound",
    lead: "Two devices in the same room pass short encrypted notes to each other as audible tones. No Wi-Fi, no relay, no internet: your speaker sends and your microphone listens.",
    why: `Sound Chat asks for the microphone once, when you start. It needs to hear the other device. Audio is never recorded to a file, never stored, and never sent anywhere — it only ever plays or listens.`,
    whyVolume:
      "Start with both devices in the same room a few metres apart and the volume turned up. Every note is played out loud, so you both see and hear it happen.",
    limitsHeading: "What it does, and what it does not",
    limits: [
      "Every note is audible. Anyone nearby can hear it, and anyone with a microphone in the room can record it.",
      `Notes are short: ${MAX_MESSAGE_ASCII_CHARACTERS} plain characters at most, which is one or two seconds of sound each half. Accents, symbols and emoji each cost more than one byte, so they fill the limit faster.`,
      "A recording of a note cannot be read later, because every session makes its own random key material. A recording of the handshake can occupy one pairing, but cannot read anything.",
      "Pairing confirms that both devices hold the same code. It cannot tell you who is holding the other device.",
      "Sound Chat needs this page to be open and in the foreground to send. It holds a note while the tab is in the background.",
    ] as const,
    displayAction: "Show a pairing code",
    enterAction: "Enter a pairing code",
    dismiss: "Not now",
  },

  /** Pairing screen: one branch per role, plus the shared waiting copy. */
  pairing: {
    displayHeading: "Show this code on the other device",
    displayBody:
      "Type it into the second device. This one is listening, and will play a short tone to answer.",
    enterHeading: "Type the code from the other device",
    enterBody:
      "The code is eight characters using the digits 2 to 9 and the letters A to Z. It is never played out loud as sound.",
    fieldLabel: "Pairing code",
    codeLabel: "Pairing code to type in",
    codeAction: "Connect",
    copyAction: "Copy code",
    copiedAction: "Copied",
    copyRefused: "Copying was refused by the browser. Write the code down and type it in instead.",
    waitingDisplay: "Listening for the other device",
    waitingEnter: "Playing the handshake tone, then listening for an answer",
    hint: "Both devices in the same room, a few metres apart, volume up.",
    retry: "Start pairing again",
    changeRole: "Use the other option instead",
    roleLabel: {
      displayer: "You are showing a code",
      enterer: "You are entering a code",
    } satisfies Record<PairingRole, string>,
  },

  /** The live transport state, one sentence each, all nine states covered. */
  transport: {
    idle: "Not started",
    listening: "Listening",
    transmitting: "Playing your note out loud",
    awaiting_turn: "The other device is on the air. Yours goes next.",
    awaiting_ack: "On the air, waiting for the other device to confirm.",
    backoff: "The channel was busy. Trying again.",
    hidden_hold: "Held while this tab is in the background.",
    error: "Sound Chat could not start.",
    module_error: "The sound codec stopped working.",
  } satisfies Record<TransportState, string>,

  /** One-block and multi-block transmission progress. */
  transmit: {
    label: "Playing out loud",
    /** The honest state between `send()` returning and the first block playing. */
    arming: "Getting ready to play.",
    progressLabel: "Transmission progress",
    block: (blockIndex: number, blocks: number, remainingMs: number) =>
      `Block ${blockIndex} of ${blocks} - about ${secondsLabel(remainingMs)} left`,
    pairBlock: (remainingMs: number) => `Handshake tone - about ${secondsLabel(remainingMs)} left`,
    acking: "Your note is on the air. Waiting for the other device to confirm it.",
    queued: "Queued. It goes out when the channel is clear.",
    delivered: "Delivered",
    retrying: (attempts: number) =>
      `Not confirmed yet. Attempt ${attempts} of 3, then it is given up.`,
    failed: "Not received. The other device did not acknowledge it.",
    /** P6: something was in the air, and this pairing cannot read it. */
    unreadable: "A transmission was heard, but this pairing code cannot read it.",
  },

  /** The transcript, before anything has been exchanged. */
  transcript: {
    logLabel: "Notes exchanged",
    scrollLabel: "Sound Chat transcript",
    emptyHeading: "No notes yet.",
    emptyBody: "Anything the other device sends appears here as soon as it is decoded.",
  },

  composer: {
    label: "Note to send",
    placeholder: "Type a short note",
    send: "Send",
    byteCounter: (bytes: number) => `${bytes} / ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes`,
    overCap: (overBy: number) =>
      `Too long by ${overBy} byte${overBy === 1 ? "" : "s"}. This channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes at a time.`,
    atCap: "That is the limit for one transmission.",
    singleBlock: `One block: about ${secondsLabel(BLOCK_DURATION_MS)} of sound.`,
    twoBlocks: `Two blocks: about ${secondsLabel(2 * BLOCK_DURATION_MS)} of sound.`,
    empty: "Nothing to send yet.",
    bytesHint:
      "Plain letters and numbers cost one byte each. Accents, symbols and emoji cost more, so they reach the limit sooner.",
    blockedByPairing: "Pairing has to finish before notes can be sent.",
    queueFull: `${MAX_PENDING_MESSAGES} notes are already waiting. The channel cannot hold more than that.`,
  },

  /** What each `session.send()` refusal means to the person who pressed send. */
  refusal: {
    "not-paired": "Pairing has to finish before notes can be sent.",
    empty: "Nothing to send yet.",
    "too-long": `This channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes at a time.`,
    "queue-full": `${MAX_PENDING_MESSAGES} notes are already waiting. The channel cannot hold more than that.`,
    "module-error": "The sound codec stopped working.",
    stopped: "Sound Chat has stopped.",
  } satisfies Record<SendRefusal, string>,

  /** A fixable reason the session could not start. */
  blocked: {
    "mic-denied": {
      heading: "Microphone access was refused",
      body: "Sound Chat cannot hear the other device without it. Allow the microphone for this site in your browser's address bar, then try again.",
    },
    "mic-missing": {
      heading: "No microphone was found",
      body: "This device reports no audio input. Connect a microphone or headset and try again.",
    },
    "mic-unsupported": {
      heading: "This browser cannot capture sound",
      body: "Sound Chat needs microphone capture, which this browser or this page's security context does not provide.",
    },
    "device-rate": {
      heading: "This device's audio runs at the wrong rate",
      body: "Sound Chat decodes at 48000 Hz and cannot decode on a device whose audio runs at a different rate. Nothing you can change in the browser fixes this one.",
    },
    "bad-code": {
      heading: "That pairing code is not valid",
      body: "A pairing code is eight characters using the digits 2 to 9 and the letters A to Z. Check it and try again.",
    },
    "crypto-unavailable": {
      heading: "This browser cannot do the encryption",
      body: "Sound Chat needs the Web Crypto API to derive a key from your pairing code, and this browser does not provide it.",
    },
    "codec-unavailable": {
      heading: "The sound codec could not start",
      body: "The audio codec either did not load or could not set up its two instances. Reloading the page usually clears it.",
    },
    "audio-unavailable": {
      heading: "The audio engine would not start",
      body: "The microphone was granted, but the audio engine would not attach it. Reloading the page, or unplugging and reconnecting the microphone, usually clears it.",
    },
  } satisfies Record<SoundChatBlock["kind"], { heading: string; body: string }>,

  /** Actions shared by every start-up failure screen. */
  actions: {
    retry: "Try again",
    back: "Go back",
    stop: "Stop Sound Chat",
    exit: "Back to Husk",
  },

  /** The shell: title bar and the one in-between state that has no session yet. */
  shell: {
    title: "Sound Chat",
    preparing: "Setting up the microphone and the sound codec.",
    noticesLabel: "Sound Chat status messages",
  },

  /** Terminal for this session. The two causes read differently on purpose. */
  fatal: {
    "codec-died": {
      heading: "The sound codec stopped working",
      body: "Sound Chat's audio codec failed part-way through this session and cannot be reused. Nothing in flight was delivered. Restarting builds a whole new session; your pairing code stays the same.",
    },
    "frame-contract": {
      heading: "Sound Chat could not use a block it built itself",
      body: "A transmission block did not match the format this session writes, so the session cannot continue. Nothing in flight was delivered. Restart Sound Chat and try again.",
    },
  } satisfies Record<SoundChatFatal["kind"], { heading: string; body: string }>,

  /** The single confirmation dialog, reused for restart and for discarding. */
  modal: {
    restartTitle: "Restart Sound Chat?",
    restartDescription:
      "The current session ends and a new one starts with the same pairing code. Anything in flight is discarded.",
    restartConfirm: "Restart Sound Chat",
    discardTitle: "Stop Sound Chat?",
    discardDescription:
      "This session ends, the microphone is released, and everything in the transcript is discarded. Nothing is kept anywhere.",
    discardConfirm: "Stop Sound Chat",
    cancel: "Keep going",
  },

  info: {
    heading: "About Sound Chat",
    how: "A note is turned into one or two fixed-length audio blocks, each one a little under two seconds of tones between about 1.9 and 6.3 kHz. Each block is encrypted with a key derived from your pairing code, and the key itself is never played as sound. The two devices take turns: one speaks, then listens for the other's confirmation, then the other speaks.",
    rate: `The channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes in ${secondsLabel(2 * BLOCK_DURATION_MS)} at the cap, or ${secondsLabel(BLOCK_DURATION_MS)} for a short note - about ${Math.round(MAX_MESSAGE_PLAINTEXT_BYTES / ((2 * BLOCK_DURATION_MS) / 1000))} bytes a second of your own text. It is a short-notes channel, not a messenger.`,
    privacy:
      "Encryption is AES-256-GCM in the browser, derived from the pairing code with PBKDF2. Nothing is stored: reload the page and the session is gone, and a recording of an earlier session cannot be read in a new one.",
    attribution: ATTRIBUTION_LINE,
    attributionLink: "Read the ggwave licence",
  },

  /** An outbound message's own status line, one per protocol status. */
  outbound: {
    sending: "Playing",
    sent: "Delivered",
    failed: "Not received",
  } satisfies Record<OutboundStatus, string>,

  /** Pairing failure copy is the pairing machine's, not ours. */
  pairingFailure: (reason: PairingFailureReason) => describePairingFailure(reason),

  /** Constants the copy above quotes, so a test can assert they agree. */
  facts: {
    singleBlockBytes: SINGLE_BLOCK_PLAINTEXT_BYTES,
    capBytes: MAX_MESSAGE_PLAINTEXT_BYTES,
    maxBlocks: MAX_MESSAGE_BLOCKS_ALLOWED,
    blockDurationMs: BLOCK_DURATION_MS,
    maxPending: MAX_PENDING_MESSAGES,
  },
} as const;
