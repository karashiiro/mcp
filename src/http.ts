import { serve, type ServerType } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { InMemoryEventStore } from "./event-store.js";
import type {
  ServerHandle,
  StatelessServerFactory,
  StatefulServerFactory,
} from "./types.js";

export type {
  ServerHandle,
  StatelessServerFactory,
  StatefulServerFactory,
} from "./types.js";

// Re-export for backwards compatibility
export type { ServerFactory } from "./types.js";

/**
 * Options for legacy SSE transport compatibility.
 * @deprecated SSE transport is deprecated in favor of Streamable HTTP.
 */
export interface LegacySseOptions {
  /** Endpoint for SSE stream. Defaults to "/sse". */
  sseEndpoint?: string;
  /** Endpoint for messages. Defaults to "/messages". */
  messagesEndpoint?: string;
}

export interface HttpServerSessionOptions {
  sessionIdGenerator?: () => string; // defaults to uuid.v4
  /**
   * Session time-to-live in milliseconds. Sessions without activity for this
   * duration will be automatically cleaned up. Defaults to 30 minutes.
   * Set to 0 or undefined to disable automatic cleanup.
   */
  sessionTtlMs?: number;
  /**
   * Interval in milliseconds for checking expired sessions.
   * Defaults to 60000 (1 minute). Only used if sessionTtlMs is set.
   */
  cleanupIntervalMs?: number;
  /**
   * Callback invoked when a session is closed.
   * Called for all cleanup paths: TTL expiration, DELETE requests, transport close, and server shutdown.
   * Useful for cleaning up session-scoped resources like database connections or client state.
   *
   * Note: In TTL cleanup, the callback is invoked but not awaited to avoid blocking the cleanup interval.
   * In all other paths (DELETE, transport close, shutdown), async callbacks are awaited.
   *
   * @param sessionId - The ID of the session being closed
   */
  onSessionClosed?: (sessionId: string) => void | Promise<void>;
  /**
   * Enable legacy SSE transport compatibility.
   * When provided, adds /sse and /messages endpoints for older clients.
   * @deprecated SSE transport is deprecated in favor of Streamable HTTP.
   */
  legacySse?: LegacySseOptions;
}

/**
 * Base HTTP server options without session configuration.
 */
export interface HttpServerOptionsBase {
  port: number;
  host: string;
  endpoint: string;
}

/**
 * HTTP server options for stateless mode (no sessions).
 */
export interface HttpServerStatelessOptions extends HttpServerOptionsBase {
  sessions?: undefined;
}

/**
 * HTTP server options for stateful mode (with sessions).
 */
export interface HttpServerStatefulOptions extends HttpServerOptionsBase {
  sessions: HttpServerSessionOptions;
}

/**
 * Combined HTTP server options type.
 */
export type HttpServerOptions =
  | HttpServerStatelessOptions
  | HttpServerStatefulOptions;

const defaultOptions: HttpServerOptions = Object.freeze({
  port: 8080,
  host: "127.0.0.1",
  endpoint: "/mcp",
  sessions: undefined,
});

/**
 * Session state base interface.
 */
interface SessionStateBase {
  server: McpServer;
  /** Timestamp of last activity (Date.now()) for TTL tracking */
  lastActivity: number;
  /** Number of active streaming connections (e.g., SSE streams) */
  activeStreams: number;
}

/**
 * Session state for Streamable HTTP transport.
 */
interface StreamableHttpSessionState extends SessionStateBase {
  type: "streamable-http";
  transport: WebStandardStreamableHTTPServerTransport;
  eventStore: InMemoryEventStore;
}

/**
 * Session state for legacy SSE transport.
 */
interface SseSessionState extends SessionStateBase {
  type: "sse";
  transport: SSEServerTransport;
}

/**
 * Discriminated union of session state types.
 */
type SessionState = StreamableHttpSessionState | SseSessionState;

/**
 * Helper to create a closeable handle from a node server.
 */
function createHandle(server: ServerType): ServerHandle {
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err?: Error) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

/**
 * Serve an MCP server over HTTP in stateless mode.
 *
 * In stateless mode, the factory is called for each incoming request to create
 * a fresh McpServer instance per request, since McpServer can only be attached
 * to one client at a time. The factory receives no parameters.
 *
 * @param serverFactory - Factory function that creates McpServer instances (called per request).
 * @param options - Server configuration options (without sessions).
 * @returns A handle to control the server lifecycle.
 */
export function serveHttp(
  serverFactory: StatelessServerFactory,
  options?: Partial<Omit<HttpServerOptionsBase, "sessions">> & {
    sessions?: undefined;
  },
): Promise<ServerHandle>;

/**
 * Serve an MCP server over HTTP in stateful mode with per-client sessions.
 *
 * In stateful mode, the factory is called once per client session, receiving the session ID.
 * This allows each client to have isolated state.
 *
 * @param serverFactory - Factory function that creates McpServer instances per session.
 * @param options - Server configuration options with sessions enabled.
 * @returns A handle to control the server lifecycle.
 */
