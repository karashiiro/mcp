import type { EventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

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

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${streamId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    this.events.set(eventId, { streamId, message });
    return eventId;
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
