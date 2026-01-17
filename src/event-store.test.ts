import { describe, it, expect } from "vitest";
import { InMemoryEventStore } from "./event-store.js";

describe("InMemoryEventStore", () => {
  describe("basic operations", () => {
    it("stores and retrieves events", async () => {
      const store = new InMemoryEventStore();

      const eventId = await store.storeEvent("stream1", {
        jsonrpc: "2.0",
        method: "test",
      });

      expect(eventId).toContain("stream1");
      expect(store.size).toBe(1);
    });

    it("clears all events", async () => {
      const store = new InMemoryEventStore();

      await store.storeEvent("stream1", { jsonrpc: "2.0", method: "test1" });
      await store.storeEvent("stream1", { jsonrpc: "2.0", method: "test2" });
      expect(store.size).toBe(2);

      store.clear();
      expect(store.size).toBe(0);
    });
  });

  describe("maxEventsPerStream", () => {
    it("evicts oldest events when limit exceeded", async () => {
      const store = new InMemoryEventStore({ maxEventsPerStream: 3 });

      // Store 5 events
      const ids: string[] = [];
      for (let i = 1; i <= 5; i++) {
        // Small delay to ensure different timestamps in event IDs
        await new Promise((resolve) => setTimeout(resolve, 5));
        const id = await store.storeEvent("stream1", {
          jsonrpc: "2.0",
          method: `test${i}`,
        });
        ids.push(id);
      }

      // Should only have 3 events (oldest 2 evicted)
      expect(store.size).toBe(3);
    });

    it("keeps events from different streams separate", async () => {
      const store = new InMemoryEventStore({ maxEventsPerStream: 2 });

      // Store 3 events in stream1
      for (let i = 1; i <= 3; i++) {
        await store.storeEvent("stream1", { jsonrpc: "2.0", method: `s1-${i}` });
      }

      // Store 3 events in stream2
      for (let i = 1; i <= 3; i++) {
        await store.storeEvent("stream2", { jsonrpc: "2.0", method: `s2-${i}` });
      }

      // Each stream should have max 2 events = 4 total
      expect(store.size).toBe(4);
    });

    it("does not evict when no limit set", async () => {
      const store = new InMemoryEventStore();

      // Store many events
      for (let i = 1; i <= 100; i++) {
        await store.storeEvent("stream1", { jsonrpc: "2.0", method: `test${i}` });
      }

      // All events should be stored
      expect(store.size).toBe(100);
    });
  });

  describe("replayEventsAfter", () => {
    it("replays events after a given event ID", async () => {
      const store = new InMemoryEventStore();

      // Store events with delays to ensure ordering
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id1 = await store.storeEvent("stream1", {
        jsonrpc: "2.0",
        method: "event1",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.storeEvent("stream1", {
        jsonrpc: "2.0",
        method: "event2",
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.storeEvent("stream1", {
        jsonrpc: "2.0",
        method: "event3",
      });

      // Replay after first event
      const replayed: { eventId: string; method: string }[] = [];
      await store.replayEventsAfter(id1, {
        send: async (eventId, message) => {
          replayed.push({
            eventId,
            method: (message as { method: string }).method,
          });
        },
      });

      // Should have replayed event2 and event3
      expect(replayed.length).toBe(2);
      expect(replayed[0]?.method).toBe("event2");
      expect(replayed[1]?.method).toBe("event3");
    });
  });
});
