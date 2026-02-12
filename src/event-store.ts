import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { EventStore } from "./types.js";

/**
 * Options for configuring the in-memory event store.
 */
export interface InMemoryEventStoreOptions {
  /**
   * Maximum number of events to store per stream.
   * When exceeded, oldest events are evicted (FIFO).
   * Defaults to undefined (no limit).
   */
  maxEventsPerStream?: number;
}

/**
 * In-memory event store for SSE resumability.
 * Stores events in memory and allows replaying them from a specific point.
 * Note: Events are lost on restart.
 */
export class InMemoryEventStore implements EventStore {
  private events = new Map<
    string,
    { streamId: string; message: JSONRPCMessage }
  >();
  private initializeRequests = new Map<string, JSONRPCMessage>();
  private readonly maxEventsPerStream: number | undefined;

  constructor(options: InMemoryEventStoreOptions = {}) {
    this.maxEventsPerStream = options.maxEventsPerStream;
  }

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.events.set(eventId, { streamId, message });

    // Evict oldest events if limit exceeded
    if (this.maxEventsPerStream !== undefined) {
      this.evictOldestIfNeeded(streamId);
    }

    return eventId;
  }

  /**
   * Evict oldest events for a stream if it exceeds maxEventsPerStream.
   */
  private evictOldestIfNeeded(streamId: string): void {
    if (this.maxEventsPerStream === undefined) return;

    // Get all events for this stream, sorted by ID (contains timestamp)
    const streamEvents = Array.from(this.events.entries())
      .filter(([, event]) => event.streamId === streamId)
      .sort(([a], [b]) => a.localeCompare(b));

    // Remove oldest events until we're under the limit
    while (streamEvents.length > this.maxEventsPerStream) {
      const [oldestId] = streamEvents.shift()!;
      this.events.delete(oldestId);
    }
  }

  /**
   * Clear all events from the store.
   * Call this when the session is being deleted.
   */
  clear(): void {
    this.events.clear();
    this.initializeRequests.clear();
  }

  /**
   * Check if the event store has data for the given session.
   * @param sessionId - The ID of the session to check
   * @returns true if an initialize request exists for the session
   */
  async hasSession(sessionId: string): Promise<boolean> {
    return this.initializeRequests.has(sessionId);
  }

  /**
   * Store the initialization request for session restoration.
   * @param sessionId - The ID of the session
   * @param request - The initialize request message to store
   */
  async storeInitializeRequest(sessionId: string, request: JSONRPCMessage): Promise<void> {
    this.initializeRequests.set(sessionId, request);
  }

  /**
   * Retrieve the stored initialization request.
   * @param sessionId - The ID of the session
   * @returns The stored initialize request, or undefined if not found
   */
  async getInitializeRequest(sessionId: string): Promise<JSONRPCMessage | undefined> {
    return this.initializeRequests.get(sessionId);
  }

  /**
   * Get the current number of events stored.
   */
  get size(): number {
    return this.events.size;
  }

  async replayEventsAfter(
    lastEventId: string,
    {
      send,
    }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const lastEvent = this.events.get(lastEventId);
    if (!lastEvent) {
      return lastEventId;
    }

    const streamId = lastEvent.streamId;

    // Get all events for this stream, sorted by their ID (which contains timestamp)
    const streamEvents = Array.from(this.events.entries())
      .filter(([, event]) => event.streamId === streamId)
      .sort(([a], [b]) => a.localeCompare(b));

    // Find the index of the last event and replay everything after it
    const lastIndex = streamEvents.findIndex(([id]) => id === lastEventId);
    if (lastIndex === -1) {
      return lastEventId;
    }

    let lastReplayedId = lastEventId;
    for (let i = lastIndex + 1; i < streamEvents.length; i++) {
      const [eventId, event] = streamEvents[i]!;
      await send(eventId, event.message);
      lastReplayedId = eventId;
    }

    return lastReplayedId;
  }
}
