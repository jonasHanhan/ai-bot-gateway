import fs from "node:fs/promises";
import path from "node:path";
import { parsePathListEnv as parsePathListEnvFromUtil } from "../utils/pathEnv.js";

export async function loadConfig(filePath, options = {}) {
  const defaultModel = typeof options.defaultModel === "string" ? options.defaultModel : "gpt-5.3-codex";
  const defaultEffort = typeof options.defaultEffort === "string" ? options.defaultEffort : "medium";

  let parsed = {};
  try {
    const raw = await fs.readFile(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    parsed = {};
  }

  const normalizedChannels = {};
  const rawChannels =
    parsed && typeof parsed === "object" && parsed.channels && typeof parsed.channels === "object"
      ? parsed.channels
      : {};

  for (const [channelId, value] of Object.entries(rawChannels)) {
    if (typeof value === "string") {
      normalizedChannels[channelId] = { cwd: path.resolve(value) };
      continue;
    }
    if (value && typeof value === "object" && typeof value.cwd === "string") {
      const explicitAgentId =
        typeof value.agentId === "string" ? value.agentId : typeof value.agent === "string" ? value.agent : undefined;
      normalizedChannels[channelId] = {
        cwd: path.resolve(value.cwd),
        model: typeof value.model === "string" ? value.model : undefined,
        ...(typeof explicitAgentId === "string" ? { agentId: explicitAgentId } : {})
      };
      continue;
    }
    throw new Error(`Mapping ${channelId} must map to a cwd string or { cwd, model?, agentId? } object`);
  }

  const normalizedAgents = {};
  const rawAgents = parsed && typeof parsed.agents === "object" && !Array.isArray(parsed.agents) ? parsed.agents : {};
  for (const [agentId, value] of Object.entries(rawAgents)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const capabilities =
      value.capabilities && typeof value.capabilities === "object" && !Array.isArray(value.capabilities)
        ? Object.fromEntries(
            Object.entries(value.capabilities)
              .map(([name, enabled]) => [String(name).trim(), enabled === true])
              .filter(([name]) => name.length > 0)
          )
        : undefined;
    normalizedAgents[agentId] = {
      ...(typeof value.model === "string" ? { model: value.model.trim() } : {}),
      ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(value.meta && typeof value.meta === "object" && !Array.isArray(value.meta) ? { meta: value.meta } : {})
    };
  }
  const defaultAgent = typeof parsed.defaultAgent === "string" ? parsed.defaultAgent.trim() : "";

  let allowedUserIds = Array.isArray(parsed.allowedUserIds)
    ? parsed.allowedUserIds.filter((value) => typeof value === "string")
    : [];
  let allowedFeishuUserIds = Array.isArray(parsed.allowedFeishuUserIds)
    ? parsed.allowedFeishuUserIds.filter((value) => typeof value === "string")
    : [];

  const placeholderIds = new Set(["123456789012345678"]);
  const hadPlaceholder = allowedUserIds.some((id) => placeholderIds.has(id));
  allowedUserIds = allowedUserIds.filter((id) => !placeholderIds.has(id));

  const envAllowedRaw = process.env.DISCORD_ALLOWED_USER_IDS;
  if (envAllowedRaw !== undefined) {
    const fromEnv = envAllowedRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (fromEnv.length === 0) {
      throw new Error(
        "DISCORD_ALLOWED_USER_IDS is set but empty. Provide one or more user IDs (comma-separated)."
      );
    }
    allowedUserIds = fromEnv;
  } else if (hadPlaceholder && allowedUserIds.length === 0) {
    console.warn("channels.json has placeholder allowedUserIds. Access control is disabled until you set real user IDs.");
  }

  const envApprovalPolicy = process.env.CODEX_APPROVAL_POLICY;
  const envFeishuAllowedRaw = process.env.FEISHU_ALLOWED_OPEN_IDS;
  if (envFeishuAllowedRaw !== undefined) {
    const fromEnv = envFeishuAllowedRaw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (fromEnv.length === 0) {
      throw new Error(
        "FEISHU_ALLOWED_OPEN_IDS is set but empty. Provide one or more open IDs (comma-separated)."
      );
    }
    allowedFeishuUserIds = fromEnv;
  }

  const rawApprovalPolicy = typeof envApprovalPolicy === "string" ? envApprovalPolicy : parsed.approvalPolicy;
  const parsedApprovalPolicy = normalizeApprovalPolicy(rawApprovalPolicy);
  if (rawApprovalPolicy !== undefined && rawApprovalPolicy !== null && parsedApprovalPolicy === null) {
    throw new Error(
      `Invalid approval policy '${rawApprovalPolicy}'. Use one of: untrusted, on-failure, on-request, never.`
    );
  }
  const approvalPolicy = parsedApprovalPolicy ?? "never";

  const envSandboxMode = process.env.CODEX_SANDBOX_MODE;
  const rawSandboxMode = typeof envSandboxMode === "string" ? envSandboxMode : parsed.sandboxMode;
  const parsedSandboxMode = normalizeSandboxMode(rawSandboxMode);
  if (rawSandboxMode !== undefined && rawSandboxMode !== null && parsedSandboxMode === null) {
    throw new Error(
      `Invalid sandbox mode '${rawSandboxMode}'. Use one of: read-only, workspace-write, danger-full-access.`
    );
  }
  const sandboxMode = parsedSandboxMode ?? "workspace-write";

  return {
    channels: normalizedChannels,
    defaultAgent: defaultAgent || null,
    agents: normalizedAgents,
    defaultModel:
      typeof parsed.defaultModel === "string" && parsed.defaultModel.trim().length > 0
        ? parsed.defaultModel.trim()
        : defaultModel,
    defaultEffort: normalizeEffort(parsed.defaultEffort) ?? defaultEffort,
    approvalPolicy,
    sandboxMode,
    allowedUserIds,
    allowedFeishuUserIds,
    autoDiscoverProjects: parsed.autoDiscoverProjects !== false
  };
}

function normalizeEffort(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const allowed = new Set(["low", "medium", "high"]);
  return allowed.has(normalized) ? normalized : null;
}

function normalizeApprovalPolicy(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const allowed = new Set(["untrusted", "on-failure", "on-request", "never"]);
  return allowed.has(normalized) ? normalized : null;
}

function normalizeSandboxMode(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  const allowed = new Set(["read-only", "workspace-write", "danger-full-access"]);
  return allowed.has(normalized) ? normalized : null;
}

export function parseAttachmentItemTypes(raw) {
  const fallback = ["imageView", "toolCall", "mcpToolCall", "commandExecution"];
  if (raw === undefined || raw === null) {
    return new Set(fallback);
  }
  const normalized = String(raw)
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return new Set(fallback);
  }
  return new Set(normalized);
}

export function parsePathListEnv(raw) {
  return parsePathListEnvFromUtil(raw);
}
