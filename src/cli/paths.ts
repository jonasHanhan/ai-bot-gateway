import path from "node:path";
import fs from "node:fs";

export interface CliRuntimePaths {
  configPath: string;
  statePath: string;
  heartbeatPath: string;
  restartRequestPath: string;
  restartAckPath: string;
  stdoutLogPath: string;
  stderrLogPath: string;
}

export function resolveCliRuntimePaths(cwd: string): CliRuntimePaths {
  const runtimeRoot = resolveRuntimeRoot(cwd);
  const plistLogPaths = readLaunchdLogPaths(runtimeRoot);
  const stdoutLogPath = resolveLogPath(
    process.env.DISCORD_STDOUT_LOG_PATH,
    plistLogPaths.stdoutLogPath,
    "/tmp/codex-discord-bridge.out.log"
  );
  const stderrLogPath = resolveLogPath(
    process.env.DISCORD_STDERR_LOG_PATH,
    plistLogPaths.stderrLogPath,
    "/tmp/codex-discord-bridge.err.log"
  );

  return {
    configPath: path.resolve(runtimeRoot, process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json"),
    statePath: path.resolve(runtimeRoot, process.env.STATE_PATH ?? "data/state.json"),
    heartbeatPath: path.resolve(runtimeRoot, process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json"),
    restartRequestPath: path.resolve(runtimeRoot, process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json"),
    restartAckPath: path.resolve(runtimeRoot, process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json"),
    stdoutLogPath,
    stderrLogPath
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

function resolveLogPath(envValue: string | undefined, plistValue: string | null, fallback: string): string {
  const fromEnv = String(envValue ?? "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const fromPlist = String(plistValue ?? "").trim();
  if (fromPlist) {
    return path.resolve(fromPlist);
  }
  return path.resolve(fallback);
}

function resolveRuntimeRoot(cwd: string): string {
  const configured = String(process.env.DISCORD_BRIDGE_ROOT ?? "").trim();
  if (configured) {
    return path.resolve(configured);
  }
  return path.resolve(cwd);
}

function readLaunchdLogPaths(cwd: string): { stdoutLogPath: string | null; stderrLogPath: string | null } {
  const plistPath = path.resolve(cwd, "com.codex.discord.bridge.plist");
  try {
    const raw = fs.readFileSync(plistPath, "utf8");
    const stdoutLogPath = extractPlistStringValue(raw, "StandardOutPath");
    const stderrLogPath = extractPlistStringValue(raw, "StandardErrorPath");
    return { stdoutLogPath, stderrLogPath };
  } catch {
    return { stdoutLogPath: null, stderrLogPath: null };
  }
}

function extractPlistStringValue(raw: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]+)<\\/string>`, "i");
  const match = raw.match(pattern);
  const value = String(match?.[1] ?? "").trim();
  return value || null;
}
