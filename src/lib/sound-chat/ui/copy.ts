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
 * `deep-p3a-copy.test.ts` machine-checks the two mechanical rules (no emoji, and
 * none of the words that would claim the channel is inaudible) across every string
 * here; `render.test.tsx` makes the same two checks against the rendered markup of
 * every state, which is the only place a string can escape the table.
 */

import { MAX_MESSAGE_ASCII_CHARACTERS, MAX_MESSAGE_PLAINTEXT_BYTES } from "../protocol";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH } from "../crypto";
import { PAIRING_CONFIRMATION_COPY, describePairingFailure } from "../pairing";
import type { PairingFailureReason, PairingRole } from "../pairing";
import type { OutboundStatus } from "../protocol";
import type { SoundChatBlock, SoundChatFatal } from "./controller";
import type { SendRefusal } from "../session";
import type { TransportState } from "../transport-machine";
import { MAX_PENDING_MESSAGES } from "../session";
import { BLOCK_DURATION_MS, secondsLabel } from "./budget";

export { PAIRING_CONFIRMATION_COPY, describePairingFailure };

/** The one-line MIT notice, reachable from the Sound Chat screen itself. */
export const ATTRIBUTION_LINE =
  "Sound encoding by ggwave (MIT), copyright (c) 2020 Georgi Gerganov.";

/**
 * The letters a code cannot contain, derived from the alphabet rather than typed.
 *
 * WHY this is computed and not written out: `PAIRING_CODE_ALPHABET` is
 * `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — `I` and `O` are removed so they cannot be
 * confused with `1` and `0`. The copy used to say "the letters A to Z", which is
 * a rule the implementation does not follow: a person who typed an `I` because
 * the screen told them to was refused by a field that had just told them `I` was
 * allowed. Deriving the sentence from the constant makes that impossible to
 * reintroduce, and a test asserts the derivation is still the whole difference.
 */
function excludedLetters(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return [...letters].filter((letter) => !PAIRING_CODE_ALPHABET.includes(letter)).join(" and ");
}

/**
 * The code's alphabet, as a sentence, with the exclusions named.
 *
 * NOT a whole clause: both call sites already supply their own subject ("The
 * code is …", "A pairing code is …"), and a leading "a code is" in the constant
 * made the two sentences on screen read "The code is a code is 8 characters …"
 * and "A pairing code is a code is 8 characters …".
 */
export const PAIRING_CODE_RULE = `${PAIRING_CODE_LENGTH} characters using the digits 2 to 9 and the letters A to Z, except ${excludedLetters()}`;

/**
 * The sentence for one transport state.
 *
 * Every entry is a function of the attempt count even though only `backoff` uses
 * it. That is deliberate: a mixed `Record<TransportState, string | Function>`
 * needs a runtime `typeof` to read, and a `typeof` against a table is the shape
 * the anti-slop rules ban because it usually means the table should be typed
 * differently. One uniform type means no narrowing at the call site, and
 * `satisfies Record<...>` still fails to compile if a state is ever added without
 * a sentence.
 *
 * The attempt number earns its place in `backoff` for two reasons at once. It is
 * the honest wording — "trying again" without a count does not say whether this
 * is the second attempt or the last. And a byte-identical sentence is never
 * re-announced: React does not touch the DOM when the text has not changed, so a
 * person waiting through three attempts would hear it exactly once.
 */
export function transportSentence(state: TransportState, attempts = 1): string {
  return SOUND_CHAT_COPY.transport[state](Math.max(1, Math.round(attempts)));
}

