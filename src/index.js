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
import { resolveRepoContext, isGeneralChannel } from "./channels/context.js";
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
let heartbeatTimer = null;
let shuttingDown = false;
let restartAckHandled = false;
const turnRunner = createTurnRunner({
  queues,
  activeTurns,
  state,
  codex,
  config,
  safeReply,
  buildSandboxPolicyForTurn,
  isThreadNotFoundError,
  finalizeTurn
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

await codex.start();
await fs.mkdir(generalChannelCwd, { recursive: true }).catch((error) => {
  console.warn(`failed to ensure general cwd at ${generalChannelCwd}: ${error.message}`);
});
await discord.login(discordToken);
await discord.application?.fetch().catch(() => null);
await waitForDiscordReady(discord);
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
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    await codex.stop();
  } catch {}
  discord.destroy();
  process.exit(exitCode);
}

function startHeartbeatLoop() {
  void writeHeartbeatFile();
  void maybeHandleRestartAckSignal();
  heartbeatTimer = setInterval(() => {
    void writeHeartbeatFile();
    void maybeHandleRestartAckSignal();
  }, heartbeatIntervalMs);
  if (typeof heartbeatTimer?.unref === "function") {
    heartbeatTimer.unref();
  }
}

async function writeHeartbeatFile() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      startedAt: processStartedAt,
      pid: process.pid,
      activeTurns: activeTurns.size,
      pendingApprovals: pendingApprovals.size,
      restartRequestPath,
      restartAckPath
    };
    await fs.mkdir(path.dirname(heartbeatPath), { recursive: true });
    const tempPath = `${heartbeatPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
    await fs.rename(tempPath, heartbeatPath);
  } catch (error) {
    debugLog("ops", "heartbeat write failed", { message: String(error?.message ?? error) });
  }
}

async function maybeHandleRestartAckSignal() {
  if (!exitOnRestartAck || restartAckHandled || shuttingDown) {
    return;
  }
  try {
    const raw = await fs.readFile(restartAckPath, "utf8");
    const parsed = JSON.parse(raw);
    const acknowledgedAt = typeof parsed?.acknowledgedAt === "string" ? parsed.acknowledgedAt : "";
    if (!acknowledgedAt) {
      return;
    }
    if (new Date(acknowledgedAt).getTime() <= new Date(processStartedAt).getTime()) {
      return;
    }
    restartAckHandled = true;
    console.log(`restart ack detected at ${restartAckPath}; exiting for host-managed restart`);
    await shutdown(0);
  } catch {}
}

async function handleMessage(message) {
  if (message.author.bot) {
    return;
  }

  const rawContent = message.content.trim();
  if (!isAllowedUser(message.author.id)) {
    console.warn(`ignoring message from filtered user ${message.author.id} in channel ${message.channelId}`);
    return;
  }

  const imageAttachments = collectImageAttachments(message);
  if (!rawContent && imageAttachments.length === 0) {
    return;
  }

  const content = normalizeIncomingContent(rawContent, discord.user?.id);
  if (!content && imageAttachments.length === 0) {
    return;
  }

  if (content.toLowerCase() === "!resync") {
    const result = await bootstrapChannelMappings();
    await safeReply(
      message,
      `Resynced channels. discovered=${result.discoveredCwds}, created=${result.createdChannels}, moved=${result.movedChannels}, pruned=${result.prunedBindings}, mapped=${Object.keys(channelSetups).length}`
    );
    return;
  }

  if (content.toLowerCase() === "!rebuild") {
    const result = await bootstrapChannelMappings({ forceRebuild: true });
    await safeReply(
      message,
      `Rebuilt channels. nuked_channels=${result.deletedChannels}, nuked_categories=${result.deletedCategories}, cleared_bindings=${result.clearedBindings}, discovered=${result.discoveredCwds}, created=${result.createdChannels}, moved=${result.movedChannels}, pruned=${result.prunedBindings}, mapped=${Object.keys(channelSetups).length}`
    );
    return;
  }

  const context = resolveRepoContext(message, {
    channelSetups,
    config,
    generalChannel: {
      id: generalChannelId,
      name: generalChannelName,
      cwd: generalChannelCwd
    }
  });
  if (content.startsWith("!")) {
    const [commandRaw, ...restParts] = content.split(/\s+/);
    const command = commandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    if (command === "!initrepo") {
      await handleInitRepoCommand(message, rest);
      return;
    }
  }

  if (!context) {
    return;
  }

  if (content.startsWith("!")) {
    await handleCommand(message, content, context);
    return;
  }

  const inputItems = await buildTurnInputFromMessage(message, content, imageAttachments, context.setup);
  if (inputItems.length === 0) {
    return;
  }
  enqueuePrompt(context.repoChannelId, {
    inputItems,
    message,
    setup: context.setup,
    repoChannelId: context.repoChannelId
  });
}

async function handleInteraction(interaction) {
  if (!interaction.isButton()) {
    return;
  }
  const parsed = parseApprovalButtonCustomId(interaction.customId, approvalButtonPrefix);
  if (!parsed) {
    return;
  }

  if (!isAllowedUser(interaction.user.id)) {
    await interaction.reply({
      content: "You are not allowed to approve requests for this bot.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const approval = pendingApprovals.get(parsed.token);
  if (!approval) {
    await interaction.reply({ content: "That approval is already resolved.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (approval.repoChannelId !== interaction.channelId) {
    await interaction.reply({
      content: "That approval belongs to a different channel.",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const result = await applyApprovalDecision(parsed.token, parsed.decision, `<@${interaction.user.id}>`);
  if (!result.ok) {
    await interaction.reply({
      content: `Failed to send approval response: ${result.error}`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }
  await interaction.reply({
    content: `${parsed.decision} sent for approval \`${parsed.token}\`.`,
    flags: MessageFlags.Ephemeral
  });
}

