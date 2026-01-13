import { serve, type ServerType } from "@hono/node-server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { v4 as uuidv4 } from "uuid";
import { InMemoryEventStore } from "./event-store.js";

export interface HttpServerSessionOptions {
  sessionIdGenerator?: () => string; // defaults to uuid.v4
}

export interface HttpServerOptions {
  port: number;
  host: string;
  endpoint: string;
  sessions?: HttpServerSessionOptions | undefined;
}

/**
 * Handle returned by serveHttp for controlling the server lifecycle.
 */
export interface HttpServerHandle {
  /** Close the HTTP server and stop accepting new connections. */
  close: () => Promise<void>;
}

const defaultOptions: HttpServerOptions = Object.freeze({
  port: 8080,
  host: "127.0.0.1",
  endpoint: "/mcp",
  sessions: undefined,
});

/**
 * Session state tracking for stateful mode.
 */
interface SessionState {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  eventStore: InMemoryEventStore;
}

/**
 * Helper to create a closeable handle from a node server.
 */
function createHandle(server: ServerType): HttpServerHandle {
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
): Promise<HttpServerHandle> {
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
): Promise<HttpServerHandle> {
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
): HttpServerHandle {
  const sessions = new Map<string, SessionState>();
  const sessionIdGenerator = options.sessions?.sessionIdGenerator ?? uuidv4;

  const app = new Hono();
  addCors(app);

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
          sessions.set(sid, { transport, server, eventStore });
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
      return session.transport.handleRequest(recreateRequest());
    }

    // Invalid request (no session ID, not an initialize request)
    return c.text("Bad request - missing session ID", 400);
  });

  const httpServer = serve({
    fetch: app.fetch,
    port: options.port,
    hostname: options.host,
  });

  return createHandle(httpServer);
}

function addCors(app: Hono): void {
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
