/**
 * Room store.
 *
 * Holds the decrypted, in-memory view of a room for the current tab. Nothing
 * here is persisted: closing the tab discards it, which is the point.
 */

import { create } from "zustand";
import { joinRoom } from "./api";
import { ACK_TIMEOUT_MS, PEER_GRACE_MS } from "./config";
import {
  RoomConnection,
  type ConnectionEndReason,
  type ConnectionHandlers,
  type ConnectionStatus,
} from "./connection";
import { DecryptionFailedError, open, seal, importRoomKey } from "./crypto";
import type { Participant, SealedBody, SealedEnvelope, ServerMessage } from "./protocol";
import { transition, type RoomEvent, type RoomState } from "./room-machine";

export type DeliveryState = "sending" | "sent" | "failed" | "unverified";

export type ChatEntry = {
  readonly id: string;
  readonly seq: number;
  readonly mine: boolean;
  readonly senderId: string;
  readonly ts: number;
  readonly delivery: DeliveryState;
  readonly body: SealedBody | null;
  readonly system?: string;
};

/** Minimal connection surface the store depends on (injectable for tests). */
export type ConnectionLike = {
  connect(): void;
  close(): void;
  resetBackoff(): void;
  send(localId: string, payload: SealedEnvelope): boolean;
  sendControl(frame: { t: "cancel"; fileId: string }): boolean;
};

export type ConnectionSpawner = (roomId: string, handlers: ConnectionHandlers) => ConnectionLike;

type RoomStore = {
  state: RoomState;
  status: ConnectionStatus;
  /** Browser connectivity signal (navigator.onLine via window events). */
  online: boolean;
  roomId: string;
  selfId: string;
  participants: readonly Participant[];
  entries: readonly ChatEntry[];
  /** Wall-clock time of the most recent peer leave; deadline for the grace UI. */
  lastLeaveAt: number | null;
  malformedCount: number;
  error: string | null;
  connect: (roomId: string, keyFragment: string) => Promise<void>;
  retry: () => Promise<void>;
  notifyOnline: () => void;
  notifyOffline: () => void;
  sendText: (text: string) => Promise<void>;
  sendFileMessage: (body: SealedBody) => Promise<void>;
  markFailed: (id: string) => void;
  retryMessage: (id: string) => Promise<void>;
  cancelFile: (fileId: string) => void;
  leave: () => void;
};

function nextId(): string {
  return crypto.randomUUID();
}