function isAllowedUser(userId) {
  if (!Array.isArray(config.allowedUserIds) || config.allowedUserIds.length === 0) {
    return true;
  }
  return config.allowedUserIds.includes(userId);
}

function normalizeIncomingContent(content, botUserId) {
  if (!content) {
    return "";
  }
  if (!botUserId) {
    return content.trim();
  }
  const mentionPrefix = new RegExp(`^<@!?${botUserId}>\\s*`);
  return content.replace(mentionPrefix, "").trim();
}

function collectImageAttachments(message) {
  if (!message?.attachments?.size) {
    return [];
  }
  const all = [...message.attachments.values()];
  return all.filter((attachment) => isImageAttachment(attachment)).slice(0, Math.max(0, maxImagesPerMessage));
}

function isImageAttachment(attachment) {
  if (!attachment) {
    return false;
  }
  const contentType = String(attachment.contentType ?? "").toLowerCase();
  if (contentType.startsWith("image/")) {
    return true;
  }
  const name = String(attachment.name ?? "").toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|svg)$/.test(name);
}

async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
  const inputItems = [];
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed) {
    inputItems.push({ type: "text", text: formatInputTextForSetup(trimmed, setup) });
  }

  const localImages = await downloadImageAttachments(imageAttachments, message.id);
  inputItems.push(...localImages);
  return inputItems;
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

async function downloadImageAttachments(attachments, messageId) {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return [];
  }
  await fs.mkdir(imageCacheDir, { recursive: true });
  const images = [];

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    const downloaded = await downloadImageAttachment(attachment, messageId, index + 1);
    if (downloaded) {
      images.push(downloaded);
      continue;
    }
    if (typeof attachment?.url === "string" && attachment.url) {
      images.push({ type: "image", url: attachment.url });
    }
  }

  return images;
}

async function downloadImageAttachment(attachment, messageId, ordinal) {
  const sourceUrls = [attachment?.proxyURL, attachment?.url]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (sourceUrls.length === 0) {
    return null;
  }

  try {
    const bytes = await fetchDiscordAttachmentBytes(sourceUrls);
    if (bytes.length === 0) {
      return null;
    }
    const extension = guessImageExtension(attachment);
    const fileName = `${Date.now()}-${messageId}-${ordinal}${extension}`;
    const filePath = path.join(imageCacheDir, fileName);
    await fs.writeFile(filePath, bytes);
    return { type: "localImage", path: filePath };
  } catch (error) {
    console.warn(`failed to download Discord image attachment ${attachment?.id ?? "unknown"}: ${error.message}`);
    return null;
  }
}

