import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { renderLaunchdPlist, renderManagedLaunchdWrapper, resolveLaunchdServiceInfo } from "../paths.js";

interface LaunchctlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ProcessEntry {
  pid: number;
  ppid: number | null;
  command: string;
}

const ALWAYS_INCLUDED_RUNTIME_DEPENDENCIES = ["dotenv", "https-proxy-agent", "undici"];
const DISCORD_RUNTIME_DEPENDENCIES = ["discord.js"];
const FEISHU_RUNTIME_DEPENDENCIES = ["@larksuiteoapi/node-sdk"];

type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;
type ProcessManager = {
  list: () => Promise<ProcessEntry[]>;
  kill: (pid: number, signal?: NodeJS.Signals) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export async function runStartCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "start command does not accept arguments",
      details: {
        usage: "start"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);
  const prepareResult = await prepareLaunchdService(service, runner);
  if (prepareResult) {
    return prepareResult;
  }

  const kickstart = await runner(["kickstart", "-k", service.serviceTarget]);
  const kickstartRecovered = kickstart.code !== 0 && (await isLoadedService(service, runner));
  if (kickstart.code !== 0 && !kickstartRecovered) {
    return failure("failed to start launchd service", service, kickstart);
  }

  return {
    ok: true,
    message: "service started",
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath,
      reclaimedPids: cleanup
    }
  };
}

export async function runRestartCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "restart command does not accept arguments",
      details: {
        usage: "restart"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const bootout = await runner(["bootout", service.serviceTarget]);
  if (bootout.code !== 0 && !isAlreadyStopped(bootout.stderr)) {
    return failure("failed to stop launchd service before restart", service, bootout);
  }

  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);
  const prepareResult = await prepareLaunchdService(service, runner);
  if (prepareResult) {
    return prepareResult;
  }

  const kickstart = await runner(["kickstart", "-k", service.serviceTarget]);
  const kickstartRecovered = kickstart.code !== 0 && (await isLoadedService(service, runner));
  if (kickstart.code !== 0 && !kickstartRecovered) {
    return failure("failed to restart launchd service", service, kickstart);
  }

  return {
    ok: true,
    message: "service restarted",
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath,
      reclaimedPids: cleanup
    }
  };
}

async function prepareLaunchdService(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  runner: LaunchctlRunner
): Promise<CliCommandResult | null> {
  try {
    await installLaunchdPlist(service);
  } catch (error) {
    return {
      ok: false,
      message: "failed to prepare launchd service files",
      details: {
        serviceTarget: service.serviceTarget,
        plistPath: service.installedPlistPath,
        sourcePlistPath: service.sourcePlistPath,
        error: truncateError(error)
      }
    };
  }

  const enable = await runner(["enable", service.serviceTarget]);
  if (enable.code !== 0) {
    return failure("failed to enable launchd service", service, enable);
  }

  const bootstrap = await runner(["bootstrap", service.domain, service.installedPlistPath]);
  const alreadyLoaded = bootstrap.code !== 0 && (isAlreadyLoaded(bootstrap.stderr) || (await isLoadedService(service, runner)));
  if (bootstrap.code !== 0 && !alreadyLoaded) {
    return failure("failed to bootstrap launchd service", service, bootstrap);
  }

  return null;
}

async function isLoadedService(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  runner: LaunchctlRunner
): Promise<boolean> {
  const result = await runner(["print", service.serviceTarget]);
  return result.code === 0;
}

export async function runStopCommand(
  args: string[],
  context: CliContext,
  runner: LaunchctlRunner = runLaunchctl,
  processManager: ProcessManager = createDefaultProcessManager()
): Promise<CliCommandResult> {
  if (args.length > 0) {
    return {
      ok: false,
      message: "stop command does not accept arguments",
      details: {
        usage: "stop"
      }
    };
  }

  const service = resolveLaunchdServiceInfo(context.cwd);
  const bootout = await runner(["bootout", service.serviceTarget]);
  if (bootout.code !== 0 && !isAlreadyStopped(bootout.stderr)) {
    return failure("failed to stop launchd service", service, bootout);
  }
  const cleanup = await cleanupConflictingRuntimeProcesses(service, processManager);

  return {
    ok: true,
    message: "service stopped",
    details: {
      serviceTarget: service.serviceTarget,
      reclaimedPids: cleanup
    }
  };
}

