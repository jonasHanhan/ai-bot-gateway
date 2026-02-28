import path from "node:path";

export interface CliRuntimePaths {
  configPath: string;
  statePath: string;
  heartbeatPath: string;
  restartRequestPath: string;
  restartAckPath: string;
}

export function resolveCliRuntimePaths(cwd: string): CliRuntimePaths {
  return {
    configPath: path.resolve(cwd, process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json"),
    statePath: path.resolve(cwd, process.env.STATE_PATH ?? "data/state.json"),
    heartbeatPath: path.resolve(cwd, process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json"),
    restartRequestPath: path.resolve(cwd, process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json"),
    restartAckPath: path.resolve(cwd, process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json")
  };
}

export function parsePathListEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    return [];
  }
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry));
}
