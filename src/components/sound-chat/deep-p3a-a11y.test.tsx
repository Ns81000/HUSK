/**
 * Accessibility of the Sound Chat screen, against WCAG 2.1 AA and normal
 * screen-reader practice.
 *
 * WHY `renderToStaticMarkup` and not a DOM: there is no jsdom, no happy-dom and
 * no testing-library in this repo and `package.json` is not this feature's to
 * edit. `react-dom/server` is already a dependency, so this file asserts the
 * *real* markup — the real `role`s, the real ids, the real `aria-describedby`
 * tokens, the real `disabled` attributes — which is the only thing a screen
 * reader or a text extractor ever sees. Effects do not run, so behaviour that
 * lives in an effect is out of reach here and each such case says so in a
 * comment rather than pretending to assert it.
 *
 * The two things markup genuinely cannot prove are focus *position* and
 * announcement *timing*. Both are handled by asserting the absence of the thing
 * that would cause the problem (no `autoFocus`, no `tabIndex={-1}` target, no
 * text inside the live region that changes on a tick) and by saying in a comment
 * that this is an argument from the markup, not an observation of a browser.
 *
 * One section reads `src/styles.css` to measure contrast, and the
 * `text-ink-muted` it pins was found failing 4.5:1 and the components were moved
 * off `text-ink-faint`. That pin is a plain `it`, deliberately: it asserts
 * "this token passes", so the day the token is fixed the assertion stays green
 * and the `not.toContain` beside it is what catches a regression. `it.fails`
 * would have inverted into a false failure the moment the defect was closed.
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
import { SoundChatScreen } from "@/components/sound-chat/sound-chat-screen";
import { SOUND_CHAT_COPY, transportSentence } from "@/lib/sound-chat/ui/copy";
import { SOUND_CHAT_ENTRY_COPY } from "@/lib/sound-chat/ui/entry-copy";
import {
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  validatePairingCode,
} from "@/lib/sound-chat/crypto";
import type { PairingState } from "@/lib/sound-chat/pairing";
import type { SessionStats } from "@/lib/sound-chat/session";
import type { TransportState } from "@/lib/sound-chat/transport-machine";

/** React escapes text; a reader does not. Same decoder as `render.test.tsx`. */
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

const ALL_STATES: readonly TransportState[] = [
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

const PAIRING_STATES: readonly PairingState[] = [
  { kind: "idle" },
  { kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" },
  { kind: "awaiting-confirmation", code: "ABCD2345", role: "enterer" },
  { kind: "paired", code: "ABCD2345", role: "displayer", peerSalt: new Uint8Array(16) },
  { kind: "failed", code: "ABCD2345", role: "displayer", reason: "wrong-code" },
];

const STATS: SessionStats = {
  blocksDecoded: 3,
  framesUnreadable: 1,
  messagesDelivered: 2,
  duplicatesSuppressed: 4,
  conflicts: 0,
  acksSent: 2,
  retries: 1,
};

/* ------------------------------------------------------------------ *
 * Every screen the feature can show, as one table, so no screen is
 * checked by one test and forgotten by the next.
 * ------------------------------------------------------------------ */

function pairing(state: PairingState): ReactElement {
  const role = state.kind === "idle" ? "displayer" : state.role;
  return (
    <PairingPanel
      role={role}
      code="ABCD2345"
      state={state}
      failure={state.kind === "failed" ? SOUND_CHAT_COPY.pairingFailure("wrong-code") : null}
      busy={false}
      onRetry={noop}
      onSwitchRole={noop}
    />
  );
}

function composer(value: string, over: Partial<Parameters<typeof Composer>[0]> = {}): ReactElement {
  return (
    <Composer
      value={value}
      onChange={noop}
      onSubmit={noop}
      disabled={false}
      disabledReason={null}
      {...over}
    />
  );
}

const SCREENS: readonly (readonly [string, ReactElement])[] = [
  ["permission", <PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />],
  ...PAIRING_STATES.map((state): readonly [string, ReactElement] => [
    `pairing:${state.kind}`,
    pairing(state),
  ]),
  ["chat:empty", <MessageList inbound={[]} outbound={[]} />],
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
        ]}
      />
      {composer("a".repeat(85))}
    </div>,
  ],
  [
    "chat:disabled",
    composer("hi", { disabled: true, disabledReason: SOUND_CHAT_COPY.composer.blockedByPairing }),
  ],
  ["chat:refusal", composer("hi", { refusal: SOUND_CHAT_COPY.refusal["queue-full"] })],
  [
    "blocked",
    <BlockedPanel
      block={{ kind: "mic-denied", detail: "NotAllowedError" }}
      onRetry={noop}
      onBack={noop}
    />,
  ],
  [
    "blocked:unknown",
    <BlockedPanel block={{ kind: "never-heard-of", detail: "odd" }} onRetry={noop} onBack={noop} />,
  ],
  [
    "fatal",
    <FatalPanel fatal={{ kind: "codec-died", detail: "CodecModuleError" }} onRestart={noop} />,
  ],
  [
    "fatal:unknown",
    <FatalPanel fatal={{ kind: "never-heard-of", detail: "odd" }} onRestart={noop} />,
  ],
  ["info:closed", <InfoPanel open={false} onToggle={noop} stats={STATS} />],
  ["info:open", <InfoPanel open onToggle={noop} stats={STATS} />],
  ["entry:loading", <SoundChatEntry />],
];

/* ------------------------------------------------------------------ *
 * Helpers for the id/reference work.
 * ------------------------------------------------------------------ */

function idsIn(markup: string): string[] {
  return [...markup.matchAll(/ id="([^"]*)"/g)].map((match) => match[1] ?? "");
}

type Reference = { readonly attribute: string; readonly id: string };

/** Every id-valued ARIA reference and every `for=`, as (attribute, id) pairs. */
function referencesIn(markup: string): Reference[] {
  const out: Reference[] = [];
  for (const match of markup.matchAll(
    /\s(for|aria-labelledby|aria-describedby|aria-controls|aria-owns)="([^"]*)"/g,
  )) {
    for (const id of (match[2] ?? "").split(/\s+/).filter(Boolean)) {
      out.push({ attribute: match[1] ?? "", id });
    }
  }
  return out;
}

/** Text a reader would hear for an element, ignoring anything `aria-hidden`. */
function accessibleText(markup: string, openTag: RegExp): string {
  const start = markup.search(openTag);
  if (start < 0) return "";
  const tagEnd = markup.indexOf(">", start);
  const openTagText = markup.slice(start, tagEnd + 1);
  const name = /\saria-label="([^"]*)"/.exec(openTagText)?.[1];
  if (name !== undefined) return name;
  const labelledBy = /\saria-labelledby="([^"]*)"/.exec(openTagText)?.[1];
  if (labelledBy !== undefined) {
    return labelledBy
      .split(/\s+/)
      .map((id) => findTextById(markup, id))
      .join(" ")
      .trim();
  }
  // Otherwise the element's own text content, up to its closing tag.
  const close = markup.indexOf("</", tagEnd);
  return textBetween(markup, tagEnd + 1, close < 0 ? markup.length : close);
}

function findTextById(markup: string, id: string): string {
  const at = markup.indexOf(` id="${id}"`);
  if (at < 0) return "";
  const openEnd = markup.indexOf(">", at);
  const close = markup.indexOf("</", openEnd);
  return textBetween(markup, openEnd + 1, close < 0 ? markup.length : close);
}

