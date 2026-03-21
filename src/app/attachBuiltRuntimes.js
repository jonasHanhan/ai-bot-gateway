import { buildBridgeRuntimes } from "./buildRuntimes.js";
import { isDiscordMissingPermissionsError, waitForDiscordReady } from "./runtimeUtils.js";

export async function attachBuiltRuntimes(params) {
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
    runtimeContainer
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
    processStartedAt,
    discordToken,
    fetchChannelByRouteId
  } = context;

  const {
    bootstrapChannelMappings,
    registerSlashCommands,
    backendRuntime,
    platformRegistry,
    feishuRuntime,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime
  } = await buildBridgeRuntimes({
    runtimeContext: {
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
    },
    runtimeEnv,
    channelSetupStore: {
      getChannelSetups,
      setChannelSetups
    },
    runtimeServices: {
      runtimeAdapters,
      safeReply,
      safeSendToChannel,
      debugLog,
      turnRecoveryStore,
      createApprovalToken,
      sendChunkedToChannel: runtimeAdapters.sendChunkedToChannel
    },
    ioRuntime: {
      waitForDiscordReady,
      isDiscordMissingPermissionsError
    }
  });

  runtimeContainer.setRef("notificationRuntime", notificationRuntime);
  runtimeContainer.setRef("serverRequestRuntime", serverRequestRuntime);
  runtimeContainer.setRef("discordRuntime", discordRuntime);
  runtimeContainer.setRef("platformRegistry", platformRegistry);
  runtimeContainer.setRef("backendRuntime", backendRuntime);
  runtimeContainer.setRef("feishuRuntime", feishuRuntime);

  return { bootstrapChannelMappings, registerSlashCommands, backendRuntime, feishuRuntime, platformRegistry };
}
