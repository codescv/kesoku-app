import { ulid } from '@kesoku/protocol';

export type WorkoutChannelEvent =
  | { type: 'doc-updated'; ownerKey: string; docKey: string; ts: number }
  | { type: 'writer-released'; ts: number };

type WireMessage = WorkoutChannelEvent & { senderId: string };
type PeerListener = (ev: WorkoutChannelEvent) => void;

const CHANNEL_NAME = 'kesoku-workout';
/** Unique per-tab sender id so same-tab messages (even across duplicate channel instances) are always ignored. */
export const WORKOUT_TAB_SENDER_ID = `tab_${ulid()}`;

let sharedChannel: BroadcastChannel | null = null;
const listeners = new Set<PeerListener>();

function ensureChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!sharedChannel) {
    try {
      sharedChannel = new BroadcastChannel(CHANNEL_NAME);
      sharedChannel.onmessage = (ev: MessageEvent) => {
        const data = ev.data as Partial<WireMessage> | null;
        if (!data || typeof data.type !== 'string') return;
        // Strict self-echo filter: never process messages originating from this tab
        if (data.senderId === WORKOUT_TAB_SENDER_ID) return;
        for (const fn of listeners) {
          try {
            fn(data as WorkoutChannelEvent);
          } catch {
            /* isolate listener errors */
          }
        }
      };
    } catch {
      return null;
    }
  }
  return sharedChannel;
}

export function broadcastWorkoutEvent(event: WorkoutChannelEvent): void {
  const ch = ensureChannel();
  if (!ch) return;
  try {
    const wire: WireMessage = { ...event, senderId: WORKOUT_TAB_SENDER_ID };
    ch.postMessage(wire);
  } catch {
    /* ignore closed/unavailable channel */
  }
}

export function onWorkoutPeerEvent(fn: PeerListener): () => void {
  ensureChannel();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test seam: close and recreate the shared BroadcastChannel (e.g. when mocking BroadcastChannel). */
export function resetWorkoutChannelForTest(): void {
  if (sharedChannel) {
    try {
      sharedChannel.close();
    } catch {
      /* ignore */
    }
    sharedChannel = null;
  }
}
