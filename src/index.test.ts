import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import getPort from "get-port";
import { z } from "zod";
import { InMemoryEventStore } from "./event-store.js";
import { serveHttp, type ServerHandle } from "./index.js";

/**
 * Helper to create a minimal MCP server for testing.
 */
function createTestServer(): McpServer {
  const server = new McpServer({
    name: "test-server",
    version: "1.0.0",
  });

  // Register a simple tool so we can test tool calls
  server.registerTool(
    "echo",
    { description: "Echoes the input", inputSchema: { message: z.string() } },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    }),
  );

  return server;
}

/**
 * Helper to create an MCP client connected to a server via Streamable HTTP.
 */
async function createClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/**
 * Helper to create an MCP client connected to a server via SSE.
 */
async function createSseClient(url: string): Promise<Client> {
  const transport = new SSEClientTransport(new URL(url));
  const client = new Client({ name: "test-sse-client", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

describe("serveHttp integration tests", () => {
  let serverHandle: ServerHandle | undefined;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    port = await getPort();
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  });

  afterEach(async () => {
    if (serverHandle) {
      await serverHandle.close();
      serverHandle = undefined;
    }
  });

  describe("stateless mode", () => {
    it("accepts client connections and responds to initialize", async () => {
      serverHandle = await serveHttp(createTestServer, { port });

      const client = await createClient(baseUrl);

      // Client connected successfully!
      expect(client).toBeDefined();

      await client.close();
    });

    it("calls factory for each request so servers are not reused", async () => {
      const factoryCalls: number[] = [];
      serverHandle = await serveHttp(
        () => {
          factoryCalls.push(Date.now());
          return createTestServer();
        },
        { port },
      );

      // Connect multiple clients — each connection triggers at least one request
      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);

      // Factory must be called more than once since each request gets its own server
      expect(factoryCalls.length).toBeGreaterThan(1);

      await client1.close();
      await client2.close();
    });

    it("can call tools on the server", async () => {
      serverHandle = await serveHttp(createTestServer, { port });

      const client = await createClient(baseUrl);

      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "Hello MCP!" },
      })) as CallToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Echo: Hello MCP!",
      });

      await client.close();
    });

    it("can list tools from the server", async () => {
      serverHandle = await serveHttp(createTestServer, { port });

      const client = await createClient(baseUrl);

      const tools = await client.listTools();

      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]?.name).toBe("echo");

      await client.close();
    });

    it("uses custom port and endpoint", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        endpoint: "/custom-mcp",
      });

      const client = await createClient(`http://127.0.0.1:${port}/custom-mcp`);

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      await client.close();
    });

    it("factory in stateless mode receives no parameters", async () => {
      let factoryCalled = false;

      // In stateless mode, factory signature is () => McpServer (no sessionId parameter)
      serverHandle = await serveHttp(
        () => {
          factoryCalled = true;
          return createTestServer();
        },
        { port },
      );

      const client = await createClient(baseUrl);

      expect(factoryCalled).toBe(true);

      await client.close();
    });

    it("supports async factory in stateless mode", async () => {
      let factoryCallCount = 0;

      serverHandle = await serveHttp(
        async () => {
          // Simulate async initialization
          await new Promise((resolve) => setTimeout(resolve, 10));
          factoryCallCount++;
          return createTestServer();
        },
        { port },
      );

      // Factory is not called at startup — it's called per request
      expect(factoryCallCount).toBe(0);

      const client = await createClient(baseUrl);

      // After connecting, factory should have been called at least once
      expect(factoryCallCount).toBeGreaterThanOrEqual(1);

      // Verify the server works
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      await client.close();
    });
  });

  describe("stateful mode (sessions)", () => {
    it("accepts client connections in session mode", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {},
      });

      const client = await createClient(baseUrl);

      // Client connected successfully!
      expect(client).toBeDefined();

      await client.close();
    });

    it("calls factory for each new client session", async () => {
      const factoryCalls: number[] = [];
      serverHandle = await serveHttp(
        () => {
          factoryCalls.push(Date.now());
          return createTestServer();
        },
        {
          port,
          sessions: {},
        },
      );

      // Each client gets its own session
      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);

      expect(factoryCalls.length).toBe(2); // One per session!

      await client1.close();
      await client2.close();
    });

    it("can call tools in session mode", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {},
      });

      const client = await createClient(baseUrl);

      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "Session test!" },
      })) as CallToolResult;

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Echo: Session test!",
      });

      await client.close();
    });

    it("maintains separate state per session", async () => {
      // Create server with a tool that tracks call count
      const serverCallCounts = new Map<string, number>();

      serverHandle = await serveHttp(
        () => {
          const serverId = Math.random().toString(36).slice(2);
          serverCallCounts.set(serverId, 0);

          const server = new McpServer({
            name: "stateful-test-server",
            version: "1.0.0",
          });

          server.tool("increment", "Increments counter", {}, async () => {
            const count = (serverCallCounts.get(serverId) ?? 0) + 1;
            serverCallCounts.set(serverId, count);
            return { content: [{ type: "text", text: `Count: ${count}` }] };
          });

          return server;
        },
        {
          port,
          sessions: {},
        },
      );

      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);

      // Each client has its own server instance with its own counter
      const result1a = (await client1.callTool({
        name: "increment",
        arguments: {},
      })) as CallToolResult;
      const result1b = (await client1.callTool({
        name: "increment",
        arguments: {},
      })) as CallToolResult;
      const result2a = (await client2.callTool({
        name: "increment",
        arguments: {},
      })) as CallToolResult;

      // Client 1's counter: 1, 2
      expect(result1a.content[0]).toMatchObject({ text: "Count: 1" });
      expect(result1b.content[0]).toMatchObject({ text: "Count: 2" });

      // Client 2's counter: 1 (independent!)
      expect(result2a.content[0]).toMatchObject({ text: "Count: 1" });

      await client1.close();
      await client2.close();
    });

    it("uses custom sessionIdGenerator", async () => {
      let generatorCalled = false;

      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          sessionIdGenerator: () => {
            generatorCalled = true;
            return "my-custom-session-id-12345";
          },
        },
      });

      const client = await createClient(baseUrl);

      expect(generatorCalled).toBe(true);

      await client.close();
    });

    it("passes sessionId to factory in stateful mode", async () => {
      const receivedSessionIds: (string | undefined)[] = [];

      serverHandle = await serveHttp(
        (sessionId) => {
          receivedSessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {
            sessionIdGenerator: () => "test-session-123",
          },
        },
      );

      const client = await createClient(baseUrl);

      expect(receivedSessionIds.length).toBe(1);
      expect(receivedSessionIds[0]).toBe("test-session-123");

      await client.close();
    });

    it("supports async factory returning Promise<McpServer>", async () => {
      const factoryCalls: string[] = [];

      serverHandle = await serveHttp(
        async (sessionId) => {
          // Simulate async initialization
          await new Promise((resolve) => setTimeout(resolve, 10));
          factoryCalls.push(sessionId ?? "undefined");
          return createTestServer();
        },
        {
          port,
          sessions: {
            sessionIdGenerator: () => "async-session-456",
          },
        },
      );

      const client = await createClient(baseUrl);

      expect(factoryCalls.length).toBe(1);
      expect(factoryCalls[0]).toBe("async-session-456");

      // Verify the server actually works
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      await client.close();
    });
  });

  describe("legacy SSE mode", () => {
    it("accepts SSE client connections", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          legacySse: {},
        },
      });

      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const client = await createSseClient(sseUrl);

      // Client connected successfully!
      expect(client).toBeDefined();

      await client.close();
    });

    it("can call tools over SSE transport", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          legacySse: {},
        },
      });

      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const client = await createSseClient(sseUrl);

      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "Hello SSE!" },
      })) as CallToolResult;

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Echo: Hello SSE!",
      });

      await client.close();
    });

    it("uses custom SSE endpoints", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          legacySse: {
            sseEndpoint: "/custom-sse",
            messagesEndpoint: "/custom-messages",
          },
        },
      });

      const sseUrl = `http://127.0.0.1:${port}/custom-sse`;
      const client = await createSseClient(sseUrl);

      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]?.name).toBe("echo");

      await client.close();
    });

    it("calls factory for each SSE client session", async () => {
      const factoryCalls: number[] = [];
      serverHandle = await serveHttp(
        () => {
          factoryCalls.push(Date.now());
          return createTestServer();
        },
        {
          port,
          sessions: {
            legacySse: {},
          },
        },
      );

      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const client1 = await createSseClient(sseUrl);
      const client2 = await createSseClient(sseUrl);

      expect(factoryCalls.length).toBe(2); // One per SSE session!

      await client1.close();
      await client2.close();
    });

    it("passes sessionId to factory in SSE mode", async () => {
      const receivedSessionIds: (string | undefined)[] = [];

      serverHandle = await serveHttp(
        (sessionId) => {
          receivedSessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {
            legacySse: {},
          },
        },
      );

      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const client = await createSseClient(sseUrl);

      expect(receivedSessionIds.length).toBe(1);
      // SSE transport generates its own session ID (UUID format)
      expect(receivedSessionIds[0]).toBeDefined();
      expect(typeof receivedSessionIds[0]).toBe("string");

      await client.close();
    });

    it("supports async factory in SSE mode", async () => {
      const factoryCalls: string[] = [];

      serverHandle = await serveHttp(
        async (sessionId) => {
          // Simulate async initialization
          await new Promise((resolve) => setTimeout(resolve, 10));
          factoryCalls.push(sessionId ?? "undefined");
          return createTestServer();
        },
        {
          port,
          sessions: {
            legacySse: {},
          },
        },
      );

      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const client = await createSseClient(sseUrl);

      expect(factoryCalls.length).toBe(1);
      expect(factoryCalls[0]).not.toBe("undefined");

      // Verify the server works
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      await client.close();
    });

    it("supports both SSE and streamable HTTP clients simultaneously", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          legacySse: {},
        },
      });

      // Connect SSE client
      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const sseClient = await createSseClient(sseUrl);

      // Connect Streamable HTTP client
      const httpClient = await createClient(baseUrl);

      // Both should work
      const sseResult = (await sseClient.callTool({
        name: "echo",
        arguments: { message: "SSE" },
      })) as CallToolResult;

      const httpResult = (await httpClient.callTool({
        name: "echo",
        arguments: { message: "HTTP" },
      })) as CallToolResult;

      expect(sseResult.content[0]).toMatchObject({ text: "Echo: SSE" });
      expect(httpResult.content[0]).toMatchObject({ text: "Echo: HTTP" });

      await sseClient.close();
      await httpClient.close();
    });
  });

  describe("server handle", () => {
    it("can close the server", async () => {
      serverHandle = await serveHttp(createTestServer, { port });

      // Server works before close
      const client = await createClient(baseUrl);
      await client.listTools();
      await client.close();

      // Close the server
      await serverHandle.close();
      serverHandle = undefined; // Prevent double-close in afterEach

      // Server should reject new connections after close
      await expect(createClient(baseUrl)).rejects.toThrow();
    });

    it("cleans up all sessions on close", async () => {
      const sessionIds: string[] = [];
      serverHandle = await serveHttp(
        (sessionId) => {
          sessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {
            sessionTtlMs: 60000, // Long TTL so sessions don't expire
          },
        },
      );

      // Create multiple sessions
      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);
      expect(sessionIds.length).toBe(2);

      // Verify sessions work
      await client1.listTools();
      await client2.listTools();

      // Close the server - this should clean up all sessions
      await serverHandle.close();
      serverHandle = undefined;

      // Server should be down, can't create new connections
      await expect(createClient(baseUrl)).rejects.toThrow();
    });
  });

  describe("session TTL", () => {
    it("expires sessions after TTL with no activity", async () => {
      const sessionIds: string[] = [];
      serverHandle = await serveHttp(
        (sessionId) => {
          sessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {
            sessionTtlMs: 100, // 100ms TTL
            cleanupIntervalMs: 50, // Check every 50ms
          },
        },
      );

      // Create a session
      const client = await createClient(baseUrl);
      const sessionId = sessionIds[0]!;

      // Verify session works
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      // Wait for TTL + cleanup interval to pass
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Session should be expired - subsequent request should fail
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(response.status).toBe(404);
    });

    it("keeps sessions alive with activity", async () => {
      const sessionIds: string[] = [];
      serverHandle = await serveHttp(
        (sessionId) => {
          sessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {
            sessionTtlMs: 150, // 150ms TTL
            cleanupIntervalMs: 50, // Check every 50ms
          },
        },
      );

      // Create a session
      const client = await createClient(baseUrl);

      // Keep session alive by making requests every 100ms (before TTL expires)
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(1);
      }

      // Session should still be alive after 300ms total (3 x 100ms)
      // because each request refreshed the TTL
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      await client.close();
    });

    it("does not expire SSE sessions with active connections", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          sessionTtlMs: 100, // Very short TTL
          cleanupIntervalMs: 50,
          legacySse: {},
        },
      });

      // Connect SSE client (this creates an active stream)
      const sseUrl = `http://127.0.0.1:${port}/sse`;
      const sseClient = await createSseClient(sseUrl);

      // Wait longer than TTL
      await new Promise((resolve) => setTimeout(resolve, 200));

      // SSE session should still be alive because it has an active stream
      const tools = await sseClient.listTools();
      expect(tools.tools).toHaveLength(1);

      await sseClient.close();
    });
  });

  describe("DELETE session termination", () => {
    it("returns 204 when deleting a valid session", async () => {
      const sessionIds: string[] = [];
      serverHandle = await serveHttp(
        (sessionId) => {
          sessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {},
        },
      );

      // Create a session by connecting a client
      const client = await createClient(baseUrl);
      expect(sessionIds.length).toBe(1);
      const sessionId = sessionIds[0];

      // Send DELETE request with session ID
      const response = await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId!,
        },
      });

      expect(response.status).toBe(204);

      // Note: client.close() may fail since session is already deleted, that's OK
      try {
        await client.close();
      } catch {
        // Expected - session was deleted server-side
      }
    });

    it("returns 404 when deleting a non-existent session", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {},
      });

      // Send DELETE with fake session ID
      const response = await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          "mcp-session-id": "non-existent-session-id-12345",
        },
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Session not found");
    });

    it("returns 400 when DELETE has no session ID", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {},
      });

      // Send DELETE without session ID header
      const response = await fetch(baseUrl, {
        method: "DELETE",
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Session ID required for DELETE");
    });

    it("subsequent requests to deleted session fail with 404", async () => {
      const sessionIds: string[] = [];
      serverHandle = await serveHttp(
        (sessionId) => {
          sessionIds.push(sessionId);
          return createTestServer();
        },
        {
          port,
          sessions: {},
        },
      );

      // Create a session
      const client = await createClient(baseUrl);
      const sessionId = sessionIds[0]!;

      // Verify session works
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(1);

      // Delete the session
      const deleteResponse = await fetch(baseUrl, {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId,
        },
      });
      expect(deleteResponse.status).toBe(204);

      // Try to use the deleted session - should get 404
      const postResponse = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": sessionId,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(postResponse.status).toBe(404);
    });
  });

  describe("custom event store factory", () => {
    it("uses default InMemoryEventStore when factory not provided", async () => {
      // Verify backward compatibility - existing code works unchanged
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          sessionTtlMs: 60000,
          // No eventStoreFactory provided
        },
      });

      const client = await createClient(baseUrl);

      // Verify session works (implicitly using default InMemoryEventStore)
      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "test" },
      })) as CallToolResult;
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Echo: test",
      });

      await client.close();
    });

    it("calls custom sync factory with correct session ID", async () => {
      // Verify factory receives session ID for session-specific configuration
      const factoryCalls: string[] = [];

      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          eventStoreFactory: (sessionId) => {
            factoryCalls.push(sessionId);
            return new InMemoryEventStore({
              maxEventsPerStream: 100,
            });
          },
        },
      });

      const client = await createClient(baseUrl);

      // Verify factory was called exactly once with a valid session ID
      expect(factoryCalls).toHaveLength(1);
      expect(factoryCalls[0]).toBeTruthy();
      expect(typeof factoryCalls[0]).toBe("string");

      await client.close();
    });

    it("calls custom async factory and awaits result", async () => {
      // Verify async factory support (important for Redis/DB-backed stores)
      let factoryCalled = false;

      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          eventStoreFactory: async (sessionId) => {
            await new Promise((resolve) => setTimeout(resolve, 50));
            factoryCalled = true;
            return new InMemoryEventStore();
          },
        },
      });

      const client = await createClient(baseUrl);

      // Verify async factory was awaited before session creation completed
      expect(factoryCalled).toBe(true);

      await client.close();
    });

    it("creates separate event store instances per session", async () => {
      // Verify session isolation - each session gets its own store
      const factoryCalls: string[] = [];
      const stores: unknown[] = [];

      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          eventStoreFactory: (sessionId) => {
            factoryCalls.push(sessionId);
            const store = new InMemoryEventStore();
            stores.push(store);
            return store;
          },
        },
      });

      // Create two separate client sessions
      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);

      // Verify factory called twice with different session IDs
      expect(factoryCalls).toHaveLength(2);
      expect(factoryCalls[0]).not.toBe(factoryCalls[1]);

      // Verify two separate store instances created
      expect(stores).toHaveLength(2);
      expect(stores[0]).not.toBe(stores[1]);

      await client1.close();
      await client2.close();
    });

    it("respects InMemoryEventStore options from factory", async () => {
      // Verify factory can pass custom options to InMemoryEventStore
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          eventStoreFactory: (sessionId) => {
            // Create with maxEventsPerStream limit
            return new InMemoryEventStore({ maxEventsPerStream: 5 });
          },
        },
      });

      const client = await createClient(baseUrl);

      // Make multiple requests to generate events
      for (let i = 0; i < 10; i++) {
        await client.callTool({
          name: "echo",
          arguments: { message: `test ${i}` },
        });
      }

      // Session still works (no errors thrown)
      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "final test" },
      })) as CallToolResult;
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "Echo: final test",
      });

      await client.close();
    });
  });

  describe("session restoration", () => {
    it("restores session from persistent event store after simulated restart", async () => {
      // Use a persistent store that survives clear() calls
      // This simulates a DB-backed store that persists init requests
      class PersistentTestStore extends InMemoryEventStore {
        private persistedInitRequest: { sessionId: string; request: unknown } | undefined;

        override async storeInitializeRequest(sessionId: string, request: unknown): Promise<void> {
          this.persistedInitRequest = { sessionId, request };
          await super.storeInitializeRequest(sessionId, request as import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage);
        }

        override async hasSession(sessionId: string): Promise<boolean> {
          return this.persistedInitRequest?.sessionId === sessionId;
        }

        override async getInitializeRequest(sessionId: string): Promise<import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage | undefined> {
          if (this.persistedInitRequest?.sessionId === sessionId) {
            return this.persistedInitRequest.request as import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage;
          }
          return undefined;
        }

        // Override clear to NOT clear the init request (simulating persistent storage)
        override clear(): void {
          // Only clear events, not the init request
          // This simulates a DB store that persists init requests
        }
      }

      const sharedStore = new PersistentTestStore();
      let capturedSessionId: string | undefined;

      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          eventStoreFactory: () => sharedStore,
          sessionIdGenerator: () => {
            capturedSessionId = "restoration-test-session-" + Date.now();
            return capturedSessionId;
          },
        },
      });

      // Create initial session and make a request
      const client = await createClient(baseUrl);
      const result = (await client.callTool({
        name: "echo",
        arguments: { message: "before restart" },
      })) as CallToolResult;
      expect(result.content[0]).toMatchObject({
        text: "Echo: before restart",
      });

      // Close the client before shutting down
      await client.close();

      // Simulate server restart by closing and reopening
      await serverHandle.close();
      serverHandle = undefined;

      // Get a new port to avoid port conflicts
      const newPort = await getPort();
      const newBaseUrl = `http://127.0.0.1:${newPort}/mcp`;

      // Reopen server with the same shared store
      serverHandle = await serveHttp(createTestServer, {
        port: newPort,
        sessions: {
          eventStoreFactory: () => sharedStore,
        },
      });

      // Try to use the old session ID - should restore successfully
      const response = await fetch(newBaseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": capturedSessionId!,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      // Should succeed (200 OK) instead of 404
      expect(response.status).toBe(200);

      // Response might be SSE format or JSON - handle both
      const contentType = response.headers.get("content-type");
      let responseBody: unknown;
      if (contentType?.includes("text/event-stream")) {
        // Parse SSE format: "event: message\ndata: {...}\n\n"
        const sseText = await response.text();
        const dataLine = sseText.split("\n").find(line => line.startsWith("data: "));
        responseBody = dataLine ? JSON.parse(dataLine.slice(6)) : null;
      } else {
        responseBody = await response.json();
      }

      expect(responseBody).toMatchObject({
        jsonrpc: "2.0",
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "echo" }),
          ]),
        },
        id: 1,
      });
    });

    it("returns 404 for unknown session when event store has no data", async () => {
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          // Empty event stores that support restoration methods but have no data
          eventStoreFactory: () => new InMemoryEventStore(),
        },
      });

      // Try to use a non-existent session ID
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "mcp-session-id": "non-existent-session-12345",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/list",
          id: 1,
        }),
      });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Session not found");
    });

    it("handles concurrent restoration requests for same session", async () => {
      // Use a persistent store that survives clear() calls
      class PersistentTestStore extends InMemoryEventStore {
        private persistedInitRequest: { sessionId: string; request: unknown } | undefined;

        override async storeInitializeRequest(sessionId: string, request: unknown): Promise<void> {
          this.persistedInitRequest = { sessionId, request };
          await super.storeInitializeRequest(sessionId, request as import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage);
        }

        override async hasSession(sessionId: string): Promise<boolean> {
          return this.persistedInitRequest?.sessionId === sessionId;
        }

        override async getInitializeRequest(sessionId: string): Promise<import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage | undefined> {
          if (this.persistedInitRequest?.sessionId === sessionId) {
            return this.persistedInitRequest.request as import("@modelcontextprotocol/sdk/types.js").JSONRPCMessage;
          }
          return undefined;
        }

        override clear(): void {
          // Only clear events, not the init request
        }
      }

      const sharedStore = new PersistentTestStore();
      let restorationAttempts = 0;
      const restorationDelay = 100; // ms

      // First, create a session
      serverHandle = await serveHttp(createTestServer, {
        port,
        sessions: {
          eventStoreFactory: () => sharedStore,
          sessionIdGenerator: () => "concurrent-test-session",
        },
      });

      // Initialize the session
      const client = await createClient(baseUrl);
      await client.listTools();
      await client.close();

      // Simulate restart
      await serverHandle.close();
      serverHandle = undefined;

      // Get a new port
      const newPort = await getPort();
      const newBaseUrl = `http://127.0.0.1:${newPort}/mcp`;

      // Reopen with a slow event store factory to simulate slow restoration
      serverHandle = await serveHttp(createTestServer, {
        port: newPort,
        sessions: {
          eventStoreFactory: async () => {
            restorationAttempts++;
            // Add delay to simulate slow restoration
            await new Promise((resolve) => setTimeout(resolve, restorationDelay));
            return sharedStore;
          },
        },
      });

      // Fire multiple concurrent requests with the same session ID
      const concurrentRequests = Array(3)
        .fill(null)
        .map(() =>
          fetch(newBaseUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
              "mcp-session-id": "concurrent-test-session",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              method: "tools/list",
              id: 1,
            }),
          }),
        );

      const responses = await Promise.all(concurrentRequests);

      // All requests should succeed
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      // Only ONE restoration should have been attempted due to the lock
      // (eventStoreFactory is called once for restoration check, then the
      // restored session is reused for subsequent requests)
      expect(restorationAttempts).toBe(1);
    });
  });
});