async function fetchDiscordAttachmentBytes(sourceUrls) {
  const seen = new Set();
  const urls = [];
  for (const sourceUrl of sourceUrls) {
    if (!seen.has(sourceUrl)) {
      seen.add(sourceUrl);
      urls.push(sourceUrl);
    }
  }

  const authHeaders = discordToken ? { Authorization: `Bot ${discordToken}` } : null;
  const attempts = [];
  for (const sourceUrl of urls) {
    attempts.push({ sourceUrl, headers: authHeaders });
    attempts.push({ sourceUrl, headers: null });
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.sourceUrl, {
        headers: attempt.headers ?? undefined
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("attachment download failed");
}

function guessImageExtension(attachment) {
  const byName = path.extname(String(attachment?.name ?? "")).toLowerCase();
  if (byName && byName.length <= 10) {
    return byName;
  }
  const contentType = String(attachment?.contentType ?? "").toLowerCase();
  const known = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tif",
    "image/svg+xml": ".svg"
  };
  return known[contentType] ?? ".png";
}

async function handleCommand(message, content, context) {
  const [commandRaw, ...restParts] = content.split(/\s+/);
  const command = commandRaw.toLowerCase();
  const rest = restParts.join(" ").trim();

  if (command === "!help") {
    await safeReply(
      message,
      [
        "Commands:",
        "`!initrepo [force]` create/bind repo for this channel using channel name",
        "`!ask <prompt>` send prompt in this repo channel",
        "`!status` show queue/thread status for this channel",
        "`!new` reset Codex thread binding for this channel",
        "`!interrupt` interrupt current turn in this channel",
        "`!where` show bot runtime paths and binding details",
        "`!approve [id]` approve the latest (or specified) pending request",
        "`!decline [id]` decline the latest (or specified) pending request",
        "`!cancel [id]` cancel the latest (or specified) pending request",
        "`!resync` non-destructive sync with Codex projects",
        "`!rebuild` destructive rebuild of managed channels",
        "Tip: use the Approve/Decline/Cancel buttons on approval messages",
        "Model: one repo text channel = one persistent Codex thread",
        "Also supported in #general: plain chat and !commands (read-only, no file writes)"
      ].join("\n")
    );
    return;
  }

  if (command === "!ask") {
    const imageAttachments = collectImageAttachments(message);
    if (!rest && imageAttachments.length === 0) {
      await safeReply(message, "Usage: `!ask <prompt>`");
      return;
    }
    const inputItems = await buildTurnInputFromMessage(message, rest, imageAttachments, context.setup);
    if (inputItems.length === 0) {
      await safeReply(message, "No usable text or image attachment found for `!ask`.");
      return;
    }
    enqueuePrompt(context.repoChannelId, {
      inputItems,
      message,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
    return;
  }

  if (command === "!status") {
    const queue = getQueue(context.repoChannelId);
    const binding = state.getBinding(context.repoChannelId);
    const codexThreadId = binding?.codexThreadId ?? null;
    const activeTurn = findActiveTurnByRepoChannel(context.repoChannelId);
    const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
    const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
    const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
    await safeReply(
      message,
      [
        `cwd: \`${context.setup.cwd}\``,
        `mode: ${modeLabel}`,
        `approval policy: \`${config.approvalPolicy}\``,
        `sandbox mode: \`${sandboxMode}\``,
        `file writes: ${fileWrites}`,
        `codex thread: ${codexThreadId ? `\`${codexThreadId}\`` : "none"}`,
        `queue depth: ${queue.jobs.length}`,
        `active turn: ${activeTurn ? "yes" : "no"}`
      ].join("\n")
    );
    return;
  }

  if (command === "!new") {
    state.clearBinding(context.repoChannelId);
    await state.save();
    await safeReply(message, "Cleared Codex thread binding for this channel. Next prompt starts a new Codex thread.");
    return;
  }

  if (command === "!interrupt") {
    const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
    if (!threadId) {
      await safeReply(message, "No Codex thread is bound to this channel yet.");
      return;
    }
    try {
      await codex.request("turn/interrupt", { threadId });
      await safeReply(message, "Interrupt requested.");
    } catch (error) {
      await safeReply(message, `Interrupt failed: ${error.message}`);
    }
    return;
  }

  if (command === "!where") {
    const threadId = state.getBinding(context.repoChannelId)?.codexThreadId;
    const sandboxMode = context.setup.sandboxMode ?? config.sandboxMode;
    const modeLabel = context.setup.mode === "general" ? "general" : "repo channel";
    const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
    const lines = [
      `codex bin: \`${codexBin}\``,
      `CODEX_HOME: \`${codexHomeEnv ?? "(unset; codex default path)"}\``,
      `state file: \`${statePath}\``,
      `channel config: \`${configPath}\``,
      `channel mode: \`${modeLabel}\``,
      `channel cwd: \`${context.setup.cwd}\``,
      `repo channel: \`${context.repoChannelId}\``,
      `approval policy: \`${config.approvalPolicy}\``,
      `sandbox mode: \`${sandboxMode}\``,
      `file writes: \`${fileWrites}\``,
      `codex thread: ${threadId ? `\`${threadId}\`` : "none"}`
    ];
    await safeReply(message, lines.join("\n"));
    return;
  }

  if (command === "!approve" || command === "!decline" || command === "!cancel") {
    let token = rest;
    if (!token) {
      token = findLatestPendingApprovalTokenForChannel(message.channelId);
      if (!token) {
        await safeReply(message, `No pending approvals in this channel. Usage: \`${command} <id>\``);
        return;
      }
    }
    const approval = pendingApprovals.get(token);
    if (!approval) {
      await safeReply(message, `No pending approval with id \`${token}\`.`);
      return;
    }
    if (approval.repoChannelId !== message.channelId) {
      await safeReply(message, "That approval belongs to a different channel.");
      return;
    }
    const decision = command === "!approve" ? "accept" : command === "!cancel" ? "cancel" : "decline";
    const result = await applyApprovalDecision(token, decision, `<@${message.author.id}>`);
    if (!result.ok) {
      await safeReply(message, `Failed to send approval response: ${result.error}`);
      return;
    }
    await safeReply(message, `${decision} sent for approval \`${token}\`.`);
    return;
  }

  await safeReply(message, "Unknown command. Use `!help`.");
}

