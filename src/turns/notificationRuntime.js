export function createNotificationRuntime(deps) {
  const {
    activeTurns,
    renderVerbosity,
    TURN_PHASE,
    transitionTurnPhase,
    normalizeCodexNotification,
    extractAgentMessageText,
    maybeSendAttachmentsForItem,
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
    discordMaxMessageLength,
    debugLog,
    writeHeartbeatFile,
    onTurnFinalized
  } = deps;

  async function handleNotification({ method, params }) {
    const normalized = normalizeCodexNotification({ method, params });

    if (normalized.kind === "agent_delta") {
      const threadId = normalized.threadId;
      const delta = normalized.delta;
      if (!threadId || !delta) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      debugLog("item-delta", "agent delta", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        deltaLength: delta.length
      });
      appendTrackerText(tracker, delta, { fromDelta: true });
      return;
    }

    if (normalized.kind === "item_lifecycle") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      const tracker = activeTurns.get(threadId);
      if (!tracker) {
        return;
      }
      const item = normalized.item;
      const state = normalized.state;
      if (state === "started") {
        transitionTurnPhase(tracker, TURN_PHASE.RUNNING);
      }
      debugLog("item-event", "item lifecycle", {
        threadId,
        turnId: threadId,
        discordMessageId: tracker.statusMessageId ?? null,
        state,
        itemType: item?.type,
        itemId: item?.id ?? null
      });

      if (item?.type === "fileChange" && method === "item/completed") {
        recordFileChanges(tracker, item);
      }

      if (shouldAnnounceStatusItem(item?.type, renderVerbosity)) {
        const statusLine = recordItemStatusLine(item, state);
        if (statusLine) {
          const statusMessage = await sendStatusUpdateLine(tracker, statusLine);
          if (statusMessage) {
            const key = makeItemStatusKey(item);
            if (key) {
              tracker.itemStatusMessages.set(key, statusMessage.id);
              const pendingEmoji = tracker.pendingCompletionReactions?.get(key);
              if (pendingEmoji) {
                tracker.pendingCompletionReactions.delete(key);
                await reactToStatusMessage(tracker, statusMessage.id, key, pendingEmoji);
              }
            }
          }
        } else if (state === "completed" && shouldReactOnCompletion(item?.type)) {
          await reactToStatusCompletion(tracker, item);
        }
      }

      if (state === "completed") {
        await maybeSendAttachmentsForItem(tracker, item);
      }

      if (state === "started") {
        return;
      }

      const messageText = extractAgentMessageText(item);
      if (!messageText) {
        return;
      }
      if (tracker.seenDelta || tracker.fullText.length > 0) {
        return;
      }
      appendTrackerText(tracker, messageText, { fromDelta: false });
      return;
    }

    if (normalized.kind === "turn_completed") {
      const threadId = normalized.threadId;
      if (!threadId) {
        return;
      }
      await finalizeTurn(threadId, null);
      return;
    }

    if (normalized.kind === "error") {
      const threadId = normalized.threadId;
      const message = normalized.errorMessage;
      if (threadId) {
        const tracker = activeTurns.get(threadId);
        if (tracker && isTransientReconnectErrorMessage(message)) {
          markTurnReconnecting(tracker, "🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...");
          debugLog("transport", "transient reconnect while turn active", {
            threadId,
            turnId: threadId,
            discordMessageId: tracker.statusMessageId ?? null,
            message: truncateStatusText(String(message ?? ""), 200)
          });
          return;
        }
        await finalizeTurn(threadId, new Error(message));
      }
    }
  }

  function onTurnReconnectPending(threadId, context = {}) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    const attempt = Number.isFinite(Number(context.attempt)) ? Number(context.attempt) : 1;
    const suffix = attempt > 1 ? ` (retry ${attempt})` : "";
    markTurnReconnecting(
      tracker,
      `🔄 Temporary reconnect while processing. Continuing automatically while connection recovers...${suffix}`
    );
  }

  function scheduleFlush(tracker) {
    if (tracker.flushTimer) {
      return;
    }
    const elapsed = Date.now() - tracker.lastFlushAt;
    const delay = Math.max(0, 1200 - elapsed);
    tracker.flushTimer = setTimeout(() => {
      tracker.flushTimer = null;
      void flushTrackerParagraphs(tracker, { force: false });
    }, delay);
  }

  async function flushTrackerParagraphs(tracker, { force }) {
    if (!force && !activeTurns.has(tracker.threadId)) {
      return;
    }
    const content = buildTrackerMessageContent(tracker);
    await editTrackerMessage(tracker, content);
    tracker.lastFlushAt = Date.now();
  }

  async function finalizeTurn(threadId, error) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }
    if (tracker.finalizing) {
      return;
    }
    if (!transitionTurnPhase(tracker, TURN_PHASE.FINALIZING)) {
      return;
    }
    tracker.finalizing = true;

    if (tracker.flushTimer) {
      clearTimeout(tracker.flushTimer);
      tracker.flushTimer = null;
    }

    try {
      if (error) {
        tracker.failed = true;
        tracker.completed = true;
        tracker.failureMessage = error.message;
        transitionTurnPhase(tracker, TURN_PHASE.FAILED);
        if (isTransientReconnectErrorMessage(error.message)) {
          pushStatusLine(
            tracker,
            "🔄 Temporary reconnect while processing did not recover in time. Please retry."
          );
        } else {
          pushStatusLine(tracker, `❌ Error: ${truncateStatusText(error.message, 220)}`);
        }
        await flushTrackerParagraphs(tracker, { force: true });
        tracker.reject(error);
        return;
      }

      tracker.completed = true;
      transitionTurnPhase(tracker, TURN_PHASE.DONE);
      pushStatusLine(tracker, "👍 Tool calling done");
      await flushTrackerParagraphs(tracker, { force: true });

      tracker.fullText = normalizeFinalSummaryText(tracker.fullText);
      const diffBlock = buildFileDiffSection(tracker);
      const renderPlan = buildTurnRenderPlan({
        summaryText: tracker.fullText,
        diffBlock,
        verbosity: renderVerbosity
      });
      if (renderPlan.primaryMessage) {
        await sendChunkedToChannel(tracker.channel, renderPlan.primaryMessage);
      }
      for (const statusMessage of renderPlan.statusMessages) {
        await sendChunkedToChannel(tracker.channel, statusMessage);
      }

      tracker.resolve(tracker.fullText);
    } finally {
      activeTurns.delete(threadId);
      await onTurnFinalized?.(tracker);
      await writeHeartbeatFile();
    }
  }

  function markTurnReconnecting(tracker, line) {
    if (!tracker) {
      return;
    }
    transitionTurnPhase(tracker, TURN_PHASE.RECONNECTING);
    pushStatusLine(tracker, line);
    scheduleFlush(tracker);
  }

  function appendTrackerText(tracker, text, { fromDelta }) {
    if (!text) {
      return;
    }
    tracker.fullText += text;
    if (fromDelta) {
      tracker.seenDelta = true;
    }
  }

  function shouldAnnounceStatusItem(itemType, verbosity = "user") {
    if (typeof itemType !== "string" || !itemType) {
      return false;
    }
    let announced;
    if (verbosity === "debug") {
      announced = new Set([
        "commandExecution",
        "mcpToolCall",
        "webSearch",
        "imageView",
        "contextCompaction",
        "collabAgentToolCall",
        "toolCall"
      ]);
    } else if (verbosity === "ops") {
      announced = new Set(["commandExecution", "mcpToolCall", "webSearch", "imageView", "toolCall"]);
    } else {
      announced = new Set(["imageView"]);
    }
    return announced.has(itemType);
  }

  function recordItemStatusLine(item, state) {
    if (!item || typeof item !== "object") {
      return null;
    }
    const lines = summarizeItemForStatus(item, state);
    if (lines.length === 0) {
      return null;
    }
    return lines[lines.length - 1];
  }

  async function sendStatusUpdateLine(tracker, line) {
    if (!tracker?.channel || typeof line !== "string" || !line.trim()) {
      return null;
    }
    const normalized = line.trim();
    if (tracker.lastStatusUpdateLine === normalized) {
      return null;
    }
    tracker.lastStatusUpdateLine = normalized;
    const message = await safeSendToChannel(tracker.channel, normalized);
    debugLog("status", "status line sent", {
      threadId: tracker.threadId,
      turnId: tracker.threadId,
      discordMessageId: tracker.statusMessageId ?? null,
      line: normalized
    });
    return message;
  }

  function makeItemStatusKey(item) {
    if (!item || typeof item !== "object") {
      return "";
    }
    if (item.id !== undefined && item.id !== null) {
      const id = String(item.id);
      if (id) {
        return `id:${id}`;
      }
    }
    if (item.type === "commandExecution" && typeof item.command === "string" && item.command) {
      return `cmd:${item.command}`;
    }
    if (item.type === "webSearch") {
      const queries = extractWebSearchDetails(item);
      if (queries.length > 0) {
        return `search:${queries[0]}`;
      }
    }
    return "";
  }

  function shouldReactOnCompletion(itemType) {
    return itemType === "commandExecution" || itemType === "webSearch";
  }

  async function reactToStatusCompletion(tracker, item) {
    const key = makeItemStatusKey(item);
    if (!key) {
      return;
    }
    const emoji = completionReactionEmoji(item);
    if (!emoji) {
      return;
    }
    const messageId = tracker.itemStatusMessages.get(key);
    if (!messageId) {
      tracker.pendingCompletionReactions?.set(key, emoji);
      return;
    }
    await reactToStatusMessage(tracker, messageId, key, emoji);
  }

  function completionReactionEmoji(item) {
    if (!item || typeof item !== "object") {
      return null;
    }
    if (item.type === "commandExecution") {
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      if (exitCode === 0) {
        return "✅";
      }
      if (exitCode !== null) {
        return "❌";
      }
      return "✅";
    }
    if (item.type === "webSearch") {
      return "✅";
    }
    return null;
  }

  async function reactToStatusMessage(tracker, messageId, key, emoji) {
    if (!tracker.channel?.isTextBased?.()) {
      return;
    }
    try {
      const message = await tracker.channel.messages.fetch(messageId);
      if (message) {
        await message.react(emoji);
      }
    } catch (error) {
    debugLog("status", "completion reaction failed", {
      threadId: tracker.threadId,
      turnId: tracker.threadId,
      discordMessageId: tracker.statusMessageId ?? null,
      key,
      emoji,
      error: String(error?.message ?? error)
      });
    }
  }

  function pushStatusLine(tracker, line) {
    if (!tracker || typeof line !== "string") {
      return;
    }
    const normalized = line.trim();
    if (!normalized) {
      return;
    }
    if (tracker.currentStatusLine === normalized) {
      return;
    }
    tracker.currentStatusLine = normalized;
  }

  function buildTrackerMessageContent(tracker) {
    return truncateForDiscordMessage(tracker.currentStatusLine || "⏳ Thinking...", discordMaxMessageLength);
  }

  async function editTrackerMessage(tracker, content) {
    if (!tracker?.channel || !content) {
      return;
    }
    if (tracker.lastRenderedContent === content) {
      return;
    }
    const payload = truncateForDiscordMessage(content, discordMaxMessageLength);
    try {
      if (tracker.statusMessage) {
        await tracker.statusMessage.edit(payload);
        tracker.lastRenderedContent = payload;
        debugLog("render", "edited status message", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId
        });
        return;
      }
    } catch (error) {
      debugLog("render", "direct edit failed", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        messageId: tracker.statusMessageId,
        error: String(error?.message ?? error)
      });
    }

    if (tracker.statusMessageId && tracker.channel?.isTextBased?.()) {
      try {
        const fetched = await tracker.channel.messages.fetch(tracker.statusMessageId);
        if (fetched) {
          await fetched.edit(payload);
          tracker.statusMessage = fetched;
          tracker.lastRenderedContent = payload;
          debugLog("render", "fetched and edited status message", {
            threadId: tracker.threadId,
            turnId: tracker.threadId,
            messageId: tracker.statusMessageId
          });
          return;
        }
      } catch (error) {
        debugLog("render", "fetch/edit fallback failed", {
          threadId: tracker.threadId,
          turnId: tracker.threadId,
          messageId: tracker.statusMessageId,
          error: String(error?.message ?? error)
        });
      }
    }

    const replacement = await safeSendToChannel(tracker.channel, payload);
    if (replacement) {
      const previousDiscordMessageId = tracker.statusMessageId ?? null;
      tracker.statusMessage = replacement;
      tracker.statusMessageId = replacement.id;
      tracker.lastRenderedContent = payload;
      debugLog("render", "sent replacement status message", {
        threadId: tracker.threadId,
        turnId: tracker.threadId,
        previousDiscordMessageId,
        messageId: replacement.id
      });
    }
  }

  return {
    handleNotification,
    finalizeTurn,
    onTurnReconnectPending
  };
}
