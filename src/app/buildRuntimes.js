import { buildCommandRuntime } from "./buildCommandRuntime.js";
import { buildBackendRuntime } from "./buildBackendRuntime.js";
import { buildNotificationRuntime } from "./buildNotificationRuntime.js";
import { buildApprovalRuntime } from "./buildApprovalRuntime.js";
import { createPlatformRegistry } from "../platforms/platformRegistry.js";
import { DISCORD_CHANNEL_TYPES, DISCORD_MESSAGE_FLAGS } from "../discord/constants.js";

export async function buildBridgeRuntimes(deps) {
  const {
    runtimeContext,
    runtimeEnv,
    runtimeServices,
    channelSetupStore,
    ioRuntime
  } = deps;
  const {
    path,
    fs,
    execFileAsync,
    discord,
    discordToken,
    fetchChannelByRouteId,
    processStartedAt,
    codex,
    config,
    state,
    activeTurns,
    pendingApprovals
  } = runtimeContext;
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
    discordMessageChunkLimit,
    feishuMessageChunkLimit,
    backendHttpEnabled,
    backendHttpHost,
    backendHttpPort,
    generalChannelId,
    generalChannelName,
    generalChannelCwd,
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
    feishuEventDedupeTtlMs,
    feishuEventDedupePath,
    feishuStatusReactions
  } = runtimeEnv;
  const { getChannelSetups, setChannelSetups } = channelSetupStore;
  const {
    runtimeAdapters,
    safeReply,
    safeSendToChannel,
    safeAddReaction,
    debugLog,
    turnRecoveryStore,
    createApprovalToken,
    sendChunkedToChannel
  } = runtimeServices;
  const { waitForDiscordReady, isDiscordMissingPermissionsError } = ioRuntime;

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
    ChannelType: DISCORD_CHANNEL_TYPES,
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
    disableStreamingOutput,
    discordMaxMessageLength: discordMessageChunkLimit,
    feishuMaxMessageLength: feishuMessageChunkLimit,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    runtimeAdapters,
    safeSendToChannel,
    safeAddReaction,
    feishuStatusReactions,
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

  let discordRuntime = createDisabledDiscordRuntime();
  let feishuRuntime = createDisabledFeishuRuntime({ feishuTransport, feishuWebhookPath });
  const platforms = [];

  if (discordToken) {
    const [{ buildDiscordRuntime }, { createDiscordPlatform }] = await Promise.all([
      import("./buildDiscordRuntime.js"),
      import("../platforms/discordPlatform.js")
    ]);
    discordRuntime = buildDiscordRuntime({
      ChannelType: DISCORD_CHANNEL_TYPES,
      MessageFlags: DISCORD_MESSAGE_FLAGS,
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
    platforms.push(
      createDiscordPlatform({
        discord,
        discordToken,
        waitForDiscordReady,
        runtime: discordRuntime,
        bootstrapChannelMappings
      })
    );
  }

  if (feishuEnabled) {
    const [{ buildFeishuRuntime }, { createFeishuPlatform }] = await Promise.all([
      import("./buildFeishuRuntime.js"),
      import("../platforms/feishuPlatform.js")
    ]);
    feishuRuntime = buildFeishuRuntime({
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
        feishuUnboundChatMode,
        feishuUnboundChatCwd,
        feishuRequireMentionInGroup,
        feishuSegmentedStreaming,
        feishuStreamMinChars,
        feishuEventDedupeTtlMs,
        feishuEventDedupePath
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
    platforms.push(
      createFeishuPlatform({
        runtime: feishuRuntime
      })
    );
  }

  platformRegistry = createPlatformRegistry(platforms);

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

function createDisabledDiscordRuntime() {
  return {
    handleMessage: async () => {},
    handleInteraction: async () => {},
    handleChannelCreate: async () => {},
    registerSlashCommands: async () => null
  };
}

function createDisabledFeishuRuntime({ feishuTransport = null, feishuWebhookPath = "" } = {}) {
  return {
    enabled: false,
    transport: feishuTransport,
    webhookPath: feishuWebhookPath,
    fetchChannelByRouteId: async () => null,
    handleHttpRequest: async () => {},
    start: async () => ({ started: false }),
    stop: async () => ({ platformId: "feishu", stopped: false })
  };
}