async function handleInitRepoCommand(message, rest) {
  if (message.channel.type !== ChannelType.GuildText) {
    await safeReply(message, "`!initrepo` is only available in server text channels.");
    return;
  }
  if (isGeneralChannel(message.channel)) {
    await safeReply(message, "`!initrepo` is disabled in #general (read-only channel).");
    return;
  }
  if (!repoRootPath) {
    await safeReply(message, "Set `DISCORD_REPO_ROOT` in `.env` before using `!initrepo`.");
    return;
  }

  const force = rest.toLowerCase() === "force";
  const repoName = makeChannelName(message.channel.name);
  const repoPath = path.join(repoRootPath, repoName);
  const existingSetup = channelSetups[message.channelId];

  if (existingSetup && existingSetup.cwd !== repoPath && !force) {
    await safeReply(
      message,
      `This channel is already bound to \`${existingSetup.cwd}\`. Use \`!initrepo force\` to rebind.`
    );
    return;
  }

  await fs.mkdir(repoRootPath, { recursive: true });
  const repoExists = await pathExists(repoPath);
  if (repoExists && !force && (!existingSetup || existingSetup.cwd !== repoPath)) {
    await safeReply(
      message,
      `Repo path already exists: \`${repoPath}\`. Rename channel or run \`!initrepo force\`.`
    );
    return;
  }

  await fs.mkdir(repoPath, { recursive: true });
  await execFileAsync("git", ["-C", repoPath, "init"], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024
  });

  channelSetups[message.channelId] = {
    cwd: repoPath,
    model: config.defaultModel
  };
  state.clearBinding(message.channelId);
  await state.save();

  const nextTopic = upsertTopicTag(message.channel.topic, managedChannelTopicPrefix, repoPath);
  if (nextTopic !== message.channel.topic) {
    await message.channel.setTopic(nextTopic).catch((error) => {
      console.warn(`failed setting channel topic for ${message.channelId}: ${error.message}`);
    });
  }

  await safeReply(
    message,
    `Initialized repo \`${repoName}\` at \`${repoPath}\` and bound this channel.`
  );
}

async function bootstrapChannelMappings(options = {}) {
  const forceRebuild = options.forceRebuild === true;
  const guild = await resolveGuild();
  await guild.channels.fetch();

  let deletedChannels = 0;
  let deletedCategories = 0;
  let clearedBindings = 0;
  let deletedCwds = [];
  if (forceRebuild) {
    const reset = await resetManagedLayout(guild);
    deletedChannels = reset.deletedChannels;
    deletedCategories = reset.deletedCategories;
    clearedBindings = reset.clearedBindings;
    deletedCwds = reset.deletedCwds;
    await guild.channels.fetch();
    channelSetups = {};
  }

  const projectsCategory = await ensureProjectsCategory(guild);
  const cutover = await performCutoverCleanup(guild, projectsCategory.id);

  const discoveredFromTopics = collectChannelSetupsFromGuildTopics(guild);
  const merged = { ...channelSetups, ...discoveredFromTopics };
  const sanitized = {};
  for (const [channelId, setup] of Object.entries(merged)) {
    const channel = guild.channels.cache.get(channelId);
    if (channel?.type === ChannelType.GuildText) {
      sanitized[channelId] = setup;
    }
  }
  channelSetups = sanitized;

  let discoveredCwds = [];
  try {
    discoveredCwds = await discoverProjectsFromCodex();
  } catch (error) {
    console.error(`failed to discover projects from codex: ${error.message}`);
  }
  if (forceRebuild && discoveredCwds.length === 0 && deletedCwds.length > 0) {
    discoveredCwds = deletedCwds;
  }

  let createdChannels = 0;
  for (const cwd of discoveredCwds) {
    if (findChannelIdByCwd(cwd)) {
      continue;
    }
    let channel;
    try {
      channel = await ensureProjectChannel(guild, cwd, projectsCategory.id);
    } catch (error) {
      if (isDiscordMissingPermissionsError(error)) {
        console.error(
          "Discord denied channel creation (Missing Permissions). Grant the bot role `Manage Channels` (or Administrator), then run `!resync`."
        );
        break;
      }
      throw error;
    }
    channelSetups[channel.id] = {
      cwd,
      model: config.defaultModel
    };
    createdChannels += 1;
  }

  const prunedBindings = await pruneInvalidThreadBindings(guild);

  return {
    discoveredCwds: discoveredCwds.length,
    createdChannels,
    movedChannels: cutover.movedChannels,
    prunedBindings,
    deletedChannels,
    deletedCategories,
    clearedBindings
  };
}

async function resolveGuild() {
  const configuredGuildId = process.env.DISCORD_GUILD_ID;
  if (configuredGuildId) {
    const guild = discord.guilds.cache.get(configuredGuildId);
    if (guild) {
      return guild;
    }
    const fetchedGuild = await discord.guilds.fetch(configuredGuildId).catch(() => null);
    if (fetchedGuild) {
      return fetchedGuild;
    }
    const allGuilds = await discord.guilds.fetch().catch(() => new Map());
    const knownGuilds = [...allGuilds.values()].map((g) => `${g.name} (${g.id})`);
    const appId = discord.application?.id;
    throw new Error(
      [
        `DISCORD_GUILD_ID=${configuredGuildId} is not visible to this bot.`,
        knownGuilds.length > 0
          ? `Bot can access: ${knownGuilds.join(", ")}`
          : "Bot is not in any guilds.",
        appId
          ? `Re-invite with guild install + bot scope: https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=274877975552`
          : "Re-invite the bot with guild install and bot scope."
      ].join(" ")
    );
  }

  const guilds = [...discord.guilds.cache.values()];
  if (guilds.length === 1) {
    return guilds[0];
  }

  const fetched = await discord.guilds.fetch().catch(() => new Map());
  if (fetched.size === 1) {
    return [...fetched.values()][0];
  }

  throw new Error("Set DISCORD_GUILD_ID (bot is in multiple guilds).");
}

