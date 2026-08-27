/**
 * Room store.
 *
 * Holds the decrypted, in-memory view of a room for the current tab. Nothing
 * here is persisted: closing the tab discards it, which is the point.
 */

import { create } from "zustand";
import { joinRoom } from "./api";
import { PEER_GRACE_MS } from "./config";
import { RoomConnection, type ConnectionStatus } from "./connection";
import { DecryptionFailedError, open, seal, importRoomKey } from "./crypto";
import type { Participant, SealedBody, ServerMessage } from "./protocol";
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

type RoomStore = {
  state: RoomState;
  status: ConnectionStatus;
  pin: string;
  selfId: string;
  participants: readonly Participant[];
  entries: readonly ChatEntry[];
  error: string | null;
  connect: (pin: string, keyFragment: string) => Promise<void>;
  sendText: (text: string) => Promise<void>;
  sendFileMessage: (body: SealedBody) => Promise<void>;
  markFailed: (id: string) => void;
  cancelFile: (fileId: string) => void;
  leave: () => void;
};

let connection: RoomConnection | null = null;
let roomKey: CryptoKey | null = null;
let graceTimer: ReturnType<typeof setTimeout> | null = null;

function nextId(): string {
  return crypto.randomUUID();
}

export const useRoomStore = create<RoomStore>((set, get) => {
  function apply(event: RoomEvent): void {
    set((current) => ({ state: transition(current.state, event) }));
  }

  function pushSystem(text: string): void {
    set((current) => ({
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

  async function handleServerMessage(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case "welcome": {
        set({ selfId: message.you, participants: message.participants });
        apply({ type: "CONNECTED", peers: message.participants.length });
        apply({ type: "RECONNECTED", peers: message.participants.length });
        break;
      }
      case "presence": {
        set({ participants: message.participants });
        if (message.event === "join") {
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
            graceTimer = null;
          }
          apply({ type: "PEER_JOINED" });
        } else {
          apply({ type: "PEER_LEFT", peers: message.participants.length });
          if (graceTimer !== null) {
            clearTimeout(graceTimer);
          }
          graceTimer = setTimeout(() => {
            graceTimer = null;
            const peers = get().participants.length;
            if (peers <= 1) {
              pushSystem("A participant left the room.");
            }
            apply({ type: "GRACE_EXPIRED", peers });
          }, PEER_GRACE_MS);
        }
        break;
      }
      case "ack": {
        set((current) => ({
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
        const mine = message.senderId === get().selfId;
        if (mine) {
          set((current) => ({
            entries: current.entries.map((entry) =>
              entry.id === message.localId
                ? { ...entry, seq: message.seq, delivery: "sent" }
                : entry,
            ),
          }));
          return;
        }
        try {
          const body = await open<SealedBody>(key, message.payload);
          set((current) => ({
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
          if (error instanceof DecryptionFailedError) {
            set((current) => ({
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

  async function publish(body: SealedBody): Promise<void> {
    const key = roomKey;
    const active = connection;
    if (key === null || active === null) {
      return;
    }
    const id = nextId();
    set((current) => ({
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
    } catch {
      get().markFailed(id);
    }
  }

  return {
    state: "idle",
    status: "closed",
    pin: "",
    selfId: "",
    participants: [],
    entries: [],
    error: null,

    async connect(pin, keyFragment) {
      set({ pin, state: "joining", entries: [], error: null });
      try {
        roomKey = await importRoomKey(keyFragment);
      } catch {
        set({ state: "closed_not_found", error: "This link is missing a valid room key." });
        return;
      }
      connection?.close();
      connection = new RoomConnection(pin, {
        onMessage: (message) => {
          void handleServerMessage(message);
        },
        onStatus: (status) => {
          set({ status });
          if (status === "reconnecting") {
            apply({ type: "DISCONNECTED" });
          }
        },
        fetchJoinToken: async () => {
          const result = await joinRoom(pin);
          return result.ok ? result.joinToken : null;
        },
      });
      connection.connect();
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
      set((current) => ({
        entries: current.entries.map((entry) =>
          entry.id === id ? { ...entry, delivery: "failed" } : entry,
        ),
      }));
    },

    cancelFile(fileId) {
      connection?.sendControl({ t: "cancel", fileId });
    },

    leave() {
      connection?.close();
      connection = null;
      roomKey = null;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      set({ state: "closed_by_host", status: "closed", entries: [], participants: [] });
    },
  };
});

/** Sorted by the server sequence number; client timestamps are display-only. */
export function orderedEntries(entries: readonly ChatEntry[]): ChatEntry[] {
  return [...entries].sort((a, b) => (a.seq === b.seq ? a.ts - b.ts : a.seq - b.seq));
}
