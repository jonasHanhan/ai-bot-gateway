import { normalizeCodexNotification } from "../codex/notificationMapper.js";
import { extractAgentMessageText, isTransientReconnectErrorMessage } from "../codex/eventUtils.js";
import { buildTurnRenderPlan, truncateForDiscordMessage } from "../render/messageRenderer.js";
import { TURN_PHASE, transitionTurnPhase } from "../turns/lifecycle.js";
import { createNotificationRuntime } from "../turns/notificationRuntime.js";
import {
  buildFileDiffSection,
  extractWebSearchDetails,
  recordFileChanges,
  summarizeItemForStatus,
  truncateStatusText
} from "../turns/turnFormatting.js";
import { normalizeFinalSummaryText } from "../turns/textNormalization.js";

export function buildNotificationRuntime(deps) {
  const { activeTurns, renderVerbosity, runtimeAdapters, safeSendToChannel, debugLog, turnRecoveryStore, sendChunkedToChannel } = deps;

  return createNotificationRuntime({
    activeTurns,
    renderVerbosity,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendAttachmentsForItem: runtimeAdapters.maybeSendAttachmentsForItem,
    recordFileChanges,
    summarizeItemForStatus,
    extractWebSearchDetails,
    buildFileDiffSection,
    buildTurnRenderPlan,
    sendChunkedToChannel,
    normalizeFinalSummaryText,
    truncateStatusText,
    isTransientReconnectErrorMessage,
    safeSendToChannel,
    truncateForDiscordMessage,
    discordMaxMessageLength: 1900,
    debugLog,
    writeHeartbeatFile: runtimeAdapters.writeHeartbeatFile,
    onTurnFinalized: async (tracker) => {
      await turnRecoveryStore.removeTurn(tracker?.threadId);
    }
  });
}