async function ensureProjectsCategory(guild) {
  for (const channel of guild.channels.cache.values()) {
    if (
      channel.type === ChannelType.GuildCategory &&
      channel.name.toLowerCase() === projectsCategoryName.toLowerCase()
    ) {
      return channel;
    }
  }
  return guild.channels.create({
    name: projectsCategoryName,
    type: ChannelType.GuildCategory
  });
}

async function resetManagedLayout(guild) {
  let deletedChannels = 0;
  let deletedCategories = 0;
  const touchedCategoryIds = new Set();
  const deletedCwdSet = new Set();

  for (const channel of guild.channels.cache.values()) {
    if (!isManagedChannelForCleanup(channel)) {
      continue;
    }
    const cwd = parseCwdFromTopic(channel.topic);
    if (cwd) {
      deletedCwdSet.add(cwd);
    }
    if (channel.parentId) {
      touchedCategoryIds.add(channel.parentId);
    }
    try {
      await channel.delete("rebuild: delete managed codex channel");
      deletedChannels += 1;
    } catch (error) {
      if (isDiscordMissingPermissionsError(error)) {
        console.error(`Missing permissions deleting managed channel ${channel.id} during rebuild.`);
        continue;
      }
      throw error;
    }
  }

  const snapshot = state.snapshot();
  const bindings = snapshot?.threadBindings ?? {};
  const clearedBindings = Object.keys(bindings).length;
  if (clearedBindings > 0) {
    state.clearAllBindings();
    await state.save();
  }

  await guild.channels.fetch();
  const legacyCategoryBaseNames = new Set(
    [...deletedCwdSet].map((cwd) => makeChannelName(path.basename(cwd) || "repo"))
  );
  const categoriesToDelete = new Set();
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildCategory) {
      continue;
    }
    const lowerName = channel.name.toLowerCase();
    const isProjectsCategory = lowerName === projectsCategoryName.toLowerCase();
    const isTouched = touchedCategoryIds.has(channel.id);
    const isLegacyByName = isLegacyProjectCategoryName(lowerName, legacyCategoryBaseNames);
    if (isProjectsCategory || isTouched || isLegacyByName) {
      categoriesToDelete.add(channel.id);
    }
  }

  for (const categoryId of categoriesToDelete) {
    const category = guild.channels.cache.get(categoryId);
    if (category?.type !== ChannelType.GuildCategory) {
      continue;
    }
    const hasChildren = [...guild.channels.cache.values()].some(
      (candidate) => candidate.parentId === category.id
    );
    if (hasChildren) {
      continue;
    }
    try {
      await category.delete("rebuild: delete stale category");
      deletedCategories += 1;
    } catch (error) {
      if (isDiscordMissingPermissionsError(error)) {
        console.error(`Missing permissions deleting category ${category.id} during rebuild.`);
        continue;
      }
      throw error;
    }
  }

  return {
    deletedChannels,
    deletedCategories,
    clearedBindings,
    deletedCwds: [...deletedCwdSet].sort((a, b) => a.localeCompare(b))
  };
}

async function discoverProjectsFromCodex() {
  if (config.autoDiscoverProjects === false) {
    return [];
  }

  const cwds = new Set();
  let cursor = undefined;
  let page = 0;

  while (page < 50) {
    const params = {
      limit: 100,
      sortKey: "updated_at"
    };
    if (cursor) {
      params.cursor = cursor;
    }
    const response = await codex.request("thread/list", params);
    const rows = Array.isArray(response?.data) ? response.data : [];
    for (const row of rows) {
      if (typeof row?.cwd === "string" && row.cwd.trim()) {
        cwds.add(path.resolve(row.cwd));
      }
    }
    if (!response?.nextCursor) {
      break;
    }
    cursor = response.nextCursor;
    page += 1;
  }

  return [...cwds].sort((a, b) => a.localeCompare(b));
}

function collectChannelSetupsFromGuildTopics(guild) {
  const discovered = {};
  for (const channel of guild.channels.cache.values()) {
    if (!isManagedRepoChannel(channel)) {
      continue;
    }
    const cwd = parseCwdFromTopic(channel.topic);
    if (!cwd) {
      continue;
    }
    discovered[channel.id] = {
      cwd,
      model: findConfiguredModelForCwd(cwd)
    };
  }
  return discovered;
}

function findConfiguredModelForCwd(cwd) {
  const resolvedCwd = path.resolve(cwd);
  for (const setup of Object.values(channelSetups)) {
    if (setup?.cwd === resolvedCwd && typeof setup?.model === "string") {
      return setup.model;
    }
  }
  for (const setup of Object.values(config.channels)) {
    if (setup?.cwd === resolvedCwd && typeof setup?.model === "string") {
      return setup.model;
    }
  }
  return config.defaultModel;
}

