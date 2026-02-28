import { buildCommandRuntime } from "./buildCommandRuntime.js";
import { buildNotificationRuntime } from "./buildNotificationRuntime.js";
import { buildApprovalRuntime } from "./buildApprovalRuntime.js";
import { buildDiscordRuntime } from "./buildDiscordRuntime.js";

export function buildBridgeRuntimes(deps) {
  const {
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    projectsCategoryName,
    managedChannelTopicPrefix,
    managedThreadTopicPrefix,
    repoRootPath,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    renderVerbosity,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    sendChunkedToChannel
  } = deps;

  const { bootstrapChannelMappings, handleCommand, handleInitRepoCommand } = buildCommandRuntime({
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
    repoRootPath,
    managedThreadTopicPrefix,
    managedChannelTopicPrefix,
    codexBin,
    codexHomeEnv,
    statePath,
    configPath,
    isDiscordMissingPermissionsError,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
  });

  const notificationRuntime = buildNotificationRuntime({
    activeTurns,
    renderVerbosity,
    runtimeAdapters,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    sendChunkedToChannel,
  });

  const serverRequestRuntime = buildApprovalRuntime({
    codex,
    discord,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    safeSendToChannel,
    createApprovalToken
  });

  const discordRuntime = buildDiscordRuntime({
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
    safeReply,
  });

  return {
    bootstrapChannelMappings,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  };
}
