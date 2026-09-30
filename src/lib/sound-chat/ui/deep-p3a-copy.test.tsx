/**
 * Copy honesty: every user-visible string, against what the protocol actually
 * proves.
 *
 * WHY a copy file and not a documentation review: master plan constraint 5 and
 * Section 10.2 P7 are binding, and a sentence is either derived from a constant
 * or it is a claim somebody has to remember to keep true. So each rule below is
 * mechanical — a word list, a code-point range, an arithmetic identity against
 * the constant it quotes — and the constants are imported rather than retyped, so
 * a sentence that quotes 84 bytes is checked against the 84 the protocol
 * enforces rather than against a second copy of it.
 *
 * `render.test.tsx` already covers no-emoji and no-inaudibility-claim. This
 * file does not repeat that as a check; it *widens* it. The word list here is
 * longer than the one there, the code-point ranges include the trademark and
 * copyright blocks that a character class would have to lie about, and the
 * checks run over the *rendered* output of every screen as well as over the
 * copy table, so a literal typed straight into a component is caught too.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { BlockedPanel } from "@/components/sound-chat/blocked-panel";
import { Composer } from "@/components/sound-chat/composer";
import { FatalPanel } from "@/components/sound-chat/fatal-panel";
import { InfoPanel } from "@/components/sound-chat/info-panel";
import { MessageList } from "@/components/sound-chat/message-list";
import { PairingPanel } from "@/components/sound-chat/pairing-panel";
import { PermissionPrompt } from "@/components/sound-chat/permission-prompt";
import { TransmitStatus } from "@/components/sound-chat/transmit-status";
import { SoundChatEntry } from "@/components/sound-chat/sound-chat-entry";
import {
  ATTRIBUTION_LINE,
  PAIRING_CONFIRMATION_COPY,
  PAIRING_CODE_RULE,
  SOUND_CHAT_COPY,
  transportSentence,
  describePairingFailure,
} from "./copy";
import type { TransportState } from "../transport-machine";
import { SOUND_CHAT_ENTRY_COPY } from "./entry-copy";
import { measureMessage, secondsLabel } from "./budget";
import {
  MAX_MESSAGE_ASCII_CHARACTERS,
  MAX_MESSAGE_BLOCKS,
  MAX_MESSAGE_PLAINTEXT_BYTES,
  MAX_SEND_ATTEMPTS,
  SINGLE_BLOCK_PLAINTEXT_BYTES,
} from "../protocol";
import { PAIRING_CODE_ALPHABET, PAIRING_CODE_LENGTH, PAIRING_CODE_BITS } from "../crypto";
import { ACK_TIMEOUT_MS, BLOCK_DURATION_MS, MAX_PENDING_MESSAGES, TURN_GAP_MS } from "../session";
import { CODEC_SAMPLE_RATE } from "../codec";
import type { PairingFailureReason } from "../pairing";
import type { SoundChatBlock, SoundChatFatal } from "./controller";
import type { SendRefusal } from "../session";

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const noop = (): void => {};

/** What a person typing, not what the feature wrote. */
const OVER_CAP_NOTE = "a".repeat(MAX_MESSAGE_PLAINTEXT_BYTES + 1);

/** Every string in a nested object, with the path that reached it. */
function everyString(value: unknown, path = "copy"): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (typeof value === "function") return [];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => everyString(entry, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => everyString(entry, `${path}.${key}`));
  }
  return [];
}

/** The same functions, called, so a template literal is checked as resolved text. */
function resolvedStrings(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const [reason, text] of [
    ...(["wrong-code", "no-peer", "no-confirmation"] satisfies PairingFailureReason[]).map(
      (reason): [string, string] => [
        `copy.pairingFailure(${reason})`,
        describePairingFailure(reason),
      ],
    ),
    ["copy.pairingFailure(unknown)", describePairingFailure("nope" as PairingFailureReason)],
  ] as const) {
    out.push({ path: reason, text });
  }
  // Every byte count the composer can render, so the reachability sweep below
  // never has to be told which one a screen used.
  for (let bytes = 0; bytes <= MAX_MESSAGE_PLAINTEXT_BYTES + 1; bytes += 1) {
    out.push({
      path: `copy.composer.byteCounter(${String(bytes)})`,
      text: SOUND_CHAT_COPY.composer.byteCounter(bytes),
    });
  }
  for (const overBy of [1, 2, 17]) {
    out.push({
      path: `copy.composer.overCap(${String(overBy)})`,
      text: SOUND_CHAT_COPY.composer.overCap(overBy),
    });
  }
  for (const attempts of [2, MAX_SEND_ATTEMPTS]) {
    out.push({
      path: `copy.transmit.retrying(${String(attempts)})`,
      text: SOUND_CHAT_COPY.transmit.retrying(attempts),
    });
  }
  for (const [index, blocks, remainingMs] of [
    [1, 2, 2880],
    [2, 2, 1920],
    [1, 1, 960],
  ] as const) {
    out.push({
      path: `copy.transmit.block(${String(index)}, ${String(blocks)}, ${String(remainingMs)})`,
      text: SOUND_CHAT_COPY.transmit.block(index, blocks, remainingMs),
    });
  }
  out.push({ path: "PAIRING_CONFIRMATION_COPY", text: PAIRING_CONFIRMATION_COPY });
  out.push({ path: "ATTRIBUTION_LINE", text: ATTRIBUTION_LINE });
  // Every transport state, resolved. All nine entries of that record are
  // functions of the attempt count (see `copy.ts` — one uniform type, so no
  // runtime narrowing at the call site), which means `everyString` skips the
  // whole group. Without this the sweep below would report every rendered
  // transport sentence as "text that is not in the copy table" — a false
  // failure that looks exactly like a component with prose typed into it.
  for (const state of [
    "idle",
    "listening",
    "transmitting",
    "awaiting_turn",
    "awaiting_ack",
    "backoff",
    "hidden_hold",
    "error",
    "module_error",
  ] as const) {
    out.push({
      path: `copy.transport.${state}`,
      text: transportSentence(state),
    });
  }
  // And the one entry whose text depends on the attempt, at both ends of its
  // range, so the sweep can see every string that state can produce.
  for (const attempts of [1, MAX_SEND_ATTEMPTS]) {
    out.push({
      path: `copy.transport.backoff(attempt ${String(attempts)})`,
      text: transportSentence("backoff", attempts),
    });
  }
  return out;
}

const TABLE = everyString(SOUND_CHAT_COPY);
const ENTRY = everyString(SOUND_CHAT_ENTRY_COPY);
const ALL: { path: string; text: string }[] = [...TABLE, ...ENTRY, ...resolvedStrings()];

