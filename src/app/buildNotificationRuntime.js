import { normalizeCodexNotification } from "../codex/notificationMapper.js";
import { extractAgentMessageText, isTransientReconnectErrorMessage } from "../codex/eventUtils.js";
import { sanitizeSummaryForDiscord, truncateForDiscordMessage } from "../render/messageRenderer.js";
import { TURN_PHASE, transitionTurnPhase } from "../turns/lifecycle.js";
import { createNotificationRuntime } from "../turns/notificationRuntime.js";
import { buildFileDiffSection, recordFileChanges, truncateStatusText } from "../turns/turnFormatting.js";
import { normalizeFinalSummaryText } from "../turns/textNormalization.js";

export function buildNotificationRuntime(deps) {
  const {
    activeTurns,
    renderVerbosity = "user",
    runtimeAdapters,
    safeSendToChannel,
    safeAddReaction,
    feishuStatusReactions,
    debugLog,
    turnRecoveryStore,
    sendChunkedToChannel,
    discordMaxMessageLength = 1900,
    feishuMaxMessageLength = 8000,
    disableStreamingOutput = false,
    feishuSegmentedStreaming = false,
    feishuStreamMinChars = 80
  } = deps;

  return createNotificationRuntime({
    activeTurns,
    renderVerbosity,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendAttachmentsForItem: runtimeAdapters.maybeSendAttachmentsForItem,
    maybeSendInferredAttachmentsFromText: runtimeAdapters.maybeSendInferredAttachmentsFromText,
    recordFileChanges,
    buildFileDiffSection,
    sanitizeSummaryForDiscord,
    sendChunkedToChannel,
    normalizeFinalSummaryText,
    truncateStatusText,
    isTransientReconnectErrorMessage,
    safeSendToChannel,
    safeAddReaction,
    feishuStatusReactions,
    truncateForDiscordMessage,
    discordMaxMessageLength,
    feishuMaxMessageLength,
    disableStreamingOutput,
    feishuSegmentedStreaming,
    feishuStreamMinChars,
    debugLog,
    writeHeartbeatFile: runtimeAdapters.writeHeartbeatFile,
    onTurnFinalized: async (tracker) => {
      await turnRecoveryStore.removeTurn(tracker?.threadId, {
        status: tracker?.failed ? "failed" : "done",
        errorMessage: tracker?.failed ? tracker?.failureMessage ?? null : null
      });
    }
  });
}