export function serveHttp(
  serverFactory: StatefulServerFactory,
  options: Partial<HttpServerOptionsBase> & {
    sessions: HttpServerSessionOptions;
  },
): Promise<ServerHandle>;

// Implementation signature (accepts both)
export async function serveHttp(
  serverFactory: StatelessServerFactory | StatefulServerFactory,
  options: Partial<HttpServerOptions> = {},
): Promise<ServerHandle> {
  const mergedOptions: HttpServerOptions = {
    ...defaultOptions,
    ...options,
  };

  if (mergedOptions.sessions) {
    return serveHttpStateful(
      serverFactory as StatefulServerFactory,
      mergedOptions as HttpServerStatefulOptions,
    );
  } else {
    return serveHttpStateless(
      serverFactory as StatelessServerFactory,
      mergedOptions as HttpServerStatelessOptions,
    );
  }
}

/**
 * Stateless mode: new server instance per request, no session tracking.
 *
 * McpServer instances can only be attached to one client at a time, so we
 * create a fresh server and transport for every incoming HTTP request.
 */
async function serveHttpStateless(
  serverFactory: StatelessServerFactory,
  options: HttpServerStatelessOptions,
): Promise<ServerHandle> {
  // Create the Hono app
  const app = new Hono<{ Bindings: HttpBindings }>();
  addCors(app);

  // MCP endpoint — each request gets its own server + transport
  app.all(options.endpoint, async (c) => {
    const server = await serverFactory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  const httpServer = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: options.host,
  });

  return createHandle(httpServer);
}

/**
 * Stateful mode: per-session servers, transports, and event stores.
 */