/** The text of a markup range, with the tags removed and the gaps collapsed. */
function textBetween(markup: string, from: number, to: number): string {
  return markup
    .slice(from, to)
    .replace(/<svg\b[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Every interactive element, as its open tag and the text that follows it.
 *
 * `\s` before `id=` matters: `aria-invalid="false"` ends in `id="false"`, and a
 * lazy `[^>]*id="` would match the tail of it and read the field's id as
 * `false`.
 */
function interactiveTags(markup: string): { tag: string; from: number; to: number }[] {
  return [...markup.matchAll(/<(button|a|input|textarea|select)\b[^>]*>/g)].map((match) => ({
    tag: match[0],
    from: match.index,
    to: match.index + match[0].length,
  }));
}

/** The element name a tag belongs to, so its own closing tag can be found. */
function elementName(openTag: string): string {
  return /^<([a-z]+)/.exec(openTag)?.[1] ?? "";
}

/** The text of the elements a list of `aria-describedby` tokens points at. */
function targets(markup: string, ids: readonly string[]): string {
  return ids.map((id) => findTextById(markup, id)).join(" ");
}

/** The `aria-describedby` tokens of the first element matching `openTag`. */
function describedBy(markup: string, openTag: RegExp): string[] {
  const at = markup.search(openTag);
  if (at < 0) return [];
  const tagEnd = markup.indexOf(">", at);
  return (/\saria-describedby="([^"]*)"/.exec(markup.slice(at, tagEnd))?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
}

const COMPONENT_DIR = fileURLToPath(new URL(".", import.meta.url));

function componentFile(name: string): string {
  return readFileSync(COMPONENT_DIR + name, "utf8");
}

function componentSources(): string {
  return readdirSync(COMPONENT_DIR)
    .filter((name) => !name.includes(".test.") && (name.endsWith(".ts") || name.endsWith(".tsx")))
    .map((name) => componentFile(name))
    .join("\n");
}

const STYLES = readFileSync(fileURLToPath(new URL("../../styles.css", import.meta.url)), "utf8");
const ROUTE = readFileSync(
  fileURLToPath(new URL("../../routes/sound-chat.tsx", import.meta.url)),
  "utf8",
);
const ROOT_ROUTE = readFileSync(
  fileURLToPath(new URL("../../routes/__root.tsx", import.meta.url)),
  "utf8",
);

/* ================================================================== *
 * A1 — names and roles: every reference resolves, no id twice.
 * ================================================================== */

describe("A1 every ARIA reference in every screen resolves inside that screen", () => {
  it("has screens to check, so an empty table cannot pass silently", () => {
    expect(SCREENS.length).toBeGreaterThan(15);
  });

  for (const [name, element] of SCREENS) {
    it(`${name} has no duplicate id and no dangling reference`, () => {
      const markup = render(element);
      const ids = idsIn(markup);
      const duplicates = ids.filter((id, at) => ids.indexOf(id) !== at);
      expect(duplicates, `duplicate id(s): ${duplicates.join(", ")}`).toEqual([]);
      const dangling = referencesIn(markup).filter((reference) => !ids.includes(reference.id));
      expect(
        dangling.map((reference) => `${reference.attribute}="${reference.id}"`),
        `${name} has a reference to an id that is not in the tree`,
      ).toEqual([]);
    });
  }

  it("two of everything in one tree still resolve, because ids must be unique per instance", () => {
    const markup = render(
      <div>
        {[
          SCREENS[0]?.[1],
          pairing({
            kind: "paired",
            code: "ABCD2345",
            role: "displayer",
            peerSalt: new Uint8Array(16),
          }),
          <InfoPanel open onToggle={noop} stats={STATS} />,
          <InfoPanel open={false} onToggle={noop} stats={STATS} />,
          composer("a".repeat(85)),
          composer("ok"),
        ]}
      </div>,
    );
    const ids = idsIn(markup);
    expect(new Set(ids).size, "ids repeated across two instances").toBe(ids.length);
    expect(referencesIn(markup).filter((reference) => !ids.includes(reference.id))).toEqual([]);
  });
});

/* ================================================================== *
 * A2 — every control has an accessible name.
 * ================================================================== */

describe("A2 every interactive control has an accessible name", () => {
  for (const [name, element] of SCREENS) {
    it(`${name} names every button, link, field and disclosure`, () => {
      const markup = render(element);
      const unnamed = interactiveTags(markup)
        .filter(({ tag, from, to }) => {
          // A name can come from an attribute, or from the element's own content.
          if (/\saria-label="[^"]+"/.test(tag)) return false;
          if (/\saria-labelledby="[^"]+"/.test(tag)) return false;
          if (/\stitle="[^"]+"/.test(tag)) return false;
          // A submit or reset button's name may be `value`.
          if (/\stype="(submit|reset)"/.test(tag) && /\svalue="[^"]+"/.test(tag)) return false;
          // A field's name may be a `<label for>`; the caller checks that
          // association resolves, so here only the presence of a label matters.
          if (/^<(input|textarea|select)\b/.test(tag)) {
            const id = /\sid="([^"]+)"/.exec(tag)?.[1] ?? "";
            if (id !== "" && new RegExp(`<label[^>]*for="${id}"`).test(markup)) return false;
          }
          const close = markup.indexOf(`</${elementName(tag)}>`, to);
          const name_ = textBetween(markup, to, close < 0 ? markup.length : close);
          return name_.length === 0;
        })
        .map(({ tag }) => tag);
      expect(unnamed, `${name} has a control with no name`).toEqual([]);
    });
  }

  it("the transcript's own scroll container is named and is a region, not a bare div", () => {
    // A `div` with `aria-label` and no `role` is role=generic, and an accessible
    // name on generic is not exposed. The scroll container also has to be
    // keyboard-scrollable (WCAG 2.1.1), which needs a tab stop.
    const markup = render(<MessageList inbound={[]} outbound={[]} />);
    const scroller = /<div[^>]*overflow-y-auto[^>]*>/.exec(markup)?.[0];
    expect(scroller, "no scroll container found").toBeTruthy();
    expect(scroller).toMatch(/\srole="(region|log)"/);
    expect(scroller).toMatch(/\stabindex="0"/);
    expect(scroller).toMatch(/\saria-label="[^"]+"/);
  });

  it("the displayer's pairing code is announced as a pairing code, not as the page heading", () => {
    // The group around the code readout was labelled by the page `<h1>`, so its
    // accessible name was the same string as the enclosing region and the eight
    // characters were announced with nothing saying what they are.
    const markup = render(
      pairing({ kind: "waiting-for-peer", code: "ABCD2345", role: "displayer" }),
    );
    const group = /<div[^>]*role="group"[^>]*>/.exec(markup)?.[0];
    expect(group, "no group around the code readout").toBeTruthy();
    // Read the heading by level-2 as well as level-1: matching only <h1> left
    // `headingId` empty whenever the panel demoted its own heading, and
    // `not.toContain('aria-labelledby=""')` cannot fail. The assertion below is
    // the one that matters, so it is given a real id to compare against.
    const headingId = /<h[12][^>]*id="([^"]+)"/.exec(markup)?.[1] ?? "";
    expect(headingId, "the panel rendered no heading at all").not.toBe("");
    expect(group).toContain(SOUND_CHAT_COPY.pairing.codeLabel);
    expect(group, "the group is announced as the page heading").not.toContain(
      `aria-labelledby="${headingId}"`,
    );
  });
});

/* ================================================================== *
 * A3 — live regions: how many, and what each one narrates.
 * ================================================================== */

