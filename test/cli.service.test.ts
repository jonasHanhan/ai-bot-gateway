import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManagedRuntimePackageManifest,
  runRestartCommand,
  runStartCommand,
  runStopCommand
} from "../src/cli/commands/service.js";
import { resolveInstalledLaunchdPlistPath } from "../src/cli/paths.js";

const tempDirs: string[] = [];
const originalLaunchdLabel = process.env.DISCORD_LAUNCHD_LABEL;
const originalHome = process.env.HOME;

beforeEach(() => {
  delete process.env.DISCORD_LAUNCHD_LABEL;
});

afterEach(async () => {
  process.env.DISCORD_LAUNCHD_LABEL = originalLaunchdLabel;
  process.env.HOME = originalHome;
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function seedLaunchdSupportFiles(cwd: string): Promise<void> {
  await fs.mkdir(path.join(cwd, "scripts"), { recursive: true });
  await fs.mkdir(path.join(cwd, "src"), { recursive: true });
  await fs.mkdir(path.join(cwd, "config"), { recursive: true });
  await fs.mkdir(path.join(cwd, "data"), { recursive: true });
  await fs.writeFile(
    path.join(cwd, "scripts", "launchd-wrapper.sh"),
    "#!/usr/bin/env bash\nset -euo pipefail\nexec /bin/bash ./scripts/restart-supervisor.sh -- /usr/bin/node ./scripts/start-with-proxy.mjs\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "scripts", "start-with-proxy.mjs"),
    'import "../src/index.js";\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "scripts", "restart-supervisor.sh"),
    "#!/usr/bin/env bash\n# Host-managed restart supervisor\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "scripts", "log-rotating-writer.sh"),
    "#!/usr/bin/env bash\ncat >> \"${2:-/tmp/test.log}\"\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "src", "index.js"),
    'console.log("runtime ready");\n',
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "config", "channels.json"),
    JSON.stringify({ channels: {} }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "data", "state.json"),
    JSON.stringify({ channels: {} }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "agent-gateway-test",
      private: true,
      type: "module",
      dependencies: {}
    }, null, 2),
    "utf8"
  );
  await fs.chmod(path.join(cwd, "scripts", "launchd-wrapper.sh"), 0o755);
  await fs.chmod(path.join(cwd, "scripts", "start-with-proxy.mjs"), 0o755);
  await fs.chmod(path.join(cwd, "scripts", "restart-supervisor.sh"), 0o755);
  await fs.chmod(path.join(cwd, "scripts", "log-rotating-writer.sh"), 0o755);
}

function createProcessManager(entries: Array<{ pid: number; ppid: number | null; command: string }>) {
  const alive = new Set(entries.map((entry) => entry.pid));
  const killed: Array<{ pid: number; signal: string }> = [];
  return {
    killed,
    manager: {
      list: async () =>
        entries.filter((entry) => alive.has(entry.pid)).map((entry) => ({
          pid: entry.pid,
          ppid: entry.ppid,
          command: entry.command
        })),
      kill: async (pid: number, signal = "SIGTERM") => {
        killed.push({ pid, signal });
        alive.delete(pid);
      },
      sleep: async () => {}
    }
  };
}

