import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dotenv from "dotenv";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags
} from "discord.js";
import { CodexRpcClient } from "./codexRpcClient.js";
import { maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService } from "./attachments/service.js";
import { createAttachmentInputBuilder } from "./attachments/inputBuilder.js";
import { createRuntimeOps } from "./app/runtimeOps.js";
import { createDiscordRuntime } from "./app/discordRuntime.js";
import { createBootstrapService } from "./channels/bootstrapService.js";
import { resolveRepoContext, isGeneralChannel } from "./channels/context.js";
import { createCommandRouter } from "./commands/router.js";
import { loadConfig, parseAttachmentItemTypes, parsePathListEnv } from "./config/loadConfig.js";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  describeToolRequestUserInput,
  parseApprovalButtonCustomId
} from "./codex/approvalPayloads.js";
import { normalizeCodexNotification } from "./codex/notificationMapper.js";
import { createTurnRunner } from "./codex/turnRunner.js";
import {
  buildTurnRenderPlan,
  normalizeRenderVerbosity,
  sendChunkedToChannel as sendChunkedToChannelFromRenderer,
  truncateForDiscordMessage
} from "./render/messageRenderer.js";
import { StateStore } from "./stateStore.js";
import { TURN_PHASE, transitionTurnPhase } from "./turns/lifecycle.js";
import { createNotificationRuntime } from "./turns/notificationRuntime.js";
import { normalizeFinalSummaryText } from "./turns/textNormalization.js";

dotenv.config();

const discordToken = process.env.DISCORD_BOT_TOKEN;
if (!discordToken) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

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
const discordMaxMessageLength = 1900;
const execFileAsync = promisify(execFile);
const workspaceWritableRootsCache = new Map();
const extraWritableRoots = parsePathListEnv(process.env.CODEX_EXTRA_WRITABLE_ROOTS);
const defaultModel = "gpt-5.3-codex";
const defaultEffort = "medium";

const config = await loadConfig(configPath, { defaultModel, defaultEffort });
let channelSetups = { ...config.channels };
const state = new StateStore(statePath);
await state.load();
const legacyThreadsDropped = state.consumeLegacyDropCount();
if (legacyThreadsDropped > 0) {
  console.warn(`Cutover: dropped ${legacyThreadsDropped} legacy channel thread bindings from state.`);
  await state.save();
}

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});
const codex = new CodexRpcClient({
  codexBin
});

const queues = new Map();
const activeTurns = new Map();
const pendingApprovals = new Map();
let nextApprovalToken = 1;
const processStartedAt = new Date().toISOString();
let shuttingDown = false;
let runtimeOps = null;
let discordRuntime = null;
let notificationRuntime = null;
const turnRunner = createTurnRunner({
  queues,
  activeTurns,
  state,
  codex,
  config,
  safeReply,
  buildSandboxPolicyForTurn,
  isThreadNotFoundError,
  finalizeTurn,
  onTurnReconnectPending,
  onActiveTurnsChanged: () => runtimeOps?.writeHeartbeatFile()
});
const attachmentInputBuilder = createAttachmentInputBuilder({
  fs,
  imageCacheDir,
  maxImagesPerMessage,
  discordToken,
  fetch,
  formatInputTextForSetup,
  logger: console
});

codex.on("stderr", (line) => {
  console.error(`[codex] ${line}`);
});
codex.on("notification", (event) => {
  void handleNotification(event);
});
codex.on("serverRequest", (request) => {
  void handleServerRequest(request);
});
codex.on("exit", ({ code, signal }) => {
  console.error(`codex app-server exited (code=${code}, signal=${signal ?? "none"})`);
});
codex.on("error", (error) => {
  console.error(`codex app-server error: ${error.message}`);
});

discord.on("clientReady", () => {
  console.log(`Discord connected as ${discord.user?.tag}`);
});

discord.on("messageCreate", (message) => {
  void handleMessage(message).catch((error) => {
    console.error(`message handler failed in channel ${message.channelId}: ${error.message}`);
  });
});
discord.on("interactionCreate", (interaction) => {
  void handleInteraction(interaction).catch((error) => {
    console.error(`interaction handler failed: ${error.message}`);
  });
});

