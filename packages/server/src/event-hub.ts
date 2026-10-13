import { randomUUID } from "node:crypto";
import {
  eventStreamKey,
  PROTOCOL_VERSION,
  type EventChannel,
  type EventCursor,
  type EventCursorMap,
  type EventEnvelope,
  type EventResyncReason,
  type EventStreamRef,
  type JsonValue,
} from "@ompiui/protocol";

type Listener = (event: EventEnvelope) => void;
const wireFrames = new WeakMap<
  EventEnvelope,
  { data: string; bytes: number }
>();
const omittedFrames = new WeakMap<EventEnvelope, { data: string; bytes: number }>();

export function eventWireFrame(event: EventEnvelope): {
  data: string;
  bytes: number;
} {
  let wire = wireFrames.get(event);
  if (!wire) {
    const data = `{"channel":"event","event":${JSON.stringify(event)}}`;
    wire = { data, bytes: Buffer.byteLength(data) };
    wireFrames.set(event, wire);
  }
  return wire;
}

export function omittedEventWireFrame(event: EventEnvelope): { data: string; bytes: number } {
  let wire = omittedFrames.get(event);
  if (!wire) {
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload as Record<string, unknown>
      : {};
    const data = JSON.stringify({
      channel: "control",
      type: "payload_omitted",
      stream: event.stream,
      cursor: event.cursor,
      eventId: event.eventId,
      eventChannel: event.channel,
      commandId: event.channel === "command.updated" && typeof payload.id === "string" ? payload.id : undefined,
    });
    wire = { data, bytes: Buffer.byteLength(data) };
    omittedFrames.set(event, wire);
  }
  return wire;
}
const MAX_STREAMS = 4096;
const MAX_LISTENERS = 1024;
const STREAM_HISTORY_BYTES = 2 * 1024 * 1024;
const TOTAL_HISTORY_BYTES = 32 * 1024 * 1024;

interface StreamState {
  stream: EventStreamRef;
  epoch: string;
  sequence: number;
  history: EventEnvelope[];
  sizes: number[];
  bytes: number;
}

export class EventHub {
  private readonly listeners = new Set<Listener>();
  private readonly streams = new Map<string, StreamState>();
  private readonly emptyEpoch = randomUUID();
  private historyBytes = 0;

  constructor(private readonly historyLimit = 256) {}

  subscribe(listener: Listener): () => void {
    if (this.listeners.size >= MAX_LISTENERS)
      throw new Error("event subscriber limit reached");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(
    stream: EventStreamRef,
    channel: EventChannel,
    payload: JsonValue,
  ): EventEnvelope {
    const state = this.getOrCreate(stream);
    state.sequence += 1;
    const event: EventEnvelope = {
      protocolVersion: PROTOCOL_VERSION,
      stream,
      cursor: { epoch: state.epoch, sequence: state.sequence },
      eventId: randomUUID(),
      timestamp: new Date().toISOString(),
      channel,
      payload,
    };
    const bytes = eventWireFrame(event).bytes;
    state.history.push(event);
    state.sizes.push(bytes);
    state.bytes += bytes;
    this.historyBytes += bytes;
    while (
      state.history.length > this.historyLimit ||
      state.bytes > STREAM_HISTORY_BYTES
    )
      this.shiftHistory(state);
    if (this.historyBytes > TOTAL_HISTORY_BYTES) {
      for (const oldest of this.streams.values()) {
        while (oldest.history.length && this.historyBytes > TOTAL_HISTORY_BYTES)
          this.shiftHistory(oldest);
        if (this.historyBytes <= TOTAL_HISTORY_BYTES) break;
      }
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a failed subscriber must not break the others */
      }
    }
    return event;
  }

  getCursor(stream: EventStreamRef): EventCursor {
    const state = this.streams.get(eventStreamKey(stream));
    return state
      ? { epoch: state.epoch, sequence: state.sequence }
      : { epoch: this.emptyEpoch, sequence: 0 };
  }

  getCursorMap(streams: EventStreamRef[]): EventCursorMap {
    return Object.fromEntries(
      streams.map((stream) => [eventStreamKey(stream), this.getCursor(stream)]),
    );
  }

  replaySince(
    stream: EventStreamRef,
    cursor?: EventCursor,
  ): {
    events: EventEnvelope[];
    resyncRequired: boolean;
    reason?: EventResyncReason;
  } {
    const state = this.streams.get(eventStreamKey(stream));
    if (!state) {
      if (!cursor)
        return { events: [], resyncRequired: true, reason: "missing_cursor" };
      if (cursor.epoch !== this.emptyEpoch)
        return { events: [], resyncRequired: true, reason: "epoch_mismatch" };
      if (cursor.sequence !== 0)
        return { events: [], resyncRequired: true, reason: "future_cursor" };
      return { events: [], resyncRequired: false };
    }
    if (!cursor)
      return { events: [], resyncRequired: true, reason: "missing_cursor" };
    if (cursor.epoch === this.emptyEpoch && cursor.sequence === 0) {
      const first = state.history[0]?.cursor.sequence ?? state.sequence + 1;
      return first === 1
        ? { events: [...state.history], resyncRequired: false }
        : { events: [], resyncRequired: true, reason: "history_expired" };
    }
    if (cursor.epoch !== state.epoch)
      return { events: [], resyncRequired: true, reason: "epoch_mismatch" };
    if (cursor.sequence > state.sequence)
      return { events: [], resyncRequired: true, reason: "future_cursor" };
    const oldest = state.history[0]?.cursor.sequence ?? state.sequence + 1;
    if (cursor.sequence < oldest - 1)
      return { events: [], resyncRequired: true, reason: "history_expired" };
    return {
      events: state.history.filter(
        (event) => event.cursor.sequence > cursor.sequence,
      ),
      resyncRequired: false,
    };
  }

  resetEpoch(stream: EventStreamRef): void {
    const state = this.getOrCreate(stream);
    state.epoch = randomUUID();
    state.sequence = 0;
    state.history.length = 0;
    this.historyBytes -= state.bytes;
    state.bytes = 0;
    state.sizes.length = 0;
  }

  private shiftHistory(state: StreamState): void {
    state.history.shift();
    const bytes = state.sizes.shift() ?? 0;
    state.bytes -= bytes;
    this.historyBytes -= bytes;
  }

  private getOrCreate(stream: EventStreamRef): StreamState {
    const key = eventStreamKey(stream);
    const existing = this.streams.get(key);
    if (existing) {
      this.streams.delete(key);
      this.streams.set(key, existing);
      return existing;
    }
    // Only server publications create history. Arbitrary client subscriptions
    // cannot consume slots, pin entries, or evict another client's cursor.
    if (this.streams.size >= MAX_STREAMS) {
      const oldest = this.streams.keys().next().value;
      if (oldest !== undefined) {
        this.historyBytes -= this.streams.get(oldest)!.bytes;
        this.streams.delete(oldest);
      }
    }
    const state: StreamState = {
      stream,
      epoch: randomUUID(),
      sequence: 0,
      history: [],
      sizes: [],
      bytes: 0,
    };
    this.streams.set(key, state);
    return state;
  }
}