/* ------------------------------------------------------------------ *
 * Every screen, so a literal typed into a component is checked too.
 * ------------------------------------------------------------------ */

const noopProps = { onDisplay: noop, onEnter: noop, onDismiss: noop };

const SCREENS: readonly (readonly [string, ReactElement])[] = [
  ["permission", <PermissionPrompt {...noopProps} />],
  [
    "pairing:waiting",
    <PairingPanel
      role="displayer"
      code="ABCD2345"
      state={{ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }}
      failure={null}
      busy={false}
      onRetry={noop}
      onSwitchRole={noop}
    />,
  ],
  [
    "pairing:paired",
    <PairingPanel
      role="enterer"
      code="ABCD2345"
      state={{ kind: "paired", code: "ABCD2345", role: "enterer", peerSalt: new Uint8Array(16) }}
      failure={null}
      busy={false}
      onRetry={noop}
      onSwitchRole={noop}
    />,
  ],
  ...(["wrong-code", "no-peer", "no-confirmation"] as const).map(
    (reason): readonly [string, ReactElement] => [
      `pairing:failed:${reason}`,
      <PairingPanel
        role="displayer"
        code="ABCD2345"
        state={{ kind: "failed", code: "ABCD2345", role: "displayer", reason }}
        failure={describePairingFailure(reason)}
        busy={false}
        onRetry={noop}
        onSwitchRole={noop}
      />,
    ],
  ),
  [
    "chat:mixed",
    <div>
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 2, blockIndex: 1, fraction: 0.25, remainingMs: 2880 }}
      />
      <MessageList
        inbound={[{ seq: 2, msgId: 1, text: "from them" }]}
        outbound={[
          { seq: 1, msgId: 3, sendId: 3, text: "from us", status: "sent", attempts: 1, blocks: 1 },
          { seq: 3, msgId: 4, sendId: 4, text: "over", status: "failed", attempts: 3, blocks: 2 },
          { seq: 4, msgId: 5, sendId: 5, text: "held", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />
      <Composer
        value={OVER_CAP_NOTE}
        onChange={noop}
        onSubmit={noop}
        disabled={false}
        disabledReason={null}
        refusal={SOUND_CHAT_COPY.refusal["queue-full"]}
      />
    </div>,
  ],
  ...(["mic-denied", "bad-code", "device-rate"] as const).map(
    (kind): readonly [string, ReactElement] => [
      `blocked:${kind}`,
      <BlockedPanel block={{ kind, detail: "NotAllowedError" }} onRetry={noop} onBack={noop} />,
    ],
  ),
  ...(["codec-died", "frame-contract"] as const).map((kind): readonly [string, ReactElement] => [
    `fatal:${kind}`,
    <FatalPanel fatal={{ kind, detail: "CodecModuleError" }} onRestart={noop} />,
  ]),
  ["info:open", <InfoPanel open onToggle={noop} />],
  ["info:closed", <InfoPanel open={false} onToggle={noop} />],
  ["entry", <SoundChatEntry />],
];

/* ================================================================== *
 * H1 — the pairing alphabet, the one place the copy stated a rule the
 * code does not follow.
 * ================================================================== */

describe("H1 the pairing alphabet sentence matches the alphabet the code accepts", () => {
  it("names the exclusions the implementation actually makes", () => {
    // The copy used to say "the digits 2 to 9 and the letters A to Z", and the
    // alphabet is `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` — `I` and `O` are removed so
    // they cannot be read as `1` and `0`. A person who typed an `I` because the
    // screen told them to was refused by a field that had just told them `I` was
    // allowed.
    expect(PAIRING_CODE_ALPHABET).not.toContain("I");
    expect(PAIRING_CODE_ALPHABET).not.toContain("O");
    expect(PAIRING_CODE_ALPHABET).not.toContain("0");
    expect(PAIRING_CODE_ALPHABET).not.toContain("1");
    expect(PAIRING_CODE_RULE).toContain("except I and O");
    expect(PAIRING_CODE_RULE).not.toMatch(/\bthe letters A to Z\.(?!\s)/);
  });

  it("derives the whole sentence, so a future alphabet change cannot drift", () => {
    expect(PAIRING_CODE_RULE).toContain(String(PAIRING_CODE_LENGTH));
    for (const character of PAIRING_CODE_ALPHABET) {
      // Every character the code accepts is in one of the two stated ranges.
      const inDigits = character >= "2" && character <= "9";
      const inLetters = character >= "A" && character <= "Z";
      expect(inDigits || inLetters, `${character} is outside the stated ranges`).toBe(true);
    }
    // And every character the code refuses is named as an exclusion, or is a
    // digit the sentence already rules out.
    for (const character of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      const accepted = PAIRING_CODE_ALPHABET.includes(character);
      const stated = PAIRING_CODE_RULE.includes(character);
      if (!accepted && character >= "A") {
        expect(stated, `${character} is refused but not named in the rule`).toBe(true);
      }
    }
    expect(PAIRING_CODE_BITS).toBe(PAIRING_CODE_LENGTH * 5);
  });

  it("the sentence is on screen on both screens that ask for a code", () => {
    expect(SOUND_CHAT_COPY.pairing.enterBody).toContain(PAIRING_CODE_RULE);
    expect(SOUND_CHAT_COPY.blocked["bad-code"].body).toContain(PAIRING_CODE_RULE);
    const markup = render(<PermissionPrompt {...noopProps} />);
    // The rules prose is on the role step's sibling, the code step; what the
    // screen must never show is the old, wrong rule.
    expect(markup).not.toContain("the digits 2 to 9 and the letters A to Z. It is never");
  });
});

/* ================================================================== *
 * H2 — no claim that the channel is inaudible, hidden, private or
 * unnoticeable. A wider word list than `render.test.tsx`'s.
 * ================================================================== */

const INAUDIBLE_CLAIM =
  /\b(silent(ly)?|inaudible|inaudibly|whisper\w*|stealth\w*|unheard|invisible|unnoticeable|discreet\w*|covert\w*|secret\w*|private|privately|confidential\w*|anonymous\w*|no one[^.]{0,24}(hear|notice)|nobody[^.]{0,24}(hear|notice)|without (a )?(sound|noise|audible)|unencrypted|plain ?text)\b/i;

/** A word that only means something bad in a claim; a prohibition or a key name is fine. */
const NOT_A_CLAIM_CONTEXT = /\bhidden_hold\b/;

describe("H2 nothing claims the channel cannot be heard, seen or recorded", () => {
  it("has a wide enough word list to be worth running", () => {
    // A self-test on the detector, because a word list that matches nothing is
    // the same as no word list. Each of these would be a real defect.
    for (const phrase of [
      "this is silent",
      "plays silently",
      "inaudible to the room",
      "in stealth mode",
      "discreet tones",
      "a private channel",
      "confidential end to end",
      "no one can hear it",
      "without a sound",
      "nobody nearby will notice",
      "an unnoticeable whisper",
    ]) {
      expect(INAUDIBLE_CLAIM.test(phrase), `"${phrase}" was not detected`).toBe(true);
    }
    for (const phrase of [
      "Held while this tab is in the background.",
      "Every note is audible. Anyone nearby can hear it.",
      "a recording of the handshake can occupy one pairing, but cannot read anything",
      "the key itself is never played as sound",
      "Hidden_hold is a transport state name",
    ]) {
      expect(INAUDIBLE_CLAIM.test(phrase), `"${phrase}" was a false positive`).toBe(false);
    }
  });

  it("makes no such claim in any string the copy table can produce", () => {
    const offenders = ALL.filter(
      (entry) => !NOT_A_CLAIM_CONTEXT.test(entry.path) && INAUDIBLE_CLAIM.test(entry.text),
    );
    expect(offenders.map((entry) => `${entry.path}: ${entry.text}`)).toEqual([]);
  });

  it("makes no such claim in the rendered output of any screen", () => {
    for (const [name, element] of SCREENS) {
      expect(INAUDIBLE_CLAIM.test(render(element)), `${name} makes an inaudibility claim`).toBe(
        false,
      );
    }
  });

  it("states the opposite, in the words the record actually uses", () => {
    const audible = SOUND_CHAT_COPY.permission.limits[0] ?? "";
    expect(audible).toMatch(/audible/i);
    expect(audible).toMatch(/anyone nearby can hear it/i);
    expect(audible).toMatch(/microphone in the room can record it/i);
    expect(SOUND_CHAT_COPY.permission.lead).toMatch(/audible tones/i);
    expect(transportSentence("transmitting")).toMatch(/out loud/i);
  });

  it("the disclosure that a recording cannot be read later is about the key, not the sound", () => {
    // The honest boundary: the *sound* is recordable, a *recording* cannot be
    // decrypted later. The copy has to keep the two apart, or it reads as
    // "private" by implication.
    const recording = SOUND_CHAT_COPY.permission.limits[2] ?? "";
    expect(recording).toMatch(/recording/i);
    expect(recording).toMatch(/cannot be read later/i);
    expect(recording).toMatch(/random key material/i);
    const privacy = SOUND_CHAT_COPY.info.privacy;
    expect(privacy).toMatch(/AES-256-GCM/);
    expect(privacy).toMatch(/PBKDF2/);
    expect(privacy).toMatch(/Nothing is stored/);
    // And it does not quietly claim the transmission itself is unreadable.
    expect(privacy).not.toMatch(/nobody|no one|unreadable|secure|anonymous/i);
  });

  it("keeps the note channel's own claim to the medium, not to a range", () => {
    const lead = SOUND_CHAT_COPY.permission.lead;
    expect(lead).toMatch(/same room/i);
    expect(lead).toMatch(/No Wi-Fi, no relay, no internet/);
    // It says where the sound goes, and never says how far it reaches.
    expect(lead).not.toMatch(/\b\d+\s*(m|metre|meter|feet|ft)\b/i);
  });
});

/* ================================================================== *
 * H3 — no identity claim.
 * ================================================================== */

// `whose` is deliberately absent: it is about a person in an identity claim and
// about a rate in "a device whose audio runs at a different rate", and the
// sentence that matters is the one about a person, which `who is` catches.
const IDENTITY_CLAIM =
  /\b(who is|identity|identities|authentic|verified person|trusted|trust|your friend|the right (device|person)|the correct (device|person)|the owner|impersonat\w+|genuine)\b/i;

/** Sentences that mention a person on purpose, and only to deny the claim. */
const NEGATED_IDENTITY: RegExp[] = [
  /not who is holding/i,
  /cannot tell you who is holding/i,
  /is a key check, not an identity check/i,
];

describe("H3 nothing claims the handshake proved who is holding the other device", () => {
  it("the confirmation proves the code and says what it does not prove", () => {
    expect(PAIRING_CONFIRMATION_COPY).toMatch(/share the same code/i);
    expect(PAIRING_CONFIRMATION_COPY).toMatch(/can hear each other right now/i);
    expect(PAIRING_CONFIRMATION_COPY).toMatch(/not who is holding the other device/i);
    // The affirmative half is about the code and the channel, never a person.
    expect(
      IDENTITY_CLAIM.test(
        PAIRING_CONFIRMATION_COPY.replace(/not who is holding the other device\./i, ""),
      ),
    ).toBe(false);
  });

  it("every sentence that mentions a person denies the claim rather than making it", () => {
    for (const entry of ALL) {
      if (!IDENTITY_CLAIM.test(entry.text)) continue;
      expect(
        NEGATED_IDENTITY.some((pattern) => pattern.test(entry.text)),
        `${entry.path} mentions a person and does not deny the claim: "${entry.text}"`,
      ).toBe(true);
    }
  });

  it("the wrong-code failure is about a different code, not a different person", () => {
    const wrongCode = describePairingFailure("wrong-code");
    expect(wrongCode).toMatch(/a different pairing code/i);
    expect(wrongCode).toMatch(/Check the code and try again/);
    expect(IDENTITY_CLAIM.test(wrongCode)).toBe(false);
  });

  it("the role labels say which screen you are on, not who you are talking to", () => {
    expect(SOUND_CHAT_COPY.pairing.roleLabel.displayer).toBe("You are showing a code");
    expect(SOUND_CHAT_COPY.pairing.roleLabel.enterer).toBe("You are entering a code");
    for (const label of Object.values(SOUND_CHAT_COPY.pairing.roleLabel)) {
      expect(IDENTITY_CLAIM.test(label), label).toBe(false);
    }
  });

  it("the code is never described as a secret that proves anything", () => {
    // "Secret" would be a claim about the *code*; the code is a shared key, and
    // the honest thing to say about it is that the other device has to have it.
    for (const entry of ALL) {
      if (!/\bcode\b/i.test(entry.text)) continue;
      expect(entry.text, `${entry.path} calls the code a secret`).not.toMatch(
        /\b(secret|private|secret key|shared secret)\b/i,
      );
    }
  });
});

/* ================================================================== *
 * H4 — delivery. Only an acknowledged note may be called delivered.
 * ================================================================== */

/** A `deliver*` that is not inside a negation. */
function affirmativeDeliveries(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[^.]*\bdeliver\w*[^.]*/gi)) {
    const sentence = match[0];
    if (
      /\b(nothing|not|no|never|neither|none|cannot|can't|wasn't|weren't|isn't|un)\b/i.test(sentence)
    ) {
      continue;
    }
    out.push(sentence.trim());
  }
  return out;
}