describe("cli service commands", () => {
  test("start command bootstraps/enables/kickstarts service", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>Label</key><string>com.agent.gateway</string></dict></plist>",
      "utf8"
    );
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    const installedPlistPath = resolveInstalledLaunchdPlistPath("com.agent.gateway");
    const supportRoot = path.join(fakeHome, "Library", "Application Support", "AgentGateway", "com.agent.gateway");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("service started");
    expect(calls).toEqual([
      ["enable", `${domain}/com.agent.gateway`],
      ["bootstrap", domain, installedPlistPath],
      ["kickstart", "-k", `${domain}/com.agent.gateway`]
    ]);
    const installedPlist = await fs.readFile(installedPlistPath, "utf8");
    expect(installedPlist).toContain(`<string>${supportRoot}/launchd-wrapper.sh</string>`);
    expect(installedPlist).not.toContain("<string>-lc</string>");
    expect(installedPlist).not.toContain("./scripts/start-with-proxy.mjs");
    expect(fsSync.existsSync(supportRoot)).toBe(true);
    const managedRuntimeRoot = path.join(supportRoot, "runtime");
    const wrapper = await fs.readFile(path.join(supportRoot, "launchd-wrapper.sh"), "utf8");
    expect(wrapper).toContain(`RUNTIME_ROOT='${managedRuntimeRoot}'`);
    expect(wrapper).toContain(`${supportRoot}/log-rotating-writer.sh`);
    expect(await fs.readFile(path.join(managedRuntimeRoot, "scripts", "start-with-proxy.mjs"), "utf8")).toContain('../src/index.js');
    expect(await fs.readFile(path.join(managedRuntimeRoot, "src", "index.js"), "utf8")).toContain('runtime ready');
    expect(await fs.readFile(path.join(managedRuntimeRoot, "config", "channels.json"), "utf8")).toContain('"channels"');
    expect(await fs.readFile(path.join(managedRuntimeRoot, "package.json"), "utf8")).toContain('"agent-gateway-test"');
    expect(await fs.readFile(path.join(managedRuntimeRoot, "data", "state.json"), "utf8")).toContain('"channels"');
  });

  test("start tolerates already-loaded bootstrap responses", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 4) {
        return { code: 5, stdout: "", stderr: "service already loaded" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    expect(result.ok).toBe(true);
    expect(calls.length).toBe(3);
  });

  test("start returns error when launchd support files are missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-missing-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;

    const calls: string[][] = [];
    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    expect(result.ok).toBe(false);
    expect(result.message).toBe("failed to prepare launchd service files");
    expect(String(result.details?.error ?? "")).toContain("launchd-wrapper.sh");
    expect(calls).toEqual([]);
  });

  test("start tolerates launchctl bootstrap I/O error when service is already loaded", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 2) {
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      if (invocation === 3) {
        return { code: 0, stdout: "service loaded", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["enable", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`],
      [
        "bootstrap",
        `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`,
        resolveInstalledLaunchdPlistPath("com.agent.gateway")
      ],
      ["print", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`],
      ["kickstart", "-k", `gui/${typeof process.getuid === "function" ? process.getuid() : 0}/com.agent.gateway`]
    ]);
  });

  test("start tolerates kickstart failure when the service is already loaded", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-start-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await fs.writeFile(
      path.join(cwd, "com.agent.gateway.plist"),
      "<plist><dict><key>Label</key><string>com.agent.gateway</string></dict></plist>",
      "utf8"
    );
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    let invocation = 0;

    const result = await runStartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      invocation += 1;
      if (invocation === 3) {
        return { code: 37, stdout: "", stderr: "" };
      }
      if (invocation === 4) {
        return { code: 0, stdout: "service loaded", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      ["enable", `${domain}/com.agent.gateway`],
      ["bootstrap", domain, resolveInstalledLaunchdPlistPath("com.agent.gateway")],
      ["kickstart", "-k", `${domain}/com.agent.gateway`],
      ["print", `${domain}/com.agent.gateway`]
    ]);
  });

  test("stop command accepts already-stopped state", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-stop-"));
    tempDirs.push(cwd);

    const result = await runStopCommand([], { cwd, now: new Date() }, async () => {
      return { code: 3, stdout: "", stderr: "Could not find service" };
    }, createProcessManager([]).manager);

    expect(result.ok).toBe(true);
    expect(result.message).toBe("service stopped");
  });

  test("restart command kickstarts service and reports restart semantics", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-restart-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];

    const result = await runRestartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }, createProcessManager([]).manager);

    const domain = `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
    expect(result.ok).toBe(true);
    expect(result.message).toBe("service restarted");
    expect(calls).toEqual([
      ["bootout", `${domain}/com.agent.gateway`],
      ["enable", `${domain}/com.agent.gateway`],
      ["bootstrap", domain, resolveInstalledLaunchdPlistPath("com.agent.gateway")],
      ["kickstart", "-k", `${domain}/com.agent.gateway`]
    ]);
  });

  test("restart reclaims competing supervisor and child processes before relaunch", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-restart-cleanup-"));
    tempDirs.push(cwd);
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-home-"));
    tempDirs.push(fakeHome);
    process.env.HOME = fakeHome;
    await seedLaunchdSupportFiles(cwd);
    const calls: string[][] = [];
    const processes = createProcessManager([
      {
        pid: 101,
        ppid: 1,
        command: `bash /tmp/restart-supervisor-v2.sh -- /usr/bin/node ${path.join(cwd, "scripts/start-with-proxy.mjs")}`
      },
      {
        pid: 102,
        ppid: 101,
        command: `/usr/bin/node ${path.join(cwd, "scripts/start-with-proxy.mjs")}`
      }
    ]);

    const result = await runRestartCommand([], { cwd, now: new Date() }, async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    }, processes.manager);

    expect(result.ok).toBe(true);
    expect(result.details?.reclaimedPids).toEqual([101]);
    expect(processes.killed).toEqual([{ pid: 101, signal: "SIGTERM" }]);
  });

  test("restart/start/stop reject unexpected args", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "dc-bridge-service-args-"));
    tempDirs.push(cwd);

    const restart = await runRestartCommand(["now"], { cwd, now: new Date() });
    expect(restart.ok).toBe(false);
    expect(restart.message).toContain("does not accept arguments");

    const start = await runStartCommand(["now"], { cwd, now: new Date() });
    expect(start.ok).toBe(false);
    expect(start.message).toContain("does not accept arguments");

    const stop = await runStopCommand(["now"], { cwd, now: new Date() });
    expect(stop.ok).toBe(false);
    expect(stop.message).toContain("does not accept arguments");
  });

  test("builds a managed runtime package with only shared and configured platform dependencies", () => {
    const manifest = buildManagedRuntimePackageManifest(
      {
        name: "agent-gateway",
        dependencies: {
          "@larksuiteoapi/node-sdk": "^1.0.0",
          "discord.js": "^14.0.0",
          "dotenv": "^16.0.0",
          "https-proxy-agent": "^7.0.0",
          "undici": "^7.0.0"
        },
        devDependencies: {
          typescript: "^5.0.0"
        }
      },
      {
        FEISHU_APP_ID: "app-id",
        FEISHU_APP_SECRET: "app-secret"
      }
    );

    expect(manifest.dependencies).toEqual({
      "@larksuiteoapi/node-sdk": "^1.0.0",
      "dotenv": "^16.0.0",
      "https-proxy-agent": "^7.0.0",
      "undici": "^7.0.0"
    });
    expect(manifest.dependencies["discord.js"]).toBeUndefined();
    expect(manifest.devDependencies).toEqual({
      typescript: "^5.0.0"
    });
  });
});
