import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config/loadConfig.js";
import { createDiscordPlatform } from "../../platforms/discordPlatform.js";
import { createFeishuPlatform } from "../../platforms/feishuPlatform.js";
import type { CliCommandResult, CliContext } from "../../types/events.js";
import { parsePathListEnv, resolveCliRuntimePaths } from "../paths.js";

export async function runDoctorCommand(_args: string[], context: CliContext): Promise<CliCommandResult> {
  const paths = resolveCliRuntimePaths(context.cwd);
  const checks: Array<{ name: string; ok: boolean; value?: unknown }> = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const hasDiscordToken = Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_TOKEN.trim());
  const hasFeishuAppId = Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_ID.trim());
  const hasFeishuAppSecret = Boolean(process.env.FEISHU_APP_SECRET && process.env.FEISHU_APP_SECRET.trim());
  const hasFeishuCredentials = hasFeishuAppId && hasFeishuAppSecret;
  checks.push({ name: "DISCORD_BOT_TOKEN", ok: hasDiscordToken });
  checks.push({ name: "FEISHU_APP_ID", ok: hasFeishuAppId });
  checks.push({ name: "FEISHU_APP_SECRET", ok: hasFeishuAppSecret });
  if (!hasDiscordToken && !hasFeishuCredentials) {
    failures.push("Missing chat platform credentials: set DISCORD_BOT_TOKEN or FEISHU_APP_ID + FEISHU_APP_SECRET");
  }

  const codexBin = process.env.CODEX_BIN ?? "codex";
  checks.push({ name: "CODEX_BIN", ok: true, value: codexBin });

  const configCheck = await runConfigIntegrityChecks(paths.configPath);
  checks.push(...configCheck.checks);
  failures.push(...configCheck.failures);
  warnings.push(...configCheck.warnings);

  const platformCheck = runPlatformAdapterChecks();
  checks.push(...platformCheck.checks);
  failures.push(...platformCheck.failures);

  const stateDirOk = await ensureDirectory(path.dirname(paths.statePath));
  checks.push({ name: "state_dir_writable", ok: stateDirOk, value: path.dirname(paths.statePath) });
  if (!stateDirOk) {
    failures.push(`State directory not writable: ${path.dirname(paths.statePath)}`);
  }

  const attachmentRoots = parsePathListEnv(process.env.DISCORD_ATTACHMENT_ROOTS);
  const attachmentRootChecks = [];
  for (const root of attachmentRoots) {
    const exists = await canAccess(root);
    attachmentRootChecks.push({ root, exists });
    if (!exists) {
      warnings.push(`Attachment root missing or inaccessible: ${root}`);
    }
  }
  checks.push({ name: "attachment_roots", ok: true, value: attachmentRootChecks });

  const generalCwd = path.resolve(process.env.DISCORD_GENERAL_CWD ?? path.join("/tmp", "codex-discord-bridge", "general"));
  const generalCwdOk = await ensureDirectory(generalCwd);
  checks.push({ name: "general_cwd_writable", ok: generalCwdOk, value: generalCwd });
  if (!generalCwdOk) {
    warnings.push(`General channel cwd not writable: ${generalCwd}`);
  }

  const ok = failures.length === 0;
  return {
    ok,
    message: ok ? "doctor: ok" : "doctor: failed",
    details: {
      checks,
      failures,
      warnings,
      configPath: paths.configPath,
      statePath: paths.statePath,
      heartbeatPath: paths.heartbeatPath,
      restartRequestPath: paths.restartRequestPath,
      restartAckPath: paths.restartAckPath
    }
  };
}