runtimeOps = createRuntimeOps({
  fs,
  path,
  debugLog,
  activeTurns,
  pendingApprovals,
  heartbeatPath,
  restartRequestPath,
  restartAckPath,
  restartNoticePath,
  processStartedAt,
  heartbeatIntervalMs,
  exitOnRestartAck,
  safeReply,
  safeSendToChannel,
  truncateStatusText,
  shutdown
});

const bootstrapService = createBootstrapService({
  ChannelType,
  path,
  discord,
  codex,
  config,
  state,
  projectsCategoryName,
  managedChannelTopicPrefix,
  managedThreadTopicPrefix,
  isDiscordMissingPermissionsError,
  getChannelSetups: () => channelSetups,
  setChannelSetups: (next) => {
    channelSetups = next;
  }
});
const { bootstrapChannelMappings, makeChannelName } = bootstrapService;
const commandRouter = createCommandRouter({
  ChannelType,
  isGeneralChannel,
  fs,
  path,
  execFileAsync,
  repoRootPath,
  managedChannelTopicPrefix,
  codexBin,
  codexHomeEnv,
  statePath,
  configPath,
  config,
  state,
  codex,
  pendingApprovals,
  makeChannelName,
  collectImageAttachments,
  buildTurnInputFromMessage,
  enqueuePrompt,
  getQueue,
  findActiveTurnByRepoChannel,
  requestSelfRestartFromDiscord,
  findLatestPendingApprovalTokenForChannel,
  applyApprovalDecision,
  safeReply,
  getChannelSetups: () => channelSetups,
  setChannelSetups: (nextSetups) => {
    channelSetups = nextSetups;
  }
});
const { handleCommand, handleInitRepoCommand } = commandRouter;
notificationRuntime = createNotificationRuntime({
  activeTurns,
  renderVerbosity,
  TURN_PHASE,
  transitionTurnPhase,
  normalizeCodexNotification,
  extractAgentMessageText,
  maybeSendAttachmentsForItem,
  recordFileChanges,
  summarizeItemForStatus,
  extractWebSearchDetails,
  buildFileDiffSection,
  buildTurnRenderPlan,
  sendChunkedToChannel,
  normalizeFinalSummaryText,
  truncateStatusText,
  isTransientReconnectErrorMessage,
  safeSendToChannel,
  truncateForDiscordMessage,
  discordMaxMessageLength,
  debugLog,
  writeHeartbeatFile
});
discordRuntime = createDiscordRuntime({
  discord,
  config,
  resolveRepoContext,
  generalChannelId,
  generalChannelName,
  generalChannelCwd,
  getChannelSetups: () => channelSetups,
  bootstrapChannelMappings,
  shouldHandleAsSelfRestartRequest,
  requestSelfRestartFromDiscord,
  collectImageAttachments,
  buildTurnInputFromMessage,
  enqueuePrompt,
  handleCommand,
  handleInitRepoCommand,
  parseApprovalButtonCustomId,
  approvalButtonPrefix,
  pendingApprovals,
  applyApprovalDecision,
  safeReply,
  MessageFlags
});

await codex.start();
await fs.mkdir(generalChannelCwd, { recursive: true }).catch((error) => {
  console.warn(`failed to ensure general cwd at ${generalChannelCwd}: ${error.message}`);
});
await discord.login(discordToken);
await discord.application?.fetch().catch(() => null);
await waitForDiscordReady(discord);
await maybeCompletePendingRestartNotice();
try {
  const bootstrapSummary = await bootstrapChannelMappings();
  console.log(
    `channel bootstrap complete (discovered=${bootstrapSummary.discoveredCwds}, created=${bootstrapSummary.createdChannels}, moved=${bootstrapSummary.movedChannels}, pruned=${bootstrapSummary.prunedBindings}, mapped=${Object.keys(channelSetups).length})`
  );
} catch (error) {
  console.error(`channel bootstrap failed: ${error.message}`);
}
startHeartbeatLoop();

process.on("SIGINT", () => {
  void shutdown(0);
});
process.on("SIGTERM", () => {
  void shutdown(0);
});

async function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  runtimeOps?.stopHeartbeatLoop();
  try {
    await codex.stop();
  } catch {}
  discord.destroy();
  process.exit(exitCode);
}

function startHeartbeatLoop() {
  runtimeOps?.startHeartbeatLoop();
}

async function writeHeartbeatFile() {
  await runtimeOps?.writeHeartbeatFile();
}