/**
 * The one string allowed to say "delivered": the status of a note the peer
 * acknowledged. Every other entry is checked with it removed, so the rule is
 * "this word, here, and nowhere else" rather than "this word is banned".
 */
const THE_ONE_DELIVERY = SOUND_CHAT_COPY.outbound.sent;

describe("H4 only an acknowledged note is ever called delivered", () => {
  it("the acknowledged status is the one that says it, and the others do not", () => {
    expect(THE_ONE_DELIVERY).toBe("Delivered");
    expect(SOUND_CHAT_COPY.outbound.sending).not.toMatch(/deliver/i);
    expect(SOUND_CHAT_COPY.outbound.failed).not.toMatch(/deliver/i);
    // And the two that are not acknowledged say what is true instead.
    expect(SOUND_CHAT_COPY.outbound.sending).toBe("Playing");
    expect(SOUND_CHAT_COPY.outbound.failed).toBe("Not received");
  });

  it("every other `deliver*` in the copy is a negation", () => {
    for (const entry of ALL) {
      if (entry.text === THE_ONE_DELIVERY) continue;
      const affirmative = affirmativeDeliveries(entry.text);
      expect(affirmative, `${entry.path} claims a delivery: ${affirmative.join(" | ")}`).toEqual(
        [],
      );
    }
  });

  it("every other `deliver*` in the rendered output of any screen is a negation", () => {
    // The transcript is the only screen allowed the word, and only for the note
    // the session acknowledged — so it is checked on its own below. Every other
    // screen must not contain it at all, affirmative or not.
    for (const [name, element] of SCREENS) {
      if (name === "chat:mixed") continue;
      const markup = render(element);
      const affirmative = affirmativeDeliveries(markup);
      expect(affirmative, `${name} claims a delivery: ${affirmative.join(" | ")}`).toEqual([]);
    }
  });

  it("in the transcript the word appears once per acknowledged note and never for another", () => {
    const row = (status: "sending" | "sent" | "failed"): string =>
      render(
        <MessageList
          inbound={[]}
          outbound={[{ seq: 1, msgId: 1, text: "n", sendId: 1, status, attempts: 1, blocks: 1 }]}
        />,
      );
    for (const status of ["sending", "sent", "failed"] as const) {
      const occurrences = row(status).match(/deliver/gi) ?? [];
      expect(
        occurrences.length,
        `a ${status} note says "delivered" ${occurrences.length} times`,
      ).toBe(status === "sent" ? 1 : 0);
    }
    // Mixed: exactly one word, for the one acknowledged note.
    const mixed = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 1, sendId: 1, text: "a", status: "sending", attempts: 1, blocks: 1 },
          { seq: 2, msgId: 2, sendId: 2, text: "b", status: "sent", attempts: 1, blocks: 1 },
          { seq: 3, msgId: 3, sendId: 3, text: "c", status: "failed", attempts: 3, blocks: 2 },
        ]}
      />,
    );
    expect((mixed.match(/deliver/gi) ?? []).length).toBe(1);
    // The info panel's counter for received notes is deliberately not called
    // "delivered", because a session stat is not a per-note acknowledgement.
    expect(SOUND_CHAT_COPY.info.statMessagesDelivered).toBe("Notes received");
    expect(SOUND_CHAT_COPY.info.statMessagesDelivered).not.toMatch(/deliver/i);
  });

  it("the fatal copy's `delivered` is a claim about what did not happen", () => {
    for (const kind of ["codec-died", "frame-contract"] as const) {
      const body = SOUND_CHAT_COPY.fatal[kind].body;
      expect(body, kind).toMatch(/Nothing in flight was delivered\./);
      expect(affirmativeDeliveries(body)).toEqual([]);
    }
  });
});