function serveHttpStateful(
  serverFactory: StatefulServerFactory,
  options: HttpServerStatefulOptions,
): ServerHandle {
  const sessions = new Map<string, SessionState>();
  const sessionIdGenerator = options.sessions.sessionIdGenerator ?? uuidv4;
  const onSessionClosed = options.sessions.onSessionClosed;

  // Helper to safely invoke onSessionClosed callback
  // Catches errors to prevent user code from breaking cleanup
  const notifySessionClosed = (sessionId: string): void => {
    if (onSessionClosed) {
      try {
        // Fire and forget - don't await to avoid blocking
        // Errors are logged but not propagated to prevent breaking cleanup
        Promise.resolve(onSessionClosed(sessionId)).catch((error) => {
          console.error(
            `[MCP] onSessionClosed callback error for session ${sessionId}:`,
            error,
          );
        });
      } catch (error) {
        // Log synchronous errors from user callback
        console.error(
          `[MCP] onSessionClosed callback sync error for session ${sessionId}:`,
          error,
        );
      }
    }
  };

  // Async version for paths where we can await
  const notifySessionClosedAsync = async (sessionId: string): Promise<void> => {
    if (onSessionClosed) {
      try {
        await onSessionClosed(sessionId);
      } catch (error) {
        // Log but don't propagate to prevent breaking cleanup
        console.error(
          `[MCP] onSessionClosed callback error for session ${sessionId}:`,
          error,
        );
      }
    }
  };

  // Session TTL configuration
  const sessionTtlMs = options.sessions.sessionTtlMs;
  const cleanupIntervalMs = options.sessions.cleanupIntervalMs ?? 60000; // Default 1 minute

  // Set up periodic cleanup for expired sessions
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;
  if (sessionTtlMs && sessionTtlMs > 0) {
    cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of sessions) {
        // Skip sessions with active streaming connections
        if (session.activeStreams > 0) {
          continue;
        }
        if (now - session.lastActivity > sessionTtlMs) {
          // Session expired - close transport and remove
          session.transport.close().catch(() => {
            // Ignore close errors for expired sessions
          });
          // Clear event store if this is a streamable HTTP session
          if (session.type === "streamable-http") {
            session.eventStore.clear();
          }
          sessions.delete(sessionId);
          // Notify callback (fire and forget to avoid blocking interval)
          notifySessionClosed(sessionId);
        }
      }
    }, cleanupIntervalMs);
  }

  // Legacy SSE options
  const legacySse = options.sessions?.legacySse;
  const sseEndpoint = legacySse?.sseEndpoint ?? "/sse";
  const messagesEndpoint = legacySse?.messagesEndpoint ?? "/messages";

  const app = new Hono<{ Bindings: HttpBindings }>();
  addCors(app);

  // Main MCP endpoint (Streamable HTTP)
  app.all(options.endpoint, async (c) => {
    const sessionId = c.req.header("mcp-session-id");

    // Handle DELETE method for session termination
    if (c.req.method === "DELETE") {
      if (!sessionId) {
        return c.text("Session ID required for DELETE", 400);
      }
      const session = sessions.get(sessionId);
      if (!session) {
        return c.text("Session not found", 404);
      }
      // Close the transport and clean up
      await session.transport.close();
      // Clear event store if this is a streamable HTTP session
      if (session.type === "streamable-http") {
        session.eventStore.clear();
      }
      sessions.delete(sessionId);
      // Notify callback (awaited since we're in async context)
      await notifySessionClosedAsync(sessionId);
      return c.body(null, 204);
    }

    // Clone the request so we can read the body without consuming it
    const rawRequest = c.req.raw;
    const bodyText = await rawRequest.text();
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // Invalid JSON - body stays null
    }

    // Helper to recreate request with body (since we consumed it)
    const recreateRequest = () =>
      new Request(rawRequest.url, {
        method: rawRequest.method,
        headers: rawRequest.headers,
        body: bodyText || undefined,
      });

    // New session (initialize request without session ID)
    if (!sessionId && body && isInitializeRequest(body)) {
      // Generate session ID upfront so we can pass it to the factory
      const sid = sessionIdGenerator();

      // Create server with session ID (supports async factories)
      const server = await serverFactory(sid);

      const eventStore = new InMemoryEventStore();
      const transport = new WebStandardStreamableHTTPServerTransport({
        // Use our pre-generated session ID
        sessionIdGenerator: () => sid,
        eventStore,
        onsessioninitialized: () => {
          // Server already created above, just store the session state
          const session: StreamableHttpSessionState = {
            type: "streamable-http",
            transport,
            server,
            eventStore,
            lastActivity: Date.now(),
            activeStreams: 0,
          };
          sessions.set(sid, session);
        },
      });

      // Connect server to transport before handling the request
      await server.connect(transport);

      transport.onclose = () => {
        eventStore.clear();
        sessions.delete(sid);
        // Notify callback (fire and forget since onclose is sync)
        notifySessionClosed(sid);
      };

      return transport.handleRequest(recreateRequest());
    }

    // Existing session
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session) {
        return c.text("Session not found", 404);
      }
      // Validate transport type matches endpoint
      if (session.type !== "streamable-http") {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          },
          400,
        );
      }
      // Update last activity for TTL tracking
      session.lastActivity = Date.now();
      return session.transport.handleRequest(recreateRequest());
    }

    // Invalid request (no session ID, not an initialize request)
    return c.text("Bad request - missing session ID", 400);
  });

  // Legacy SSE endpoints (only if enabled)
  if (legacySse) {
    // GET /sse - Establish SSE stream
    app.get(sseEndpoint, async (c) => {
      const { outgoing } = c.env;

      // Create SSE transport with messages endpoint
      const transport = new SSEServerTransport(messagesEndpoint, outgoing);

      // Create server with session ID (supports async factories)
      const server = await serverFactory(transport.sessionId);

      // Store session - SSE connection counts as an active stream
      const session: SseSessionState = {
        type: "sse",
        transport,
        server,
        lastActivity: Date.now(),
        activeStreams: 1, // SSE connection is an active stream
      };
      sessions.set(transport.sessionId, session);

      // Cleanup on close - SSE stream is no longer active
      transport.onclose = () => {
        session.activeStreams = 0;
        sessions.delete(transport.sessionId);
        // Notify callback (fire and forget since onclose is sync)
        notifySessionClosed(transport.sessionId);
      };

      // Connect and start
      await server.connect(transport);

      // Signal to Hono that we've handled the response directly
      return RESPONSE_ALREADY_SENT;
    });

    // POST /messages - Handle messages for SSE sessions
    app.post(messagesEndpoint, async (c) => {
      const sessionId = c.req.query("sessionId");

      if (!sessionId) {
        return c.text("Missing sessionId query parameter", 400);
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return c.text("Session not found", 404);
      }

      // Validate transport type matches endpoint
      if (session.type !== "sse") {
        return c.json(
          {
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message:
                "Bad Request: Session exists but uses a different transport protocol",
            },
            id: null,
          },
          400,
        );
      }

      const { incoming, outgoing } = c.env;

      // Update last activity for TTL tracking
      session.lastActivity = Date.now();

      // Parse body for SSEServerTransport
      const bodyText = await c.req.text();
      let parsedBody: unknown = null;
      try {
        parsedBody = bodyText ? JSON.parse(bodyText) : null;
      } catch {
        // Let handlePostMessage handle the error
      }

      await session.transport.handlePostMessage(incoming, outgoing, parsedBody);

      return RESPONSE_ALREADY_SENT;
    });
  }

  const httpServer = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: options.host,
  });

  // Create handle that also clears the cleanup interval
  const baseHandle = createHandle(httpServer);
  return {
    close: async () => {
      if (cleanupInterval) {
        clearInterval(cleanupInterval);
      }
      // Close all active sessions and clear their event stores
      for (const [sessionId, session] of sessions) {
        await session.transport.close().catch(() => {
          // Ignore close errors during shutdown
        });
        // Clear event store if this is a streamable HTTP session
        if (session.type === "streamable-http") {
          session.eventStore.clear();
        }
        // Notify callback (awaited since we're in async shutdown)
        await notifySessionClosedAsync(sessionId);
      }
      sessions.clear();
      await baseHandle.close();
    },
  };
}

function addCors(app: Hono<{ Bindings: HttpBindings }>): void {
  // Enable CORS for all origins
  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "mcp-session-id",
        "Last-Event-ID",
        "mcp-protocol-version",
      ],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );
}