async function requestSelfRestartFromDiscord(message, reason) {
  await runtimeOps?.requestSelfRestartFromDiscord(message, reason);
}

async function maybeCompletePendingRestartNotice() {
  await runtimeOps?.maybeCompletePendingRestartNotice(discord);
}

function shouldHandleAsSelfRestartRequest(content) {
  return runtimeOps?.shouldHandleAsSelfRestartRequest(content) ?? false;
}

async function handleMessage(message) {
  await discordRuntime?.handleMessage(message);
}

async function handleInteraction(interaction) {
  await discordRuntime?.handleInteraction(interaction);
}

function collectImageAttachments(message) {
  return attachmentInputBuilder.collectImageAttachments(message);
}

async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
  return await attachmentInputBuilder.buildTurnInputFromMessage(message, text, imageAttachments, setup);
}

function formatInputTextForSetup(text, setup) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return "";
  }
  if (setup?.mode !== "general") {
    return trimmed;
  }
  return [
    "[Channel context: #general]",
    "Treat this channel as informational Q&A and general conversation.",
    "Do not assume repo work, file edits, or tool/command execution unless explicitly requested.",
    "Ignore local cwd/repo context unless the user explicitly asks for it.",
    "",
    trimmed
  ].join("\n");
}

function waitForDiscordReady(client) {
  if (client.isReady()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    client.once("clientReady", () => resolve());
  });
}

function isDiscordMissingPermissionsError(error) {
  return (
    Number(error?.code) === 50013 ||
    Number(error?.rawError?.code) === 50013 ||
    String(error?.message ?? "").toLowerCase().includes("missing permissions")
  );
}

function isChannelUnavailableError(error) {
  const code = String(error?.code ?? "");
  const apiCode = Number(error?.rawError?.code ?? 0);
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === "ChannelNotCached" ||
    code === "10003" ||
    apiCode === 10003 ||
    message.includes("channel not cached") ||
    message.includes("unknown channel")
  );
}

function isThreadNotFoundError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function isTransientReconnectErrorMessage(message) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    /reconnecting\.\.\.\s*\d+\/\d+/i.test(normalized) ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("connection reset") ||
    normalized.includes("connection closed") ||
    normalized.includes("connection lost") ||
    normalized.includes("econnreset")
  );
}

function debugLog(scope, message, details) {
  if (!debugLoggingEnabled) {
    return;
  }
  if (details === undefined) {
    console.log(`[debug:${scope}] ${message}`);
    return;
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(details);
  } catch {
    serialized = String(details);
  }
  const trimmed = serialized.length > 1200 ? `${serialized.slice(0, 1200)}...` : serialized;
  console.log(`[debug:${scope}] ${message} ${trimmed}`);
}

async function safeReply(message, content) {
  try {
    return await message.reply(content);
  } catch (error) {
    if (!isChannelUnavailableError(error)) {
      throw error;
    }
    const channel = await discord.channels.fetch(message.channelId).catch(() => null);
    if (channel && channel.isTextBased()) {
      try {
        return await channel.send(content);
      } catch (sendError) {
        if (!isChannelUnavailableError(sendError)) {
          throw sendError;
        }
      }
    }
    console.warn(`reply dropped in unavailable channel ${message.channelId}`);
    return null;
  }
}

function enqueuePrompt(repoChannelId, job) {
  turnRunner.enqueuePrompt(repoChannelId, job);
}

function getQueue(repoChannelId) {
  return turnRunner.getQueue(repoChannelId);
}

async function processQueue(repoChannelId) {
  await turnRunner.processQueue(repoChannelId);
}

async function ensureThreadId(repoChannelId, setup) {
  return turnRunner.ensureThreadId(repoChannelId, setup);
}

function createActiveTurn(threadId, repoChannelId, message, cwd, options = {}) {
  return turnRunner.createActiveTurn(threadId, repoChannelId, message, cwd, options);
}

function abortActiveTurn(threadId, error) {
  return turnRunner.abortActiveTurn(threadId, error);
}

async function handleNotification({ method, params }) {
  await notificationRuntime?.handleNotification({ method, params });
}

function onTurnReconnectPending(threadId, context = {}) {
  notificationRuntime?.onTurnReconnectPending(threadId, context);
}

