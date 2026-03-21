import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { CodexRpcClient } from "../codexRpcClient.js";
import {
  maybeSendAttachmentsForItem as maybeSendAttachmentsForItemFromService,
  maybeSendInferredAttachmentsFromText as maybeSendInferredAttachmentsFromTextFromService
} from "../attachments/service.js";
import { createAttachmentInputBuilder } from "../attachments/inputBuilder.js";
import { createChannelMessaging } from "./channelMessaging.js";
import { createRuntimeAdapters } from "./runtimeAdapters.js";
import { createRuntimeContainer } from "./runtimeContainer.js";
import { isThreadNotFoundError } from "../codex/eventUtils.js";
import { createSandboxPolicyResolver } from "../codex/sandboxPolicy.js";
import { createTurnRunner } from "../codex/turnRunner.js";
import { sendChunkedToChannel as sendChunkedToChannelFromRenderer } from "../render/messageRenderer.js";
import { createTurnRecoveryStore } from "../turns/recoveryStore.js";
import { statusLabelForItemType, truncateStatusText } from "../turns/turnFormatting.js";
import { formatInputTextForSetup } from "./runtimeUtils.js";
import { isFeishuRouteId } from "../feishu/ids.js";

export async function buildRuntimeGraph(deps) {
  const { runtimeEnv, discordToken, execFileAsync, debugLog, discordMaxMessageLength, feishuMaxMessageLength, config, state } = deps;
  const {
    codexBin,
    imageCacheDir,
    maxImagesPerMessage,
    attachmentMaxBytes,
    attachmentRoots,
    attachmentInferFromText,
    attachmentsEnabled,
    attachmentLogEnabled,
    attachmentItemTypes,
    attachmentIssueLimitPerTurn,
    inFlightRecoveryPath,
    turnRecovery,
    extraWritableRoots,
    stripAnsiForDiscord
  } = runtimeEnv;

  const discord = discordToken ? await createDiscordClient() : createDisabledDiscordClient();
  const codex = new CodexRpcClient({
    codexBin
  });
  const runtimeContainer = createRuntimeContainer();
  const fetchChannelByRouteId = async (routeId) => {
    const platformRegistry = runtimeContainer.getRef("platformRegistry");
    if (platformRegistry?.fetchChannelByRouteId) {
      return await platformRegistry.fetchChannelByRouteId(routeId);
    }
    if (isFeishuRouteId(routeId)) {
      return (await runtimeContainer.getRef("feishuRuntime")?.fetchChannelByRouteId?.(routeId)) ?? null;
    }
    return await discord.channels.fetch(routeId).catch(() => null);
  };
  const channelMessaging = createChannelMessaging({
    fetchChannelByRouteId,
    stripAnsiForDiscord
  });
  const { safeReply, safeSendToChannel, safeSendToChannelPayload, safeAddReaction } = channelMessaging;
  const sandboxPolicyResolver = createSandboxPolicyResolver({
    path,
    execFileAsync,
    extraWritableRoots
  });
  const { buildSandboxPolicyForTurn } = sandboxPolicyResolver;
  const turnRecoveryStore = createTurnRecoveryStore({
    fs,
    path,
    recoveryPath: inFlightRecoveryPath,
    recoveryConfig: turnRecovery,
    debugLog
  });
  await turnRecoveryStore.load();

  const queues = new Map();
  const activeTurns = new Map();
  const pendingApprovals = new Map();
  const processStartedAt = new Date().toISOString();
  let nextApprovalToken = 1;
  const createApprovalToken = () => String(nextApprovalToken++).padStart(4, "0");
  const attachmentInputBuilder = createAttachmentInputBuilder({
    fs,
    imageCacheDir,
    maxImagesPerMessage,
    discordToken,
    fetch,
    formatInputTextForSetup,
    logger: console
  });
  const runtimeAdapters = createRuntimeAdapters({
    attachmentInputBuilder,
    runtimeContainer,
    maybeSendAttachmentsForItemFromService,
    maybeSendInferredAttachmentsFromTextFromService,
    sendChunkedToChannelFromRenderer,
    attachmentConfig: {
      attachmentsEnabled,
      attachmentLogEnabled,
      attachmentItemTypes,
      attachmentMaxBytes,
      attachmentRoots,
      imageCacheDir,
      attachmentInferFromText,
      attachmentIssueLimitPerTurn
    },
    channelMessagingConfig: {
      statusLabelForItemType,
      safeSendToChannel,
      safeSendToChannelPayload,
      truncateStatusText,
      discordMaxMessageLength,
      feishuMaxMessageLength
    }
  });

  runtimeContainer.setRef(
    "turnRunner",
    createTurnRunner({
    queues,
    activeTurns,
    state,
    codex,
    config,
    safeReply,
    buildSandboxPolicyForTurn,
    isThreadNotFoundError,
    finalizeTurn: runtimeAdapters.finalizeTurn,
    onTurnReconnectPending: runtimeAdapters.onTurnReconnectPending,
    onTurnCreated: async (tracker) => {
      await turnRecoveryStore.upsertTurnFromTracker(tracker);
    },
    onTurnAborted: async (threadId, tracker) => {
      await turnRecoveryStore.removeTurn(threadId, {
        status: "cancelled",
        errorMessage: tracker?.failureMessage ?? null
      });
    },
      onActiveTurnsChanged: () => runtimeContainer.getRef("runtimeOps")?.writeHeartbeatFile()
    })
  );

  return {
    fs,
    path,
    discord,
    codex,
    safeReply,
    safeSendToChannel,
    safeAddReaction,
    fetchChannelByRouteId,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    runtimeContainer,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
  };
}

async function createDiscordClient() {
  const { Client, GatewayIntentBits } = await import("discord.js");
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
  });
}

function createDisabledDiscordClient() {
  const client = new EventEmitter();
  client.channels = {
    fetch: async () => null
  };
  client.application = null;
  client.user = null;
  client.isReady = () => false;
  client.login = async () => null;
  client.destroy = () => {};
  return client;
}
