import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EventStore as SdkEventStore } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Extended EventStore interface that includes cleanup method and session restoration support.
 * Custom event store implementations must implement this interface.
 */
export interface EventStore extends SdkEventStore {
  /**
   * Clear all events from the store.
   * Called when the session is being closed/deleted.
   */
  clear(): void;

  /**
   * Check if the event store has data for the given session.
   * Used during session restoration to determine if a session can be restored.
   * @param sessionId - The ID of the session to check
   * @returns true if the session exists in the store, false otherwise
   */
  hasSession?(sessionId: string): Promise<boolean>;

  /**
   * Store the initialization request for session restoration.
   * Called when a new session is created so it can be replayed during restoration.
   * @param sessionId - The ID of the session
   * @param request - The initialize request message to store
   */
  storeInitializeRequest?(sessionId: string, request: JSONRPCMessage): Promise<void>;

  /**
   * Retrieve the stored initialization request.
   * Used during session restoration to replay the original initialize request.
   * @param sessionId - The ID of the session
   * @returns The stored initialize request, or undefined if not found
   */
  getInitializeRequest?(sessionId: string): Promise<JSONRPCMessage | undefined>;
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