async function handleServerRequest({ id, method, params }) {
  const resolvedMethod = resolveServerRequestMethod(method, params);
  console.log(`server request method=${method} resolved=${resolvedMethod} id=${String(id)} idType=${typeof id}`);

  if (resolvedMethod === "item/tool/call") {
    const threadId = extractThreadId(params);
    const repoChannelId = threadId ? findRepoChannelIdByCodexThreadId(threadId) : null;
    if (repoChannelId) {
      const channel = await discord.channels.fetch(repoChannelId).catch(() => null);
      if (channel && channel.isTextBased()) {
        const toolName = typeof params?.tool === "string" ? params.tool : "unknown-tool";
        await safeSendToChannel(
          channel,
          `⚠️ dynamic tool call is not supported in this bridge (\`${toolName}\`). Returning failure to Codex.`
        );
      }
    }
    codex.respond(id, buildUnsupportedToolCallResponse(method));
    return;
  }

  if (!isApprovalLikeServerRequestMethod(resolvedMethod)) {
    console.warn(`Unhandled server request method: ${method} (resolved=${resolvedMethod})`);
    const bestEffort = buildBestEffortServerRequestResponse(resolvedMethod, method, params);
    codex.respond(id, bestEffort);
    return;
  }

  const threadId = extractThreadId(params);
  const repoChannelId = threadId ? findRepoChannelIdByCodexThreadId(threadId) : null;
  if (!repoChannelId) {
    codex.respond(id, buildFallbackResponseForServerRequest(resolvedMethod, params));
    return;
  }

  const channel = await discord.channels.fetch(repoChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    codex.respond(id, buildFallbackResponseForServerRequest(resolvedMethod, params));
    return;
  }
  if (resolvedMethod === "item/fileChange/requestApproval" && isGeneralChannel(channel)) {
    await safeSendToChannel(channel, "Declined file change in #general (read-only mode).");
    codex.respond(id, buildResponseForServerRequest(resolvedMethod, params, "decline"));
    return;
  }

  const existingToken = findPendingApprovalTokenByRequestId(id);
  const token = existingToken ?? String(nextApprovalToken++).padStart(4, "0");
  if (!existingToken) {
    pendingApprovals.set(token, {
      requestId: id,
      method: resolvedMethod,
      repoChannelId,
      threadId,
      params,
      approvalMessageId: null
    });
  }

  const detailLines = [];
  if (typeof params?.reason === "string" && params.reason) {
    detailLines.push(`reason: ${params.reason}`);
  }
  if (Array.isArray(params?.command) && params.command.length > 0) {
    detailLines.push(`command: \`${truncateStatusText(params.command.join(" "), 900)}\``);
  } else if (typeof params?.command === "string" && params.command) {
    detailLines.push(`command: \`${truncateStatusText(params.command, 900)}\``);
  }
  if (typeof params?.cwd === "string" && params.cwd) {
    detailLines.push(`cwd: \`${params.cwd}\``);
  }
  if (typeof params?.callId === "string" && params.callId) {
    detailLines.push(`call id: \`${params.callId}\``);
  }
  if (typeof params?.toolCallId === "string" && params.toolCallId) {
    detailLines.push(`tool call id: \`${params.toolCallId}\``);
  }
  if (resolvedMethod === "item/tool/requestUserInput") {
    detailLines.push(...describeToolRequestUserInput(params));
  }

  if (existingToken) {
    console.warn(`Duplicate approval request for requestId=${id}; reusing token=${token}`);
    return;
  }

  console.log(
    `approval requested method=${resolvedMethod} token=${token} requestId=${id} channel=${repoChannelId} thread=${threadId ?? "n/a"}`
  );

  const approvalContent = truncateForDiscordMessage(
    [
      `Approval requested: \`${resolvedMethod}\``,
      `Use buttons below (or \`!approve ${token}\` / \`!decline ${token}\` / \`!cancel ${token}\`)`,
      ...detailLines
    ].join("\n")
  );
  const approvalMessage = await channel.send({
    content: approvalContent,
    components: buildApprovalActionRows(token, approvalButtonPrefix)
  });
  const record = pendingApprovals.get(token);
  if (record) {
    record.approvalMessageId = approvalMessage.id;
  }
}