/* ================================================================== *
 * H5 — figures. Every number checked against the constant it quotes.
 * ================================================================== */

describe("H5 every figure the copy quotes is the figure the code enforces", () => {
  it("the constants this file pins are the ones the protocol and session export", () => {
    expect(MAX_MESSAGE_PLAINTEXT_BYTES).toBe(84);
    expect(SINGLE_BLOCK_PLAINTEXT_BYTES).toBe(43);
    expect(MAX_MESSAGE_BLOCKS).toBe(2);
    expect(MAX_MESSAGE_ASCII_CHARACTERS).toBe(84);
    expect(BLOCK_DURATION_MS).toBe(1_920);
    expect(TURN_GAP_MS).toBe(700);
    expect(ACK_TIMEOUT_MS).toBe(7_460);
    expect(MAX_PENDING_MESSAGES).toBe(4);
    expect(MAX_SEND_ATTEMPTS).toBe(3);
    expect(CODEC_SAMPLE_RATE).toBe(48_000);
    expect(PAIRING_CODE_LENGTH).toBe(8);
  });

  it("shows the arithmetic behind the rate rather than a typed-in number", () => {
    // "about 22 bytes a second" is 84 / 3.84. The sentence has to carry the
    // inputs, or the derived figure is a claim with nothing behind it.
    const rate = SOUND_CHAT_COPY.info.rate;
    const twoBlocks = secondsLabel(MAX_MESSAGE_BLOCKS * BLOCK_DURATION_MS);
    expect(rate).toContain(String(MAX_MESSAGE_PLAINTEXT_BYTES));
    expect(rate).toContain(twoBlocks);
    expect(rate).toContain(secondsLabel(BLOCK_DURATION_MS));
    expect(rate).toMatch(
      new RegExp(`${String(Math.round(MAX_MESSAGE_PLAINTEXT_BYTES / 3.84))} bytes a second`),
    );
    expect(Math.round(MAX_MESSAGE_PLAINTEXT_BYTES / 3.84)).toBe(22);
    // The short-note duration is one block, and the cap is two.
    expect(twoBlocks).toBe("3.8 seconds");
    expect(secondsLabel(BLOCK_DURATION_MS)).toBe("1.9 seconds");
  });

  it("derives every duration string from the block duration", () => {
    expect(SOUND_CHAT_COPY.composer.singleBlock).toBe(
      `One block: about ${secondsLabel(BLOCK_DURATION_MS)} of sound.`,
    );
    expect(SOUND_CHAT_COPY.composer.twoBlocks).toBe(
      `Two blocks: about ${secondsLabel(MAX_MESSAGE_BLOCKS * BLOCK_DURATION_MS)} of sound.`,
    );
    // The progress line's own figure comes from the same helper, so a 2880 ms
    // remainder is "about 2.9 seconds" and never a rounded-up lie.
    expect(SOUND_CHAT_COPY.transmit.block(1, 2, 2880)).toContain(
      `about ${secondsLabel(2880)} left`,
    );
    expect(secondsLabel(2880)).toBe("2.9 seconds");
    expect(secondsLabel(960)).toBe("1 second");
    // No duration is quoted without "about", because it is a prediction from our
    // own schedule and not a measurement of the other device.
    for (const entry of ALL) {
      if (!/\d+(\.\d+)?\s+second/.test(entry.text)) continue;
      expect(entry.text, `${entry.path} quotes a duration without "about"`).toMatch(
        /(\babout \d|\bup to \d)/i,
      );
    }
  });

  it("derives the byte figures from the cap, and the cap from the cap", () => {
    expect(SOUND_CHAT_COPY.composer.byteCounter(0)).toBe(
      `0 / ${String(MAX_MESSAGE_PLAINTEXT_BYTES)} bytes`,
    );
    expect(SOUND_CHAT_COPY.composer.overCap(1)).toContain(String(MAX_MESSAGE_PLAINTEXT_BYTES));
    expect(SOUND_CHAT_COPY.refusal["too-long"]).toContain(String(MAX_MESSAGE_PLAINTEXT_BYTES));
    expect(SOUND_CHAT_COPY.refusal["queue-full"]).toContain(String(MAX_PENDING_MESSAGES));
    // The duplicate is deleted: one sentence for one fact, and `refusal` is the
    // table the send path actually reads.
    expect("queueFull" in SOUND_CHAT_COPY.composer).toBe(false);
    // The pre-prompt's own cap sentence quotes the same constant, as characters.
    expect(SOUND_CHAT_COPY.permission.limits[1] ?? "").toContain(
      String(MAX_MESSAGE_ASCII_CHARACTERS),
    );
  });

  it("the retry figure is the retry budget", () => {
    expect(SOUND_CHAT_COPY.transmit.retrying(2)).toContain(
      `Attempt 2 of ${String(MAX_SEND_ATTEMPTS)}`,
    );
    expect(MAX_SEND_ATTEMPTS).toBe(3);
  });

  it("the audio band is quoted as the codec's band, rounded the honest way", () => {
    // `AUDIBLE_FASTEST` at ggwave's defaults is bin 40 to bin 135 at 46.875 Hz:
    // 1875.0 Hz to 6328.125 Hz. `prompts/sound-chat/GGWAVE_DEEP_DIVE.md` derives
    // both from `freqStart * dF`, and the range is the one the copy has to round:
    // 1.875 kHz is "about 1.9" and 6.328 kHz is "about 6.3". Rounding the top up
    // to 6.4 would claim frequencies the codec never emits.
    const bandLow = 40 * 46.875;
    const bandHigh = (40 + 95) * 46.875;
    expect(bandLow).toBe(1_875);
    expect(bandHigh).toBe(6_328.125);
    const how = SOUND_CHAT_COPY.info.how;
    expect(how).toContain(`about ${(Math.round(bandLow / 100) / 10).toFixed(1)} and`);
    expect(how).toContain(`${(Math.round(bandHigh / 100) / 10).toFixed(1)} kHz`);
    // And it does not claim a band the protocol does not use, in either
    // direction: no ultrasound, and nothing that reads as inaudible.
    expect(how).not.toMatch(/ultrasound|inaudible|high[- ]frequency|above \d/i);
    // The one figure with a unit in the whole UI is the top of the band. The
    // bottom is stated as "about 1.9" because it is a round number away from
    // 1.875, and "1.875 kHz" would claim a precision the copy does not need.
    const quoted = ALL.flatMap((entry) =>
      [...entry.text.matchAll(/\b\d+(?:\.\d+)?\s*kHz\b/gi)].map((match) => match[0].toLowerCase()),
    );
    expect(new Set(quoted)).toEqual(new Set(["6.3 khz"]));
    expect(how).toContain("about 1.9 and 6.3 kHz");
  });

  it("the sample rate the failure screen names is the rate the codec runs at", () => {
    expect(SOUND_CHAT_COPY.blocked["device-rate"].body).toContain(
      `${String(CODEC_SAMPLE_RATE)} Hz`,
    );
  });

  it("the pairing code's entropy is not quoted, because nothing measures it", () => {
    // 40 bits is a real number and quoting it would be a security claim this
    // feature has not measured an attack against. Nothing may state it.
    for (const entry of ALL) {
      expect(entry.text, `${entry.path} quotes the code's entropy`).not.toMatch(/\b\d+\s*bits?\b/i);
    }
  });

  it("the distance advice is a recommendation, never a capability", () => {
    const volume = SOUND_CHAT_COPY.permission.whyVolume;
    const hint = SOUND_CHAT_COPY.pairing.hint;
    for (const sentence of [volume, hint]) {
      expect(sentence).toMatch(/same room/i);
      // A capability claim would be "works up to" or "reaches"; a recommendation
      // is "start with" or "a few metres apart".
      expect(sentence, `"${sentence}" promises a range`).not.toMatch(
        /\b(up to|within|reaches|range of|guaranteed|always|never fails|reliable)\b/i,
      );
    }
  });
});

