import { createShutdownHandler } from "./shutdown.js";
import { registerShutdownSignals } from "./signalHandlers.js";
import { startBridgeRuntime } from "./startup.js";
import { wireBridgeListeners } from "./wireListeners.js";
import { createRuntimeOpsContext } from "./createRuntimeOpsContext.js";
import { attachBuiltRuntimes } from "./attachBuiltRuntimes.js";
import { registerRuntimeErrorGuards } from "./runtimeErrorGuards.js";

export async function runBridgeProcess(context) {
  const {
    fs,
    path,
    runtimeEnv,
    debugLog,
    getChannelSetups,
    setChannelSetups,
    discord,
    codex,
    safeReply,
    safeSendToChannel,
    fetchChannelByRouteId,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    refs,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
  } = context;
  const { generalChannelCwd } = runtimeEnv;

  wireBridgeListeners({
    codex,
    discord,
    handleNotification: runtimeAdapters.handleNotification,
    handleServerRequest: runtimeAdapters.handleServerRequest,
    handleChannelCreate: runtimeAdapters.handleChannelCreate,
    handleMessage: runtimeAdapters.handleMessage,
    handleInteraction: runtimeAdapters.handleInteraction
  });

  refs.runtimeOps = createRuntimeOpsContext({
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    safeReply,
    safeSendToChannel,
    fetchChannelByRouteId,
    refs,
    runtimeEnv
  });

  const { backendRuntime, platformRegistry } = attachBuiltRuntimes({
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
  });

  refs.shutdown = createShutdownHandler({
    codex,
    discord,
    stopBackendRuntime: () => backendRuntime?.stop?.(),
    stopPlatformRuntimes: () => platformRegistry?.stop?.(),
    stopHeartbeatLoop: () => refs.runtimeOps?.stopHeartbeatLoop()
  });
  registerRuntimeErrorGuards({
    shutdown: refs.shutdown
  });
  await startBridgeRuntime({
    codex,
    fs,
    generalChannelCwd,
    platformRegistry,
    maybeCompletePendingRestartNotice: runtimeAdapters.maybeCompletePendingRestartNotice,
    turnRecoveryStore,
    safeSendToChannel,
    fetchChannelByRouteId,
    startBackendRuntime: () => backendRuntime?.start?.(),
    setBackendReady: (value) => backendRuntime?.setReady?.(value),
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    startHeartbeatLoop: runtimeAdapters.startHeartbeatLoop
  });

  registerShutdownSignals(refs.shutdown);
}