async function ensureProjectChannel(guild, cwd, projectsCategoryId) {
  const existing = findGuildChannelByCwd(guild, cwd);
  if (existing) {
    if (existing.parentId !== projectsCategoryId) {
      await existing.setParent(projectsCategoryId, { lockPermissions: false });
    }
    const expectedTopic = topicForCwd(cwd);
    if (existing.topic !== expectedTopic) {
      await existing.setTopic(expectedTopic);
    }
    return existing;
  }

  const baseName = makeChannelName(path.basename(cwd) || "repo");
  const name = uniqueChannelName(guild, baseName);
  const topic = topicForCwd(cwd);

  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: projectsCategoryId,
    topic
  });
}

function findGuildChannelByCwd(guild, cwd) {
  for (const channel of guild.channels.cache.values()) {
    if (!isManagedRepoChannel(channel)) {
      continue;
    }
    const parsed = parseCwdFromTopic(channel.topic);
    if (parsed === cwd) {
      return channel;
    }
  }
  return null;
}

async function performCutoverCleanup(guild, projectsCategoryId) {
  let movedChannels = 0;

  for (const channel of guild.channels.cache.values()) {
    if (!isManagedRepoChannel(channel)) {
      continue;
    }
    if (channel.parentId === projectsCategoryId) {
      continue;
    }
    try {
      await channel.setParent(projectsCategoryId, { lockPermissions: false });
    } catch (error) {
      if (isDiscordMissingPermissionsError(error)) {
        console.error("Missing permissions to move channel into projects category during sync.");
        continue;
      }
      throw error;
    }
    movedChannels += 1;
  }

  return { movedChannels };
}

async function pruneInvalidThreadBindings(guild) {
  const snapshot = state.snapshot();
  const bindings = snapshot?.threadBindings ?? {};
  let removed = 0;

  for (const [repoChannelId, binding] of Object.entries(bindings)) {
    const channel = guild.channels.cache.get(repoChannelId);
    const valid =
      !!channel &&
      channel.type === ChannelType.GuildText &&
      !!channelSetups[repoChannelId] &&
      (!binding?.cwd || binding.cwd === channelSetups[repoChannelId].cwd);

    if (!valid) {
      state.clearBinding(repoChannelId);
      removed += 1;
    }
  }

  if (removed > 0) {
    await state.save();
  }

  return removed;
}

function findChannelIdByCwd(cwd) {
  for (const [channelId, setup] of Object.entries(channelSetups)) {
    if (setup?.cwd === cwd) {
      return channelId;
    }
  }
  return null;
}

function makeChannelName(input) {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return (cleaned || "repo").slice(0, 100);
}

function isLegacyProjectCategoryName(categoryNameLower, legacyBaseNames) {
  if (!legacyBaseNames || legacyBaseNames.size === 0) {
    return false;
  }
  for (const base of legacyBaseNames) {
    if (categoryNameLower === base) {
      return true;
    }
    if (!categoryNameLower.startsWith(`${base}-`)) {
      continue;
    }
    const suffix = categoryNameLower.slice(base.length + 1);
    if (/^[0-9]+$/.test(suffix)) {
      return true;
    }
  }
  return false;
}

function uniqueChannelName(guild, baseName) {
  let candidate = baseName;
  let index = 2;
  const lowerExisting = new Set(
    [...guild.channels.cache.values()]
      .filter((channel) => channel.type === ChannelType.GuildText)
      .map((channel) => channel.name.toLowerCase())
  );

  while (lowerExisting.has(candidate.toLowerCase())) {
    const suffix = `-${index}`;
    candidate = `${baseName.slice(0, Math.max(1, 100 - suffix.length))}${suffix}`;
    index += 1;
  }

  return candidate;
}

function topicForCwd(cwd) {
  return `${managedChannelTopicPrefix}${cwd}`;
}

function upsertTopicTag(topic, prefix, value) {
  const safeValue = String(value ?? "").trim();
  if (!safeValue) {
    return typeof topic === "string" ? topic : "";
  }
  const lines = typeof topic === "string" && topic.trim() ? topic.split(/\n+/).map((line) => line.trim()) : [];
  const kept = lines.filter((line) => !line.startsWith(prefix));
  kept.push(`${prefix}${safeValue}`);
  return kept.join("\n").trim();
}

function parseTaggedTopicValue(topic, prefix) {
  if (typeof topic !== "string" || !topic.trim()) {
    return null;
  }
  for (const rawLine of topic.split(/\n+/)) {
    const line = rawLine.trim();
    if (!line.startsWith(prefix)) {
      continue;
    }
    const value = line.slice(prefix.length).trim();
    return value || null;
  }
  return null;
}

async function pathExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseCwdFromTopic(topic) {
  const cwd = parseTaggedTopicValue(topic, managedChannelTopicPrefix);
  return cwd ? path.resolve(cwd) : null;
}

function parseCodexThreadIdFromTopic(topic) {
  return parseTaggedTopicValue(topic, managedThreadTopicPrefix);
}

function isManagedChannelForCleanup(channel) {
  if (channel.type !== ChannelType.GuildText) {
    return false;
  }
  return !!parseCwdFromTopic(channel.topic) || !!parseCodexThreadIdFromTopic(channel.topic);
}

