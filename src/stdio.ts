import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ServerHandle, StatelessServerFactory } from "./types.js";

export type { ServerHandle, StatelessServerFactory } from "./types.js";

// Re-export for backwards compatibility
export type { ServerFactory } from "./types.js";

/**
 * Serve an MCP server over stdio (stdin/stdout).
 *
 * @param serverFactory - Factory function that creates an McpServer instance.
 *   Called once with no parameters (stdio is always single-session).
 *   Can return a Promise for async initialization.
 * @returns A handle to control the server lifecycle.
 */
export async function serveStdio(
  serverFactory: StatelessServerFactory,
): Promise<ServerHandle> {
  const server = await serverFactory();

  const transport = new StdioServerTransport();

  // Set up the closed promise before connecting
  let resolveClose: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClose = resolve;
  });

  transport.onclose = () => {
    resolveClose();
  };

  // connect() automatically calls transport.start() for stdio
  await server.connect(transport);

  let closePromise: Promise<void> | undefined;

  return {
    close: () => {
      if (!closePromise) {
        closePromise = transport.close().then(() => closedPromise);
      }
      return closePromise;
    },
  };
}
