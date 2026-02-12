import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore as SdkEventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/**
 * Extended EventStore interface that includes cleanup method.
 * Custom event store implementations must implement this interface.
 */
export interface EventStore extends SdkEventStore {
  /**
   * Clear all events from the store.
   * Called when the session is being closed/deleted.
   */
  clear(): void;
}

/**
 * Handle returned by serve functions for controlling the server lifecycle.
 */
export interface ServerHandle {
  /** Close the server and stop accepting new connections. */
  close: () => Promise<void>;
}

/**
 * Factory function for stateless mode (no session ID).
 * Used by serveStdio and serveHttp without sessions.
 */
export type StatelessServerFactory = () => McpServer | Promise<McpServer>;

/**
 * Factory function for stateful mode (receives session ID).
 * Used by serveHttp with sessions enabled.
 */
export type StatefulServerFactory = (
  sessionId: string,
) => McpServer | Promise<McpServer>;

/**
 * Factory function for creating event stores (receives session ID).
 * Used by serveHttp with sessions enabled to support custom event storage implementations.
 */
export type EventStoreFactory = (
  sessionId: string,
) => EventStore | Promise<EventStore>;

/**
 * Union type for all server factory signatures.
 * @deprecated Prefer using StatelessServerFactory or StatefulServerFactory directly.
 */
export type ServerFactory = (
  sessionId?: string,
) => McpServer | Promise<McpServer>;