/** The attempt number `transport.backoff` quotes. Shared so it cannot drift. */
const MAX_SEND_ATTEMPTS_SHOWN = 3;

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
      `Notes are short: ${MAX_MESSAGE_ASCII_CHARACTERS} plain characters at most, which is up to 3.8 seconds of sound. Anything outside plain letters and digits can cost more than one byte, so it fills the limit faster.`,
      "A recording of a note cannot be read later, because every session makes its own random key material. A recording of the handshake can occupy one pairing, but cannot read anything.",
      "Pairing confirms that both devices hold the same code. It cannot tell you who is holding the other device.",
      "Sound Chat needs this page to be open and in the foreground to send. It holds a note while the tab is in the background.",
    ] as const,
    displayAction: "Show a pairing code",
    enterAction: "Enter a pairing code",
    /**
     * The label on the pre-prompt's own disclosure.
     *
     * Why the limits, the microphone explanation and the attribution moved off
     * the action column and in here: the pre-prompt's job is one decision, and
     * everything that is *reading* rather than deciding belongs behind a control
     * that says it is reading. The content is still in the document either way,
     * so a screen reader is not made to open a disclosure to be told what the
     * microphone is for.
     */
    learnMore: "Learn more",
    /** The disclosure's own dismiss control. */
    close: "Close",
    /**
     * Kept, and no longer rendered.
     *
     * "Not now" was a third quiet button beside "Enter a pairing code", doing
     * exactly what the shell's own back control does — leaving Sound Chat — so
     * the screen offered two controls for one exit and neither was the obvious
     * one. The prop is still accepted by `PermissionPrompt` because callers and
     * tests pass it; the label stays here because the wording is still the right
     * wording for any future explicit dismiss.
     */
    dismiss: "Not now",
  },

  /** Pairing screen: one branch per role, plus the shared waiting copy. */
  pairing: {
    displayHeading: "Show this code on the other device",
    displayBody:
      "Type it into the second device. This one is listening, and will play a short tone to answer.",
    enterHeading: "Type the code from the other device",
    enterBody: `The code is ${PAIRING_CODE_RULE}. It is never played out loud as sound.`,
    /**
     * The same screen, after a retry that carried the typed code through.
     *
     * An enterer that already holds a code must not be told to type one: there is
     * no field on this screen, so "Type the code from the other device" is an
     * instruction to do something impossible. This states the code actually in
     * use, which is the only thing a person in this state can act on — they can
     * see whether it is the code they meant.
     */
    enterRetryHeading: "Playing your handshake tone",
    enterRetryBody:
      "This is the code being used. It is never played out loud as sound, only matched against the other device's tone.",
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
    /**
     * The role switch, keyed by the role the control switches *to*.
     *
     * NOT "Use the other option instead": this is the only escape from a
     * 90-second wait, and a label that says "the other option" makes the person
     * work out which option that is from the screen they are already on — the
     * one screen that cannot show them the other option. Keying the table by the
     * destination role rather than writing a conditional means the label cannot
     * drift from the branch that renders it, and a `PairingRole` added later is a
     * compile error here rather than a button with the wrong sentence on it.
     */
    switchTo: {
      displayer: "Show a code instead",
      enterer: "Enter a code instead",
    } satisfies Record<PairingRole, string>,
    roleLabel: {
      displayer: "You are showing a code",
      enterer: "You are entering a code",
    } satisfies Record<PairingRole, string>,
  },

  /**
   * The live transport state, one sentence each, all nine states covered.
   *
   * `backoff` is the only one that reads its argument; the other eight take it
   * and ignore it, which is what keeps the whole record a single function type.
   */
  transport: {
    idle: () => "Not started",
    listening: () => "Listening",
    transmitting: () => "Playing your note out loud",
    awaiting_turn: () => "The other device is on the air. Yours goes next.",
    awaiting_ack: () => "On the air, waiting for the other device to confirm.",
    /**
     * `backoff` has three distinct causes in the machine — a detected collision,
     * the peer starting while we wait, and an acknowledgement that simply never
     * arrived — and the third is by far the most common. "The channel was busy"
     * names a cause the software cannot observe: a missed decode, a wrong code,
     * room noise and a device that was not listening are all indistinguishable
     * from here, and every other sentence in this table names only what is known.
     */
    backoff: (attempts: number) =>
      `Not confirmed yet, so it is being tried again (attempt ${attempts} of ${MAX_SEND_ATTEMPTS_SHOWN}).`,
    hidden_hold: () => "Held while this tab is in the background.",
    error: () => "Sound Chat could not start.",
    module_error: () => "The sound codec stopped working.",
  } satisfies Record<TransportState, (attempts: number) => string>,

  /** One-block and multi-block transmission progress. */
  transmit: {
    /** The honest state between `send()` returning and the first block playing. */
    arming: "Getting ready to play.",
    progressLabel: "Transmission progress",
    block: (blockIndex: number, blocks: number, remainingMs: number) =>
      `Block ${blockIndex} of ${blocks} - about ${secondsLabel(remainingMs)} left`,
    acking: "Your note is on the air. Waiting for the other device to confirm it.",
    /**
     * REMOVED IN PHASE 3V — there is no global "Queued." line here any more.
     *
     * It rendered for every busy-but-not-on-air state and said exactly what the
     * per-note `outbound.queued` row says — "this note of mine is accepted and
     * not played yet" — except without saying *which* note. Two sentences for one
     * fact, one of them unattributed, is how two copies drift apart. The rows say
     * it once each, attributed, which is the whole fix.
     */
    retrying: (attempts: number) =>
      `Not confirmed yet. Attempt ${attempts} of 3, then it is given up.`,
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
    /**
     * Shown only when the character count and the byte count disagree, i.e. only
     * when the note holds something outside plain ASCII. For plain text the two
     * numbers are the same number and printing both is noise; the count is here
     * because `maxLength` is deliberately absent (it counts UTF-16 code units,
     * which disagrees with the byte budget in both directions), so without a count
     * a person has no way to see that 42 accented letters is 42 characters and
     * exactly the whole 84-byte limit.
     *
     * A count, not a second budget: there is no character cap, because 84 is
     * reachable in characters only by note that is entirely ASCII.
     */
    characterCounter: (characters: number) =>
      `${characters} character${characters === 1 ? "" : "s"}`,
    overCap: (overBy: number) =>
      `Too long by ${overBy} byte${overBy === 1 ? "" : "s"}. This channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes at a time.`,
    atCap: "That is the limit for one transmission.",
    singleBlock: `One block: about ${secondsLabel(BLOCK_DURATION_MS)} of sound.`,
    twoBlocks: `Two blocks: about ${secondsLabel(2 * BLOCK_DURATION_MS)} of sound.`,
    empty: "Nothing to send yet.",
    bytesHint:
      "Plain letters and digits cost one byte each. Anything else can cost more, so it reaches the limit sooner.",
    blockedByPairing: "Pairing has to finish before notes can be sent.",
    /**
     * The keyboard hint under the field.
     *
     * WHY this exists as copy at all: a `<textarea>` does not submit the form it
     * sits in, so Enter is a key the field has to be *told* to accept — and a key
     * shortcut nobody is told about is a key shortcut nobody uses. It says both
     * halves, because "Enter to send" alone is the sentence that makes someone
     * lose their line break.
     */
    enterHint: "Enter to send · Shift + Enter for new line",
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
      body: "Sound Chat needs microphone capture, which this browser or this page's security context does not provide. Try a different browser, a newer version of this one, or a page served over https.",
    },
    "device-rate": {
      heading: "This device's audio runs at the wrong rate",
      body: "Sound Chat decodes at 48000 Hz and cannot decode on a device whose audio runs at a different rate. Nothing you can change in the browser fixes this one.",
    },
    "bad-code": {
      heading: "That pairing code is not valid",
      body: `A pairing code is ${PAIRING_CODE_RULE}. Check it and try again.`,
    },
    "crypto-unavailable": {
      heading: "This browser cannot do the encryption",
      body: "Sound Chat needs the Web Crypto API to derive a key from your pairing code, and this browser does not provide it. Try a different browser, or a newer version of this one.",
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
    exit: "Back to Husk",
    dismissNotices: "Dismiss these messages",
    /**
     * Ends the chat session and returns to the start screen.
     *
     * NOT "Stop" or "Exit": the screen it returns to is the microphone
     * pre-prompt inside this feature, so the honest name for the trade is that
     * the session ends and you start again. The separate `actions.exit` above is
     * a whole-page navigation out of Sound Chat, and two controls that both sound
     * like leaving would differ only in a way nobody could see.
     */
    leave: "End this session",
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

  /**
   * The one confirmation dialog. Only the restart uses it: the cancel label is
   * not ours to choose (the shared `Modal` primitive hardcodes it), and leaving
   * the page is a plain anchor whose full navigation is the more honest teardown
   * \u2014 so no copy for a stop dialog survives to be unused.
   */
  modal: {
    restartTitle: "Restart Sound Chat?",
    restartDescription:
      "The current session ends, the microphone is released, and the whole transcript is cleared from this page. A new session starts with the same pairing code.",
    restartConfirm: "Restart Sound Chat",
    /**
     * The other direction: back to the microphone pre-prompt, keeping nothing.
     * It names the same three consequences the restart does, because they are
     * the same three: the session ending, the microphone being released, and the
     * transcript going. A person who paired with the wrong device has to know the
     * cost before paying it, not after.
     */
    leaveTitle: "End this Sound Chat session?",
    leaveDescription:
      "The session ends, the microphone is released, and the whole transcript is cleared from this page. You start again from the beginning, with a new pairing code.",
    leaveConfirm: "End session",
  },

  info: {
    heading: "About Sound Chat",
    how: "A note is turned into one or two fixed-length audio blocks, each one a little under two seconds of tones between about 1.9 and 6.3 kHz. Each block is encrypted with a key derived from your pairing code, and the key itself is never played as sound. The two devices take turns: one speaks, then listens for the other's confirmation, then the other speaks.",
    rate: `The channel carries ${MAX_MESSAGE_PLAINTEXT_BYTES} bytes in ${secondsLabel(2 * BLOCK_DURATION_MS)} at the cap, or ${secondsLabel(BLOCK_DURATION_MS)} for a short note - about ${Math.round(MAX_MESSAGE_PLAINTEXT_BYTES / ((2 * BLOCK_DURATION_MS) / 1000))} bytes a second of your own text. It is a short-notes channel, not a messenger.`,
    privacy:
      "Encryption is AES-256-GCM in the browser, derived from the pairing code with PBKDF2. Nothing is stored: reload the page and the session is gone, and a recording of an earlier session cannot be read in a new one.",
    attribution: ATTRIBUTION_LINE,
    attributionLink: "Read the ggwave licence",
    statsHeading: "This session",
    statBlocksDecoded: "Blocks heard",
    statMessagesDelivered: "Notes received",
    statDuplicatesSuppressed: "Repeated blocks ignored",
    statUnreadable: "Unreadable blocks",
    statRetries: "Retries",
  },

  /** An outbound message's own status line, one per protocol status. */
  outbound: {
    /**
     * Accepted and in the session's queue, not yet on the air.
     *
     * NOT "Sending" and not "Waiting": neither is true yet. The word has to say
     * the note is safely held and has not been played, because that is exactly
     * the state a person cannot otherwise see — before this status existed a
     * note accepted in that state had no row at all.
     */
    queued: "Queued, not played yet",
    sending: "Playing",
    sent: "Delivered",
    failed: "Not received",
  } satisfies Record<OutboundStatus, string>,

  /** Pairing failure copy is the pairing machine's, not ours. */
  pairingFailure: (reason: PairingFailureReason) => describePairingFailure(reason),
} as const;
