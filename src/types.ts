/**
 * Handle returned by serve functions for controlling the server lifecycle.
 */
export interface ServerHandle {
  /** Close the server and stop accepting new connections. */
  close: () => Promise<void>;
}
