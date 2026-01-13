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
import type { ServerHandle } from "./types.js";

export type { ServerHandle } from "./types.js";

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
   * Enable legacy SSE transport compatibility.
   * When provided, adds /sse and /messages endpoints for older clients.
   * @deprecated SSE transport is deprecated in favor of Streamable HTTP.
   */
  legacySse?: LegacySseOptions;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  endpoint: string;
  sessions?: HttpServerSessionOptions | undefined;
}

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
 * Serve an MCP server over HTTP.
 *
 * @param serverFactory - Factory function that creates McpServer instances.
 *   In stateless mode, called once. In stateful mode, called per session.
 * @param options - Server configuration options.
 *   If `sessions` is provided, runs in stateful mode with per-session servers.
 *   If `sessions` is undefined, runs in stateless mode with a single server.
 * @returns A handle to control the server lifecycle.
 */
export async function serveHttp(
  serverFactory: () => McpServer,
  options: Partial<HttpServerOptions> = {},
): Promise<ServerHandle> {
  const mergedOptions: HttpServerOptions = {
    ...defaultOptions,
    ...options,
  };

  if (mergedOptions.sessions) {
    return serveHttpStateful(serverFactory, mergedOptions);
  } else {
    return serveHttpStateless(serverFactory, mergedOptions);
  }
}

/**
 * Stateless mode: single server instance, single transport, no session tracking.
 */
async function serveHttpStateless(
  serverFactory: () => McpServer,
  options: HttpServerOptions,
): Promise<ServerHandle> {
  // Call factory ONCE to get the single server instance
  const server = serverFactory();

  // Create the transport (no session ID generator = stateless)
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  // Create the Hono app
  const app = new Hono();
  addCors(app);

  // MCP endpoint
  app.all(options.endpoint, (c) => transport.handleRequest(c.req.raw));

  await server.connect(transport);

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
  serverFactory: () => McpServer,
  options: HttpServerOptions,
): ServerHandle {
  const sessions = new Map<string, SessionState>();
  const sessionIdGenerator = options.sessions?.sessionIdGenerator ?? uuidv4;

  // Legacy SSE options
  const legacySse = options.sessions?.legacySse;
  const sseEndpoint = legacySse?.sseEndpoint ?? "/sse";
  const messagesEndpoint = legacySse?.messagesEndpoint ?? "/messages";

  const app = new Hono<{ Bindings: HttpBindings }>();
  addCors(app);

  // Main MCP endpoint (Streamable HTTP)
  app.all(options.endpoint, async (c) => {
    const sessionId = c.req.header("mcp-session-id");

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
      const eventStore = new InMemoryEventStore();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator,
        eventStore,
        onsessioninitialized: (sid) => {
          // Factory called per session!
          const server = serverFactory();
          const session: StreamableHttpSessionState = {
            type: "streamable-http",
            transport,
            server,
            eventStore,
          };
          sessions.set(sid, session);
          server.connect(transport);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
        }
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

      // Create and connect server
      const server = serverFactory();

      // Store session
      const session: SseSessionState = {
        type: "sse",
        transport,
        server,
      };
      sessions.set(transport.sessionId, session);

      // Cleanup on close
      transport.onclose = () => {
        sessions.delete(transport.sessionId);
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

  return createHandle(httpServer);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addCors(app: Hono<any, any, any>): void {
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