describe("A3 one live region per event, and none of them narrates the same event twice", () => {
  it("the chat screen has one log, one status and no alert until something is refused", () => {
    const quiet = render(
      <div>
        <TransmitStatus
          transport="transmitting"
          transmitting
          progress={{ blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 }}
        />
        <MessageList
          inbound={[]}
          outbound={[
            { seq: 1, msgId: 1, sendId: 1, text: "hi", status: "sending", attempts: 1, blocks: 1 },
          ]}
        />
        {composer("hi")}
      </div>,
    );
    expect((quiet.match(/role="log"/g) ?? []).length).toBe(1);
    expect((quiet.match(/role="status"/g) ?? []).length).toBe(1);
    expect((quiet.match(/role="alert"/g) ?? []).length).toBe(0);

    const refused = render(composer("hi", { refusal: SOUND_CHAT_COPY.refusal["module-error"] }));
    expect((refused.match(/role="alert"/g) ?? []).length).toBe(1);
  });

  it("the log and the status never carry the same sentence", () => {
    for (const state of ALL_STATES) {
      const markup = render(
        <div>
          <TransmitStatus
            transport={state}
            transmitting={state === "transmitting"}
            progress={null}
          />
          <MessageList
            inbound={[]}
            outbound={[
              { seq: 1, msgId: 1, sendId: 1, text: "note", status: "sent", attempts: 1, blocks: 1 },
            ]}
          />
        </div>,
      );
      const status = transportSentence(state);
      const logAt = markup.indexOf('role="log"');
      expect(logAt, `${state} renders no log`).toBeGreaterThan(-1);
      // The status sentence appears once, before the log, and never inside it.
      expect(markup.indexOf(status)).toBeLessThan(logAt);
      expect(markup.slice(logAt)).not.toContain(status);
    }
  });

  it("the status sentence is byte-identical across eleven progress ticks", () => {
    // This is the 10-announcements-a-second test, and the only honest way to
    // make it in markup: the live region is the state sentence, and the sentence
    // does not change when the bar moves. Effects and the controller's 100 ms
    // ticker are not involved — the same eleven props the ticker produces are
    // rendered eleven times and the live region's own markup is compared.
    const regionAt = (markup: string): string => {
      const start = markup.indexOf('role="status"');
      expect(start, "no status region").toBeGreaterThan(-1);
      const open = markup.lastIndexOf("<", start);
      const close = markup.indexOf("</p>", start);
      return markup.slice(open, close + 4);
    };
    const seen = new Set<string>();
    const values: number[] = [];
    for (let tick = 0; tick <= 10; tick += 1) {
      const markup = render(
        <TransmitStatus
          transport="transmitting"
          transmitting
          progress={{
            blocks: 2,
            blockIndex: 1,
            fraction: tick / 10,
            remainingMs: 2000 - tick * 200,
          }}
        />,
      );
      seen.add(regionAt(markup));
      values.push(Number(/aria-valuenow="([^"]*)"/.exec(markup)?.[1] ?? "-1"));
    }
    // The bar really did move across the sweep, so the comparison is not vacuous.
    // (Its floor is 1%, never 0%, so the values are compared as a rising run
    // rather than as `tick * 10`.)
    expect(values[0], "the bar never moved").toBeLessThan(values[10] ?? 0);
    for (let at = 1; at < values.length; at += 1) {
      expect(values[at] ?? 0, `tick ${at} went backwards`).toBeGreaterThanOrEqual(
        values[at - 1] ?? 0,
      );
    }
    expect([...seen].length, `the live region changed across ticks:\n${[...seen].join("\n")}`).toBe(
      1,
    );
  });

  it("the progress bar is never inside a live region, in any state", () => {
    for (const state of ALL_STATES) {
      for (const progress of [
        null,
        { blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 },
        { blocks: 2, blockIndex: 2, fraction: 1, remainingMs: 0 },
      ] as const) {
        const markup = render(
          <TransmitStatus
            transport={state}
            transmitting={state === "transmitting"}
            progress={progress}
          />,
        );
        const bar = markup.indexOf('role="progressbar"');
        if (bar < 0) continue;
        for (const role of ["status", "alert", "log"] as const) {
          const live = markup.indexOf(`role="${role}"`);
          if (live < 0) continue;
          // An element closes between the live region's own opening tag and the
          // bar, so the bar cannot be inside it: whatever the live region
          // contains ends first.
          const lastClose = markup.lastIndexOf("</", bar);
          expect(
            lastClose,
            `${state}: the bar is inside the role="${role}" region`,
          ).toBeGreaterThanOrEqual(markup.indexOf(">", live) + 1);
        }
      }
    }
  });

  it("the transcript's live region exists before there is anything to announce", () => {
    // A `role="log"` that is created at the same moment as its first child is
    // not reliably announced: a live region has to be in the document, and
    // settled, before its content changes. So the empty transcript has to carry
    // the region, and the empty state has to live inside it.
    const empty = render(<MessageList inbound={[]} outbound={[]} />);
    expect(empty).toContain('role="log"');
    const logAt = empty.indexOf('role="log"');
    expect(empty.slice(logAt)).toContain(SOUND_CHAT_COPY.transcript.emptyHeading);
    expect(empty.slice(logAt)).toContain(SOUND_CHAT_COPY.transcript.emptyBody);
    // And the empty state is not announced as if it were a note: additions only.
    expect(empty).toContain('aria-relevant="additions"');
  });

  it("a note arriving is an addition to a region that was already there", () => {
    const empty = render(<MessageList inbound={[]} outbound={[]} />);
    const one = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 1, sendId: 1, text: "first", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    const region = (markup: string): string => {
      const at = markup.indexOf('role="log"');
      const open = markup.lastIndexOf("<", at);
      return markup.slice(open, markup.indexOf(">", at) + 1);
    };
    expect(region(one)).toBe(region(empty));
    // The region is present in the empty tree, which is what makes the addition
    // an addition rather than an insertion.
    expect(empty).toContain('role="log"');
    expect(one).toContain("first");
  });
});

/* ================================================================== *
 * A4 — the one role="alert" that wraps a dialog.
 * ================================================================== */

describe("A4 the restart dialog is not inside the fatal panel's live region", () => {
  it("closes the alert element before the Modal opens", () => {
    // `aria-modal="true"` and a `role="alert"` ancestor are contradictory: the
    // dialog's mounting would be announced by the assertive region that is
    // already announcing the failure, on top of the dialog's own announcement.
    // The check is a tag balance rather than a slice, so it cannot be fooled by
    // indentation.
    const source = componentFile("fatal-panel.tsx");
    const alertAt = source.indexOf('role="alert"');
    const modalAt = source.indexOf("<Modal");
    expect(alertAt, "no role=alert in fatal-panel.tsx").toBeGreaterThan(-1);
    expect(modalAt, "no Modal in fatal-panel.tsx").toBeGreaterThan(-1);
    // The element the alert's own tag opens.
    const elementStart = source.lastIndexOf("<div", alertAt);
    const between = source.slice(elementStart, modalAt);
    const opens = (between.match(/<div\b/g) ?? []).length;
    const closes = (between.match(/<\/div>/g) ?? []).length;
    expect(
      opens - closes,
      `the alert's element is still open ${String(opens - closes)} deep when the Modal starts`,
    ).toBe(0);
    // And the rendered failure screen has no dialog in it at all, because the
    // dialog is closed until it is asked for.
    expect(
      render(<FatalPanel fatal={{ kind: "codec-died", detail: "x" }} onRestart={noop} />),
    ).not.toContain('role="dialog"');
  });

  it("the same is true of the blocked panel, which has no dialog at all", () => {
    const source = componentFile("blocked-panel.tsx");
    expect(source).not.toContain("<Modal");
    expect(
      (
        render(
          <BlockedPanel block={{ kind: "mic-denied", detail: "x" }} onRetry={noop} onBack={noop} />,
        ).match(/role="dialog"/g) ?? []
      ).length,
    ).toBe(0);
  });
});

/* ================================================================== *
 * A5 — focus after the focused element is removed.
 * ================================================================== */

