import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import getPort from "get-port";
import { z } from "zod";
import { serveHttp, type HttpServerHandle } from "./index.js";

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
  let serverHandle: HttpServerHandle | undefined;
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
      const factoryCalls: number[] = [];
      serverHandle = await serveHttp(
        () => {
          factoryCalls.push(Date.now());
          return createTestServer();
        },
        { port },
      );

      const client = await createClient(baseUrl);

      // Client connected successfully!
      expect(client).toBeDefined();
      expect(factoryCalls.length).toBe(1); // Factory called once

      await client.close();
    });

    it("calls factory only once for multiple client connections", async () => {
      const factoryCalls: number[] = [];
      serverHandle = await serveHttp(
        () => {
          factoryCalls.push(Date.now());
          return createTestServer();
        },
        { port },
      );

      // Connect multiple clients
      const client1 = await createClient(baseUrl);
      const client2 = await createClient(baseUrl);

      expect(factoryCalls.length).toBe(1); // Still only 1!

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
  });
});