function resolveServerRequestMethod(method, params) {
  if (typeof method !== "string") {
    return "";
  }

  if (method === "tool/requestUserInput") {
    return "item/tool/requestUserInput";
  }
  if (method === "tool/call") {
    return "item/tool/call";
  }
  if (method === "commandExecution/requestApproval") {
    return "item/commandExecution/requestApproval";
  }
  if (method === "fileChange/requestApproval") {
    return "item/fileChange/requestApproval";
  }

  if (method !== "item/tool/requestUserInput" && Array.isArray(params?.questions)) {
    return "item/tool/requestUserInput";
  }
  if (method !== "item/tool/call" && typeof params?.tool === "string" && typeof params?.callId === "string") {
    return "item/tool/call";
  }

  return method;
}

function isApprovalLikeServerRequestMethod(method) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

function buildFallbackResponseForServerRequest(method, params) {
  return buildResponseForServerRequest(method, params, "decline");
}

function buildBestEffortServerRequestResponse(resolvedMethod, originalMethod, params) {
  if (resolvedMethod === "item/tool/call" || originalMethod === "item/tool/call" || originalMethod === "tool/call") {
    return buildUnsupportedToolCallResponse(originalMethod);
  }
  if (resolvedMethod === "item/tool/requestUserInput" || Array.isArray(params?.questions)) {
    return buildToolRequestUserInputResponse(params, "decline");
  }
  if (
    resolvedMethod === "item/commandExecution/requestApproval" ||
    resolvedMethod === "item/fileChange/requestApproval" ||
    resolvedMethod === "execCommandApproval" ||
    resolvedMethod === "applyPatchApproval"
  ) {
    return buildFallbackResponseForServerRequest(resolvedMethod, params);
  }
  if (typeof params?.decision === "string") {
    return { decision: "decline" };
  }
  return {};
}

function buildUnsupportedToolCallResponse(originalMethod) {
  const text = "Dynamic tool calls are not supported by codex-discord-bridge.";
  const modern = {
    contentItems: [{ type: "inputText", text }],
    success: false
  };
  const legacy = {
    content: [{ type: "text", text }],
    structuredContent: { error: text },
    isError: true
  };
  if (originalMethod === "tool/call") {
    return legacy;
  }
  return { ...modern, ...legacy };
}

function findLatestPendingApprovalTokenForChannel(repoChannelId) {
  let latest = null;
  for (const [token, approval] of pendingApprovals.entries()) {
    if (approval.repoChannelId === repoChannelId) {
      latest = token;
    }
  }
  return latest;
}

async function applyApprovalDecision(token, decision, actorMention) {
  const approval = pendingApprovals.get(token);
  if (!approval) {
    return { ok: false, error: `No pending approval with id ${token}.` };
  }

  try {
    const response = buildResponseForServerRequest(approval.method, approval.params, decision);
    console.log(
      `approval response method=${approval.method} token=${token} requestId=${String(approval.requestId)} requestIdType=${typeof approval.requestId} decision=${decision}`
    );
    codex.respond(approval.requestId, response);
  } catch (error) {
    return { ok: false, error: error.message };
  }

  pendingApprovals.delete(token);
  void markApprovalResolved(approval, token, decision, actorMention);
  return { ok: true };
}

async function markApprovalResolved(approval, token, decision, actorMention) {
  if (!approval?.approvalMessageId) {
    return;
  }
  const channel = await discord.channels.fetch(approval.repoChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return;
  }
  const approvalMessage = await channel.messages.fetch(approval.approvalMessageId).catch(() => null);
  if (!approvalMessage) {
    return;
  }
  const statusLine = `Decision: \`${decision}\` by ${actorMention}`;
  const previous = typeof approvalMessage.content === "string" ? approvalMessage.content : "";
  const content = previous.includes("Decision:") ? previous : `${previous}\n${statusLine}`;
  await approvalMessage
    .edit({
      content,
      components: buildApprovalActionRows(token, approvalButtonPrefix, { disabled: true, selectedDecision: decision })
    })
    .catch(() => null);
}

function findPendingApprovalTokenByRequestId(requestId) {
  const requestKey = makeRpcIdKey(requestId);
  for (const [token, approval] of pendingApprovals.entries()) {
    if (makeRpcIdKey(approval.requestId) === requestKey) {
      return token;
    }
  }
  return null;
}

function makeRpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function listPendingApprovalTokensForChannel(repoChannelId) {
  const tokens = [];
  for (const [token, approval] of pendingApprovals.entries()) {
    if (approval.repoChannelId === repoChannelId) {
      tokens.push(token);
    }
  }
  return tokens;
}

function findRepoChannelIdByCodexThreadId(threadId) {
  const persisted = state.findConversationChannelIdByCodexThreadId(threadId);
  if (persisted) {
    return persisted;
  }
  for (const tracker of activeTurns.values()) {
    if (tracker.threadId === threadId) {
      return tracker.repoChannelId;
    }
  }
  return null;
}

function findActiveTurnByRepoChannel(repoChannelId) {
  return turnRunner.findActiveTurnByRepoChannel(repoChannelId);
}

async function finalizeTurn(threadId, error) {
  await notificationRuntime?.finalizeTurn(threadId, error);
}

function summarizeItemForStatus(item, state) {
  if (!item || typeof item !== "object") {
    return [];
  }
  if (item.type === "commandExecution") {
    const command = truncateStatusText(typeof item.command === "string" ? item.command : "", 140);
    if (!command) {
      return [];
    }
    if (state === "started") {
      return [`⚙️ Command: \`${command}\``];
    }
    return [];
  }
  if (item.type === "webSearch") {
    const queries = extractWebSearchDetails(item);
    if (queries.length === 0) {
      return [];
    }
    if (state !== "started") {
      return [];
    }
    const normalized = normalizeSearchLabel(queries[0]);
    return [`🌍 Search: \`${truncateStatusText(normalized, 140)}\``];
  }
  if (item.type === "fileChange" && state === "completed") {
    const changes = Array.isArray(item.changes) ? item.changes : [item];
    const lines = [];
    for (const change of changes) {
      const entry = extractFileChangeEntry(change);
      if (!entry) {
        continue;
      }
      lines.push(`File edit: ${path.basename(entry.pathName)} +${entry.added} -${entry.removed}`);
      if (lines.length >= 4) {
        break;
      }
    }
    return lines;
  }
  if (item.type === "mcpToolCall") {
    const server = typeof item.server === "string" ? item.server : "server";
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    if (state !== "started") {
      return [];
    }
    return [`🛠️ Tool: \`${truncateStatusText(`${server}/${tool}`, 140)}\``];
  }
  if (item.type === "imageView") {
    if (state !== "started") {
      return [];
    }
    const fileName = typeof item.path === "string" && item.path ? path.basename(item.path) : "image";
    return [`🖼️ Image: ${truncateStatusText(fileName, 140)}`];
  }
  if (item.type === "contextCompaction" && state === "completed") {
    return ["🧠 Context compacted"];
  }
  return [];
}

function buildFileDiffSection(tracker) {
  if (!tracker?.fileChangeSummary || tracker.fileChangeSummary.size === 0) {
    return "";
  }

  let totalAdded = 0;
  let totalRemoved = 0;
  const lines = [];
  for (const [pathName, stats] of tracker.fileChangeSummary.entries()) {
    const added = coerceNonNegativeInt(stats?.added);
    const removed = coerceNonNegativeInt(stats?.removed);
    totalAdded += added;
    totalRemoved += removed;
    const fileName = path.basename(pathName);
    lines.push({ fileName, added, removed });
  }
  lines.sort((a, b) => `${a.fileName}`.localeCompare(`${b.fileName}`));
  const maxLines = 10;
  const visible = lines.slice(0, maxLines);
  const green = "\u001b[32m";
  const red = "\u001b[31m";
  const dim = "\u001b[37m";
  const reset = "\u001b[0m";
  const parts = ["```ansi"];
  parts.push(`${green}📄${reset} ${dim}Files changed:${reset} ${green}+${totalAdded}${reset} ${red}-${totalRemoved}${reset}`);
  for (const { fileName, added, removed } of visible) {
    parts.push(`${dim}${fileName}${reset} ${green}+${added}${reset} ${red}-${removed}${reset}`);
  }
  if (lines.length > maxLines) {
    parts.push(`${dim}... ${lines.length - maxLines} more${reset}`);
  }
  parts.push("```");
  return parts.join("\n");
}

function normalizeSearchLabel(raw) {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname) {
      return url.hostname;
    }
  } catch {}
  return trimmed;
}

