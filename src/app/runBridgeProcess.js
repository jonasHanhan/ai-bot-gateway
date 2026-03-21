import { createShutdownHandler } from "./shutdown.js";
import { registerShutdownSignals } from "./signalHandlers.js";
import { startBridgeRuntime } from "./startup.js";
import { wireBridgeListeners } from "./wireListeners.js";
import { createRuntimeOpsContext } from "./createRuntimeOpsContext.js";
import { attachBuiltRuntimes } from "./attachBuiltRuntimes.js";
import { registerRuntimeErrorGuards } from "./runtimeErrorGuards.js";

function logRuntimeSnapshot(runtimeContainer, event) {
  console.info(
    `[runtime] event=${event} phase=${runtimeContainer.getPhase()} snapshot=${JSON.stringify(runtimeContainer.snapshot())}`
  );
}

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
    runtimeContainer,
    runtimeAdapters,
    turnRecoveryStore,
    createApprovalToken
  } = context;
  const { generalChannelCwd } = runtimeEnv;

  runtimeContainer.setRef(
    "runtimeOps",
    createRuntimeOpsContext({
    fs,
    path,
    debugLog,
    activeTurns,
    pendingApprovals,
    processStartedAt,
    safeReply,
    safeSendToChannel,
    fetchChannelByRouteId,
      runtimeContainer,
    runtimeEnv
    })
  );

  const { backendRuntime, platformRegistry } = await attachBuiltRuntimes({
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
  });
  runtimeContainer.assertInitialized([
    "turnRunner",
    "runtimeOps",
    "notificationRuntime",
    "serverRequestRuntime",
    "discordRuntime",
    "platformRegistry",
    "backendRuntime",
    "feishuRuntime"
  ]);
  runtimeContainer.transitionTo(runtimeContainer.RuntimePhase.RUNTIMES_ATTACHED);
  logRuntimeSnapshot(runtimeContainer, "runtimes_attached");

  wireBridgeListeners({
    codex,
    discord,
    handleNotification: runtimeAdapters.handleNotification,
    handleServerRequest: runtimeAdapters.handleServerRequest,
    handleChannelCreate: runtimeAdapters.handleChannelCreate,
    handleMessage: runtimeAdapters.handleMessage,
    handleInteraction: runtimeAdapters.handleInteraction
  });

  const shutdownImpl = createShutdownHandler({
    codex,
    discord,
    stopBackendRuntime: () => backendRuntime?.stop?.(),
    stopPlatformRuntimes: () => platformRegistry?.stop?.(),
    stopHeartbeatLoop: () => runtimeContainer.requireRef("runtimeOps").stopHeartbeatLoop()
  });
  runtimeContainer.setRef("shutdown", async (exitCode, metadata = {}) => {
    if (runtimeContainer.getPhase() !== runtimeContainer.RuntimePhase.SHUTTING_DOWN) {
      runtimeContainer.transitionTo(runtimeContainer.RuntimePhase.SHUTTING_DOWN);
      logRuntimeSnapshot(runtimeContainer, "shutting_down");
    }
    await runtimeContainer
      .requireRef("runtimeOps")
      .recordShutdown({
        exitCode,
        ...(metadata && typeof metadata === "object" ? metadata : {})
      });
    await shutdownImpl(exitCode);
  });
  registerRuntimeErrorGuards({
    shutdown: runtimeContainer.requireRef("shutdown")
  });
  await startBridgeRuntime({
    codex,
    fs,
    generalChannelCwd,
    platformRegistry,
    maybeCompletePendingRestartNotice: runtimeAdapters.maybeCompletePendingRestartNotice,
    announceStartup: runtimeAdapters.announceStartup,
    turnRecoveryStore,
    safeSendToChannel,
    fetchChannelByRouteId,
    startBackendRuntime: () => backendRuntime?.start?.(),
    setBackendReady: (value) => backendRuntime?.setReady?.(value),
    getMappedChannelCount: () => Object.keys(getChannelSetups()).length,
    startHeartbeatLoop: runtimeAdapters.startHeartbeatLoop
  });
  runtimeContainer.transitionTo(runtimeContainer.RuntimePhase.READY);
  logRuntimeSnapshot(runtimeContainer, "ready");

  registerShutdownSignals(runtimeContainer.requireRef("shutdown"));
}
