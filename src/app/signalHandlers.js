import process from "node:process";

export function registerShutdownSignals(shutdown) {
  process.on("SIGINT", () => {
    void shutdown?.(0);
  });
  process.on("SIGTERM", () => {
    void shutdown?.(0);
  });
}
