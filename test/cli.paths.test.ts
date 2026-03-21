import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveCliRuntimePaths, resolveInstalledLaunchdPlistPath } from "../src/cli/paths.js";

const tempDirs: string[] = [];
const originalStdout = process.env.DISCORD_STDOUT_LOG_PATH;
const originalStderr = process.env.DISCORD_STDERR_LOG_PATH;
const originalHome = process.env.HOME;

beforeEach(() => {
  delete process.env.DISCORD_STDOUT_LOG_PATH;
  delete process.env.DISCORD_STDERR_LOG_PATH;
});

afterEach(async () => {
  process.env.DISCORD_STDOUT_LOG_PATH = originalStdout;
  process.env.DISCORD_STDERR_LOG_PATH = originalStderr;
  process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("cli paths", () => {
  test("reads launchd stdout/stderr log paths from plist", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>StandardOutPath</key><string>/tmp/custom.out.log</string>
<key>StandardErrorPath</key><string>/tmp/custom.err.log</string>
</dict></plist>`;
    await fs.writeFile(path.join(cwd, "com.agent.gateway.plist"), plist, "utf8");

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.stdoutLogPath).toBe(path.resolve("/tmp/custom.out.log"));
    expect(runtimePaths.stderrLogPath).toBe(path.resolve("/tmp/custom.err.log"));
  });

  test("env overrides plist log paths", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>StandardOutPath</key><string>/tmp/plist.out.log</string></dict></plist>",
      "utf8"
    );
    process.env.DISCORD_STDOUT_LOG_PATH = "/tmp/env.out.log";
    process.env.DISCORD_STDERR_LOG_PATH = "/tmp/env.err.log";

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.stdoutLogPath).toBe(path.resolve("/tmp/env.out.log"));
    expect(runtimePaths.stderrLogPath).toBe(path.resolve("/tmp/env.err.log"));
  });

  test("prefers installed launch agent plist log paths when present", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    await fs.mkdir(path.join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    await fs.writeFile(
      resolveInstalledLaunchdPlistPath("com.agent.gateway"),
      `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>Label</key><string>com.agent.gateway</string>
<key>StandardOutPath</key><string>/tmp/installed.out.log</string>
<key>StandardErrorPath</key><string>/tmp/installed.err.log</string>
</dict></plist>`,
      "utf8"
    );
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>StandardOutPath</key><string>/tmp/source.out.log</string></dict></plist>",
      "utf8"
    );

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.stdoutLogPath).toBe(path.resolve("/tmp/installed.out.log"));
    expect(runtimePaths.stderrLogPath).toBe(path.resolve("/tmp/installed.err.log"));
  });

  test("prefers managed runtime paths when the installed launch agent mirror exists", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-paths-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-cli-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    const installedPlistPath = resolveInstalledLaunchdPlistPath("com.agent.gateway");
    const supportRoot = path.join(fakeHome, "Library", "Application Support", "AgentGateway", "com.agent.gateway");
    const managedRuntimeRoot = path.join(supportRoot, "runtime");
    await fs.mkdir(path.join(fakeHome, "Library", "LaunchAgents"), { recursive: true });
    await fs.mkdir(path.join(managedRuntimeRoot, "config"), { recursive: true });
    await fs.mkdir(path.join(managedRuntimeRoot, "data"), { recursive: true });
    await fs.writeFile(installedPlistPath, "<plist><dict><key>Label</key><string>com.agent.gateway</string></dict></plist>", "utf8");
    await fs.writeFile(path.join(supportRoot, "launchd-wrapper.sh"), "#!/usr/bin/env bash\n", "utf8");

    const runtimePaths = resolveCliRuntimePaths(cwd);
    expect(runtimePaths.configPath).toBe(path.join(managedRuntimeRoot, "config", "channels.json"));
    expect(runtimePaths.statePath).toBe(path.join(managedRuntimeRoot, "data", "state.json"));
    expect(runtimePaths.heartbeatPath).toBe(path.join(managedRuntimeRoot, "data", "bridge-heartbeat.json"));
  });

});
