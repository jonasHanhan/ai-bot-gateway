import { resolveRepoContext } from "../channels/context.js";
import { parseApprovalButtonCustomId } from "../codex/approvalPayloads.js";
import { createDiscordRuntime } from "./discordRuntime.js";

export function buildDiscordRuntime(deps) {
  const {
    MessageFlags,
    discord,
    config,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    bootstrapChannelMappings,
    runtimeAdapters,
    handleCommand,
    handleInitRepoCommand,
    approvalButtonPrefix,
    pendingApprovals,
    safeReply
  } = deps;

  return createDiscordRuntime({
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    bootstrapChannelMappings,
    shouldHandleAsSelfRestartRequest: runtimeAdapters.shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    handleCommand,
    handleInitRepoCommand,
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    MessageFlags
  });
}
