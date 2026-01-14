import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

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
 * Union type for all server factory signatures.
 * @deprecated Prefer using StatelessServerFactory or StatefulServerFactory directly.
 */
export type ServerFactory = (
  sessionId?: string,
) => McpServer | Promise<McpServer>;