async function runLaunchctl(args: string[]): Promise<LaunchctlResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn("launchctl", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function createDefaultProcessManager(): ProcessManager {
  return {
    list: async () => await listProcesses(),
    kill: async (pid, signal = "SIGTERM") => {
      process.kill(pid, signal);
    },
    sleep: async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  };
}

async function listProcesses(): Promise<ProcessEntry[]> {
  return await new Promise((resolve, reject) => {
    const child = spawn("ps", ["-axo", "pid=,ppid=,command="], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ps exited with code ${String(code)}`));
        return;
      }
      resolve(parseProcessList(stdout));
    });
  });
}

function parseProcessList(stdout: string): ProcessEntry[] {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }
      const pid = Number.parseInt(match[1], 10);
      const ppid = Number.parseInt(match[2], 10);
      if (!Number.isFinite(pid)) {
        return null;
      }
      return {
        pid,
        ppid: Number.isFinite(ppid) ? ppid : null,
        command: match[3]
      };
    })
    .filter((entry) => entry !== null);
}

async function cleanupConflictingRuntimeProcesses(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  processManager: ProcessManager
): Promise<number[]> {
  const roots = findConflictingRuntimeProcessRoots(service, await processManager.list());
  if (roots.length === 0) {
    return [];
  }

  for (const pid of roots) {
    await processManager.kill(pid, "SIGTERM").catch(() => {});
  }
  await processManager.sleep(500);

  const stillRunningAfterTerm = new Set(findConflictingRuntimeProcessRoots(service, await processManager.list()));
  for (const pid of roots) {
    if (stillRunningAfterTerm.has(pid)) {
      await processManager.kill(pid, "SIGKILL").catch(() => {});
    }
  }
  await processManager.sleep(250);

  return roots;
}

function findConflictingRuntimeProcessRoots(
  service: ReturnType<typeof resolveLaunchdServiceInfo>,
  entries: ProcessEntry[]
): number[] {
  const processMap = new Map(entries.map((entry) => [entry.pid, entry]));
  const matching = entries.filter((entry) => isManagedRuntimeProcess(entry, service));
  const roots = new Set<number>();

  for (const entry of matching) {
    let current = entry;
    while (current.ppid !== null) {
      const parent = processMap.get(current.ppid);
      if (!parent || !isManagedRuntimeProcess(parent, service)) {
        break;
      }
      current = parent;
    }
    roots.add(current.pid);
  }

  return [...roots].sort((left, right) => left - right);
}

function isManagedRuntimeProcess(entry: ProcessEntry, service: ReturnType<typeof resolveLaunchdServiceInfo>): boolean {
  const command = String(entry?.command ?? "");
  if (!command) {
    return false;
  }
  if (command.includes(service.entryScriptPath) || command.includes(service.managedEntryScriptPath)) {
    return true;
  }
  if (
    (command.includes(service.runtimeRoot) || command.includes(service.managedRuntimeRoot) || command.includes(service.supportRoot)) &&
    /restart-supervisor/i.test(command)
  ) {
    return true;
  }
  return false;
}

function isAlreadyLoaded(stderr: string): boolean {
  return /already|in use|service is running|service already loaded/i.test(String(stderr ?? ""));
}

function isAlreadyStopped(stderr: string): boolean {
  return /could not find service|service not found|no such process|not loaded/i.test(String(stderr ?? ""));
}

function failure(message: string, service: ReturnType<typeof resolveLaunchdServiceInfo>, result: LaunchctlResult): CliCommandResult {
  return {
    ok: false,
    message,
    details: {
      serviceTarget: service.serviceTarget,
      plistPath: service.installedPlistPath,
      sourcePlistPath: service.sourcePlistPath,
      code: result.code,
      stderr: truncate(result.stderr),
      stdout: truncate(result.stdout)
    }
  };
}

function truncate(value: string, limit = 400): string {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function truncateError(error: unknown, limit = 400): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return truncate(message, limit);
}

async function installLaunchdPlist(service: ReturnType<typeof resolveLaunchdServiceInfo>): Promise<void> {
  await fs.readFile(service.sourceWrapperPath, "utf8");
  await fs.readFile(service.sourceSupervisorPath, "utf8");
  await fs.readFile(service.sourceLogWriterPath, "utf8");

  await installManagedRuntimeMirror(service);

  const plistContent = renderLaunchdPlist(service);
  const managedWrapperContent = renderManagedLaunchdWrapper(service);
  const supervisorContent = await fs.readFile(service.sourceSupervisorPath, "utf8");
  const logWriterContent = await fs.readFile(service.sourceLogWriterPath, "utf8");

  await fs.mkdir(service.supportRoot, { recursive: true });
  await fs.writeFile(service.managedWrapperPath, managedWrapperContent, "utf8");
  await fs.writeFile(service.managedSupervisorPath, supervisorContent, "utf8");
  await fs.writeFile(service.managedLogWriterPath, logWriterContent, "utf8");
  await fs.chmod(service.managedWrapperPath, 0o755);
  await fs.chmod(service.managedSupervisorPath, 0o755);
  await fs.chmod(service.managedLogWriterPath, 0o755);

  await fs.mkdir(path.dirname(service.installedPlistPath), { recursive: true });
  await fs.writeFile(service.installedPlistPath, plistContent, "utf8");
  await fs.chmod(service.installedPlistPath, 0o600);
}

async function installManagedRuntimeMirror(service: ReturnType<typeof resolveLaunchdServiceInfo>): Promise<void> {
  const sourcePackageJsonPath = path.resolve(service.runtimeRoot, "package.json");
  const sourceEnvPath = path.resolve(service.runtimeRoot, ".env");
  const sourceConfigPath = path.resolve(service.runtimeRoot, "config");
  const sourceSrcPath = path.resolve(service.runtimeRoot, "src");
  const sourceEntryScriptPath = service.entryScriptPath;
  const sourceDataPath = path.resolve(service.runtimeRoot, "data");
  const managedRuntimeRoot = service.managedRuntimeRoot;
  const managedScriptsPath = path.resolve(managedRuntimeRoot, "scripts");
  const managedDataPath = path.resolve(managedRuntimeRoot, "data");
  const managedSrcPath = path.resolve(managedRuntimeRoot, "src");
  const managedConfigPath = path.resolve(managedRuntimeRoot, "config");
  const managedPackageJsonPath = path.resolve(managedRuntimeRoot, "package.json");
  const managedPackageLockPath = path.resolve(managedRuntimeRoot, "package-lock.json");
  const managedEnvPath = path.resolve(managedRuntimeRoot, ".env");
  const managedEntryScriptPath = path.resolve(managedScriptsPath, "start-with-proxy.mjs");

  const sourcePackageJsonRaw = await fs.readFile(sourcePackageJsonPath, "utf8");
  await fs.readFile(sourceEntryScriptPath, "utf8");
  await fs.access(sourceSrcPath);
  await fs.access(sourceConfigPath);
  const runtimeEnv = await resolveManagedRuntimeEnv(sourceEnvPath);
  const managedPackageJson = buildManagedRuntimePackageManifest(JSON.parse(sourcePackageJsonRaw), runtimeEnv);

  await fs.mkdir(managedRuntimeRoot, { recursive: true });
  await fs.mkdir(managedScriptsPath, { recursive: true });
  await fs.mkdir(managedDataPath, { recursive: true });
  await fs.rm(managedSrcPath, { recursive: true, force: true });
  await fs.rm(managedConfigPath, { recursive: true, force: true });
  await fs.rm(managedEntryScriptPath, { force: true });

  await fs.cp(sourceSrcPath, managedSrcPath, { recursive: true, force: true });
  await fs.cp(sourceConfigPath, managedConfigPath, { recursive: true, force: true });
  await fs.copyFile(sourceEntryScriptPath, managedEntryScriptPath);
  await fs.writeFile(managedPackageJsonPath, `${JSON.stringify(managedPackageJson, null, 2)}\n`, "utf8");
  await fs.rm(managedPackageLockPath, { force: true });
  if (await pathExists(sourceEnvPath)) {
    await fs.copyFile(sourceEnvPath, managedEnvPath);
  } else {
    await fs.rm(managedEnvPath, { force: true });
  }

  await copyDataFileIfExists(sourceDataPath, managedDataPath, "state.json");
  await copyDataFileIfExists(sourceDataPath, managedDataPath, "feishu-seen-events.json");
  await copyDataFileIfExists(sourceDataPath, managedDataPath, "inflight-turns.json");

  const manifestHash = await computeManifestHash([managedPackageJsonPath]);
  const stampPath = path.resolve(managedRuntimeRoot, ".runtime-install-stamp.json");
  const existingStamp = await readInstallStamp(stampPath);
  const nodeModulesPath = path.resolve(managedRuntimeRoot, "node_modules");
  if (existingStamp !== manifestHash || !(await pathExists(nodeModulesPath))) {
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
    await runNpmProductionInstall(managedRuntimeRoot);
    await fs.writeFile(stampPath, JSON.stringify({ manifestHash }, null, 2), "utf8");
  }
}

async function copyDataFileIfExists(sourceDir: string, targetDir: string, fileName: string): Promise<void> {
  const sourcePath = path.resolve(sourceDir, fileName);
  if (!(await pathExists(sourcePath))) {
    return;
  }
  await fs.copyFile(sourcePath, path.resolve(targetDir, fileName));
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveManagedRuntimeEnv(sourceEnvPath: string): Promise<Record<string, string>> {
  const merged = { ...process.env };
  if (!(await pathExists(sourceEnvPath))) {
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => typeof value === "string")
    );
  }
  const envFile = await fs.readFile(sourceEnvPath, "utf8");
  const parsed = parseEnvFile(envFile);
  return {
    ...parsed,
    ...Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value === "string"))
  };
}

function parseEnvFile(raw: string): Record<string, string> {
  const parsed = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function buildManagedRuntimePackageManifest(sourcePackageJson: Record<string, any>, runtimeEnv: Record<string, string> = {}) {
  const dependencies = sourcePackageJson?.dependencies && typeof sourcePackageJson.dependencies === "object"
    ? sourcePackageJson.dependencies
    : {};
  const selectedDependencyNames = new Set(ALWAYS_INCLUDED_RUNTIME_DEPENDENCIES);
  if (String(runtimeEnv.DISCORD_BOT_TOKEN ?? "").trim()) {
    for (const dependencyName of DISCORD_RUNTIME_DEPENDENCIES) {
      selectedDependencyNames.add(dependencyName);
    }
  }
  if (String(runtimeEnv.FEISHU_APP_ID ?? "").trim() && String(runtimeEnv.FEISHU_APP_SECRET ?? "").trim()) {
    for (const dependencyName of FEISHU_RUNTIME_DEPENDENCIES) {
      selectedDependencyNames.add(dependencyName);
    }
  }
  const selectedDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(([dependencyName]) => selectedDependencyNames.has(dependencyName))
  );
  return {
    ...sourcePackageJson,
    dependencies: selectedDependencies
  };
}

async function computeManifestHash(filePaths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    hash.update(await fs.readFile(filePath));
  }
  return hash.digest("hex");
}

async function readInstallStamp(stampPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(stampPath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed?.manifestHash === "string" ? parsed.manifestHash : "";
  } catch {
    return "";
  }
}

async function runNpmProductionInstall(cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["install", "--omit=dev", "--ignore-scripts", "--package-lock=false"], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "production"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `npm ci failed with code ${String(code)}`));
    });
  });
}