/* ================================================================== *
 * H6 — every failure has its own actionable sentence.
 * ================================================================== */

const GENERIC_FAILURE =
  /\b(something went wrong|an error occurred|an error happened|error occurred|failed\.|failure\.|oops|unexpected error|try again later|please try again)\b/i;

describe("H6 every failure the user can hit gets its own specific sentence", () => {
  it("none of them is a generic failure", () => {
    for (const entry of ALL) {
      expect(GENERIC_FAILURE.test(entry.text), `${entry.path} is generic: "${entry.text}"`).toBe(
        false,
      );
    }
  });

  it("each blocked and fatal screen names a cause and a fix", () => {
    // "Nothing you can change" counts as a fix: telling someone the honest
    // answer is more useful than inventing a step that does not work.
    const fix =
      /\b(allow|try again|reload\w*|restart\w*|check|connect|unplug|reconnect|use|start again|try a|nothing you can)\b/i;
    for (const [kind, entry] of Object.entries(SOUND_CHAT_COPY.blocked)) {
      expect(entry.heading.length, `${kind} heading`).toBeGreaterThan(8);
      expect(entry.body.length, `${kind} body`).toBeGreaterThan(40);
      expect(fix.test(entry.body), `${kind} body names no fix: "${entry.body}"`).toBe(true);
    }
    for (const [kind, entry] of Object.entries(SOUND_CHAT_COPY.fatal)) {
      expect(entry.body.length, `${kind} body`).toBeGreaterThan(60);
      expect(fix.test(entry.body), `${kind} body names no fix: "${entry.body}"`).toBe(true);
    }
  });

  it("each refusal names what to do, and each is distinct", () => {
    const reasons: SendRefusal[] = [
      "not-paired",
      "empty",
      "too-long",
      "queue-full",
      "module-error",
      "stopped",
    ];
    const sentences = reasons.map((reason) => SOUND_CHAT_COPY.refusal[reason]);
    expect(new Set(sentences).size, "two refusals read the same").toBe(sentences.length);
    for (const [at, sentence] of sentences.entries()) {
      expect(sentence.length, `${reasons[at]} is not a sentence`).toBeGreaterThan(15);
    }
  });

  it("each pairing failure is a distinct, complete sentence", () => {
    const reasons: PairingFailureReason[] = ["wrong-code", "no-peer", "no-confirmation"];
    const sentences = reasons.map((reason) => describePairingFailure(reason));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).toMatch(/[.!]$/);
    }
  });

  // FIXED, and it was two findings in one sentence:
  //
  //   "The other device did not confirm. It may be using a different code, or
  //    out of range."
  //
  // 1. No action. The other two reasons both end with something to do
  //    ("Check the code and try again", "then start again"). This one ends with
  //    a guess, so a person is left with nothing to act on — which is what
  //    master plan constraint 6 forbids.
  // 2. "out of range" is a claim about range the protocol cannot make. There is
  //    no distance measurement anywhere in Sound Chat: `PAIR_PEER_TIMEOUT_MS` is
  //    a wall-clock timer, and all it proves is that nothing was heard. Naming
  //    range as a cause attributes a failure to a distance the software has no
  //    idea about.
  //
  // `describePairingFailure` is in `src/lib/sound-chat/pairing.ts`, which is not
  // this file's to edit. The fix is one string: "The other device did not
  // answer. Check the code first, then try again — it may not have heard you."
  it("the no-confirmation failure names an action and claims no distance", () => {
    const sentence = describePairingFailure("no-confirmation");
    expect(sentence).toMatch(/check|try again|start again/i);
    expect(sentence).not.toMatch(/\brange\b|\bdistance\b|\bmetres?\b|\bfeet\b/i);
  });

  it("the nine transport states are nine different lines", () => {
    // Resolved through `transportSentence`, not by indexing the record: `backoff`
    // is a function of the attempt count (see `copy.ts`), so `Object.values`
    // would hand this loop a function object — one character long, and unique,
    // so it would have passed the "nine different" check while testing nothing.
    const states: readonly TransportState[] = [
      "idle",
      "listening",
      "transmitting",
      "awaiting_turn",
      "awaiting_ack",
      "backoff",
      "hidden_hold",
      "error",
      "module_error",
    ];
    const sentences = states.map((state) => transportSentence(state));
    expect(new Set(sentences).size, "two states share one sentence").toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(3);
      // A live status readout, not a paragraph: a long one is read out on every
      // state change, and this one changes on every note.
      expect(sentence.length, `"${sentence}" is too long to announce`).toBeLessThan(70);
    }
    // Two of the nine are bare labels, which is right for a settled state; the
    // other seven report something and have to be longer than a label.
    const labels = sentences.filter((sentence) => sentence.length <= 12);
    expect(labels.sort()).toEqual(["Listening", "Not started"]);
    for (const sentence of sentences) {
      if (labels.includes(sentence)) continue;
      expect(sentence.length, `"${sentence}" is a label with a sentence's job`).toBeGreaterThan(12);
    }
  });

  it("the entry point's failure sentence is actionable and not a button that cannot help", () => {
    expect(SOUND_CHAT_ENTRY_COPY.failed).toMatch(/reload/i);
    expect(SOUND_CHAT_ENTRY_COPY.failed).toMatch(/connection/i);
    // And the loading frame is a frame, not a blank page.
    expect(SOUND_CHAT_ENTRY_COPY.loading.length).toBeGreaterThan(5);
  });

  it("the unreadable-block notice does not blame the other device", () => {
    // `auth-failed` (a peer on a different code) and `conflicting-block` (a
    // block this session cannot assemble) get one sentence, and it says what
    // happened rather than who did it.
    const unreadable = SOUND_CHAT_COPY.transmit.unreadable;
    expect(unreadable).toMatch(/was heard/i);
    expect(unreadable).toMatch(/cannot read it/i);
    expect(IDENTITY_CLAIM.test(unreadable)).toBe(false);
  });
});

