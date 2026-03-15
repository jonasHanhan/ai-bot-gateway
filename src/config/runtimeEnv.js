import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseAttachmentItemTypes } from "./loadConfig.js";
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
  return "open";
}

export function loadRuntimeEnv() {
  const configPath = path.resolve(process.env.CHANNEL_CONFIG_PATH ?? "config/channels.json");
  const statePath = path.resolve(process.env.STATE_PATH ?? "data/state.json");
  const codexBin = process.env.CODEX_BIN ?? "codex";
  const codexHomeEnv = process.env.CODEX_HOME;
  const repoRootEnv = process.env.DISCORD_REPO_ROOT;
  const repoRootPath = repoRootEnv ? path.resolve(repoRootEnv) : null;
  const managedChannelTopicPrefix = "codex-cwd:";
  const managedThreadTopicPrefix = "codex-thread:";
  const approvalButtonPrefix = "approval:";
  const generalChannelId = String(process.env.DISCORD_GENERAL_CHANNEL_ID ?? "").trim();
  const generalChannelName = String(process.env.DISCORD_GENERAL_CHANNEL_NAME ?? "general")
    .trim()
    .toLowerCase();
  const generalChannelDefaultCwd = path.join(os.tmpdir(), "codex-discord-bridge", "general");
  const generalChannelCwd = path.resolve(process.env.DISCORD_GENERAL_CWD ?? generalChannelDefaultCwd);
  const imageCacheDir = path.resolve(process.env.DISCORD_IMAGE_CACHE_DIR ?? "/tmp/codex-discord-bridge-images");
  const configuredMaxImages = Number(process.env.DISCORD_MAX_IMAGES_PER_MESSAGE ?? 4);
  const maxImagesPerMessage =
    Number.isFinite(configuredMaxImages) && configuredMaxImages > 0 ? Math.floor(configuredMaxImages) : 4;
  const configuredDiscordChunkLimit = Number(
    process.env.DISCORD_MESSAGE_CHUNK_LIMIT ?? process.env.DISCORD_MAX_MESSAGE_LENGTH ?? ""
  );
  const discordMessageChunkLimit =
    Number.isFinite(configuredDiscordChunkLimit) && configuredDiscordChunkLimit >= 200
      ? Math.floor(configuredDiscordChunkLimit)
      : 1900;
  const configuredFeishuChunkLimit = Number(process.env.FEISHU_MESSAGE_CHUNK_LIMIT ?? "");
  const feishuMessageChunkLimit =
    Number.isFinite(configuredFeishuChunkLimit) && configuredFeishuChunkLimit >= 200
      ? Math.floor(configuredFeishuChunkLimit)
      : 8000;
  const configuredAttachmentMaxBytes = Number(process.env.DISCORD_ATTACHMENT_MAX_BYTES ?? "");
  const attachmentMaxBytes =
    Number.isFinite(configuredAttachmentMaxBytes) && configuredAttachmentMaxBytes > 0
      ? Math.floor(configuredAttachmentMaxBytes)
      : 8 * 1024 * 1024;
  const attachmentRoots = parsePathListEnv(process.env.DISCORD_ATTACHMENT_ROOTS);
  const attachmentInferFromText = process.env.DISCORD_ATTACHMENT_INFER_FROM_TEXT === "1";
  const attachmentsEnabled = process.env.DISCORD_ENABLE_ATTACHMENTS !== "0";
  const attachmentItemTypes = parseAttachmentItemTypes(process.env.DISCORD_ATTACHMENT_ITEM_TYPES);
  const configuredAttachmentIssueLimit = Number(process.env.DISCORD_MAX_ATTACHMENT_ISSUES_PER_TURN ?? "");
  const attachmentIssueLimitPerTurn =
    Number.isFinite(configuredAttachmentIssueLimit) && configuredAttachmentIssueLimit >= 0
      ? Math.floor(configuredAttachmentIssueLimit)
      : 1;
  const renderVerbosity = normalizeRenderVerbosity(process.env.DISCORD_RENDER_VERBOSITY);
  const stripAnsiForDiscord = process.env.DISCORD_STRIP_ANSI_OUTPUT === "1";
  const heartbeatPath = path.resolve(process.env.DISCORD_HEARTBEAT_PATH ?? "data/bridge-heartbeat.json");
  const restartRequestPath = path.resolve(process.env.DISCORD_RESTART_REQUEST_PATH ?? "data/restart-request.json");
  const restartAckPath = path.resolve(process.env.DISCORD_RESTART_ACK_PATH ?? "data/restart-ack.json");
  const restartNoticePath = path.resolve(
    process.env.DISCORD_RESTART_NOTICE_PATH ?? "data/restart-discord-notice.json"
  );
  const inFlightRecoveryPath = path.resolve(process.env.DISCORD_INFLIGHT_RECOVERY_PATH ?? "data/inflight-turns.json");
  const exitOnRestartAck = process.env.DISCORD_EXIT_ON_RESTART_ACK === "1";
  const configuredHeartbeatIntervalMs = Number(process.env.DISCORD_HEARTBEAT_INTERVAL_MS ?? "");
  const heartbeatIntervalMs =
    Number.isFinite(configuredHeartbeatIntervalMs) && configuredHeartbeatIntervalMs >= 5_000
      ? Math.floor(configuredHeartbeatIntervalMs)
      : 30_000;
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
  const configuredBackendPort = Number(process.env.BACKEND_HTTP_PORT ?? process.env.FEISHU_PORT ?? "");
  const backendHttpPort =
    Number.isFinite(configuredBackendPort) && configuredBackendPort > 0 ? Math.floor(configuredBackendPort) : 8788;
  const configuredFeishuPort = Number(process.env.FEISHU_PORT ?? "");
  const feishuPort = Number.isFinite(configuredFeishuPort) && configuredFeishuPort > 0 ? Math.floor(configuredFeishuPort) : 8788;
  const feishuHost = String(process.env.FEISHU_HOST ?? "0.0.0.0").trim() || "0.0.0.0";
  const feishuWebhookPath = String(process.env.FEISHU_WEBHOOK_PATH ?? "/feishu/events").trim() || "/feishu/events";
  const feishuGeneralChatId = String(process.env.FEISHU_GENERAL_CHAT_ID ?? "").trim();
  const feishuGeneralDefaultCwd = path.join(os.tmpdir(), "codex-discord-bridge", "feishu-general");
  const feishuGeneralCwd = path.resolve(process.env.FEISHU_GENERAL_CWD ?? feishuGeneralDefaultCwd);
  const feishuGeneralRouteId = feishuGeneralChatId ? makeFeishuRouteId(feishuGeneralChatId) : "";
  const feishuRequireMentionInGroup = process.env.FEISHU_REQUIRE_MENTION_IN_GROUP !== "0";
  const feishuSegmentedStreaming = process.env.FEISHU_SEGMENTED_STREAMING !== "0";
  const configuredFeishuStreamMinChars = Number(process.env.FEISHU_STREAM_MIN_CHARS ?? "");
  const feishuStreamMinChars =
    Number.isFinite(configuredFeishuStreamMinChars) && configuredFeishuStreamMinChars > 0
      ? Math.floor(configuredFeishuStreamMinChars)
      : 80;
  const feishuUnboundChatMode = normalizeFeishuUnboundChatMode(process.env.FEISHU_UNBOUND_CHAT_MODE);
  const feishuUnboundChatCwd = path.resolve(process.env.FEISHU_UNBOUND_CHAT_CWD ?? process.cwd());

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
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    renderVerbosity,
    stripAnsiForDiscord,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    inFlightRecoveryPath,
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
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    feishuUnboundChatMode,
    feishuUnboundChatCwd
  };
}
