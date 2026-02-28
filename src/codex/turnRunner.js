import path from "node:path";

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
    onActiveTurnsChanged
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

        try {
          await runTurn(threadId);
        } catch (error) {
          if (!isThreadNotFoundError(error)) {
            throw error;
          }

          abortActiveTurn(threadId, error);
          if (turnPromise) {
            await turnPromise.catch(() => {});
          }

          state.clearBinding(repoChannelId);
          await state.save();

          threadId = await ensureThreadId(repoChannelId, job.setup);
          await runTurn(threadId);
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
    const maxAttempts = 12;
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
        await delay(Math.min(4_000, 400 * attempt));
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
      allowFileWrites: options.allowFileWrites !== false,
      sentAttachmentKeys: new Set(),
      seenAttachmentIssueKeys: new Set(),
      attachmentIssueCount: 0,
      fullText: "",
      seenDelta: false,
      currentStatusLine: "⏳ Thinking...",
      lastStatusUpdateLine: "",
      pendingCompletionReactions: new Map(),
      lastRenderedContent: "",
      completed: false,
      failed: false,
      failureMessage: "",
      itemStatusMessages: new Map(),
      itemStatusQueues: new Map(),
      fileChangeSummary: new Map(),
      statusSyntheticCounter: 0,
      flushTimer: null,
      lastFlushAt: 0,
      resolve: resolveTurn,
      reject: rejectTurn
    });
    void onActiveTurnsChanged?.();

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

    activeTurns.delete(threadId);
    void onActiveTurnsChanged?.();
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