describe("A5 what the markup can and cannot prove about focus", () => {
  it("nothing in the feature ever moves focus programmatically", () => {
    // This is the finding, stated as an absence. Every phase change in
    // `renderPhase` swaps the whole subtree, so a control that had focus is
    // unmounted and the browser puts focus back on `<body>`: pairing failing, the
    // fatal panel appearing, the blocked panel appearing, `cancel()` returning to
    // the pre-prompt, and the preparing notice between a choice and a session.
    //
    // WHAT THE MARKUP CANNOT PROVE: where focus actually lands, and whether a
    // particular screen reader lands on the document or on the viewport. There is
    // no DOM here, so this file does not claim to know. What it can prove is that
    // nothing in the feature's own code compensates: no `autoFocus`, no
    // `tabIndex={-1}` to receive programmatic focus, no `ref` + `.focus()`.
    const sources = componentSources();
    expect(sources).not.toMatch(/\bautoFocus\b/);
    expect(sources).not.toMatch(/\.focus\(/);
    expect(sources).not.toMatch(/activeElement/);
    expect(sources).not.toMatch(/tabIndex=\{-1\}/);
    // The one `tabIndex` in the feature is a scroll container made reachable,
    // which is the opposite of a focus trap: it is a stop a keyboard can find
    // and move on from.
    const tabIndexes = [...sources.matchAll(/tabIndex=\{(-?\d+)\}/g)].map((match) => match[1]);
    expect(new Set(tabIndexes), "a tab stop that is not the transcript scroller").toEqual(
      new Set(["0"]),
    );
    expect(componentFile("message-list.tsx")).toMatch(
      /tabIndex=\{0\}[\s\S]{0,200}overflow-y-auto|overflow-y-auto[\s\S]{0,200}tabIndex=\{0\}/,
    );
  });

  it("the panels that replace a control offer a focus target a keyboard can reach", () => {
    // The only thing markup *can* prove is that the screen that appears after
    // the focus loss has somewhere to send the keyboard: a real button, in the
    // reading order, that is not disabled. That is the minimum that keeps
    // "focus is on body" from being the whole story.
    for (const [label, element] of [
      [
        "blocked",
        <BlockedPanel block={{ kind: "mic-denied", detail: "x" }} onRetry={noop} onBack={noop} />,
      ],
      ["fatal", <FatalPanel fatal={{ kind: "codec-died", detail: "x" }} onRestart={noop} />],
    ] as const) {
      const markup = render(element);
      const buttons = [...markup.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
      expect(buttons.length, `${label} offers no control`).toBeGreaterThan(0);
      for (const button of buttons) {
        expect(button, `${label} has a disabled control as its only way out`).not.toMatch(
          /\sdisabled(=|>|\s)/,
        );
      }
    }
  });

  it("the preparing notice names the wait and is the only thing on the screen", () => {
    // It replaces the pre-prompt's three buttons, so it is the screen where
    // focus loss is most likely to strand a keyboard user.
    const source = componentFile("sound-chat-screen.tsx");
    const notice = /function PreparingNotice[\s\S]*?\n}/.exec(source)?.[0] ?? "";
    expect(notice, "no PreparingNotice in sound-chat-screen.tsx").not.toBe("");
    expect(notice).toContain('role="status"');
    expect(notice).toContain("SOUND_CHAT_COPY.shell.preparing");
    expect(notice).not.toMatch(/autoFocus|tabIndex/);
    // One sentence, one region, and nothing else on the screen to read.
    expect((notice.match(/<(button|a|input|textarea)\b/g) ?? []).length).toBe(0);
    expect(SOUND_CHAT_COPY.shell.preparing.length).toBeGreaterThan(10);
  });
});

/* ================================================================== *
 * A6 — keyboard.
 * ================================================================== */

describe("A6 every action is a real control, and nothing is click-only", () => {
  it("no div, span, li, p or section carries an onClick in this feature", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(COMPONENT_DIR)) {
      if (name.includes(".") && !name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (name.includes(".test.")) continue;
      const source = readFileSync(COMPONENT_DIR + name, "utf8");
      for (const match of source.matchAll(/<(div|span|li|p|section|article)\b[^>]*\bonClick/g)) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every anchor in the feature has an href, so it is reachable and announces a link", () => {
    const markup = render(<SoundChatEntry />);
    expect(markup).not.toContain("<a ");
    const source = componentFile("sound-chat-screen.tsx");
    for (const match of source.matchAll(/<a\b[^>]*>/g)) {
      expect(match[0], `anchor without href: ${match[0]}`).toMatch(/\shref="/);
    }
  });

  it("the exit control is a link with a name, not an icon", () => {
    const source = componentFile("sound-chat-screen.tsx");
    const anchor = /<a\b[\s\S]*?<\/a>/.exec(source)?.[0] ?? "";
    expect(anchor).toContain("href=");
    expect(anchor).toContain("SOUND_CHAT_COPY.actions.exit");
    expect(SOUND_CHAT_COPY.actions.exit.length).toBeGreaterThan(3);
  });

  it("the composer's send is a submit in a form, so Enter and the button are one path", () => {
    const markup = render(composer("hi"));
    expect(markup).toContain("<form");
    expect(markup).toMatch(/<button[^>]*type="submit"/);
    // No key handler of the feature's own on the textarea: a form is the
    // keyboard path, and inventing one is how Shift+Enter breaks.
    const source = componentFile("composer.tsx");
    expect(source).not.toMatch(/onKeyDown/);
  });

  it("Escape from the pairing code step returns to the role step, and does not leave", () => {
    const source = componentFile("permission-prompt.tsx");
    expect(source).toContain('if (event.key !== "Escape")');
    // It stops the event reaching anything that would treat Escape as "go away",
    // and it is on the form, so it works from the field and from both buttons.
    expect(source).toMatch(/onKeyDown=\{onKeyDown\}/);
    expect(source).toMatch(/function onKeyDown[\s\S]*?event\.stopPropagation\(\)/);
    expect(source).toMatch(/function onKeyDown[\s\S]*?toRoleStep\(\)/);
    // The role step is still on the same screen, so there is somewhere to go.
    expect(source).toContain('setStep("role")');
  });

  it("the pairing code field is a real text input with the right keyboard hints", () => {
    const source = componentFile("permission-prompt.tsx");
    const input = /<input\b[\s\S]*?\/>/.exec(source)?.[0] ?? "";
    expect(input).toMatch(/type="text"/);
    expect(input).toMatch(/\bname="pairing-code"/);
    // A code is single-byte ASCII by definition, so a character limit is exact
    // here — unlike a note, which is counted in bytes.
    expect(input).toMatch(/maxLength=\{PAIRING_CODE_LENGTH \* 2\}/);
    expect(input).toMatch(/autoCapitalize="characters"/);
    expect(input).toMatch(/autoCorrect="off"/);
    expect(input).toMatch(/spellCheck=\{false\}/);
    // Controlled, so the value is always the normalised one.
    expect(input).toMatch(/value=\{typed\}/);
  });

  it("the restart dialog traps Tab, moves focus in, and restores it", () => {
    // The `Modal` is Husk's shared primitive and is not this feature's to edit,
    // so what is asserted here is that the feature uses it rather than rolling
    // its own dialog, and that the primitive does the three things that matter.
    const primitives = readFileSync(
      fileURLToPath(new URL("../husk/primitives.tsx", import.meta.url)),
      "utf8",
    );
    const fatal = componentFile("fatal-panel.tsx");
    expect(fatal).toContain("Modal");
    expect(fatal).not.toMatch(/role="dialog"/);
    expect(primitives).toContain('role="dialog"');
    expect(primitives).toContain('aria-modal="true"');
    expect(primitives).toMatch(/confirmRef\.current\?\.focus\(\)/);
    expect(primitives).toMatch(/event\.key === "Escape"/);
    expect(primitives).toMatch(/\(event\.shiftKey \? last : first\)\.focus\(\)/);
    expect(primitives).toMatch(/invoker\?\.focus\(\)/);
    // The dialog has a name, and its description is prose rather than a label.
    expect(primitives).toContain("aria-labelledby={titleId}");
  });
});

/* ================================================================== *
 * A7 — forms.
 * ================================================================== */

describe("A7 the composer's form says why it cannot be used", () => {
  it("names the field through a real label", () => {
    const markup = render(composer("hi"));
    // `\s` before `id=` matters: `aria-invalid="false"` ends in `id="false"`.
    const labelFor = /<label[^>]*\sfor="([^"]+)"/.exec(markup)?.[1] ?? "";
    const fieldId = /<textarea[^>]*\sid="([^"]+)"/.exec(markup)?.[1] ?? "";
    expect(labelFor, "the textarea has no associated label").not.toBe("");
    expect(labelFor).toBe(fieldId);
    expect(markup).toContain(SOUND_CHAT_COPY.composer.label);
  });

  it("describes the field with the counter, the over-cap sentence and the empty sentence", () => {
    // `aria-describedby` is the only way a screen-reader user learns why the
    // field is invalid without the message being re-announced on every
    // keystroke, so everything the field needs to be understood belongs in it.
    const overCap = render(composer("a".repeat(85)));
    const empty = render(composer(""));
    expect(targets(overCap, describedBy(overCap, /<textarea/))).toContain(
      SOUND_CHAT_COPY.composer.byteCounter(85),
    );
    expect(targets(overCap, describedBy(overCap, /<textarea/))).toContain(
      SOUND_CHAT_COPY.composer.overCap(1),
    );
    expect(targets(empty, describedBy(empty, /<textarea/))).toContain(
      SOUND_CHAT_COPY.composer.empty,
    );
  });

  it("keeps the send control reachable with aria-disabled rather than removing it", () => {
    // With `disabled`, the button leaves the tab order and the textarea is
    // disabled too, so the reason a note cannot be sent is unreachable by
    // keyboard from inside the form at all.
    for (const [name, element] of [
      ["empty", composer("")],
      ["over cap", composer("a".repeat(85))],
      [
        "session cannot send",
        composer("hi", {
          disabled: true,
          disabledReason: SOUND_CHAT_COPY.composer.blockedByPairing,
        }),
      ],
    ] as const) {
      const markup = render(element);
      const send = /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "";
      expect(send, `${name}: no submit button`).not.toBe("");
      expect(send, `${name}: the send control is aria-disabled`).toContain('aria-disabled="true"');
      expect(send, `${name}: the send control must stay focusable`).not.toMatch(
        /\sdisabled(=|>|\s)/,
      );
      // And the reason it cannot be used is attached to it, and resolves to text.
      const described = describedBy(markup, /<button[^>]*type="submit"/);
      expect(described.length, `${name}: the send control describes nothing`).toBeGreaterThan(0);
      for (const id of described) {
        expect(idsIn(markup), `${name}: described id ${id} is not in the tree`).toContain(id);
      }
      const said = targets(markup, described);
      expect(said.length, `${name}: every description target is empty`).toBeGreaterThan(0);
      expect(said, `${name}: the reason is not among the send control's descriptions`).not.toBe(
        SOUND_CHAT_COPY.composer.byteCounter(0).slice(0, 1),
      );
      // The reason is one of the three sentences that can block a send.
      expect(
        [
          SOUND_CHAT_COPY.composer.empty,
          SOUND_CHAT_COPY.composer.overCap(1),
          SOUND_CHAT_COPY.composer.blockedByPairing,
        ].some((sentence) => said.includes(sentence)),
        `${name}: the send control describes "${said}" and no reason`,
      ).toBe(true);
    }
  });

  it("a usable send is not marked unavailable", () => {
    for (const value of ["hi", "a".repeat(43), "a".repeat(84)]) {
      const markup = render(composer(value));
      const send = /<button[^>]*type="submit"[^>]*>/.exec(markup)?.[0] ?? "";
      expect(send, `${value} bytes: marked unavailable`).not.toContain("aria-disabled");
      expect(send, `${value} bytes: hard disabled`).not.toMatch(/\sdisabled(=|>|\s)/);
    }
  });

  it("marks the field invalid only when it is, and puts the error next to the field", () => {
    expect(render(composer("a".repeat(85)))).toMatch(/<textarea[^>]*aria-invalid="true"/);
    expect(render(composer("hi"))).toMatch(/<textarea[^>]*aria-invalid="false"/);
    const markup = render(composer("a".repeat(85)));
    const field = markup.indexOf("<textarea");
    const error = markup.indexOf(SOUND_CHAT_COPY.composer.overCap(1));
    const formEnd = markup.indexOf("</form>");
    // Adjacency, in the order a screen reader walks the form: the sentence is
    // after the field it is about, and before the form ends. It is *not* before
    // the send control — that shares a row with the field by design, and the
    // sentence is attached to the field rather than read in visual order.
    expect(error, "no over-cap sentence").toBeGreaterThan(field);
    expect(error, "the over-cap sentence is outside the form").toBeLessThan(formEnd);
    // And it is the field's own description, so focusing the field says it.
    expect(targets(markup, describedBy(markup, /<textarea/))).toContain(
      SOUND_CHAT_COPY.composer.overCap(1),
    );
  });

  it("a refusal interrupts once, and does not sit in a live region that ticks", () => {
    const markup = render(composer("hi", { refusal: SOUND_CHAT_COPY.refusal["queue-full"] }));
    expect(markup).toContain('role="alert"');
    // A refusal is discrete. The over-cap line is not, and is not in a live
    // region — so the two are not treated alike.
    expect(markup.match(/role="alert"/g) ?? []).toHaveLength(1);
    const overCap = render(composer("a".repeat(85)));
    expect(overCap).not.toContain('role="alert"');
    expect(overCap).not.toContain("aria-live");
  });

  it("the pairing code field's own rules are reachable from the field", () => {
    // The alphabet the code uses is on screen as prose, but a screen reader
    // reading the field hears only its value. The one thing a person cannot
    // guess — which letters are left out — is what makes a correctly typed code
    // fail, so it belongs in the field's description.
    const source = componentFile("permission-prompt.tsx");
    expect(source).toMatch(/const bodyId = useId\(\)/);
    expect(source).toMatch(/<p id=\{bodyId\}/);
    const field = /<input\b[\s\S]*?\/>/.exec(source)?.[0] ?? "";
    expect(field, "the code field describes nothing").toMatch(/aria-describedby=\{[^}]*\bbodyId\b/);
    // And the rules paragraph really is the one that states the alphabet.
    expect(/<p id=\{bodyId\}[\s\S]*?SOUND_CHAT_COPY\.pairing\.enterBody/.test(source)).toBe(true);
  });

  it("the code field is aria-invalid only while there is a problem, and the problem is an alert", () => {
    const source = componentFile("permission-prompt.tsx");
    expect(source).toMatch(/aria-invalid=\{problem !== null\}/);
    const problem = /<p\s+id=\{problemId\}[\s\S]*?>/.exec(source)?.[0] ?? "";
    expect(problem, "the validation message is not an alert").toContain('role="alert"');
    expect(problem).toContain("text-danger");
    // Both descriptions are present when there is a problem; the rules always.
    expect(source).toMatch(/aria-describedby=\{problem === null \? bodyId : `\$\{bodyId\}/);
  });

  it("a refused code names the rule, the expected value and the alphabet", () => {
    // `validatePairingCode` is pure, so the real strings it can put in front of
    // the user can be called here rather than read out of its source.
    const tooShort = ((): string => {
      try {
        validatePairingCode("ABC");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    const badLetter = ((): string => {
      try {
        validatePairingCode("ABCD234I");
        return "";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect(tooShort, "a three-character code was accepted").not.toBe("");
    expect(badLetter, "a code containing I was accepted").not.toBe("");
    // The length rule names the expected length and what was typed.
    expect(tooShort).toContain(String(PAIRING_CODE_LENGTH));
    expect(tooShort).toContain("3");
    // The alphabet rule names the alphabet itself, so a typo is actionable
    // without leaving the field — and names the one character that is wrong.
    expect(badLetter).toContain("I");
    expect(badLetter).toContain(PAIRING_CODE_ALPHABET);
    // Neither message echoes the whole code (P9).
    for (const message of [tooShort, badLetter]) {
      expect(message).not.toMatch(/\b[0-9A-HJ-NP-Z]{8}\b/);
    }
  });

  // Pinned. Both are rendered verbatim inside the `role="alert"` paragraph:
  //
  //   "a Sound Chat pairing code is exactly 8 characters; that one is 3"
  //   "\"I\" cannot appear in a Sound Chat pairing code; the alphabet is
  //    23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
  //
  // Lower-case openers, a semicolon instead of a full stop, and a raw alphabet
  // string. The content is right and actionable — the test above proves that —
  // but master plan constraint 6 asks for a sentence the user can act on, and
  // these read as an exception message. `validatePairingCode` is in
  // `src/lib/sound-chat/crypto.ts`, which is not this file's to edit; the fix is
  // two `PairingCodeError` strings, or a mapping in `copy.ts`.
  it("every pairing-code message reads as a sentence, not developer prose", () => {
    const messages: string[] = [];
    for (const input of ["ABC", "ABCD234I"]) {
      try {
        validatePairingCode(input);
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      // One opens with the offending character in quotes — which is the point
      // of that sentence, and is how the offending character is named — so it
      // starts with a quote rather than a capital. The other opens with a
      // capital. Both end as sentences, which is the actual defect fixed here:
      // both used to read as exception prose.
      expect(message).toMatch(/^([A-Z]|")/);
      expect(message).toMatch(/[.!]$/);
      expect(message).not.toMatch(/\bthe alphabet is\b/);
    }
  });
});

/* ================================================================== *
 * A8 — the progress bar.
 * ================================================================== */

describe("A8 the progress bar is determinate, finite, and out of the live region", () => {
  it("carries min, max, now, a label and a non-empty valuetext whenever it renders", () => {
    for (const state of ALL_STATES) {
      const markup = render(
        <TransmitStatus
          transport={state}
          transmitting={state === "transmitting"}
          progress={{ blocks: 2, blockIndex: 1, fraction: 0.5, remainingMs: 1920 }}
        />,
      );
      const bar = /<div[^>]*role="progressbar"[^>]*>/.exec(markup)?.[0];
      expect(bar, `${state}: no bar`).toBeTruthy();
      expect(bar).toMatch(/aria-valuemin="0"/);
      expect(bar).toMatch(/aria-valuemax="100"/);
      expect(bar).toMatch(/aria-valuenow="\d+"/);
      expect(bar).toMatch(/aria-label="[^"]+"/);
      const valueText = /aria-valuetext="([^"]*)"/.exec(bar ?? "")?.[1] ?? "";
      expect(valueText, `${state}: an empty valuetext`).not.toBe("");
      expect(valueText, `${state}: a valuetext that is not a number`).not.toMatch(/NaN|Infinity/);
    }
  });

  it("never renders NaN, Infinity or an out-of-range value, whatever the props permit", () => {
    for (const fraction of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -3,
      7.5,
    ]) {
      for (const remainingMs of [Number.NaN, Number.POSITIVE_INFINITY, -5000]) {
        const markup = render(
          <TransmitStatus
            transport="transmitting"
            transmitting
            progress={{ blocks: 2, blockIndex: 2, fraction, remainingMs }}
          />,
        );
        expect(markup, `fraction=${String(fraction)}`).not.toMatch(/NaN|Infinity/);
        const now = Number(/aria-valuenow="([^"]*)"/.exec(markup)?.[1] ?? "-1");
        expect(Number.isFinite(now), `aria-valuenow was ${String(now)}`).toBe(true);
        expect(now).toBeGreaterThanOrEqual(0);
        expect(now).toBeLessThanOrEqual(100);
      }
    }
  });

  it("is not focusable and not interactive, because it is a readout and not a control", () => {
    const markup = render(
      <TransmitStatus
        transport="transmitting"
        transmitting
        progress={{ blocks: 1, blockIndex: 1, fraction: 0.5, remainingMs: 960 }}
      />,
    );
    const bar = /<div[^>]*role="progressbar"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(bar).not.toMatch(/tabindex/);
    expect(bar).not.toMatch(/\sonClick/);
    expect(bar).not.toMatch(/aria-disabled/);
  });

  it("stops moving under prefers-reduced-motion, and never freezes invisible", () => {
    // The global rule collapses every animation to one 0.01 ms iteration, so an
    // animated element lands on its 100% keyframe. Both animations this feature
    // drives must therefore have a *visible* 100% frame, or a reduced-motion
    // user loses the indicator entirely.
    const reduced =
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(STYLES)?.[1] ?? "";
    expect(reduced, "no prefers-reduced-motion block in styles.css").not.toBe("");
    expect(reduced).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reduced).toMatch(/animation-iteration-count:\s*1\s*!important/);
    for (const animation of ["dot-pulse", "waiting-glow"]) {
      expect(STYLES, `${animation} is not defined in styles.css`).toContain(animation);
      const keyframes =
        new RegExp(`@keyframes ${animation} \\{([\\s\\S]*?)\\n  \\}`).exec(STYLES)?.[1] ?? "";
      const lastFrame = /100% \{([\s\S]*?)\}/.exec(keyframes)?.[1] ?? "";
      expect(lastFrame, `${animation} has no 100% keyframe`).not.toBe("");
      // Visible at rest: not `opacity: 0`, and not scaled out of existence.
      const opacity = /opacity:\s*([\d.]+)/.exec(lastFrame)?.[1];
      expect(opacity, `${animation} freezes with no opacity`).toBeTruthy();
      expect(Number(opacity), `${animation} freezes invisible`).toBeGreaterThan(0.2);
    }
    // And nothing in the feature animates on its own terms.
    const sources = componentSources();
    expect(sources).not.toMatch(/style=\{\{[^}]*animation/);
    expect(sources).not.toMatch(/\banimate-\[/);
  });
});

/* ================================================================== *
 * A9 — colour is never the only cue.
 * ================================================================== */

describe("A9 no state is carried by colour alone", () => {
  it("every outbound status has a word, and every non-playing one has an icon", () => {
    const source = componentFile("message-list.tsx");
    // The three statuses differ by text alone, so colour is redundant. But two
    // of them also carry an icon, and the one that does not is the one whose
    // text is the only thing saying the note has not been confirmed.
    for (const status of ["sending", "sent", "failed"] as const) {
      const markup = render(
        <MessageList
          inbound={[]}
          outbound={[{ seq: 1, msgId: 1, text: "n", sendId: 1, status, attempts: 1, blocks: 1 }]}
        />,
      );
      expect(markup, status).toContain(SOUND_CHAT_COPY.outbound[status]);
    }
    expect(source).toMatch(/view\.status === "sent" \? <CheckIcon/);
    expect(source).toMatch(/view\.status === "failed" \? <ErrorMark/);
  });

  it("every transport tone is paired with a sentence, and no tone is the only signal", () => {
    const source = componentFile("transmit-status.tsx");
    // The dot is `aria-hidden`, so the sentence is the whole signal — which is
    // correct, and is why every state needs a sentence that differs.
    expect(source).toMatch(/aria-hidden="true"/);
    const sentences = ALL_STATES.map((state) => transportSentence(state));
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const state of ALL_STATES) {
      const markup = render(
        <TransmitStatus
          transport={state}
          transmitting={state === "transmitting"}
          progress={null}
        />,
      );
      expect(markup, state).toContain(sentences[ALL_STATES.indexOf(state)] ?? "");
    }
  });

  it("every notice tone has a word that survives without the colour", () => {
    const source = componentFile("sound-chat-screen.tsx");
    for (const tone of ["danger", "warn"]) {
      expect(source, `no ${tone} notice tone`).toContain(`text-${tone}`);
    }
    // The list itself is not a live region and has a label, so the tones are for
    // reading; the text is the message, not a colour name.
    expect(source).toContain("aria-label={SOUND_CHAT_COPY.shell.noticesLabel}");
    const list = render(
      <div>
        <ul aria-label={SOUND_CHAT_COPY.shell.noticesLabel}>
          <li className="text-caption text-danger">The channel was busy.</li>
        </ul>
      </div>,
    );
    expect(list).toContain("The channel was busy.");
  });

  it("the privacy limits that carry a shield are not distinguished by the shield alone", () => {
    // The shield is `aria-hidden`, so the shape that says "this is a guarantee"
    // reaches nobody but a sighted user. Each of those sentences has to stand on
    // its own, which is why they are checked for their own subject.
    const markup = render(<PermissionPrompt onDisplay={noop} onEnter={noop} onDismiss={noop} />);
    const guarded = [SOUND_CHAT_COPY.permission.limits[2], SOUND_CHAT_COPY.permission.limits[3]];
    for (const sentence of guarded ?? []) {
      expect(markup).toContain(sentence.slice(0, 40));
      // Each names its own subject rather than leaning on an icon.
      expect(sentence).toMatch(/\b(recording|Pairing|pairing)\b/);
    }
  });
});

/* ================================================================== *
 * A10 — measured contrast of the tokens this feature's own text uses.
 * ================================================================== */

/** OKLab to LINEAR sRGB. The matrix alone — no transfer function. */
function oklabToLinearSrgb(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** The sRGB transfer function, gamma-encoding linear to display. Applied ONCE. */
function encode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
}

const inSrgbGamut = ([r, g, b]: readonly [number, number, number]): boolean =>
  [r, g, b].every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/**
 * OKLCH to DISPLAY sRGB — the quantity a WCAG contrast ratio is defined over.
 *
 * WHY THIS FUNCTION WAS REWRITTEN IN PHASE 3V. It used to return the OKLab
 * matrix's output directly, which is *linear* sRGB, and hand that straight to
 * `luminance()`, which applies the sRGB transfer function again. That is a
 * double-linearisation: it measured a different quantity from the one WCAG
 * defines. It was exact on pure black and pure white — which is why it looked
 * plausible — and wrong everywhere else.
 *
 * The consequence was not cosmetic. It reported `--ink-faint` on the canvas at
 * **4.23:1** when the true figure is **7.79:1**, and this file asserted
 * `toBeLessThan(4.5)` on that number as a "pinned defect". The token was never
 * below 4.5:1. The Phase 3 log entry that recorded "text-ink-faint at
 * 4.19-4.26:1 against a 4.5:1 requirement" is therefore false, and it is
 * corrected in this phase's log entry rather than left standing.
 *
 * WHY GAMUT MAPPING AND NOT CLAMPING. A saturated token such as
 * `--accent: oklch(0.836 0.236 135.4)` is outside sRGB. Clamping each channel
 * independently shifts the hue and lightness and produces badly wrong ratios
 * (it reported `--accent` at 1.35:1, which is absurd for a light colour on a
 * dark canvas). Browsers reduce *chroma* until the colour fits, so that is what
 * this does — a binary search, which is what CSS Color 4 specifies.
 */
function oklch(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  const at = (chroma: number) => oklabToLinearSrgb(L, chroma * Math.cos(h), chroma * Math.sin(h));
  let chroma = C;
  if (!inSrgbGamut(at(C))) {
    let low = 0;
    let high = C;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inSrgbGamut(at(mid))) low = mid;
      else high = mid;
    }
    chroma = low;
  }
  return at(chroma).map((c) => Math.min(1, Math.max(0, encode(c)))) as [number, number, number];
}

function luminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const hi = Math.max(luminance(a), luminance(b));
  const lo = Math.min(luminance(a), luminance(b));
  return (hi + 0.05) / (lo + 0.05);
}

function over(
  foreground: readonly [number, number, number],
  alpha: number,
  background: readonly [number, number, number],
): [number, number, number] {
  return [
    foreground[0] * alpha + background[0] * (1 - alpha),
    foreground[1] * alpha + background[1] * (1 - alpha),
    foreground[2] * alpha + background[2] * (1 - alpha),
  ];
}

/** The dark theme, which is the one that actually renders: `__root.tsx` adds `.dark` unconditionally. */
const DARK = {
  canvas: oklch(0.233, 0.031, 135.6),
  surface: oklch(0.268, 0.035, 136.8),
  sunken: oklch(0.206, 0.026, 135.5),
  ink: oklch(0.962, 0.016, 133.8),
  muted: oklch(0.799, 0.036, 134.6),
  faint: oklch(0.758, 0.036, 134.6),
  accent: oklch(0.836, 0.236, 135.4),
  ok: oklch(0.816, 0.219, 147.3),
  warn: oklch(0.8, 0.1, 85),
  danger: oklch(0.759, 0.144, 26.1),
} as const;

/** Every background the feature's own text is actually painted on. */
const BACKGROUNDS: readonly (readonly [string, [number, number, number]])[] = [
  ["canvas", DARK.canvas],
  ["surface", DARK.surface],
  ["surface-sunken", DARK.sunken],
  // `Panel` is `bg-black/40` over the canvas, `composer-bar` and `chat-header`
  // are their own translucent oklch, and `backdrop-blur` never gets lighter
  // than what is behind it, so these are the composited values.
  ["panel(bg-black/40)", over([0, 0, 0], 0.4, DARK.canvas)],
  ["composer-bar", over(oklch(0.26, 0.034, 137), 0.88, DARK.canvas)],
  ["chat-header", over(oklch(0.26, 0.034, 137), 0.85, DARK.canvas)],
];

describe("A10 measured contrast of the tokens this feature's text is painted in", () => {
  it("the converter is right, or none of the numbers below mean anything", () => {
    // Four ratios published by WCAG, none of them pure black on white. The old
    // self-test asserted `oklch(0.5, 0, 0)[0] === 0.125`, which *certified the
    // double-linearisation* — 0.125 is the LINEAR value, and asserting it made
    // the bug look like the specification. A self-test has to check against
    // something external, or it only proves the function matches itself.
    expect(oklch(1, 0, 0)[0]).toBeCloseTo(1, 6);
    expect(oklch(0, 0, 0)[0]).toBeCloseTo(0, 6);
    // OKLab L of 0.5 is mid grey: 0.3886 in DISPLAY sRGB, and 0.125 linear. The
    // old converter returned the linear value here and called it display.
    expect(oklch(0.5, 0, 0)[0]).toBeCloseTo(0.3886, 4);
    expect(
      oklch(0.5, 0, 0)[0],
      "the linear value, which the old converter returned",
    ).not.toBeCloseTo(0.125, 3);
    // WCAG's own worked examples.
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 2);
    expect(contrast([1, 1, 1], [0x77 / 255, 0x77 / 255, 0x77 / 255])).toBeCloseTo(4.48, 2);
    expect(contrast([0, 0, 0], [1, 1, 0])).toBeCloseTo(19.56, 2);
    expect(contrast([1, 1, 1], [0x11 / 255, 0x88 / 255, 1])).toBeCloseTo(3.53, 1);
    // And a colour that is neither black nor white, which is exactly where the
    // old pipeline failed.
    expect(contrast([1, 1, 1], [0.5, 0.5, 0.5])).toBeCloseTo(3.98, 2);
  });

  it("the theme that renders is the dark one", () => {
    expect(ROOT_ROUTE).toMatch(/classList\.add\("dark"\)/);
    expect(STYLES).toMatch(/\.dark\s*\{[\s\S]*?--ink-faint: oklch\(0\.758/);
  });

  it("the tokens that pass, pass on every background the feature uses", () => {
    // 4.5:1 is WCAG 1.4.3 for normal-size text, and every one of these is
    // `text-caption` (12.5px) or `text-body` (15px) — never large text.
    for (const token of ["ink", "muted", "accent", "ok", "warn", "danger"] as const) {
      for (const [background, colour] of BACKGROUNDS) {
        const ratio = contrast(DARK[token], colour);
        expect(
          ratio,
          `text-${token} on ${background} is ${ratio.toFixed(2)}:1, under 4.5:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("`ink-faint` clears 4.5:1 everywhere, so no component may lean on that fact", () => {
    // INVERTED IN PHASE 3V, and this is the correction of a logged false finding.
    //
    // This test used to read `expect(contrast(DARK.faint, DARK.canvas)).toBeLessThan(4.5)`
    // and carry the comment "`--ink-faint` paints every background this feature
    // uses at 4.19-4.26:1 and WCAG 1.4.3 asks 4.5:1". That number came from a
    // converter which returned the OKLab matrix's output — *linear* sRGB — and
    // fed it straight to a `luminance()` that applied the sRGB transfer function
    // again. Measured on the corrected converter, here and independently by a
    // script written from WCAG's definition: the real figure is **7.79:1**, and
    // the token is not below 4.5:1 on any background this feature uses.
    //
    // So the token does not need avoiding. The decision the Phase 3 audit made
    // (the feature uses `text-ink-muted` throughout and never `text-ink-faint`
    // for meaningful text) is still the right one — it is a token-semantics
    // choice, not a rescue job — but it is now recorded as a preference, with the
    // measurement behind it, rather than as a fix for a defect that never existed.
    for (const [name, colour] of BACKGROUNDS) {
      expect(
        contrast(DARK.faint, colour),
        `text-ink-faint on ${name} — the measurement this comment used to get wrong`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never paints meaningful text in ink-faint", () => {
    for (const [name, colour] of BACKGROUNDS) {
      expect(contrast(DARK.muted, colour), `text-ink-muted on ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    // A preference rather than a requirement, now that the token measures above
    // 4.5:1 everywhere: meaningful text goes in `ink-muted`, and the reason is
    // that `--ink-faint` is the token for decoration and separators in the rest
    // of the app, not a second text colour.
    for (const source of componentSources()) {
      expect(source, "a component uses text-ink-faint").not.toContain("text-ink-faint");
    }
  });

  it("names every place the feature paints its smallest text", () => {
    // REWRITTEN IN PHASE 3V. This block was headed "names every place the feature
    // puts meaningful text in ink-faint", which described a defect that was
    // already fixed in the same working tree when the block was written: every
    // pattern below matches `text-ink-muted`, and the assertion is that it does.
    // It is the same class as the four "Pinned" blocks the Phase 3 log already
    // records as finding 12 — a comment that names a defect that no longer
    // exists, so a reader cannot tell whether the fix landed.
    //
    // What it is genuinely for: the *blast radius* of that decision. If any of
    // these ever reverts to `text-ink-faint`, this names the place.
    const users: readonly (readonly [string, RegExp])[] = [
      ["info-panel.tsx: the attribution line", /text-caption text-ink-muted/],
      ["info-panel.tsx: the licence text", /text-\[11px\][^"]*text-ink-muted/],
      ["composer.tsx: the byte hint", /text-caption text-ink-muted/],
      ["sound-chat-screen.tsx: the notice dismissal", /text-caption text-ink-muted underline/],
      ["blocked-panel.tsx: the raw diagnostic", /text-caption text-ink-muted wrap-anywhere/],
      ["fatal-panel.tsx: the raw diagnostic", /text-caption text-ink-muted wrap-anywhere/],
      ["permission-prompt.tsx: the pre-prompt prose", /text-caption text-ink-muted/],
      ["pairing-panel.tsx: the waiting hint", /text-caption text-ink-muted/],
    ];
    for (const [label, pattern] of users) {
      const file = label.split(":")[0] ?? "";
      expect(componentFile(file), `${label} is no longer there`).toMatch(pattern);
    }
    // The composer's own status line for an unconfirmed note is the worst of
    // them: it is the only signal, it is in a log that is additions-only, and it
    // never changes colour because it never changes state back.
    const sending = render(
      <MessageList
        inbound={[]}
        outbound={[
          { seq: 1, msgId: 1, sendId: 1, text: "n", status: "sending", attempts: 1, blocks: 1 },
        ]}
      />,
    );
    expect(sending).toMatch(/class="[^"]*text-ink-muted/);
  });
});

/* ================================================================== *
 * A11 — landmarks, headings and the route.
 * ================================================================== */

describe("A11 the page has one h1, an ordered outline and the landmarks a reader needs", () => {
  // Pinned. The fix is two tags: `permission-prompt.tsx` and `pairing-panel.tsx`
  // each render `<h1 id={headingId}>` inside `<main>`, and both files are this
  // feature's. Changing them to `<h2>` leaves the visual identical (the class is
  // `text-title text-ink` either way) and the outline ordered, because
  // `blocked-panel.tsx` and `fatal-panel.tsx` already use `<h2>` under the same
  // shell.
  //
  // It is not applied here because `render.test.tsx` — which lives in the same
  // directory and is not this file's — asserts `<h1 id="` on the permission
  // prompt, and editing another test to accommodate a heading-level change is a
  // collision risk that a best-practice finding is not worth. Invert both pins
  // when that test is next touched.
  // Pinned. The shell's `<h1>Sound Chat</h1>` is the page title. The permission
  // and pairing panels each render their own `<h1>` inside `<main>`, so a
  // heading list shows two level-1 headings and neither is clearly the page's.
  // WCAG 2.1 has no "exactly one h1" criterion — this is a best-practice
  // finding, not a failure — and the markup cannot tell us which one a screen
  // reader would call the page title, only that there are two.
  it("the composed screen has exactly one level-1 heading", () => {
    const markup = render(<SoundChatScreen />);
    expect(markup.match(/<h1/g) ?? []).toHaveLength(1);
  });

  it("no panel renders its own level-1 heading", () => {
    for (const source of componentSources()) {
      expect(source, "a component renders its own <h1>").not.toMatch(/<h1\b/);
    }
  });

  it("the two failure screens are already correct about their heading level", () => {
    for (const file of ["blocked-panel.tsx", "fatal-panel.tsx"]) {
      expect(componentFile(file), `${file} should carry an h2 under the shell's h1`).toMatch(
        /<h2\b/,
      );
    }
  });

  it("the heading order never skips a level", () => {
    const markup = render(<SoundChatScreen />);
    const levels = [...markup.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1] ?? 0));
    expect(levels.length, "no headings at all").toBeGreaterThan(0);
    expect(levels[0]).toBe(1);
    for (let at = 1; at < levels.length; at += 1) {
      const previous = levels[at - 1] ?? 0;
      const current = levels[at] ?? 0;
      expect(
        current - previous,
        `heading jumped from h${previous} to h${current}`,
      ).toBeLessThanOrEqual(1);
    }
  });

  it("the shell provides banner and main, and every region is named", () => {
    const markup = render(<SoundChatScreen />);
    expect(markup).toMatch(/<header\b/);
    expect(markup).toMatch(/<main\b/);
    // Exactly one `<main>`, or the landmark is ambiguous.
    expect((markup.match(/<main\b/g) ?? []).length).toBe(1);
    // Every `<section>` is either named or the un-named `Panel` primitive, which
    // maps to `generic` and is therefore not a landmark at all.
    const sections = [...markup.matchAll(/<section\b[^>]*>/g)].map((match) => match[0]);
    const panels = sections.filter((tag) => !/aria-label/.test(tag));
    for (const tag of sections) {
      if (panels.includes(tag)) continue;
      expect(tag, "an unnamed section is a nameless landmark").toMatch(/aria-labelledby="[^"]+"/);
    }
  });

  it("the route sets a title and a description, and the document has a language", () => {
    expect(ROUTE).toMatch(/title:\s*"Sound Chat — Husk"/);
    expect(ROUTE).toMatch(/name:\s*"description"/);
    expect(ROOT_ROUTE).toMatch(/<html lang="en">/);
    // The route must not set its own `lang`, or it would fight the document's.
    expect(ROUTE).not.toMatch(/\blang\b/);
    // And the description must be true of the medium.
    expect(/content:\s*"([^"]+)"/.exec(ROUTE)?.[1] ?? "").toMatch(/audible/i);
  });

  it("the entry's own two sentences are regions, not a blank frame", () => {
    const loading = render(<SoundChatEntry />);
    expect(loading).toContain('role="status"');
    expect(loading).toContain(SOUND_CHAT_ENTRY_COPY.loading);
    const failed = render(<SoundChatEntry />);
    // Effects do not run, so the failure frame is reached through its source
    // rather than its markup: the one thing it must never be is a blank page.
    const source = componentFile("sound-chat-entry.tsx");
    expect(source).toMatch(/if \(failed\)[\s\S]*?role="alert"/);
    expect(source).toContain("SOUND_CHAT_ENTRY_COPY.failed");
    expect(failed).toContain(SOUND_CHAT_ENTRY_COPY.loading);
  });
});