async function canAccess(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(target: string): Promise<boolean> {
  try {
    await fs.mkdir(target, { recursive: true });
    await fs.access(target, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function runConfigIntegrityChecks(configPath: string): Promise<{
  checks: Array<{ name: string; ok: boolean; value?: unknown }>;
  failures: string[];
  warnings: string[];
}> {
  const checks: Array<{ name: string; ok: boolean; value?: unknown }> = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  let config;
  try {
    config = await loadConfig(configPath, {
      defaultModel: "gpt-5.3-codex",
      defaultEffort: "medium"
    });
    checks.push({ name: "config_loadable", ok: true, value: configPath });
  } catch (error) {
    checks.push({ name: "config_loadable", ok: false, value: configPath });
    failures.push(`channels config failed to load: ${error instanceof Error ? error.message : String(error)}`);
    return { checks, failures, warnings };
  }

  const agents = config?.agents && typeof config.agents === "object" ? config.agents : {};
  const agentIds = Object.keys(agents);
  const enabledAgentIds = agentIds.filter((agentId) => agents[agentId]?.enabled !== false);
  const defaultAgent = typeof config?.defaultAgent === "string" ? config.defaultAgent.trim() : "";

  if (!defaultAgent) {
    checks.push({
      name: "default_agent_valid",
      ok: true,
      value: "not configured (runtime fallback applies)"
    });
  } else if (!Object.prototype.hasOwnProperty.call(agents, defaultAgent)) {
    checks.push({ name: "default_agent_valid", ok: false, value: defaultAgent });
    failures.push(`defaultAgent '${defaultAgent}' is not declared in agents`);
  } else if (agents[defaultAgent]?.enabled === false) {
    checks.push({ name: "default_agent_valid", ok: false, value: defaultAgent });
    failures.push(`defaultAgent '${defaultAgent}' is disabled`);
  } else {
    checks.push({ name: "default_agent_valid", ok: true, value: defaultAgent });
  }

  checks.push({ name: "enabled_agents_available", ok: enabledAgentIds.length > 0 || agentIds.length === 0, value: enabledAgentIds });
  if (agentIds.length > 0 && enabledAgentIds.length === 0) {
    failures.push("All configured agents are disabled");
  }

  const channels = config?.channels && typeof config.channels === "object" ? config.channels : {};
  const unknownChannelAgentRefs: string[] = [];
  const disabledChannelAgentRefs: string[] = [];
  for (const [routeId, setup] of Object.entries(channels)) {
    const agentId = typeof setup?.agentId === "string" ? setup.agentId.trim() : "";
    if (!agentId) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(agents, agentId)) {
      unknownChannelAgentRefs.push(`${routeId}->${agentId}`);
      continue;
    }
    if (agents[agentId]?.enabled === false) {
      disabledChannelAgentRefs.push(`${routeId}->${agentId}`);
    }
  }
  checks.push({
    name: "channel_agent_refs_valid",
    ok: unknownChannelAgentRefs.length === 0 && disabledChannelAgentRefs.length === 0,
    value: {
      unknown: unknownChannelAgentRefs,
      disabled: disabledChannelAgentRefs
    }
  });
  if (unknownChannelAgentRefs.length > 0) {
    failures.push(`Unknown channel agent references: ${unknownChannelAgentRefs.join(", ")}`);
  }
  if (disabledChannelAgentRefs.length > 0) {
    warnings.push(`Disabled channel agent references: ${disabledChannelAgentRefs.join(", ")}`);
  }

  return { checks, failures, warnings };
}

function runPlatformAdapterChecks(): {
  checks: Array<{ name: string; ok: boolean; value?: unknown }>;
  failures: string[];
} {
  const checks: Array<{ name: string; ok: boolean; value?: unknown }> = [];
  const failures: string[] = [];

  const runtimeStub = {
    enabled: true,
    transport: process.env.FEISHU_TRANSPORT ?? "webhook",
    webhookPath: "/feishu/events",
    fetchChannelByRouteId: async () => null,
    handleHttpRequest: async () => {},
    start: async () => ({ started: true }),
    stop: async () => ({ stopped: true }),
    handleMessage: async () => {},
    handleInteraction: async () => {},
    registerSlashCommands: async () => ({ ok: true })
  };
  const discordPlatform = createDiscordPlatform({
    discord: { destroy() {}, channels: { fetch: async () => null }, login: async () => {}, application: { fetch: async () => {} } },
    discordToken: process.env.DISCORD_BOT_TOKEN ?? "",
    waitForDiscordReady: async () => {},
    runtime: runtimeStub,
    bootstrapChannelMappings: async () => null
  });
  const feishuPlatform = createFeishuPlatform({ runtime: runtimeStub });

  const platforms = [discordPlatform, feishuPlatform];
  const requiredPlatformKeys = ["platformId", "enabled", "capabilities", "canHandleRouteId", "fetchChannelByRouteId", "start", "stop"];
  const requiredCapabilities = [
    "supportsPlainMessages",
    "supportsSlashCommands",
    "supportsButtons",
    "supportsAttachments",
    "supportsRepoBootstrap",
    "supportsAutoDiscovery",
    "supportsWebhookIngress"
  ];

  const missingShape: string[] = [];
  const missingCaps: string[] = [];
  for (const platform of platforms) {
    const platformId = String(platform?.platformId ?? "unknown");
    for (const key of requiredPlatformKeys) {
      if (!(key in (platform ?? {}))) {
        missingShape.push(`${platformId}.${key}`);
      }
    }
    for (const capabilityName of requiredCapabilities) {
      if (!(capabilityName in (platform?.capabilities ?? {}))) {
        missingCaps.push(`${platformId}.${capabilityName}`);
      }
    }
  }

  checks.push({ name: "platform_adapters_registered", ok: missingShape.length === 0, value: missingShape });
  checks.push({ name: "platform_capabilities_complete", ok: missingCaps.length === 0, value: missingCaps });

  if (missingShape.length > 0) {
    failures.push(`Platform adapter shape incomplete: ${missingShape.join(", ")}`);
  }
  if (missingCaps.length > 0) {
    failures.push(`Platform capability map incomplete: ${missingCaps.join(", ")}`);
  }

  return { checks, failures };
}