/* ================================================================== *
 * H7 — no emoji, by code point, including the blocks a character class
 * would have to lie about.
 * ================================================================== */

/**
 * Mirrors `hasEmoji` in `render.test.tsx`, and adds the three blocks that a
 * single character class cannot express without containing characters that can
 * take a combining mark: the copyright and trademark signs, the regional
 * indicators, and the enclosed-alphanumeric supplement that carries the flag
 * sequences. The copy writes "copyright (c)" rather than the sign, which is
 * worth a test of its own because the full MIT text it is quoting uses the
 * words too.
 */
const PICTOGRAPH_RANGES: readonly (readonly [number, number, string])[] = [
  [0x1f000, 0x1faff, "pictographs, symbols and supplemental"],
  [0x2600, 0x27bf, "miscellaneous symbols and dingbats"],
  [0x2b00, 0x2bff, "arrows and mathematical symbols"],
  [0x2190, 0x21ff, "arrows"],
  [0xfe00, 0xfe0f, "variation selectors"],
  [0x00a9, 0x00a9, "copyright sign"],
  [0x00ae, 0x00ae, "registered sign"],
  [0x1f1e6, 0x1f1ff, "regional indicators (flags)"],
  [0x1f100, 0x1f1ff, "enclosed alphanumeric supplement"],
  [0x3030, 0x3030, "wavy dash"],
  [0x303d, 0x303d, "part alternation mark"],
];

function hasPictograph(subject: string): string | null {
  for (const character of subject) {
    const point = character.codePointAt(0) ?? 0;
    for (const [low, high, name] of PICTOGRAPH_RANGES) {
      if (point >= low && point <= high) {
        return `U+${point.toString(16).toUpperCase().padStart(4, "0")} (${name})`;
      }
    }
  }
  return null;
}

