import { resolve, normalize } from "node:path";
import { isMissingRolloutPathError } from "../app/runtimeUtils.js";

const DEFAULT_REQUEST_TTL_MS = 3 * 24 * 60 * 60 * 1000;  // 3 days
const DEFAULT_MAX_REQUESTS = 5000;
const DEFAULT_MAX_REQUESTS_PER_THREAD = 300;
const MIN_REQUEST_TTL_MS = 60_000;  // 1 minute
const MIN_MAX_REQUESTS = 100;
const MIN_MAX_REQUESTS_PER_THREAD = 1;
const MAX_THREAD_LIST_PAGES = 20;
const THREADS_PER_PAGE = 100;
const THREAD_LIST_CACHE_TTL_MS = 5 * 60 * 1000;  // 5 minutes

export function createTurnRecoveryStore(deps) {
  const {
    fs,
    path,
    recoveryPath,
    debugLog,
    recoveryConfig = {},
    dataDir = fs.cwd ? fs.cwd() : process.cwd()
  } = deps;

  // P0: Path traversal protection
  const normalizedRecoveryPath = normalize(recoveryPath);
  const resolvedRecoveryPath = resolve(dataDir, normalizedRecoveryPath);
  const resolvedDataDir = resolve(dataDir);
  const relativeRecoveryPath = path.relative(resolvedDataDir, resolvedRecoveryPath);

  if (
    relativeRecoveryPath === ".." ||
    relativeRecoveryPath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeRecoveryPath)
  ) {
    throw new Error(`Invalid recovery path: ${recoveryPath} must be within data directory`);
  }

  const store = {
    schemaVersion: 2,
    turns: {},
    requests: {}
  };
  const requestTtlMs = Number.isFinite(Number(recoveryConfig.requestStatusTtlMs))
    ? Math.max(MIN_REQUEST_TTL_MS, Math.floor(Number(recoveryConfig.requestStatusTtlMs)))
    : DEFAULT_REQUEST_TTL_MS;
  const maxRequests = Number.isFinite(Number(recoveryConfig.requestStatusMaxRecords))
    ? Math.max(MIN_MAX_REQUESTS, Math.floor(Number(recoveryConfig.requestStatusMaxRecords)))
    : DEFAULT_MAX_REQUESTS;
  const maxRequestsPerThread = Number.isFinite(Number(recoveryConfig.requestStatusMaxPerThread))
    ? Math.max(MIN_MAX_REQUESTS_PER_THREAD, Math.floor(Number(recoveryConfig.requestStatusMaxPerThread)))
    : DEFAULT_MAX_REQUESTS_PER_THREAD;
  const recoveryNotifyEnabled = recoveryConfig.notifyEnabled !== false;
  let saveQueue = Promise.resolve();
  let threadListCache = null;
  let threadListCacheTime = 0;

  async function load() {
    await fs.mkdir(path.dirname(resolvedRecoveryPath), { recursive: true });
    try {
      const raw = await fs.readFile(resolvedRecoveryPath, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (jsonError) {
        console.error(`Failed to parse recovery store JSON: ${jsonError.message}`);
        // P0: Backup corrupted file
        const backupPath = `${resolvedRecoveryPath}.corrupted.${Date.now()}`;
        try {
          await fs.writeFile(backupPath, raw, "utf8");
          console.error(`Corrupted file backed up to: ${backupPath}`);
        } catch (backupError) {
          console.error(`Failed to backup corrupted file: ${backupError.message}`);
        }
        // Reset to empty state
        parsed = { schemaVersion: 2, turns: {}, requests: {} };
      }
      store.schemaVersion = 2;
      store.turns =
        parsed && typeof parsed.turns === "object" && parsed.turns !== null ? { ...parsed.turns } : {};
      store.requests =
        parsed && typeof parsed.requests === "object" && parsed.requests !== null ? { ...parsed.requests } : {};
      pruneRequestStatuses();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await save();
    }
  }

  async function save() {
    const writeOnce = async () => {
      pruneRequestStatuses();
      await fs.mkdir(path.dirname(resolvedRecoveryPath), { recursive: true });
      const tempPath = `${resolvedRecoveryPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
      await fs.rename(tempPath, resolvedRecoveryPath);
    };

    const writeWithRetry = async () => {
      try {
        await writeOnce();
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
        await writeOnce();
      }
    };

    const nextSave = saveQueue.then(writeWithRetry, writeWithRetry);
    saveQueue = nextSave.catch(() => {});
    await nextSave;
  }

  function evictThreadRequestsIfNeeded(threadId, keepSlots = maxRequestsPerThread - 1) {
    if (!threadId) {
      return;
    }
    const requestIdsForThread = Object.keys(store.requests).filter((requestId) => store.requests[requestId]?.threadId === threadId);
    if (requestIdsForThread.length <= keepSlots) {
      return;
    }

    const sortable = requestIdsForThread
      .map((requestId) => {
        const value = store.requests[requestId] ?? {};
        const updatedAt = new Date(value?.updatedAt ?? value?.createdAt ?? 0).getTime();
        const status = typeof value?.status === "string" ? value.status : "";
        return {
          requestId,
          updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
          isProcessing: status === "processing"
        };
      })
      .sort((left, right) => {
        if (left.isProcessing !== right.isProcessing) {
          return left.isProcessing ? 1 : -1;
        }
        return left.updatedAt - right.updatedAt;
      });

    const removeCount = sortable.length - keepSlots;
    for (let i = 0; i < removeCount; i += 1) {
      delete store.requests[sortable[i].requestId];
    }
  }

  async function upsertTurnFromTracker(tracker) {
    if (!tracker?.threadId || !tracker?.repoChannelId) {
      return;
    }

    // P0: Resource exhaustion protection - auto-prune per-thread request history
    evictThreadRequestsIfNeeded(tracker.threadId);

    store.turns[tracker.threadId] = {
      threadId: tracker.threadId,
      repoChannelId: tracker.repoChannelId,
      platform: tracker.platform ?? null,
      requestId: tracker.requestId ?? null,
      sourceMessageId: tracker.sourceMessageId ?? null,
      channelId: tracker.channel?.id ?? tracker.repoChannelId,
      statusMessageId: tracker.statusMessageId ?? null,
      cwd: tracker.cwd ?? null,
      lifecyclePhase: tracker.lifecyclePhase ?? null,
      recoveryNotifiedAt: store.turns[tracker.threadId]?.recoveryNotifiedAt ?? null,
      seenDelta: tracker.seenDelta === true,
      fullTextLength: typeof tracker.fullText === "string" ? tracker.fullText.length : 0,
      updatedAt: new Date().toISOString()
    };
    upsertRequestStatus({
      platform: tracker.platform,
      requestId: tracker.requestId,
      threadId: tracker.threadId,
      repoChannelId: tracker.repoChannelId,
      channelId: tracker.channel?.id ?? tracker.repoChannelId,
      sourceMessageId: tracker.sourceMessageId ?? null,
      status: "processing"
    });
    await save();
  }

  async function removeTurn(threadId, options = {}) {
    if (!threadId || !store.turns[threadId]) {
      return;
    }
    const snapshot = store.turns[threadId];
    const requestStatus = typeof options.status === "string" && options.status ? options.status : "unknown";
    upsertRequestStatus({
      platform: snapshot.platform,
      requestId: snapshot.requestId,
      threadId: snapshot.threadId,
      repoChannelId: snapshot.repoChannelId,
      channelId: snapshot.channelId,
      sourceMessageId: snapshot.sourceMessageId,
      status: requestStatus,
      errorMessage: options.errorMessage ?? null
    });
    delete store.turns[threadId];
    await save();
  }

  function getRequestStatus(requestId) {
    if (!requestId) {
      return null;
    }
    const entry = store.requests[String(requestId)];
    if (!entry) {
      return null;
    }
    // P0: Performance optimization - use shallow clone instead of structuredClone
    return {
      ...entry,
      errorMessage: entry.errorMessage  // Deep clone error message
    };
  }

  function findRequestStatusBySource({ sourceMessageId, routeId, platform } = {}) {
    const messageId = String(sourceMessageId ?? "").trim();
    if (!messageId) {
      return null;
    }
    const normalizedRouteId = String(routeId ?? "").trim();
    const normalizedPlatform = String(platform ?? "").trim().toLowerCase();
    const candidates = Object.values(store.requests).filter((entry) => {
      if (String(entry?.sourceMessageId ?? "").trim() !== messageId) {
        return false;
      }
      if (normalizedRouteId) {
        const entryRoute = String(entry?.repoChannelId ?? entry?.channelId ?? "").trim();
        if (entryRoute && entryRoute !== normalizedRouteId) {
          return false;
        }
      }
      if (normalizedPlatform) {
        const entryPlatform = String(entry?.platform ?? "").trim().toLowerCase();
        if (entryPlatform && entryPlatform !== normalizedPlatform) {
          return false;
        }
      }
      return true;
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      const leftAt = new Date(left?.updatedAt ?? left?.createdAt ?? 0).getTime();
      const rightAt = new Date(right?.updatedAt ?? right?.createdAt ?? 0).getTime();
      return rightAt - leftAt;
    });
    // P0: Performance optimization - use shallow clone instead of structuredClone
    const result = candidates[0];
    return {
      ...result,
      errorMessage: result.errorMessage  // Deep clone error message
    };
  }

  function snapshot() {
    // P0: Performance optimization - use shallow clone instead of structuredClone
    return {
      schemaVersion: store.schemaVersion,
      turns: { ...store.turns },
      requests: { ...store.requests }
    };
  }

  async function reconcilePending(options) {
    const { fetchChannelByRouteId, codex, safeSendToChannel } = options;
    const turns = Object.values(store.turns);
    if (turns.length === 0) {
      return { reconciled: 0, resumedKnown: 0, missingThread: 0, skipped: 0 };
    }

    const knownThreads = await fetchKnownThreadIds(codex);
    let resumedKnown = 0;
    let missingThread = 0;
    let skipped = 0;

    for (const turn of turns) {
      let recoveryStatus = "recovery_unknown";

      try {
        const channel = await fetchChannelByRouteId(turn.channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
          skipped += 1;
          recoveryStatus = "recovery_skipped";
          try {
            await removeTurn(turn.threadId);
          } catch (removeError) {
            console.error(`Failed to remove turn ${turn.threadId}: ${removeError.message}`);
          }
          continue;
        }

        const threadKnown = knownThreads.status === "available" ? knownThreads.ids.has(turn.threadId) : null;
        if (threadKnown === true) {
          resumedKnown += 1;
          recoveryStatus = "recovery_resumed";
        } else if (threadKnown === false) {
          missingThread += 1;
          recoveryStatus = "recovery_unavailable";
        }

        if (turn.recoveryNotifiedAt) {
          try {
            await removeTurn(turn.threadId, {
              status: recoveryStatus
            });
          } catch (removeError) {
            console.error(`Failed to remove already-notified turn ${turn.threadId}: ${removeError.message}`);
          }
          continue;
        }

        store.turns[turn.threadId] = {
          ...store.turns[turn.threadId],
          recoveryNotifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await save();

        if (recoveryNotifyEnabled) {
          const settlementText =
            threadKnown === true
              ? "🔄 Recovered after restart. Previous in-flight turn may still settle. If no follow-up appears, retry your last message."
              : threadKnown === false
                ? "⚠️ Recovered after restart. Previous in-flight turn could not be resumed safely. Please retry."
                : "⚠️ Recovered after restart. Previous in-flight turn status could not be verified safely. Please retry if no follow-up appears.";
          const settlementWithRequestId = turn.requestId
            ? `${settlementText}\nrequest_id: \`${turn.requestId}\``
            : settlementText;

          let edited = false;
          if (turn.statusMessageId) {
            try {
              const message = await channel.messages.fetch(turn.statusMessageId);
              if (message) {
                await message.edit(settlementWithRequestId);
                edited = true;
              }
            } catch (editError) {
              console.error(`Failed to edit status message for turn ${turn.threadId}: ${editError.message}`);
            }
          }
          if (!edited) {
            try {
              await safeSendToChannel(channel, settlementWithRequestId);
            } catch (sendError) {
              console.error(`Failed to send settlement message for turn ${turn.threadId}: ${sendError.message}`);
            }
          }
        }

        try {
          await removeTurn(turn.threadId, {
            status: recoveryStatus
          });
        } catch (removeError) {
          console.error(`Failed to remove turn ${turn.threadId}: ${removeError.message}`);
        }
      } catch (turnError) {
        console.error(`Failed to reconcile turn ${turn.threadId}: ${turnError.message}`);
        recoveryStatus = "recovery_failed";
        try {
          await removeTurn(turn.threadId, {
            status: recoveryStatus,
            errorMessage: String(turnError.message)
          });
        } catch (removeError) {
          console.error(`Failed to remove failed turn ${turn.threadId}: ${removeError.message}`);
        }
      }
    }

    return {
      reconciled: turns.length,
      resumedKnown,
      missingThread,
      skipped
    };
  }

  async function fetchKnownThreadIds(codex, useCache = true) {
    const now = Date.now();

    // P1: Use cache (5-minute TTL)
    if (useCache && threadListCache && (now - threadListCacheTime) < THREAD_LIST_CACHE_TTL_MS) {
      debugLog?.("recovery", "Using cached thread list", {
        count: threadListCache.ids.size,
        age: `${Math.round((now - threadListCacheTime) / 1000)}s`
      });
      return threadListCache;
    }

    const ids = new Set();
    let cursor = undefined;
    for (let page = 0; page < MAX_THREAD_LIST_PAGES; page += 1) {
      try {
        const params = { limit: THREADS_PER_PAGE, sortKey: "updated_at" };
        if (cursor) {
          params.cursor = cursor;
        }
        const response = await codex.request("thread/list", params);
        const rows = Array.isArray(response?.data) ? response.data : [];
        for (const row of rows) {
          if (typeof row?.id === "string" && row.id) {
            ids.add(row.id);
          }
        }
        if (!response?.nextCursor) {
          break;
        }
        cursor = response.nextCursor;
      } catch (error) {
        const errorMessage = String(error?.message ?? error);
        if (isMissingRolloutPathError(errorMessage)) {
          debugLog?.("recovery", "thread list failed due to missing rollout path, continuing", {
            message: errorMessage
          });
          return { ids, status: "unknown" };
        }
        debugLog?.("recovery", "thread list failed while reconciling", {
          message: errorMessage
        });
        return { ids, status: "unknown" };
      }
    }

    // Update cache
    threadListCache = { ids, status: "available" };
    threadListCacheTime = now;

    return threadListCache;
  }

  function upsertRequestStatus(entry) {
    const requestId = typeof entry?.requestId === "string" ? entry.requestId : "";
    if (!requestId) {
      return;
    }
    const existing = store.requests[requestId] ?? {};
    const nextStatus = typeof entry.status === "string" && entry.status ? entry.status : existing.status ?? "processing";
    store.requests[requestId] = {
      requestId,
      platform: entry.platform ?? existing.platform ?? null,
      threadId: entry.threadId ?? existing.threadId ?? null,
      repoChannelId: entry.repoChannelId ?? existing.repoChannelId ?? null,
      channelId: entry.channelId ?? existing.channelId ?? null,
      sourceMessageId: entry.sourceMessageId ?? existing.sourceMessageId ?? null,
      status: nextStatus,
      errorMessage:
        typeof entry.errorMessage === "string"
          ? entry.errorMessage
          : entry.errorMessage === null
            ? null
            : existing.errorMessage ?? null,
      createdAt: existing.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  function pruneRequestStatuses() {
    const now = Date.now();
    const entries = Object.entries(store.requests);
    if (entries.length === 0) {
      return;
    }

    // P0: Batch delete expired requests
    const toDelete = new Set();
    for (const [requestId, value] of entries) {
      const updatedAt = new Date(value?.updatedAt ?? value?.createdAt ?? 0).getTime();
      if (!Number.isFinite(updatedAt) || now - updatedAt > requestTtlMs) {
        toDelete.add(requestId);
      }
    }

    // Batch delete
    for (const requestId of toDelete) {
      delete store.requests[requestId];
    }

    // Batch prune by count
    const remaining = Object.values(store.requests);
    if (remaining.length <= maxRequests) {
      return;
    }
    remaining.sort((left, right) => {
      const leftAt = new Date(left?.updatedAt ?? left?.createdAt ?? 0).getTime();
      const rightAt = new Date(right?.updatedAt ?? right?.createdAt ?? 0).getTime();
      return rightAt - leftAt;
    });
    const toKeep = new Set(remaining.slice(0, maxRequests).map((item) => item.requestId));
    const allRequestIds = Object.keys(store.requests);

    for (let i = 0; i < allRequestIds.length; i++) {
      const requestId = allRequestIds[i];
      if (!toKeep.has(requestId)) {
        delete store.requests[requestId];
      }
    }
  }

  return {
    load,
    snapshot,
    upsertTurnFromTracker,
    removeTurn,
    getRequestStatus,
    findRequestStatusBySource,
    reconcilePending
  };
}
