import { createBootstrapService } from "../channels/bootstrapService.js";
import { isGeneralChannel } from "../channels/context.js";
import { createCommandRouter } from "../commands/router.js";

export function buildCommandRuntime(deps) {
  const {
    ChannelType,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    pendingApprovals,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply
  } = deps;

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
    getChannelSetups,
    setChannelSetups
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
    collectImageAttachments: runtimeAdapters.collectImageAttachments,
    buildTurnInputFromMessage: runtimeAdapters.buildTurnInputFromMessage,
    enqueuePrompt: runtimeAdapters.enqueuePrompt,
    getQueue: runtimeAdapters.getQueue,
    findActiveTurnByRepoChannel: runtimeAdapters.findActiveTurnByRepoChannel,
    requestSelfRestartFromDiscord: runtimeAdapters.requestSelfRestartFromDiscord,
    findLatestPendingApprovalTokenForChannel: runtimeAdapters.findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision: runtimeAdapters.applyApprovalDecision,
    safeReply,
    getChannelSetups,
    setChannelSetups
  });
  const { handleCommand, handleInitRepoCommand } = commandRouter;

  return {
    bootstrapChannelMappings,
    handleCommand,
    handleInitRepoCommand
  };
}
