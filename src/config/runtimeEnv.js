import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseAttachmentItemTypes, parsePathListEnv } from "./loadConfig.js";
import { normalizeRenderVerbosity } from "../render/messageRenderer.js";

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
  const projectsCategoryName =
    process.env.DISCORD_PROJECTS_CATEGORY_NAME ??
    process.env.DISCORD_LEGACY_CATEGORY_NAME ??
    "codex-projects";
  const extraWritableRoots = parsePathListEnv(process.env.CODEX_EXTRA_WRITABLE_ROOTS);

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
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    renderVerbosity,
    heartbeatPath,
    restartRequestPath,
    restartAckPath,
    restartNoticePath,
    inFlightRecoveryPath,
    exitOnRestartAck,
    heartbeatIntervalMs,
    debugLoggingEnabled,
    projectsCategoryName,
    extraWritableRoots
  };
}