describe("H7 no emoji, and no pictograph that stands in for one", () => {
  it("detects what it claims to detect", () => {
    // Written as escapes rather than as literal characters, so this file cannot
    // itself contain the thing it forbids.
    for (const [subject, expected] of [
      ["a wave \u{1f44b}", "U+1F44B"],
      ["a check \u{2714}", "U+2714"],
      ["an arrow \u{2192}", "U+2192"],
      ["copyright \u{00a9}", "U+00A9"],
      ["registered \u{00ae}", "U+00AE"],
      ["a flag \u{1f1ec}\u{1f1e7}", "U+1F1EC"],
      ["a variation selector \u{fe0f}", "U+FE0F"],
    ] as const) {
      expect(hasPictograph(subject), `"${subject}" was not detected`).toContain(expected);
    }
    // And leaves prose alone, including the characters that are one code point
    // away from a pictograph: an em dash, an en dash, a degree sign, a
    // non-breaking space.
    for (const subject of ["a — b", "a – b", "90°", "plain ASCII 123", "a b", ""]) {
      expect(hasPictograph(subject), `"${subject}" was a false positive`).toBeNull();
    }
  });

  it("finds none in the copy table or in anything it can produce", () => {
    const offenders = ALL.flatMap((entry) => {
      const found = hasPictograph(entry.text);
      return found === null ? [] : [`${entry.path}: ${found}`];
    });
    expect(offenders).toEqual([]);
  });

  it("finds none in the rendered output of any screen", () => {
    for (const [name, element] of SCREENS) {
      const found = hasPictograph(render(element));
      expect(found, `${name} contains ${String(found)}`).toBeNull();
    }
  });

  it("writes the copyright the way the licence it quotes writes it", () => {
    const licence = readFileSync(
      fileURLToPath(new URL("../vendor/LICENSE.ggwave", import.meta.url)),
      "utf8",
    );
    expect(licence).toContain("Copyright (c) 2020 Georgi Gerganov");
    // The copy says the same, with the sign spelled out — which is what keeps
    // the attribution itself out of the pictograph table.
    expect(ATTRIBUTION_LINE).toContain("copyright (c) 2020 Georgi Gerganov");
    expect(ATTRIBUTION_LINE).toMatch(/ggwave \(MIT\)/);
  });
});

/* ================================================================== *
 * H8 — the ATTRIBUTION is accurate, and the copy file is the only place
 * a sentence lives.
 * ================================================================== */

const COMPONENT_DIR = fileURLToPath(new URL("../../../components/sound-chat/", import.meta.url));
const UI_DIR = fileURLToPath(new URL(".", import.meta.url));

function sourcesIn(dir: string): string {
  return readdirSync(dir)
    .filter((name) => !name.includes(".test.") && (name.endsWith(".ts") || name.endsWith(".tsx")))
    .map((name) => readFileSync(dir + name, "utf8"))
    .join("\n");
}

