// Test server script for stdio tests
// Uses jiti to load TypeScript directly

import { createRequire } from "module";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const jiti = require("jiti")(__filename);

const { serveStdio } = jiti("./index.ts");
const { McpServer } = jiti("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = jiti("zod");

function createTestServer() {
  const server = new McpServer({
    name: "test-stdio-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    { description: "Echoes the input", inputSchema: { message: z.string() } },
    async ({ message }) => ({
      content: [{ type: "text", text: `Echo: ${message}` }],
    }),
  );

  return server;
}

// Start the server - serveStdio returns immediately with a handle
await serveStdio(createTestServer);

// Keep process alive - stdin listener keeps Node running
process.stdin.resume();
