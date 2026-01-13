# @karashiiro/mcp

Lightweight utilities for serving [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) servers in TypeScript.

## Installation

```bash
npm install @karashiiro/mcp @modelcontextprotocol/sdk
```

### For HTTP transport

If you plan to use HTTP transport, you'll also need Hono:

```bash
npm install hono @hono/node-server
```

## Usage

### Stdio Transport

The simplest way to serve an MCP server. Great for CLI tools and local integrations.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveStdio } from "@karashiiro/mcp/stdio";

function createServer() {
  const server = new McpServer({
    name: "my-server",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    { description: "Says hello" },
    async () => ({
      content: [{ type: "text", text: "Hello from MCP!" }],
    }),
  );

  return server;
}

await serveStdio(createServer);
```

### HTTP Transport

Serve your MCP server over HTTP using the Streamable HTTP transport.

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { serveHttp } from "@karashiiro/mcp/http";

function createServer() {
  const server = new McpServer({
    name: "my-server",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    { description: "Says hello" },
    async () => ({
      content: [{ type: "text", text: "Hello from MCP!" }],
    }),
  );

  return server;
}

const handle = await serveHttp(createServer, {
  port: 8080,
  host: "127.0.0.1",
  endpoint: "/mcp",
});

// Later, to shut down:
await handle.close();
```

#### Stateless vs Stateful Mode

By default, `serveHttp` runs in **stateless mode** where all clients share a single server instance.

For **stateful mode** with per-client sessions, provide the `sessions` option:

```ts
const handle = await serveHttp(createServer, {
  port: 8080,
  sessions: {}, // Enable stateful mode
});
```

In stateful mode, `createServer` is called once per client session, allowing each client to have isolated state.

#### Custom Session IDs

```ts
const handle = await serveHttp(createServer, {
  port: 8080,
  sessions: {
    sessionIdGenerator: () => `session-${Date.now()}`,
  },
});
```

#### Legacy SSE Support

For backwards compatibility with older MCP clients that use SSE transport:

```ts
const handle = await serveHttp(createServer, {
  port: 8080,
  sessions: {
    legacySse: {
      sseEndpoint: "/sse",        // default: "/sse"
      messagesEndpoint: "/messages", // default: "/messages"
    },
  },
});
```

## Entry Points

This package provides multiple entry points for optimal bundle size:

| Entry Point | Description | Requires Hono |
|-------------|-------------|---------------|
| `@karashiiro/mcp` | Everything (re-exports all) | Yes |
| `@karashiiro/mcp/stdio` | Stdio transport only | No |
| `@karashiiro/mcp/http` | HTTP transport only | Yes |

If you only need stdio transport, import from `@karashiiro/mcp/stdio` to avoid bundling Hono.

## API Reference

### `serveStdio(serverFactory)`

Serves an MCP server over stdin/stdout.

- `serverFactory: () => McpServer` - Factory function that creates the server instance
- Returns: `Promise<ServerHandle>`

### `serveHttp(serverFactory, options?)`

Serves an MCP server over HTTP.

- `serverFactory: () => McpServer` - Factory function that creates server instances
- `options.port` - Port to listen on (default: `8080`)
- `options.host` - Host to bind to (default: `"127.0.0.1"`)
- `options.endpoint` - MCP endpoint path (default: `"/mcp"`)
- `options.sessions` - Enable stateful mode with per-client sessions
- `options.sessions.sessionIdGenerator` - Custom session ID generator function
- `options.sessions.legacySse` - Enable legacy SSE transport endpoints
- Returns: `Promise<ServerHandle>`

### `ServerHandle`

Handle for controlling the server lifecycle.

- `close(): Promise<void>` - Gracefully shut down the server

## License

UNLICENSED