function isManagedRepoChannel(channel) {
  if (channel.type !== ChannelType.GuildText) {
    return false;
  }
  return !!parseCwdFromTopic(channel.topic) && !parseCodexThreadIdFromTopic(channel.topic);
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
  const normalized = normalizeCodexNotification({ method, params });

  if (normalized.kind === "agent_delta") {
    const threadId = normalized.threadId;
    const delta = normalized.delta;
    if (!threadId || !delta) {
      return;
    }
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    debugLog("item-delta", "agent delta", { threadId, deltaLength: delta.length });
    appendTrackerText(tracker, delta, { fromDelta: true });
    return;
  }

  if (normalized.kind === "item_lifecycle") {
    const threadId = normalized.threadId;
    if (!threadId) {
      return;
    }
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    const item = normalized.item;
    const state = normalized.state;
    debugLog("item-event", "item lifecycle", {
      threadId,
      state,
      itemType: item?.type,
      itemId: item?.id ?? null
    });

    if (item?.type === "fileChange" && method === "item/completed") {
      recordFileChanges(tracker, item);
    }

    if (shouldAnnounceStatusItem(item?.type, renderVerbosity)) {
      const statusLine = recordItemStatusLine(item, state);
      if (statusLine) {
        const statusMessage = await sendStatusUpdateLine(tracker, statusLine);
        if (statusMessage) {
          const key = makeItemStatusKey(item);
          if (key) {
            tracker.itemStatusMessages.set(key, statusMessage.id);
            const pendingEmoji = tracker.pendingCompletionReactions?.get(key);
            if (pendingEmoji) {
              tracker.pendingCompletionReactions.delete(key);
              await reactToStatusMessage(tracker, statusMessage.id, key, pendingEmoji);
            }
          }
        }
      } else if (state === "completed" && shouldReactOnCompletion(item?.type)) {
        await reactToStatusCompletion(tracker, item);
      }
    }

    if (state === "completed") {
      await maybeSendAttachmentsForItem(tracker, item);
    }

    if (state === "started") {
      return;
    }

    const messageText = extractAgentMessageText(item);
    if (!messageText) {
      return;
    }
    if (tracker.seenDelta || tracker.fullText.length > 0) {
      return;
    }
    appendTrackerText(tracker, messageText, { fromDelta: false });
    return;
  }

  if (normalized.kind === "turn_completed") {
    const threadId = normalized.threadId;
    if (!threadId) {
      return;
    }
    await finalizeTurn(threadId, null);
    return;
  }

  if (normalized.kind === "error") {
    const threadId = normalized.threadId;
    const message = normalized.errorMessage;
    if (threadId) {
      await finalizeTurn(threadId, new Error(message));
    }
  }
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

function scheduleFlush(tracker) {
  if (tracker.flushTimer) {
    return;
  }
  const elapsed = Date.now() - tracker.lastFlushAt;
  const delay = Math.max(0, 1200 - elapsed);
  tracker.flushTimer = setTimeout(() => {
    tracker.flushTimer = null;
    void flushTrackerParagraphs(tracker, { force: false });
  }, delay);
}

async function flushTrackerParagraphs(tracker, { force }) {
  if (!force && !activeTurns.has(tracker.threadId)) {
    return;
  }
  const content = buildTrackerMessageContent(tracker);
  await editTrackerMessage(tracker, content);
  tracker.lastFlushAt = Date.now();
}

async function finalizeTurn(threadId, error) {
  const tracker = activeTurns.get(threadId);
  if (!tracker) {
    return;
  }

  if (tracker.flushTimer) {
    clearTimeout(tracker.flushTimer);
    tracker.flushTimer = null;
  }

  activeTurns.delete(threadId);

  if (error) {
    tracker.failed = true;
    tracker.completed = true;
    tracker.failureMessage = error.message;
    pushStatusLine(tracker, `❌ Error: ${truncateStatusText(error.message, 220)}`);
    await flushTrackerParagraphs(tracker, { force: true });
    tracker.reject(error);
    return;
  }

  tracker.completed = true;
  pushStatusLine(tracker, "👍 Tool calling done");
  await flushTrackerParagraphs(tracker, { force: true });

  const diffBlock = buildFileDiffSection(tracker);
  const renderPlan = buildTurnRenderPlan({
    summaryText: tracker.fullText,
    diffBlock,
    verbosity: renderVerbosity
  });
  if (renderPlan.primaryMessage) {
    await sendChunkedToChannel(tracker.channel, renderPlan.primaryMessage);
  }
  for (const statusMessage of renderPlan.statusMessages) {
    await sendChunkedToChannel(tracker.channel, statusMessage);
  }

  tracker.resolve(tracker.fullText);
}

function appendTrackerText(tracker, text, { fromDelta }) {
  if (!text) {
    return;
  }
  tracker.fullText += text;
  if (fromDelta) {
    tracker.seenDelta = true;
  }
}

function shouldAnnounceStatusItem(itemType, verbosity = "user") {
  if (typeof itemType !== "string" || !itemType) {
    return false;
  }
  let announced;
  if (verbosity === "debug") {
    announced = new Set([
      "commandExecution",
      "mcpToolCall",
      "webSearch",
      "imageView",
      "contextCompaction",
      "collabAgentToolCall",
      "toolCall"
    ]);
  } else if (verbosity === "ops") {
    announced = new Set(["commandExecution", "mcpToolCall", "webSearch", "imageView", "toolCall"]);
  } else {
    announced = new Set(["imageView"]);
  }
  return announced.has(itemType);
}

function recordItemStatusLine(item, state) {
  if (!item || typeof item !== "object") {
    return null;
  }
  const lines = summarizeItemForStatus(item, state);
  if (lines.length === 0) {
    return null;
  }
  const latest = lines[lines.length - 1];
  return latest;
}

async function sendStatusUpdateLine(tracker, line) {
  if (!tracker?.channel || typeof line !== "string" || !line.trim()) {
    return null;
  }
  const normalized = line.trim();
  if (tracker.lastStatusUpdateLine === normalized) {
    return null;
  }
  tracker.lastStatusUpdateLine = normalized;
  const message = await safeSendToChannel(tracker.channel, normalized);
  debugLog("status", "status line sent", {
    threadId: tracker.threadId,
    line: normalized
  });
  return message;
}

function makeItemStatusKey(item) {
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.id !== undefined && item.id !== null) {
    const id = String(item.id);
    if (id) {
      return `id:${id}`;
    }
  }
  if (item.type === "commandExecution" && typeof item.command === "string" && item.command) {
    return `cmd:${item.command}`;
  }
  if (item.type === "webSearch") {
    const queries = extractWebSearchDetails(item);
    if (queries.length > 0) {
      return `search:${queries[0]}`;
    }
  }
  return "";
}

