import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, it, expect, afterEach } from "vitest";

// Path to the test server script (relative to project root where tests run)
const testServerScript = "src/test-stdio-server.mjs";

/**
 * Helper to create a stdio client connected to a spawned server process.
 * StdioClientTransport handles spawning the subprocess internally.
 */
async function createStdioClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [testServerScript],
  });

  const client = new Client({ name: "test-stdio-client", version: "1.0.0" });
  await client.connect(transport);

  return client;
}

describe("serveStdio integration tests", () => {
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = undefined;
    }
  });

  it("accepts client connections and responds to initialize", async () => {
    client = await createStdioClient();

    expect(client).toBeDefined();
  });

  it("can list tools from the server", async () => {
    client = await createStdioClient();

    const tools = await client.listTools();

    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]?.name).toBe("echo");
  });

  it("can call tools on the server", async () => {
    client = await createStdioClient();

    const result = (await client.callTool({
      name: "echo",
      arguments: { message: "Hello stdio!" },
    })) as CallToolResult;

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Echo: Hello stdio!",
    });
  });
});
