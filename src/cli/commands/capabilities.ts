import type { CliCommandResult, CliContext } from "../../types/events.js";
import { loadConfig } from "../../config/loadConfig.js";
import { isFeishuWebhookTransport } from "../../feishu/transport.js";
import { resolveCliRuntimePaths } from "../paths.js";

const DEFAULT_MODEL = "gpt-5.3-codex";
const DEFAULT_EFFORT = "medium";

export async function runCapabilitiesCommand(args: string[], context: CliContext): Promise<CliCommandResult> {
  const options = parseCapabilitiesOptions(args);
  if (!options.ok) {
    return {
      ok: false,
      message: options.error,
      details: {
        usage: "capabilities [--compact]"
      }
    };
  }

  try {
    const paths = resolveCliRuntimePaths(context.cwd);
    const config = await loadConfig(paths.configPath, {
      defaultModel: DEFAULT_MODEL,
      defaultEffort: DEFAULT_EFFORT
    });

    const platformRows = buildPlatformCapabilityRows();
    const agentRows = buildAgentCapabilityRows(config?.agents ?? {}, config?.defaultAgent ?? null, config?.defaultModel ?? null);

    return {
      ok: true,
      message: "capabilities: ok",
      details: {
        configPath: paths.configPath,
        defaultAgent: config.defaultAgent,
        defaultModel: config.defaultModel,
        platformCount: platformRows.length,
        agentCount: agentRows.length,
        compact: options.compact,
        compactRows: options.compact ? buildCompactRows(platformRows, agentRows) : null,
        platforms: platformRows,
        agents: agentRows
      }
    };
  } catch (error) {
    return {
      ok: false,
      message: "capabilities: failed",
      details: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function parseCapabilitiesOptions(args: string[]): { ok: true; compact: boolean } | { ok: false; error: string } {
  let compact = false;

  for (const rawArg of args) {
    const arg = String(rawArg ?? "").trim();
    if (!arg) {
      continue;
    }
    if (arg === "--compact") {
      compact = true;
      continue;
    }
    return {
      ok: false,
      error: `unknown argument: ${arg}`
    };
  }

  return { ok: true, compact };
}

function buildCompactRows(
  platforms: Array<{ platformId: string; enabled: boolean; capabilities: Record<string, boolean> }>,
  agents: Array<{ agentId: string; enabled: boolean; isDefault: boolean; capabilities: Record<string, boolean>; model: string | null }>
): string[] {
  const rows: string[] = ["platforms:"];
  for (const platform of platforms) {
    rows.push(
      `- ${platform.platformId} | ${platform.enabled ? "enabled" : "disabled"} | slash:${mark(platform.capabilities.supportsSlashCommands)} btn:${mark(platform.capabilities.supportsButtons)} attach:${mark(platform.capabilities.supportsAttachments)} bootstrap:${mark(platform.capabilities.supportsRepoBootstrap)} auto:${mark(platform.capabilities.supportsAutoDiscovery)} webhook:${mark(platform.capabilities.supportsWebhookIngress)}`
    );
  }

  rows.push("agents:");
  if (agents.length === 0) {
    rows.push("- (none)");
    return rows;
  }

  for (const agent of agents) {
    const imageCapability = renderAgentCapability(agent.capabilities, "supportsImageInput");
    rows.push(
      `- ${agent.agentId}${agent.isDefault ? " (default)" : ""} | ${agent.enabled ? "enabled" : "disabled"} | image:${imageCapability} | model:${agent.model ?? "(default)"}`
    );
  }
  return rows;
}

function renderAgentCapability(capabilities: Record<string, boolean>, name: string): string {
  if (!Object.prototype.hasOwnProperty.call(capabilities, name)) {
    return "INHERIT";
  }
  return capabilities[name] === true ? "Y" : "N";
}

function mark(value: boolean): string {
  return value ? "Y" : "N";
}

function buildPlatformCapabilityRows() {
  const discordEnabled = Boolean(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_BOT_TOKEN.trim());
  const feishuEnabled =
    Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_ID.trim()) &&
    Boolean(process.env.FEISHU_APP_SECRET && process.env.FEISHU_APP_SECRET.trim());
  const supportsWebhookIngress = feishuEnabled && isFeishuWebhookTransport(process.env.FEISHU_TRANSPORT);

  return [
    {
      platformId: "discord",
      enabled: discordEnabled,
      capabilities: {
        supportsPlainMessages: true,
        supportsSlashCommands: true,
        supportsButtons: true,
        supportsAttachments: true,
        supportsRepoBootstrap: true,
        supportsAutoDiscovery: true,
        supportsWebhookIngress: false
      }
    },
    {
      platformId: "feishu",
      enabled: feishuEnabled,
      capabilities: {
        supportsPlainMessages: true,
        supportsSlashCommands: false,
        supportsButtons: false,
        supportsAttachments: false,
        supportsRepoBootstrap: false,
        supportsAutoDiscovery: false,
        supportsWebhookIngress
      }
    }
  ];
}

function buildAgentCapabilityRows(
  agents: Record<string, { model?: string; enabled?: boolean; capabilities?: Record<string, boolean> }>,
  defaultAgent: string | null,
  defaultModel: string | null
) {
  return Object.keys(agents)
    .sort((left, right) => left.localeCompare(right))
    .map((agentId) => {
      const agent = agents[agentId] ?? {};
      const capabilities = agent.capabilities && typeof agent.capabilities === "object" ? agent.capabilities : {};
      const model = typeof agent.model === "string" && agent.model.trim().length > 0 ? agent.model.trim() : defaultModel;
      return {
        agentId,
        enabled: agent.enabled !== false,
        model,
        isDefault: agentId === defaultAgent,
        capabilities
      };
    });
}