function shouldReactOnCompletion(itemType) {
  return itemType === "commandExecution" || itemType === "webSearch";
}

async function reactToStatusCompletion(tracker, item) {
  const key = makeItemStatusKey(item);
  if (!key) {
    return;
  }
  const emoji = completionReactionEmoji(item);
  if (!emoji) {
    return;
  }
  const messageId = tracker.itemStatusMessages.get(key);
  if (!messageId) {
    tracker.pendingCompletionReactions?.set(key, emoji);
    return;
  }
  await reactToStatusMessage(tracker, messageId, key, emoji);
}

function completionReactionEmoji(item) {
  if (!item || typeof item !== "object") {
    return null;
  }
  if (item.type === "commandExecution") {
    const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
    if (exitCode === 0) {
      return "✅";
    }
    if (exitCode !== null) {
      return "❌";
    }
    return "✅";
  }
  if (item.type === "webSearch") {
    return "✅";
  }
  return null;
}

async function reactToStatusMessage(tracker, messageId, key, emoji) {
  if (!tracker.channel?.isTextBased?.()) {
    return;
  }
  try {
    const message = await tracker.channel.messages.fetch(messageId);
    if (message) {
      await message.react(emoji);
    }
  } catch (error) {
    debugLog("status", "completion reaction failed", {
      threadId: tracker.threadId,
      key,
      emoji,
      error: String(error?.message ?? error)
    });
  }
}

function pushStatusLine(tracker, line) {
  if (!tracker || typeof line !== "string") {
    return;
  }
  const normalized = line.trim();
  if (!normalized) {
    return;
  }
  if (tracker.currentStatusLine === normalized) {
    return;
  }
  tracker.currentStatusLine = normalized;
}

function buildTrackerMessageContent(tracker) {
  return truncateForDiscordMessage(tracker.currentStatusLine || "⏳ Thinking...", discordMaxMessageLength);
}

async function editTrackerMessage(tracker, content) {
  if (!tracker?.channel || !content) {
    return;
  }
  if (tracker.lastRenderedContent === content) {
    return;
  }
  const payload = truncateForDiscordMessage(content, discordMaxMessageLength);
  try {
    if (tracker.statusMessage) {
      await tracker.statusMessage.edit(payload);
      tracker.lastRenderedContent = payload;
      debugLog("render", "edited status message", { threadId: tracker.threadId, messageId: tracker.statusMessageId });
      return;
    }
  } catch (error) {
    debugLog("render", "direct edit failed", {
      threadId: tracker.threadId,
      messageId: tracker.statusMessageId,
      error: String(error?.message ?? error)
    });
  }

  if (tracker.statusMessageId && tracker.channel?.isTextBased?.()) {
    try {
      const fetched = await tracker.channel.messages.fetch(tracker.statusMessageId);
      if (fetched) {
        await fetched.edit(payload);
        tracker.statusMessage = fetched;
        tracker.lastRenderedContent = payload;
        debugLog("render", "fetched and edited status message", {
          threadId: tracker.threadId,
          messageId: tracker.statusMessageId
        });
        return;
      }
    } catch (error) {
      debugLog("render", "fetch/edit fallback failed", {
        threadId: tracker.threadId,
        messageId: tracker.statusMessageId,
        error: String(error?.message ?? error)
      });
    }
  }

  const replacement = await safeSendToChannel(tracker.channel, payload);
  if (replacement) {
    tracker.statusMessage = replacement;
    tracker.statusMessageId = replacement.id;
    tracker.lastRenderedContent = payload;
    debugLog("render", "sent replacement status message", { threadId: tracker.threadId, messageId: replacement.id });
  }
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
