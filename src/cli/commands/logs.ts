import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { resolveCliRuntimePaths } from "../paths.js";

export async function runLogsCommand(args: string[], context: CliContext): Promise<CliCommandResult> {
  const options = parseLogsOptions(args);
  if (!options.ok) {
    return {
      ok: false,
      message: options.error,
      details: {
        usage: "logs [--lines <n>] [--since <duration|iso>] [--stdout] [--stderr] [--no-follow] [--clear]"
      }
    };
  }

  const paths = resolveCliRuntimePaths(context.cwd);
  const targetPaths = [];
  if (options.includeStdout) {
    targetPaths.push(paths.stdoutLogPath);
  }
  if (options.includeStderr) {
    targetPaths.push(paths.stderrLogPath);
  }
  const uniqueTargetPaths = [...new Set(targetPaths)];

  if (options.clear) {
    for (const logPath of uniqueTargetPaths) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, "");
    }
    console.error(`[dc-bridge logs] cleared: ${uniqueTargetPaths.map((entry) => `'${entry}'`).join(", ")}`);
    if (!options.follow) {
      return {
        ok: true,
        message: "logs cleared",
        details: {
          follow: options.follow,
          lines: options.lines,
          clear: true,
          paths: uniqueTargetPaths
        }
      };
    }
  }

  const existing = uniqueTargetPaths.filter((entry) => fs.existsSync(entry));
  if (existing.length === 0) {
    console.error(
      `[dc-bridge logs] no log file exists yet. waiting on: ${uniqueTargetPaths.map((entry) => `'${entry}'`).join(", ")}`
    );
  } else {
    console.error(`[dc-bridge logs] tailing: ${existing.map((entry) => `'${entry}'`).join(", ")}`);
  }

  if (options.since) {
    const sinceDate = parseSinceDate(options.since, context.now);
    if (!sinceDate) {
      return {
        ok: false,
        message: `invalid value for --since: ${options.since}`,
        details: {
          usage: "logs --since <10m|2h|1d|2026-02-28T10:00:00Z>"
        }
      };
    }
    const matched = printLogsSince(uniqueTargetPaths, sinceDate);
    console.error(
      `[dc-bridge logs] since ${sinceDate.toISOString()} matched ${matched} line${matched === 1 ? "" : "s"}`
    );
    if (!options.follow) {
      return {
        ok: true,
        message: "logs since output complete",
        details: {
          follow: options.follow,
          lines: options.lines,
          clear: options.clear,
          since: sinceDate.toISOString(),
          paths: uniqueTargetPaths
        }
      };
    }
  }

  const tailArgs = ["-n", options.since ? "0" : String(options.lines), "-F", ...uniqueTargetPaths];
  if (!options.follow) {
    tailArgs.splice(1, 1, String(options.lines));
    const followIndex = tailArgs.indexOf("-F");
    if (followIndex >= 0) {
      tailArgs.splice(followIndex, 1);
    }
  }

  const exitCode = await runTail(tailArgs);
  if (exitCode === 0 || exitCode === null) {
    return {
      ok: true,
      message: "logs stream ended",
      details: {
        follow: options.follow,
        lines: options.lines,
        clear: options.clear,
        since: options.since ?? null,
        paths: uniqueTargetPaths
      }
    };
  }
  return {
    ok: false,
    message: `tail exited with code ${exitCode}`,
    details: {
      follow: options.follow,
      lines: options.lines,
      clear: options.clear,
      since: options.since ?? null,
      paths: uniqueTargetPaths
    }
  };
}

async function runTail(args: string[]): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn("tail", args, { stdio: "inherit" });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => resolve(code));
  });
}

function parseLogsOptions(args: string[]):
  | {
      ok: true;
      lines: number;
      since: string | null;
      follow: boolean;
      clear: boolean;
      includeStdout: boolean;
      includeStderr: boolean;
    }
  | { ok: false; error: string } {
  let lines = 200;
  let since: string | null = null;
  let follow = true;
  let clear = false;
  let includeStdout = true;
  let includeStderr = true;

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? "").trim();
    if (!arg) {
      continue;
    }
    if (arg === "--no-follow") {
      follow = false;
      continue;
    }
    if (arg === "--clear") {
      clear = true;
      continue;
    }
    if (arg === "--stdout") {
      includeStdout = true;
      includeStderr = false;
      continue;
    }
    if (arg === "--stderr") {
      includeStdout = false;
      includeStderr = true;
      continue;
    }
    if (arg === "--lines") {
      const raw = String(args[index + 1] ?? "").trim();
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: "invalid value for --lines (must be a positive integer)" };
      }
      lines = parsed;
      index += 1;
      continue;
    }
    if (arg === "--since") {
      const raw = String(args[index + 1] ?? "").trim();
      if (!raw) {
        return { ok: false, error: "missing value for --since" };
      }
      since = raw;
      index += 1;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  return {
    ok: true,
    lines,
    since,
    follow,
    clear,
    includeStdout,
    includeStderr
  };
}

function parseSinceDate(raw: string, now: Date): Date | null {
  const normalized = String(raw ?? "").trim();
  if (!normalized) {
    return null;
  }

  const relative = /^(\d+)([smhd])$/i.exec(normalized);
  if (relative) {
    const value = Number.parseInt(relative[1], 10);
    const unit = relative[2].toLowerCase();
    const multipliers: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000
    };
    const offset = value * (multipliers[unit] ?? 0);
    if (!Number.isFinite(offset) || offset <= 0) {
      return null;
    }
    return new Date(now.getTime() - offset);
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function printLogsSince(logPaths: string[], sinceDate: Date): number {
  let total = 0;
  for (const logPath of logPaths) {
    if (!fs.existsSync(logPath)) {
      continue;
    }
    const raw = fs.readFileSync(logPath, "utf8");
    const lines = raw.split(/\r?\n/);
    const matched = lines.filter((line) => {
      const timestamp = extractTimestamp(line);
      return timestamp !== null && timestamp >= sinceDate.getTime();
    });
    if (matched.length === 0) {
      continue;
    }
    total += matched.length;
    process.stdout.write(`==> ${logPath} <==\n`);
    process.stdout.write(`${matched.join("\n")}\n`);
  }
  return total;
}

function extractTimestamp(line: string): number | null {
  if (typeof line !== "string" || !line.trim()) {
    return null;
  }

  const directIso = line.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/);
  if (directIso) {
    const time = Date.parse(directIso[0]);
    if (!Number.isNaN(time)) {
      return time;
    }
  }

  const jsonIso = line.match(/"at"\s*:\s*"([^"]+)"/);
  if (jsonIso) {
    const time = Date.parse(jsonIso[1]);
    if (!Number.isNaN(time)) {
      return time;
    }
  }

  return null;
}
