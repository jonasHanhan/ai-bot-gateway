import path from "node:path";
import { TURN_PHASE } from "../turns/lifecycle.js";

export function createTurnRunner(deps) {
  const {
    queues,
    activeTurns,
    state,
    codex,
    config,
    safeReply,
    buildSandboxPolicyForTurn,
    isThreadNotFoundError,
    finalizeTurn,
    onActiveTurnsChanged,
    onTurnReconnectPending,
    onTurnCreated,
    onTurnAborted
  } = deps;

  function enqueuePrompt(repoChannelId, job) {
    const queue = getQueue(repoChannelId);
    queue.jobs.push(job);
    if (!queue.running) {
      void processQueue(repoChannelId);
    }
  }

  function getQueue(repoChannelId) {
    const existing = queues.get(repoChannelId);
    if (existing) {
      return existing;
    }
    const created = { running: false, jobs: [] };
    queues.set(repoChannelId, created);
    return created;
  }

  async function processQueue(repoChannelId) {
    const queue = getQueue(repoChannelId);
    if (queue.running) {
      return;
    }
    queue.running = true;

    while (queue.jobs.length > 0) {
      const job = queue.jobs.shift();
      let startedThreadId = null;
      let turnPromise = null;
      const settleTimeoutMs = Number.isFinite(Number(process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS))
        ? Math.max(500, Math.floor(Number(process.env.DISCORD_TURN_SETTLE_TIMEOUT_MS)))
        : 120_000;
      try {
        let threadId = await ensureThreadId(repoChannelId, job.setup);
        startedThreadId = threadId;

        const statusMessage = await safeReply(job.message, "⏳ Thinking...");
        if (!statusMessage) {
          throw new Error("Cannot send response in this channel (channel unavailable).");
        }

        const model = job.setup.model ?? config.defaultModel;
        const effort = config.defaultEffort;
        const approvalPolicy = config.approvalPolicy;
        const sandboxMode = job.setup.sandboxMode ?? config.sandboxMode;
        const sandboxPolicy = await buildSandboxPolicyForTurn(sandboxMode, job.setup.cwd);

        const runTurn = async (targetThreadId) => {
          startedThreadId = targetThreadId;
          const turn = createActiveTurn(targetThreadId, repoChannelId, statusMessage, job.setup.cwd, {
            allowFileWrites: job.setup.allowFileWrites !== false
          });
          turnPromise = turn.promise;

          const turnParams = {
            threadId: targetThreadId,
            input: job.inputItems
          };
          if (model) {
            turnParams.model = model;
          }
          if (effort) {
            turnParams.effort = effort;
          }
          if (approvalPolicy) {
            turnParams.approvalPolicy = approvalPolicy;
          }
          if (sandboxPolicy) {
            turnParams.sandboxPolicy = sandboxPolicy;
          }

          await requestCodexWithReconnectRetry(() => codex.request("turn/start", turnParams));
          await turn.promise;
        };

        let reconnectRetryCount = 0;
        let reconnectLingerCount = 0;
        const maxTurnReconnectRetries = Number.isFinite(Number(process.env.DISCORD_TURN_RECONNECT_MAX_RETRIES))
          ? Math.max(1, Math.floor(Number(process.env.DISCORD_TURN_RECONNECT_MAX_RETRIES)))
          : 24;
        while (true) {
          try {
            await runTurn(threadId);
            break;
          } catch (error) {
            if (isThreadNotFoundError(error)) {
              abortActiveTurn(threadId, error);
              if (turnPromise) {
                await turnPromise.catch(() => {});
              }

              state.clearBinding(repoChannelId);
              await state.save();

              threadId = await ensureThreadId(repoChannelId, job.setup);
              continue;
            }

            const message = String(error?.message ?? "");
            if (isTransientReconnectError(message) && reconnectRetryCount < maxTurnReconnectRetries) {
              reconnectRetryCount += 1;
              const settlement = turnPromise ? await waitForTurnSettlement(turnPromise, settleTimeoutMs) : "timeout";
              if (settlement === "resolved") {
                break;
              }
              const tracker = activeTurns.get(threadId);
              const hasProgress = hasTurnProgress(tracker);
              if (!hasProgress) {
                if (activeTurns.has(threadId)) {
                  abortActiveTurn(threadId, error);
                }
                if (turnPromise) {
                  await turnPromise.catch(() => {});
                }
                await delay(Math.min(10_000, 1_000 * reconnectRetryCount));
                threadId = await ensureThreadId(repoChannelId, job.setup);
                continue;
              }
              // Progress already observed: do not replay same prompt and risk duplicate output.
              reconnectLingerCount += 1;
              onTurnReconnectPending?.(threadId, {
                attempt: reconnectLingerCount,
                message
              });
              const lingerSettlement = turnPromise ? await waitForTurnSettlement(turnPromise, settleTimeoutMs) : "timeout";
              if (lingerSettlement === "resolved") {
                break;
              }
              throw error;
            }

            throw error;
          }
        }
      } catch (error) {
        if (startedThreadId && activeTurns.has(startedThreadId)) {
          await finalizeTurn(startedThreadId, error);
          if (turnPromise) {
            await turnPromise.catch(() => {});
          }
        } else if (!turnPromise) {
          await safeReply(job.message, `❌ ${error.message}`);
        }
      }
    }

    queue.running = false;
  }

  async function requestCodexWithReconnectRetry(requestFn) {
    const configuredMaxAttempts = Number(process.env.DISCORD_RPC_RECONNECT_MAX_ATTEMPTS ?? "");
    const maxAttempts =
      Number.isFinite(configuredMaxAttempts) && configuredMaxAttempts > 0
        ? Math.floor(configuredMaxAttempts)
        : 60;
    let attempt = 1;
    while (true) {
      try {
        return await requestFn();
      } catch (error) {
        const message = String(error?.message ?? "");
        const shouldRetry = isTransientReconnectError(message) && attempt < maxAttempts;
        if (!shouldRetry) {
          throw error;
        }
        await delay(Math.min(10_000, 500 * attempt));
        attempt += 1;
      }
    }
  }

  async function ensureThreadId(repoChannelId, setup) {
    const existingBinding = state.getBinding(repoChannelId);
    let existingThreadId = existingBinding?.codexThreadId ?? null;
    if (existingBinding?.cwd && path.resolve(existingBinding.cwd) !== path.resolve(setup.cwd)) {
      state.clearBinding(repoChannelId);
      await state.save();
      existingThreadId = null;
    }
    const approvalPolicy = config.approvalPolicy;
    const sandboxMode = setup.sandboxMode ?? config.sandboxMode;
    if (existingThreadId) {
      try {
        const resumeParams = {
          threadId: existingThreadId,
          cwd: setup.cwd
        };
        if (approvalPolicy) {
          resumeParams.approvalPolicy = approvalPolicy;
        }
        if (sandboxMode) {
          resumeParams.sandbox = sandboxMode;
        }
        await requestCodexWithReconnectRetry(() => codex.request("thread/resume", resumeParams));
        return existingThreadId;
      } catch (error) {
        if (!isThreadNotFoundError(error)) {
          throw error;
        }
        state.clearBinding(repoChannelId);
        await state.save();
      }
    }

    const startParams = { cwd: setup.cwd };
    const model = setup.model ?? config.defaultModel;
    const effort = config.defaultEffort;
    if (model) {
      startParams.model = model;
    }
    if (effort) {
      startParams.effort = effort;
    }
    if (approvalPolicy) {
      startParams.approvalPolicy = approvalPolicy;
    }
    if (sandboxMode) {
      startParams.sandbox = sandboxMode;
    }

    const result = await requestCodexWithReconnectRetry(() => codex.request("thread/start", startParams));
    const threadId = result?.thread?.id;
    if (!threadId) {
      throw new Error("thread/start did not return thread id");
    }

    state.setBinding(repoChannelId, {
      codexThreadId: threadId,
      repoChannelId,
      cwd: setup.cwd
    });
    await state.save();
    return threadId;
  }

  function createActiveTurn(threadId, repoChannelId, message, cwd, options = {}) {
    if (activeTurns.has(threadId)) {
      throw new Error("Turn already active for this thread");
    }

    let resolveTurn;
    let rejectTurn;
    const promise = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });

    activeTurns.set(threadId, {
      threadId,
      repoChannelId,
      statusMessage: message,
      statusMessageId: message.id,
      channel: message.channel,
      cwd: typeof cwd === "string" && cwd ? cwd : null,
      lifecyclePhase: TURN_PHASE.RUNNING,
      allowFileWrites: options.allowFileWrites !== false,
      sentAttachmentKeys: new Set(),
      seenAttachmentIssueKeys: new Set(),
      attachmentIssueCount: 0,
      firstToolCallAt: 0,
      lastToolCompletedAt: 0,
      hasToolCall: false,
      hasSummaryImageAttachment: false,
      workingMessage: null,
      workingMessageId: null,
      workingMessageCreatePromise: null,
      workingTicker: null,
      thinkingStartedAt: Date.now(),
      thinkingTicker: null,
      fullText: "",
      seenDelta: false,
      currentStatusLine: "⏳ Thinking...",
      lastRenderedContent: "",
      streamedTextOffset: 0,
      streamedSummaryText: "",
      completed: false,
      failed: false,
      failureMessage: "",
      fileChangeSummary: new Map(),
      statusSyntheticCounter: 0,
      flushTimer: null,
      lastFlushAt: 0,
      lastTurnActivityAt: Date.now(),
      turnCompletionRequested: false,
      turnCompletionRequestedAt: 0,
      turnFinalizeTimer: null,
      activeLifecycleItemKeys: new Set(),
      completedLifecycleItemKeys: new Set(),
      finalizing: false,
      resolve: resolveTurn,
      reject: rejectTurn
    });
    void onActiveTurnsChanged?.();
    void onTurnCreated?.(activeTurns.get(threadId));

    return { promise };
  }

  function abortActiveTurn(threadId, error) {
    const tracker = activeTurns.get(threadId);
    if (!tracker) {
      return;
    }

    if (tracker.flushTimer) {
      clearTimeout(tracker.flushTimer);
      tracker.flushTimer = null;
    }
    if (tracker.turnFinalizeTimer) {
      clearTimeout(tracker.turnFinalizeTimer);
      tracker.turnFinalizeTimer = null;
    }
    if (tracker.workingTicker) {
      clearInterval(tracker.workingTicker);
      tracker.workingTicker = null;
    }
    if (tracker.thinkingTicker) {
      clearInterval(tracker.thinkingTicker);
      tracker.thinkingTicker = null;
    }

    activeTurns.delete(threadId);
    void onActiveTurnsChanged?.();
    tracker.lifecyclePhase = TURN_PHASE.CANCELLED;
    void onTurnAborted?.(threadId, tracker);
    tracker.reject(error ?? new Error("Turn aborted"));
  }

  function findActiveTurnByRepoChannel(repoChannelId) {
    for (const tracker of activeTurns.values()) {
      if (tracker.repoChannelId === repoChannelId) {
        return tracker;
      }
    }
    return null;
  }

  return {
    enqueuePrompt,
    getQueue,
    processQueue,
    ensureThreadId,
    createActiveTurn,
    abortActiveTurn,
    findActiveTurnByRepoChannel
  };
}

function isTransientReconnectError(message) {
  if (!message) {
    return false;
  }
  return (
    /reconnecting\.\.\.\s*\d+\/\d+/i.test(message) ||
    /temporarily unavailable/i.test(message) ||
    /connection (?:reset|closed|lost)/i.test(message) ||
    /econnreset/i.test(message)
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hasTurnProgress(tracker) {
  if (!tracker || typeof tracker !== "object") {
    return false;
  }
  if (tracker.seenDelta) {
    return true;
  }
  if (typeof tracker.fullText === "string" && tracker.fullText.trim().length > 0) {
    return true;
  }
  if (
    typeof tracker.currentStatusLine === "string" &&
    !tracker.currentStatusLine.trim().startsWith("⏳ Thinking...")
  ) {
    return true;
  }
  return false;
}

async function waitForTurnSettlement(turnPromise, timeoutMs) {
  try {
    const settled = await Promise.race([
      turnPromise.then(() => "resolved").catch(() => "rejected"),
      delay(timeoutMs).then(() => "timeout")
    ]);
    return settled;
  } catch {
    return "timeout";
  }
}
