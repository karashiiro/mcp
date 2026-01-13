import { serve } from "@hono/node-server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

export interface HttpServerSessionOptions {
  sessionIdGenerator: () => string;
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

export function serveHttp(
  server: McpServer,
  options: Partial<HttpServerOptions> = {},
): void {
  const mergedOptions: HttpServerOptions = {
    ...defaultOptions,
    ...options,
  };

  serveHttpStateless(server, mergedOptions);
}

function serveHttpStateless(server: McpServer, options: HttpServerOptions) {
  // Create the transport
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: options.sessions?.sessionIdGenerator,
  });

  // Create the Hono app
  const app = new Hono();
  addCors(app);

  // MCP endpoint
  app.all(options.endpoint, (c) => transport.handleRequest(c.req.raw));

  server.connect(transport).then(() => {
    serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    });
  });
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
