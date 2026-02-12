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

  server.registerTool("hello", { description: "Says hello" }, async () => ({
    content: [{ type: "text", text: "Hello from MCP!" }],
  }));

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

  server.registerTool("hello", { description: "Says hello" }, async () => ({
    content: [{ type: "text", text: "Hello from MCP!" }],
  }));

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

#### Session-Aware Factories

In stateful mode, the factory function receives the session ID as a parameter, enabling session-specific initialization:

```ts
const handle = await serveHttp(
  (sessionId) => {
    console.log(`Creating server for session: ${sessionId}`);
    return createServer();
  },
  {
    port: 8080,
    sessions: {},
  },
);
```

#### Async Factories

The factory function can be async, which is useful for initialization that requires async operations:

```ts
const handle = await serveHttp(
  async (sessionId) => {
    // Perform async initialization (e.g., connect to database, load config)
    await initializeResources(sessionId);
    return createServer();
  },
  {
    port: 8080,
    sessions: {},
  },
);
```

#### Custom Session IDs

```ts
const handle = await serveHttp(createServer, {
  port: 8080,
  sessions: {
    sessionIdGenerator: () => `session-${Date.now()}`,
  },
});
```

#### Custom Event Store Factory

By default, sessions use an in-memory event store that loses events on server restart. You can provide a custom event store factory for persistent storage:

```ts
import { serveHttp, InMemoryEventStore } from "@karashiiro/mcp/http";

const handle = await serveHttp(
  (sessionId) => createServer(),
  {
    port: 8080,
    sessions: {
      // Custom factory with options
      eventStoreFactory: (sessionId) => {
        return new InMemoryEventStore({
          maxEventsPerStream: 1000, // Limit events per stream
        });
      },
    },
  },
);
```

The factory can be async for implementations requiring initialization:

```ts
sessions: {
  eventStoreFactory: async (sessionId) => {
    // Example: Redis-backed event store
    const store = await createRedisEventStore(sessionId);
    return store;
  },
}
```

Custom event stores must implement the `EventStore` interface from `@karashiiro/mcp/http`, which includes the `clear()` method for cleanup.

#### Legacy SSE Support

For backwards compatibility with older MCP clients that use SSE transport:

```ts
const handle = await serveHttp(createServer, {
  port: 8080,
  sessions: {
    legacySse: {
      sseEndpoint: "/sse", // default: "/sse"
      messagesEndpoint: "/messages", // default: "/messages"
    },
  },
});
```

## Entry Points

This package provides multiple entry points for optimal bundle size:

| Entry Point             | Description                 | Requires Hono |
| ----------------------- | --------------------------- | ------------- |
| `@karashiiro/mcp`       | Everything (re-exports all) | Yes           |
| `@karashiiro/mcp/stdio` | Stdio transport only        | No            |
| `@karashiiro/mcp/http`  | HTTP transport only         | Yes           |

If you only need stdio transport, import from `@karashiiro/mcp/stdio` to avoid bundling Hono.

## API Reference

### Factory Types

The library provides two factory types for type-safe server creation:

```ts
// For stateless mode (serveStdio and serveHttp without sessions)
type StatelessServerFactory = () => McpServer | Promise<McpServer>;

// For stateful mode (serveHttp with sessions)
type StatefulServerFactory = (
  sessionId: string,
) => McpServer | Promise<McpServer>;
```

Both factory types support async initialization by returning a `Promise<McpServer>`.

### `serveStdio(serverFactory)`

Serves an MCP server over stdin/stdout.

- `serverFactory: StatelessServerFactory` - Factory function that creates a single server instance
- Returns: `Promise<ServerHandle>`

### `serveHttp(serverFactory, options?)` (stateless)

Serves an MCP server over HTTP in stateless mode.

- `serverFactory: StatelessServerFactory` - Factory function called once, creates a shared server
- `options.port` - Port to listen on (default: `8080`)
- `options.host` - Host to bind to (default: `"127.0.0.1"`)
- `options.endpoint` - MCP endpoint path (default: `"/mcp"`)
- Returns: `Promise<ServerHandle>`

### `serveHttp(serverFactory, options)` (stateful)

Serves an MCP server over HTTP in stateful mode with per-client sessions.

- `serverFactory: StatefulServerFactory` - Factory function called per session with the session ID
- `options.port` - Port to listen on (default: `8080`)
- `options.host` - Host to bind to (default: `"127.0.0.1"`)
- `options.endpoint` - MCP endpoint path (default: `"/mcp"`)
- `options.sessions` - **Required** to enable stateful mode
- `options.sessions.sessionIdGenerator` - Custom session ID generator function
- `options.sessions.legacySse` - Enable legacy SSE transport endpoints
- Returns: `Promise<ServerHandle>`

### `ServerHandle`

Handle for controlling the server lifecycle.

- `close(): Promise<void>` - Gracefully shut down the server

## License

UNLICENSED
