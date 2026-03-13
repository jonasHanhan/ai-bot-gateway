import { buildCommandRuntime } from "./buildCommandRuntime.js";
import { buildBackendRuntime } from "./buildBackendRuntime.js";
import { buildNotificationRuntime } from "./buildNotificationRuntime.js";
import { buildApprovalRuntime } from "./buildApprovalRuntime.js";
import { buildDiscordRuntime } from "./buildDiscordRuntime.js";
import { buildFeishuRuntime } from "./buildFeishuRuntime.js";
import { createPlatformRegistry } from "../platforms/platformRegistry.js";
import { createDiscordPlatform } from "../platforms/discordPlatform.js";
import { createFeishuPlatform } from "../platforms/feishuPlatform.js";

export function buildBridgeRuntimes(deps) {
  const {
    ChannelType,
    MessageFlags,
    path,
    fs,
    execFileAsync,
    discord,
    fetchChannelByRouteId,
    processStartedAt,
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
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
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
    feishuRequireMentionInGroup,
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

  let platformRegistry = null;
  const getPlatformRegistry = () => platformRegistry;

  const {
    bootstrapChannelMappings,
    getHelpText,
    isCommandSupportedForPlatform,
    runManagedRouteCommand,
    handleCommand,
    handleInitRepoCommand,
    handleSetPathCommand,
    handleMakeChannelCommand,
    handleBindCommand,
    handleUnbindCommand
  } = buildCommandRuntime({
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
    getPlatformRegistry
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
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    safeSendToChannel,
    createApprovalToken,
    fetchChannelByRouteId
  });

  const discordRuntime = buildDiscordRuntime({
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
  });

  const feishuRuntime = buildFeishuRuntime({
    config,
    runtimeEnv: {
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
      feishuRequireMentionInGroup
    },
    getChannelSetups,
    bootstrapChannelMappings,
    runManagedRouteCommand,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleSetPathCommand,
    runtimeAdapters,
    safeReply
  });

  platformRegistry = createPlatformRegistry([
    createDiscordPlatform({
      discord,
      discordToken: deps.discordToken,
      waitForDiscordReady,
      runtime: discordRuntime,
      bootstrapChannelMappings
    }),
    createFeishuPlatform({
      runtime: feishuRuntime
    })
  ]);

  const backendRuntime = buildBackendRuntime({
    enabled: backendHttpEnabled,
    host: backendHttpHost,
    port: backendHttpPort,
    processStartedAt,
    activeTurns,
    pendingApprovals,
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    platformRegistry
  });

  return {
    bootstrapChannelMappings,
    registerSlashCommands: discordRuntime.registerSlashCommands,
    backendRuntime,
    platformRegistry,
    feishuRuntime,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  };
}
