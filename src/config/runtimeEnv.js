import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseAttachmentItemTypes } from "./loadConfig.js";
import { parseRuntimeNumericConfig, parseTurnRecoveryConfig } from "./runtimeConfigSchema.js";
import { normalizeRenderVerbosity } from "../render/messageRenderer.js";
import { parsePathListEnv } from "../utils/pathEnv.js";
import { makeFeishuRouteId } from "../feishu/ids.js";
import { normalizeFeishuTransport } from "../feishu/transport.js";

function normalizeFeishuUnboundChatMode(rawMode) {
  const normalized = String(rawMode ?? "")
    .trim()
    .toLowerCase();
  if (["open", "1", "true", "all"].includes(normalized)) {
    return "open";
  }
  if (["strict", "0", "false", "bound-only"].includes(normalized)) {
    return "strict";
  }
  return "open";
}

export function loadRuntimeEnv() {
  const configPath = path.resolve(process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json");
  const statePath = path.resolve(process.env.STATE_PATH ?? "data/state.json");
  const codexBin = process.env.CODEX_BIN ?? "codex";
  const codexHomeEnv = process.env.CODEX_HOME;
  const repoRootEnv = process.env.WORKSPACE_ROOT ?? process.env.PROJECTS_ROOT ?? process.env.DISCORD_REPO_ROOT;
  const repoRootPath = repoRootEnv ? path.resolve(repoRootEnv) : null;
  const managedChannelTopicPrefix = "codex-cwd:";
  const managedThreadTopicPrefix = "codex-thread:";
  const approvalButtonPrefix = "approval:";
  const generalChannelId = String(process.env.DISCORD_GENERAL_CHANNEL_ID ?? "").trim();
  const generalChannelName = String(process.env.DISCORD_GENERAL_CHANNEL_NAME ?? "general")
    .trim()
    .toLowerCase();
  const generalChannelDefaultCwd = path.join(os.tmpdir(), "agent-gateway", "general");
  const generalChannelCwd = path.resolve(process.env.DISCORD_GENERAL_CWD ?? generalChannelDefaultCwd);
  const imageCacheDir = path.resolve(process.env.DISCORD_IMAGE_CACHE_DIR ?? "/tmp/agent-gateway-images");
  const {
    maxImagesPerMessage,
    discordMessageChunkLimit,
    feishuMessageChunkLimit,
    attachmentMaxBytes,
    attachmentIssueLimitPerTurn,
    heartbeatIntervalMs,
    feishuStreamMinChars,
    feishuEventDedupeTtlMs,
    backendHttpPort,
    feishuPort
  } = parseRuntimeNumericConfig(process.env);
  const attachmentRoots = [
    ...new Set(
      [...parsePathListEnv(process.env.DISCORD_ATTACHMENT_ROOTS), repoRootPath]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => path.resolve(value))
    )
  ];
  const attachmentInferFromText = process.env.DISCORD_ATTACHMENT_INFER_FROM_TEXT === "1";
  const attachmentsEnabled = process.env.DISCORD_ENABLE_ATTACHMENTS !== "0";
  const attachmentLogEnabled = process.env.DISCORD_LOG_ATTACHMENTS === "1";
  const attachmentItemTypes = parseAttachmentItemTypes(process.env.DISCORD_ATTACHMENT_ITEM_TYPES);
  const renderVerbosity = normalizeRenderVerbosity(process.env.DISCORD_RENDER_VERBOSITY);
  const stripAnsiForDiscord = process.env.DISCORD_STRIP_ANSI_OUTPUT === "1";
  const heartbeatPath = path.resolve(process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json");
  const restartRequestPath = path.resolve(process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json");
  const restartAckPath = path.resolve(process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json");
  const restartNoticePath = path.resolve(
    process.env.DISCORD_RESTART_NOTICE_PATH ?? "data/restart-discord-notice.json"
  );
  const restartLifecycleStatePath = path.resolve(
    process.env.DISCORD_RESTART_LIFECYCLE_STATE_PATH ?? "data/restart-lifecycle-state.json"
  );
  const restartLifecycleLogPath = path.resolve(
    process.env.DISCORD_RESTART_LIFECYCLE_LOG_PATH ?? "data/restart-lifecycle.log"
  );
  const inFlightRecoveryPath = path.resolve(process.env.DISCORD_INFLIGHT_RECOVERY_PATH ?? "data/inflight-turns.json");
  const turnRecovery = parseTurnRecoveryConfig(process.env);
  const exitOnRestartAck = process.env.DISCORD_EXIT_ON_RESTART_ACK === "1";
  const debugLoggingEnabled = process.env.DISCORD_DEBUG_LOGGING === "1";
  const disableStreamingOutput = process.env.DISABLE_STREAMING_OUTPUT === "1";
  const projectsCategoryName =
    process.env.DISCORD_PROJECTS_CATEGORY_NAME ??
    process.env.DISCORD_LEGACY_CATEGORY_NAME ??
    "codex-projects";
  const extraWritableRoots = parsePathListEnv(process.env.CODEX_EXTRA_WRITABLE_ROOTS);
  const feishuAppId = String(process.env.FEISHU_APP_ID ?? "").trim();
  const feishuAppSecret = String(process.env.FEISHU_APP_SECRET ?? "").trim();
  const feishuVerificationToken = String(process.env.FEISHU_VERIFICATION_TOKEN ?? "").trim();
  const feishuTransport = normalizeFeishuTransport(process.env.FEISHU_TRANSPORT);
  const feishuEnabled = Boolean(feishuAppId && feishuAppSecret);
  const backendHttpEnabled = process.env.BACKEND_HTTP_ENABLED === "1" || feishuEnabled;
  const backendHttpHost = String(process.env.BACKEND_HTTP_HOST ?? process.env.FEISHU_HOST ?? "0.0.0.0").trim() || "0.0.0.0";
  const feishuHost = String(process.env.FEISHU_HOST ?? "0.0.0.0").trim() || "0.0.0.0";
  const feishuWebhookPath = String(process.env.FEISHU_WEBHOOK_PATH ?? "/feishu/events").trim() || "/feishu/events";
  const feishuGeneralChatId = String(process.env.FEISHU_GENERAL_CHAT_ID ?? "").trim();
  const feishuGeneralDefaultCwd = path.join(os.tmpdir(), "agent-gateway", "feishu-general");
  const feishuGeneralCwd = path.resolve(process.env.FEISHU_GENERAL_CWD ?? feishuGeneralDefaultCwd);
  const feishuGeneralRouteId = feishuGeneralChatId ? makeFeishuRouteId(feishuGeneralChatId) : "";
  const restartNotifyRouteId =
    String(process.env.DISCORD_RESTART_NOTIFY_ROUTE_ID ?? "").trim() || generalChannelId || feishuGeneralRouteId || "";
  const feishuEventDedupePath = path.resolve(process.env.FEISHU_EVENT_DEDUPE_PATH ?? "data/feishu-seen-events.json");
  const feishuRequireMentionInGroup = process.env.FEISHU_REQUIRE_MENTION_IN_GROUP !== "0";
  const feishuLogIngress = process.env.FEISHU_LOG_INGRESS === "1";
  const feishuSegmentedStreaming = process.env.FEISHU_SEGMENTED_STREAMING === "1";
  const feishuUnboundChatMode = normalizeFeishuUnboundChatMode(process.env.FEISHU_UNBOUND_CHAT_MODE);
  const feishuUnboundChatCwd = path.resolve(process.env.FEISHU_UNBOUND_CHAT_CWD ?? repoRootEnv ?? process.cwd());

  return {
    configPath,
    statePath,
    codexBin,
    codexHomeEnv,
    repoRootPath,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    approvalButtonPrefix,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    imageCacheDir,
    maxImagesPerMessage,
    discordMessageChunkLimit,
    feishuMessageChunkLimit,
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentLogEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    renderVerbosity,
    stripAnsiForDiscord,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    restartLifecycleStatePath,
    restartLifecycleLogPath,
    restartNotifyRouteId,
    inFlightRecoveryPath,
    turnRecovery,
    exitOnRestartAck,
    heartbeatIntervalMs,
    debugLoggingEnabled,
    disableStreamingOutput,
    projectsCategoryName,
    extraWritableRoots,
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    feishuEnabled,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuTransport,
    feishuPort,
    feishuHost,
    feishuWebhookPath,
    feishuGeneralChatId,
    feishuGeneralRouteId,
    feishuGeneralCwd,
    feishuRequireMentionInGroup,
    feishuLogIngress,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    feishuEventDedupeTtlMs,
    feishuEventDedupePath,
    feishuUnboundChatMode,
    feishuUnboundChatCwd
  };
}