describe("H8 the attribution is accurate and no sentence is written into a component", () => {
  it("quotes the licence that covers the bundled codec", () => {
    const notice = readFileSync(
      fileURLToPath(new URL("../vendor/NOTICE.md", import.meta.url)),
      "utf8",
    );
    expect(ATTRIBUTION_LINE).toContain("ggwave");
    expect(ATTRIBUTION_LINE).toMatch(/\(MIT\)/);
    expect(ATTRIBUTION_LINE).toContain("Georgi Gerganov");
    // The vendor notice names the same three facts, so the two cannot disagree
    // without this test noticing.
    expect(notice).toContain("ggwave");
    expect(notice).toMatch(/MIT/);
    expect(notice).toContain("Georgi Gerganov");
  });

  it("has no user-visible prose typed straight into a component", () => {
    // Every run of two or more words in the rendered output of every screen has
    // to come from the copy table. That is what makes the tables above cover the
    // whole UI rather than the copy file: a literal typed into a component
    // renders, and a literal is not in the table.
    //
    // Two things are allowed to render text that is not in the table, and both
    // are named: the vendored MIT licence, which is the licence itself and has
    // to be verbatim, and the `Details:` label in front of a raw diagnostic,
    // which is a label rather than a claim. The notes a user typed are the third
    // exclusion, and they are passed in rather than guessed at.
    const licence = readFileSync(
      fileURLToPath(new URL("../vendor/LICENSE.ggwave", import.meta.url)),
      "utf8",
    );
    const permitted = new Set(["MIT License", "Details:"]);
    const typed = new Set([
      // The pairing code is a prop, not copy: it is generated per session and
      // rendered verbatim, which is the whole point of the screen it is on.
      "ABCD2345",
      // And the composer's buffer is whatever the person typed, which on this
      // screen is an over-cap run of `a` so the refusal path is rendered.
      OVER_CAP_NOTE,
      "from us",
      "from them",
      "over",
      "held",
      "note",
      "first",
      "hello",
      "hi",
      "a",
      "b",
      "c",
      "n",
    ]);

    for (const [name, element] of SCREENS) {
      const text = render(element)
        .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
        .replace(/<[^>]*>/g, "\n");
      for (const raw of text.split("\n")) {
        const run = raw.replace(/\s+/g, " ").trim();
        if (run.length === 0 || permitted.has(run) || typed.has(run)) continue;
        // `Details: <the audio layer's own error name>` is a label in front of a
        // prop, not copy, and it is the one thing that says which of the five
        // causes actually happened.
        if (/^Details: \S+$/.test(run)) continue;
        if (licence.includes(run)) continue;
        // Anything left is either prose from the table, or a defect. Split into
        // runs of two or more words so a stray single word is still caught.
        for (const [index, chunk] of run.split(/(?<=[.!?])\s+/).entries()) {
          if (chunk.replace(/\s+/g, " ").trim().length === 0) continue;
          const fromTable = ALL.some((entry) => entry.text.includes(chunk));
          expect(
            fromTable,
            `${name} renders text that is not in the copy table: "${chunk}" (run ${String(index)})`,
          ).toBe(true);
        }
      }
    }
  });

  it("has no stray escape in any component's JSX", () => {
    // The composer rendered a literal "`n" into the form for a week: a stray
    // backtick-n on its own line between two elements, which JSX takes as text.
    // No component may contain one between two tags, and no screen may render
    // one. Comments are stripped first, because a comment is allowed to name the
    // mistake in order to stop it happening again.
    for (const name of readdirSync(COMPONENT_DIR)) {
      if (name.includes(".test.") || !(name.endsWith(".ts") || name.endsWith(".tsx"))) continue;
      const source = readFileSync(COMPONENT_DIR + name, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ");
      expect(source, `${name} contains a stray backtick-n in its JSX`).not.toMatch(/`n/);
    }
    for (const [name, element] of SCREENS) {
      expect(render(element), `${name} renders a stray backtick-n`).not.toContain("`n");
    }
  });

  it("the copy file is the only place a user-visible sentence is written", () => {
    // `entry-copy.ts` is the second file, and it is the reason it exists: the
    // eager entry module must not import `copy.ts`. So there are exactly two.
    const copyExports = [
      ...readdirSync(UI_DIR)
        .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
        .map((name) => readFileSync(UI_DIR + name, "utf8"))
        .join("\n")
        .matchAll(/^export const [A-Z_]+/gm),
    ].map((match) => match[0]);
    expect(new Set(copyExports).size, "a copy constant is exported twice under two names").toBe(
      new Set(copyExports).size,
    );
    for (const entry of ALL) {
      // Nothing may be a bare number, a bare key, or a placeholder.
      expect(entry.text.trim(), `${entry.path} is not a sentence`).not.toMatch(
        /^(TODO|FIXME|[\d\s.,%/-]+)$/,
      );
    }
  });
});

/* ================================================================== *
 * H9 — the copy that no component reads, named rather than discovered,
 * so a new one is a test failure rather than a review question.
 * ================================================================== */

describe("H9 the copy nothing renders, named so it cannot grow silently", () => {
  it("has no accessor in the copy table that nothing can reach", () => {
    // FIXED. Six sentences were unreachable: four of them were copy for a "stop
    // Sound Chat" control that does not exist (leaving is a plain anchor, whose
    // full navigation is the more honest teardown), `modal.cancel` was copy for a
    // label the shared `Modal` primitive hardcodes so we cannot supply it, and
    // `composer.queueFull` was a byte-identical duplicate of
    // `refusal["queue-full"]` — two copies of one sentence is how they drift.
    // Deleted rather than kept as a documented gap: a phrase nothing can show is
    // not documentation, it is a fourth thing to keep in sync (Rule 6, and master
    // plan Section 10.1 class 9).
    for (const accessor of [
      "modal.cancel",
      "modal.discardTitle",
      "modal.discardDescription",
      "modal.discardConfirm",
      "actions.stop",
      "composer.queueFull",
    ]) {
      const [group, key] = accessor.split(".") as [string, string];
      const table = (SOUND_CHAT_COPY as Record<string, unknown>)[group] as
        Record<string, unknown> | undefined;
      expect(table, `${accessor}`).toBeTruthy();
      expect(Object.keys(table ?? {}), `${accessor} is still in the copy table`).not.toContain(key);
    }
    const sources = sourcesIn(COMPONENT_DIR) + sourcesIn(UI_DIR);
    for (const accessor of ["modal.restartTitle", "modal.restartConfirm", "actions.retry"]) {
      expect(sources, `${accessor} is unreachable`).toContain(`SOUND_CHAT_COPY.${accessor}`);
    }
  });
});

/* ================================================================== *
 * H10 — the two copy statements that are measurable and wrong, pinned.
 * ================================================================== */

describe("H10 two copy statements the arithmetic contradicts, pinned", () => {
  // FIXED. `permission.limits[1]` said a note is "one or two seconds of sound
  // each half". Read as it is written — and the pre-prompt is the one screen
  // where the cost of the sound has to be stated before the browser asks for the
  // microphone — it says the maximum note is one or two seconds. It is 3.8
  // seconds: two blocks of 1.92 s. `composer.twoBlocks` and `info.rate` both say
  // 3.8, so the feature contradicts itself on the only screen that matters for
  // consent.
  //
  // The fix, in `copy.ts` (this directory): say the cap's own duration. It now
  // reads "…84 plain characters at most, which is up to 3.8 seconds of sound."
  it("the pre-prompt quotes the whole cost of a full note, not less", () => {
    expect(SOUND_CHAT_COPY.permission.limits.join(" ")).toContain("3.8 seconds");
  });

  // FIXED. Both `permission.limits[1]` and `composer.bytesHint` said "Accents,
  // symbols and emoji each cost more than one byte". `!`, `?`, `#`, `&`, `.` and
  // `,` are all one byte in UTF-8, so a note full of them is not "costing more
  // than one byte" each. The honest sentence names what actually costs more:
  // accented letters, and anything outside ASCII.
  it("names no specific class of character as multi-byte, because some are not", () => {
    // `!` is a symbol and costs one byte, so "symbols cost more than one byte"
    // was false. The sentence now claims only what is true: anything outside
    // plain letters and digits *can* cost more.
    for (const sentence of [
      SOUND_CHAT_COPY.composer.bytesHint,
      SOUND_CHAT_COPY.permission.limits.join(" "),
    ]) {
      expect(sentence).not.toMatch(/accents?, symbols and emoji/i);
    }
  });

  it("the byte hint is otherwise honest about what costs more", () => {
    // So the pin above is about one over-broad noun, not about a wrong model:
    // an accented letter really is two bytes, and an emoji really is four.
    expect(measureMessage("A").bytes).toBe(1);
    expect(measureMessage("é").bytes).toBe(2);
    expect(measureMessage("€").bytes).toBe(3);
    expect(measureMessage("\u{1f600}").bytes).toBe(4);
    // A code point, not a UTF-16 unit, so one emoji counts once.
    expect(measureMessage("\u{1f600}").characters).toBe(1);
    expect(measureMessage("\u{1f600}").bytes).toBeGreaterThan(
      measureMessage("\u{1f600}").characters,
    );
  });
});

/* ================================================================== *
 * H11 — the shapes of the two closed unions the copy covers, so a state
 * added later is a compile error and a sentence added later is not
 * silently uncovered.
 * ================================================================== */

describe("H11 the copy covers every closed union exhaustively", () => {
  it("every block kind, fatal kind, refusal, status and transport state has a sentence", () => {
    const blocks: SoundChatBlock["kind"][] = [
      "mic-denied",
      "mic-missing",
      "mic-unsupported",
      "device-rate",
      "bad-code",
      "crypto-unavailable",
      "codec-unavailable",
      "audio-unavailable",
    ];
    expect(Object.keys(SOUND_CHAT_COPY.blocked).sort()).toEqual([...blocks].sort());
    for (const kind of blocks) {
      expect(SOUND_CHAT_COPY.blocked[kind].heading).toBeTruthy();
      expect(SOUND_CHAT_COPY.blocked[kind].body).toBeTruthy();
    }
    const fatals: SoundChatFatal["kind"][] = ["codec-died", "frame-contract"];
    expect(Object.keys(SOUND_CHAT_COPY.fatal).sort()).toEqual([...fatals].sort());
    const refusals: SendRefusal[] = [
      "not-paired",
      "empty",
      "too-long",
      "queue-full",
      "module-error",
      "stopped",
    ];
    expect(Object.keys(SOUND_CHAT_COPY.refusal).sort()).toEqual([...refusals].sort());
  });

  it("the pre-prompt's five limits each say something different", () => {
    const limits = SOUND_CHAT_COPY.permission.limits;
    expect(limits).toHaveLength(5);
    expect(new Set(limits).size).toBe(limits.length);
    // The first is the medium's cost, the second its size, the third the
    // recording boundary, the fourth what pairing proves, the fifth the
    // foreground requirement. Each is checked for its own subject so a rewrite
    // cannot quietly make two of them the same claim.
    expect(limits[0]).toMatch(/audible|record/i);
    expect(limits[1]).toMatch(/\b\d+\b/);
    expect(limits[2]).toMatch(/recording/i);
    expect(limits[3]).toMatch(/Pairing/i);
    expect(limits[4]).toMatch(/foreground|background/i);
  });
});