function statusLabelForItemType(itemType) {
  const map = {
    commandExecution: "command",
    mcpToolCall: "tool call",
    webSearch: "web search",
    fileChange: "file change",
    imageView: "image view",
    contextCompaction: "context compaction",
    collabAgentToolCall: "collab tool",
    toolCall: "tool",
    review: "review"
  };
  return map[itemType] ?? itemType.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function pickFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return "";
}

function coerceNonNegativeInt(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(0, Math.round(value));
    }
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) {
        return Math.max(0, parsed);
      }
    }
  }
  return 0;
}

function extractFileChangeEntry(change) {
  if (!change || typeof change !== "object") {
    return null;
  }
  const pathName = pickFirstString(change.path, change.file, change.filename, change.name);
  if (!pathName) {
    return null;
  }
  const added = coerceNonNegativeInt(
    change.added,
    change.additions,
    change.insertions,
    change.linesAdded,
    change.lines_added,
    change.addedLines
  );
  const removed = coerceNonNegativeInt(
    change.removed,
    change.deletions,
    change.linesRemoved,
    change.lines_removed,
    change.deletedLines
  );
  let resolvedAdded = added;
  let resolvedRemoved = removed;
  if (resolvedAdded === 0 && resolvedRemoved === 0 && typeof change.diff === "string") {
    const counted = countDiffLines(change.diff);
    resolvedAdded = counted.added;
    resolvedRemoved = counted.removed;
  }
  return { pathName, added: resolvedAdded, removed: resolvedRemoved };
}

function countDiffLines(diffText) {
  if (typeof diffText !== "string" || !diffText.trim()) {
    return { added: 0, removed: 0 };
  }
  let added = 0;
  let removed = 0;
  const lines = diffText.split(/\r?\n/);
  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("@@")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function recordFileChanges(tracker, item) {
  if (!tracker || !item || typeof item !== "object") {
    return;
  }
  const changes = Array.isArray(item.changes) ? item.changes : [];
  if (changes.length === 0) {
    const entry = extractFileChangeEntry(item);
    if (entry) {
      const existing = tracker.fileChangeSummary.get(entry.pathName) ?? { added: 0, removed: 0 };
      existing.added += entry.added;
      existing.removed += entry.removed;
      tracker.fileChangeSummary.set(entry.pathName, existing);
    }
    return;
  }
  for (const change of changes) {
    const entry = extractFileChangeEntry(change);
    if (!entry) {
      continue;
    }
    const existing = tracker.fileChangeSummary.get(entry.pathName) ?? { added: 0, removed: 0 };
    existing.added += entry.added;
    existing.removed += entry.removed;
    tracker.fileChangeSummary.set(entry.pathName, existing);
  }
}

function buildFileChangeSummary(tracker) {
  if (!tracker?.fileChangeSummary || tracker.fileChangeSummary.size === 0) {
    return "";
  }
  let totalAdded = 0;
  let totalRemoved = 0;
  const lines = [];
  for (const [pathName, stats] of tracker.fileChangeSummary.entries()) {
    const added = coerceNonNegativeInt(stats?.added);
    const removed = coerceNonNegativeInt(stats?.removed);
    totalAdded += added;
    totalRemoved += removed;
    lines.push(`${path.basename(pathName)} +${added} -${removed}`);
  }
  const count = tracker.fileChangeSummary.size;
  const headerParts = [`${count} file${count === 1 ? "" : "s"} changed`];
  if (totalAdded > 0 || totalRemoved > 0) {
    headerParts.push(`+${totalAdded} -${totalRemoved}`);
  }
  return [headerParts.join(" "), ...lines].join("\n");
}

function extractWebSearchDetails(item) {
  const details = [];
  const add = (value) => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }
    details.push(trimmed);
  };

  add(item?.query);
  const action = item?.action;
  if (action?.type === "search") {
    add(action.query);
    if (Array.isArray(action.queries)) {
      for (const query of action.queries) {
        add(query);
      }
    }
  } else if (action?.type === "openPage") {
    add(action.url);
  } else if (action?.type === "findInPage") {
    add(action.pattern);
    add(action.url);
  }

  return [...new Set(details)];
}

function truncateStatusText(text, limit) {
  if (typeof text !== "string") {
    return "";
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) {
    return oneLine;
  }
  return `${oneLine.slice(0, Math.max(1, limit - 3))}...`;
}

