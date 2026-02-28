import fs from "node:fs/promises";
import path from "node:path";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths } from "../paths.js";

export async function runStatusCommand(_args: string[], context: CliContext): Promise<CliCommandResult> {
  const paths = resolveCliRuntimePaths(context.cwd);
  const packagePath = path.resolve(context.cwd, "package.json");

  const [version, stateSummary, heartbeatSummary] = await Promise.all([
    readPackageVersion(packagePath),
    readStateSummary(paths.statePath),
    readHeartbeatSummary(paths.heartbeatPath)
  ]);

  return {
    ok: true,
    message: "status: ok",
    details: {
      version,
      pid: process.pid,
      configPath: paths.configPath,
      statePath: paths.statePath,
      restartRequestPath: paths.restartRequestPath,
      restartAckPath: paths.restartAckPath,
      heartbeatPath: paths.heartbeatPath,
      bindings: stateSummary.bindings,
      heartbeat: heartbeatSummary
    }
  };
}

async function readPackageVersion(packagePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version) {
      return parsed.version;
    }
  } catch {}
  return "unknown";
}

async function readStateSummary(statePath: string): Promise<{ bindings: number }> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { threadBindings?: Record<string, unknown> };
    const bindings = parsed && typeof parsed.threadBindings === "object" && parsed.threadBindings
      ? Object.keys(parsed.threadBindings).length
      : 0;
    return { bindings };
  } catch {
    return { bindings: 0 };
  }
}

async function readHeartbeatSummary(heartbeatPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(heartbeatPath, "utf8");
    const parsed = JSON.parse(raw) as {
      updatedAt?: string;
      startedAt?: string;
      activeTurns?: number;
      pendingApprovals?: number;
    };
    const updatedAt = typeof parsed.updatedAt === "string" ? parsed.updatedAt : null;
    const ageMs = updatedAt ? Math.max(0, Date.now() - new Date(updatedAt).getTime()) : null;
    return {
      found: true,
      updatedAt,
      ageSeconds: Number.isFinite(ageMs) && ageMs !== null ? Math.floor(ageMs / 1000) : null,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
      activeTurns: Number.isFinite(parsed.activeTurns) ? parsed.activeTurns : null,
      pendingApprovals: Number.isFinite(parsed.pendingApprovals) ? parsed.pendingApprovals : null
    };
  } catch {
    return {
      found: false
    };
  }
}
