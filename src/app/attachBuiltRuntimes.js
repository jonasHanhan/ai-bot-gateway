import { ChannelType, MessageFlags } from "discord.js";
import { buildBridgeRuntimes } from "./buildRuntimes.js";
import { isDiscordMissingPermissionsError, waitForDiscordReady } from "./runtimeUtils.js";

export function attachBuiltRuntimes(params) {
  const {
    context,
    runtimeEnv,
    getChannelSetups,
    setChannelSetups,
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    refs
  } = params;
  const {
    path,
    fs,
    execFileAsync,
    discord,
    codex,
    config,
    state,
    activeTurns,
    pendingApprovals,
    processStartedAt
  } = context;
  const {
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
    disableStreamingOutput,
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
    imageCacheDir,
    feishuGeneralChatId,
    feishuGeneralCwd,
    feishuUnboundChatMode,
    feishuUnboundChatCwd,
    feishuRequireMentionInGroup,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    generalChannelId,
    generalChannelName,
    generalChannelCwd
  } = runtimeEnv;

  const {
    bootstrapChannelMappings,
    registerSlashCommands,
    backendRuntime,
    platformRegistry,
    feishuRuntime,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  } = buildBridgeRuntimes({
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    discordToken: context.discordToken,
    codex,
    fetchChannelByRouteId: context.fetchChannelByRouteId,
    processStartedAt,
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
    disableStreamingOutput,
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    waitForDiscordReady,
    feishuEnabled,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuTransport,
    feishuPort,
    feishuHost,
    feishuWebhookPath,
    imageCacheDir,
    feishuGeneralChatId,
    feishuGeneralCwd,
    feishuUnboundChatMode,
    feishuUnboundChatCwd,
    feishuRequireMentionInGroup,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
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
    sendChunkedToChannel: runtimeAdapters.sendChunkedToChannel
  });

  refs.notificationRuntime = notificationRuntime;
  refs.serverRequestRuntime = serverRequestRuntime;
  refs.discordRuntime = discordRuntime;
  refs.platformRegistry = platformRegistry;
  refs.backendRuntime = backendRuntime;
  refs.feishuRuntime = feishuRuntime;

  return { bootstrapChannelMappings, registerSlashCommands, backendRuntime, feishuRuntime, platformRegistry };
}