async function buildSandboxPolicyForTurn(mode, cwd) {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "read-only") {
    return { type: "readOnly", access: { type: "fullAccess" } };
  }
  if (mode === "workspace-write") {
    const writableRoots = await resolveWorkspaceWritableRoots(cwd);
    return {
      type: "workspaceWrite",
      writableRoots,
      readOnlyAccess: { type: "fullAccess" },
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    };
  }
  return null;
}

async function resolveWorkspaceWritableRoots(cwd) {
  const key = path.resolve(cwd);
  const cached = workspaceWritableRootsCache.get(key);
  if (cached) {
    return cached;
  }

  const roots = new Set([key, ...extraWritableRoots]);
  const gitRoots = await discoverGitWritableRoots(key);
  for (const root of gitRoots) {
    roots.add(path.resolve(root));
  }

  const resolved = [...roots];
  workspaceWritableRootsCache.set(key, resolved);
  return resolved;
}

async function discoverGitWritableRoots(cwd) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { timeout: 3000, maxBuffer: 1024 * 1024 }
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && path.isAbsolute(line));
  } catch {
    return [];
  }
}

function consumeParagraphsFromRemainder(input, inCodeFence, force) {
  let index = 0;
  let start = 0;
  let fence = inCodeFence;
  const paragraphs = [];

  while (index < input.length) {
    if (input.startsWith("```", index)) {
      fence = !fence;
      index += 3;
      continue;
    }
    if (!fence && input[index] === "\n" && input[index + 1] === "\n") {
      const candidate = input.slice(start, index).trim();
      if (candidate) {
        paragraphs.push(candidate);
      }
      index += 2;
      while (input[index] === "\n") {
        index += 1;
      }
      start = index;
      continue;
    }
    index += 1;
  }

  let remainder = input.slice(start);
  if (force) {
    const finalCandidate = remainder.trim();
    if (finalCandidate) {
      paragraphs.push(finalCandidate);
      remainder = "";
    }
  }

  return { paragraphs, remainder, inCodeFence: fence };
}

async function safeSendToChannel(channel, text) {
  if (!channel || !channel.isTextBased()) {
    return null;
  }
  try {
    return await channel.send(text);
  } catch (error) {
    if (!isChannelUnavailableError(error)) {
      throw error;
    }
    return null;
  }
}

async function safeSendToChannelPayload(channel, payload) {
  if (!channel || !channel.isTextBased()) {
    return null;
  }
  try {
    return await channel.send(payload);
  } catch (error) {
    if (!isChannelUnavailableError(error)) {
      throw error;
    }
    return null;
  }
}

async function maybeSendAttachmentsForItem(tracker, item) {
  const maxAttachmentIssueMessages = tracker?.allowFileWrites === false ? 0 : attachmentIssueLimitPerTurn;
  await maybeSendAttachmentsForItemFromService(tracker, item, {
    attachmentsEnabled,
    attachmentItemTypes,
    attachmentMaxBytes,
    attachmentRoots,
    imageCacheDir,
    attachmentInferFromText,
    statusLabelForItemType,
    safeSendToChannel,
    safeSendToChannelPayload,
    truncateStatusText,
    maxAttachmentIssueMessages
  });
}

async function sendChunkedToChannel(channel, text) {
  await sendChunkedToChannelFromRenderer(channel, text, safeSendToChannel, discordMaxMessageLength);
}

function extractThreadId(params) {
  if (typeof params?.threadId === "string") {
    return params.threadId;
  }
  if (typeof params?.conversationId === "string") {
    return params.conversationId;
  }
  if (typeof params?.item?.threadId === "string") {
    return params.item.threadId;
  }
  if (typeof params?.turn?.threadId === "string") {
    return params.turn.threadId;
  }
  return null;
}

function extractAgentMessageText(item) {
  if (!item || item.type !== "agentMessage") {
    return "";
  }
  if (typeof item.text === "string" && item.text.trim()) {
    return item.text;
  }
  if (Array.isArray(item.content)) {
    const textParts = [];
    for (const part of item.content) {
      if (typeof part === "string") {
        textParts.push(part);
        continue;
      }
      if (typeof part?.text === "string") {
        textParts.push(part.text);
      }
    }
    return textParts.join("");
  }
  return "";
}
