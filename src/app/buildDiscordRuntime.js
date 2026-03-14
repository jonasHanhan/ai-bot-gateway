import { resolveRepoContext } from "../channels/context.js";
import { buildCommandTextFromInteraction, syncSlashCommands } from "../commands/slashCommands.js";
import { parseApprovalButtonCustomId } from "../codex/approvalPayloads.js";
import { createDiscordRuntime } from "./discordRuntime.js";

export function buildDiscordRuntime(deps) {
  const {
    ChannelType,
    MessageFlags,
    discord,
    config,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    projectsCategoryName,
    managedChannelTopicPrefix,
    runManagedRouteCommand,
    runtimeAdapters,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand,
    approvalButtonPrefix,
    pendingApprovals,
    safeReply
  } = deps;

  return createDiscordRuntime({
    ChannelType,
    discord,
    config,
    resolveRepoContext,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    getChannelSetups,
    projectsCategoryName,
    managedChannelTopicPrefix,
    runManagedRouteCommand,
    shouldHandleAsSelfRestartRequest: runtimeAdapters.shouldHandleAsSelfRestartRequest,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand,
    buildCommandTextFromInteraction,
    registerSlashCommands: async () => await syncSlashCommands({ discord }),
    parseApprovalButtonCustomId,
    approvalButtonPrefix,
    pendingApprovals,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    MessageFlags
  });
}