export function createRoomStore(
  spawnConnection: ConnectionSpawner = (roomId, handlers) => new RoomConnection(roomId, handlers),
) {
  let connection: ConnectionLike | null = null;
  let roomKey: CryptoKey | null = null;
  let keyFragment: string | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const ackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const seenRelays = new Set<string>();

  function clearAckTimer(id: string): void {
    const timer = ackTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      ackTimers.delete(id);
    }
  }

  function clearAllAckTimers(): void {
    for (const timer of ackTimers.values()) {
      clearTimeout(timer);
    }
    ackTimers.clear();
  }

  function armAckTimer(id: string): void {
    clearAckTimer(id);
    ackTimers.set(
      id,
      setTimeout(() => {
        ackTimers.delete(id);
        store.getState().markFailed(id);
      }, ACK_TIMEOUT_MS),
    );
  }

  /** Gives buffered-but-unacked frames a fresh window after a reconnect. */
  function armPendingAcks(): void {
    for (const entry of store.getState().entries) {
      if (entry.mine && entry.delivery === "sending") {
        armAckTimer(entry.id);
      }
    }
  }
  function apply(event: RoomEvent): void {
    store.setState((current) => ({ state: transition(current.state, event) }));
  }

  function pushSystem(text: string): void {
    store.setState((current) => ({
      entries: [
        ...current.entries,
        {
          id: nextId(),
          seq: Number.MAX_SAFE_INTEGER,
          mine: false,
          senderId: "system",
          ts: Date.now(),
          delivery: "sent",
          body: null,
          system: text,
        },
      ],
    }));
  }

  function armGraceTimer(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
    }
    graceTimer = setTimeout(checkGrace, PEER_GRACE_MS);
  }

  /**
   * Grace expiry is derived from the leave deadline, not from whichever timer
   * happened to survive concurrent leaves and joins: the callback re-checks
   * `lastLeaveAt` and reschedules when a newer leave restarted the window.
   */
  function checkGrace(): void {
    graceTimer = null;
    const last = store.getState().lastLeaveAt;
    if (last === null) {
      return;
    }
    const elapsed = Date.now() - last;
    if (elapsed < PEER_GRACE_MS) {
      graceTimer = setTimeout(checkGrace, PEER_GRACE_MS - elapsed);
      return;
    }
    const peers = store.getState().participants.length;
    if (peers <= 1) {
      pushSystem("A participant left the room.");
    }
    apply({ type: "GRACE_EXPIRED", peers });
  }

  function handleEnded(reason: ConnectionEndReason): void {
    clearAllAckTimers();
    stopGrace();
    if (reason === "join_refused_unavailable") {
      apply({ type: "ROOM_NOT_FOUND" });
    } else if (reason === "join_refused_rate_limited") {
      apply({ type: "RATE_LIMITED" });
    } else {
      apply({ type: "CONNECTION_LOST" });
    }
    store.setState({ status: "closed" });
  }

  function stopGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  async function handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case "welcome": {
        stopGrace();
        store.setState({
          selfId: message.you,
          participants: message.participants,
          lastLeaveAt: null,
        });
        apply({ type: "CONNECTED", peers: message.participants.length });
        apply({ type: "RECONNECTED", peers: message.participants.length });
        break;
      }
      case "presence": {
        store.setState({ participants: message.participants });
        if (message.event === "join") {
          store.setState({ lastLeaveAt: null });
          stopGrace();
          apply({ type: "PEER_JOINED" });
        } else {
          store.setState({ lastLeaveAt: Date.now() });
          apply({ type: "PEER_LEFT", peers: message.participants.length });
          armGraceTimer();
        }
        break;
      }
      case "ack": {
        clearAckTimer(message.localId);
        store.setState((current) => ({
          entries: current.entries.map((entry) =>
            entry.id === message.localId ? { ...entry, seq: message.seq, delivery: "sent" } : entry,
          ),
        }));
        break;
      }
      case "relay": {
        const key = roomKey;
        if (key === null) {
          return;
        }
        const mine = message.senderId === store.getState().selfId;
        if (seenRelays.has(message.localId)) {
          // Receiver-side dedup: a resend after a lost ack must not produce a
          // second bubble; only the sender's own copy gets resolved.
          if (mine) {
            store.setState((current) => ({
              entries: current.entries.map((entry) =>
                entry.id === message.localId
                  ? { ...entry, seq: message.seq, delivery: "sent" }
                  : entry,
              ),
            }));
          }
          return;
        }
        // Registered before the async decrypt so a duplicate arriving mid-
        // decrypt cannot also slip past the check.
        seenRelays.add(message.localId);
        if (mine) {
          store.setState((current) => ({
            entries: current.entries.map((entry) =>
              entry.id === message.localId
                ? { ...entry, seq: message.seq, delivery: "sent" }
                : entry,
            ),
          }));
          return;
        }
        const roomBefore = { roomId: store.getState().roomId, state: store.getState().state };
        try {
          const body = await open<SealedBody>(key, message.payload);
          if (isStale(roomBefore)) {
            return;
          }
          store.setState((current) => ({
            entries: [
              ...current.entries,
              {
                id: message.localId,
                seq: message.seq,
                mine: false,
                senderId: message.senderId,
                ts: message.ts,
                delivery: "sent",
                body,
              },
            ],
          }));
        } catch (error) {
          if (error instanceof DecryptionFailedError && !isStale(roomBefore)) {
            store.setState((current) => ({
              entries: [
                ...current.entries,
                {
                  id: message.localId,
                  seq: message.seq,
                  mine: false,
                  senderId: message.senderId,
                  ts: message.ts,
                  delivery: "unverified",
                  body: null,
                },
              ],
            }));
          }
        }
        break;
      }
      case "closed": {
        apply({ type: message.reason === "expired" ? "EXPIRED" : "LEAVE" });
        clearAllAckTimers();
        stopGrace();
        connection?.close();
        connection = null;
        break;
      }
      case "error": {
        if (message.code === "room_full") {
          apply({ type: "ROOM_FULL" });
        }
        break;
      }
      case "pong":
        break;
      default:
        break;
    }
  }

  /** Guards against a late async decrypt writing into a reset room. */
  function isStale(before: { roomId: string; state: RoomState }): boolean {
    const current = store.getState();
    return current.roomId !== before.roomId || current.state !== before.state;
  }

  async function publish(body: SealedBody): Promise<void> {
    const key = roomKey;
    const active = connection;
    if (key === null || active === null) {
      return;
    }
    const id = nextId();
    store.setState((current) => ({
      entries: [
        ...current.entries,
        {
          id,
          seq: Number.MAX_SAFE_INTEGER,
          mine: true,
          senderId: current.selfId,
          ts: Date.now(),
          delivery: "sending",
          body,
        },
      ],
    }));
    try {
      const sealed = await seal(key, body);
      active.send(id, sealed);
      armAckTimer(id);
    } catch {
      store.getState().markFailed(id);
    }
  }

  const store = create<RoomStore>((set, get) => ({
    state: "idle",
    status: "closed",
    // Node 21+ exposes a `navigator` without `onLine`; a missing flag counts
    // as online so tests and SSR never start in a phantom-offline state.
    online: typeof navigator === "undefined" ? true : navigator.onLine !== false,
    roomId: "",
    selfId: "",
    participants: [],
    entries: [],
    lastLeaveAt: null,
    malformedCount: 0,
    error: null,

    async connect(roomId, fragment) {
      store.setState({
        roomId,
        state: "joining",
        entries: [],
        error: null,
        lastLeaveAt: null,
        malformedCount: 0,
      });
      seenRelays.clear();
      try {
        roomKey = await importRoomKey(fragment);
      } catch {
        store.setState({
          state: "closed_not_found",
          error: "This link is missing a valid room key.",
        });
        return;
      }
      keyFragment = fragment;
      connection?.close();
      connection = spawnConnection(roomId, {
        onMessage: (message) => {
          void handleServerMessage(message);
        },
        onStatus: (status) => {
          store.setState({ status });
          if (status === "reconnecting") {
            apply({ type: "DISCONNECTED" });
          }
          if (status === "open") {
            armPendingAcks();
          }
        },
        onEnded: handleEnded,
        onMalformed: () => {
          store.setState((current) => ({ malformedCount: current.malformedCount + 1 }));
          console.warn(
            `Husk: dropped a malformed relay frame (total ${store.getState().malformedCount}).`,
          );
        },
        fetchJoinToken: () => joinRoom(roomId),
      });
      connection.connect();
    },

    async retry() {
      const roomId = store.getState().roomId;
      const fragment = keyFragment;
      if (roomId.length === 0 || fragment === null) {
        return;
      }
      await store.getState().connect(roomId, fragment);
    },

    notifyOffline() {
      store.setState({ online: false });
    },

    notifyOnline() {
      store.setState({ online: true });
      // Back online: drop the backoff budget and reconnect immediately.
      connection?.resetBackoff();
      // A connection that already reached its terminal state never retries on
      // its own; coming back online is exactly the moment to try again.
      if (store.getState().state === "closed_disconnected") {
        void store.getState().retry();
      }
    },

    async sendText(text) {
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        return;
      }
      await publish({ kind: "text", text: trimmed, sentAt: Date.now() });
    },

    async sendFileMessage(body) {
      await publish(body);
    },

    markFailed(id) {
      clearAckTimer(id);
      store.setState((current) => ({
        entries: current.entries.map((entry) =>
          entry.id === id ? { ...entry, delivery: "failed" } : entry,
        ),
      }));
    },

    async retryMessage(id) {
      const entry = store.getState().entries.find((candidate) => candidate.id === id);
      if (
        entry === undefined ||
        !entry.mine ||
        entry.delivery !== "failed" ||
        entry.body === null
      ) {
        return;
      }
      const key = roomKey;
      const active = connection;
      if (key === null || active === null) {
        return;
      }
      try {
        const sealed = await seal(key, entry.body);
        store.setState((current) => ({
          entries: current.entries.map((candidate) =>
            candidate.id === id ? { ...candidate, delivery: "sending" } : candidate,
          ),
        }));
        active.send(id, sealed);
        armAckTimer(id);
      } catch {
        store.getState().markFailed(id);
      }
    },

    cancelFile(fileId) {
      connection?.sendControl({ t: "cancel", fileId });
    },

    leave() {
      connection?.close();
      connection = null;
      roomKey = null;
      keyFragment = null;
      seenRelays.clear();
      clearAllAckTimers();
      stopGrace();
      store.setState({
        state: "closed_by_host",
        status: "closed",
        entries: [],
        participants: [],
        lastLeaveAt: null,
      });
    },
  }));

  // Browser connectivity signal. The default store is a page-lifetime
  // singleton, so these listeners intentionally live for the page's lifetime;
  // test stores run under Node, where `window` is undefined and nothing is
  // registered (same guard covers SSR).
  if (typeof window !== "undefined") {
    window.addEventListener("offline", () => store.getState().notifyOffline());
    window.addEventListener("online", () => store.getState().notifyOnline());
  }

  return store;
}

export type RoomStoreApi = ReturnType<typeof createRoomStore>;

export const useRoomStore = createRoomStore();

/** True while the grace window opened by the last peer leave is still running. */
export function inGraceWindow(lastLeaveAt: number | null, now: number): boolean {
  return lastLeaveAt !== null && now - lastLeaveAt < PEER_GRACE_MS;
}

/** Sorted by the server sequence number; client timestamps are display-only. */
export function orderedEntries(entries: readonly ChatEntry[]): ChatEntry[] {
  return [...entries].sort((a, b) => (a.seq === b.seq ? a.ts - b.ts : a.seq - b.seq));
}
