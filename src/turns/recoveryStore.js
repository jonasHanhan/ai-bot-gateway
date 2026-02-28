export function createTurnRecoveryStore(deps) {
  const { fs, path, recoveryPath, debugLog } = deps;
  const store = {
    schemaVersion: 1,
    turns: {}
  };

  async function load() {
    await fs.mkdir(path.dirname(recoveryPath), { recursive: true });
    try {
      const raw = await fs.readFile(recoveryPath, "utf8");
      const parsed = JSON.parse(raw);
      store.schemaVersion = 1;
      store.turns =
        parsed && typeof parsed.turns === "object" && parsed.turns !== null ? { ...parsed.turns } : {};
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await save();
    }
  }

  async function save() {
    const tempPath = `${recoveryPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tempPath, recoveryPath);
  }

  async function upsertTurnFromTracker(tracker) {
    if (!tracker?.threadId || !tracker?.repoChannelId) {
      return;
    }
    store.turns[tracker.threadId] = {
      threadId: tracker.threadId,
      repoChannelId: tracker.repoChannelId,
      channelId: tracker.channel?.id ?? tracker.repoChannelId,
      statusMessageId: tracker.statusMessageId ?? null,
      cwd: tracker.cwd ?? null,
      lifecyclePhase: tracker.lifecyclePhase ?? null,
      seenDelta: tracker.seenDelta === true,
      fullTextLength: typeof tracker.fullText === "string" ? tracker.fullText.length : 0,
      updatedAt: new Date().toISOString()
    };
    await save();
  }

  async function removeTurn(threadId) {
    if (!threadId || !store.turns[threadId]) {
      return;
    }
    delete store.turns[threadId];
    await save();
  }

  function snapshot() {
    return structuredClone(store);
  }

  async function reconcilePending(options) {
    const { discord, codex, safeSendToChannel } = options;
    const turns = Object.values(store.turns);
    if (turns.length === 0) {
      return { reconciled: 0, resumedKnown: 0, missingThread: 0, skipped: 0 };
    }

    const knownThreadIds = await fetchKnownThreadIds(codex);
    let resumedKnown = 0;
    let missingThread = 0;
    let skipped = 0;

    for (const turn of turns) {
      const channel = await discord.channels.fetch(turn.channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        skipped += 1;
        await removeTurn(turn.threadId);
        continue;
      }

      const threadKnown = knownThreadIds.has(turn.threadId);
      const settlementText = threadKnown
        ? "🔄 Recovered after restart. Previous in-flight turn may still settle. If no follow-up appears, retry your last message."
        : "⚠️ Recovered after restart. Previous in-flight turn could not be resumed safely. Please retry.";

      if (threadKnown) {
        resumedKnown += 1;
      } else {
        missingThread += 1;
      }

      let edited = false;
      if (turn.statusMessageId) {
        try {
          const message = await channel.messages.fetch(turn.statusMessageId);
          if (message) {
            await message.edit(settlementText);
            edited = true;
          }
        } catch {}
      }
      if (!edited) {
        await safeSendToChannel(channel, settlementText);
      }

      await removeTurn(turn.threadId);
    }

    return {
      reconciled: turns.length,
      resumedKnown,
      missingThread,
      skipped
    };
  }

  async function fetchKnownThreadIds(codex) {
    const ids = new Set();
    let cursor = undefined;
    for (let page = 0; page < 20; page += 1) {
      try {
        const params = { limit: 100, sortKey: "updated_at" };
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
        debugLog?.("recovery", "thread list failed while reconciling", {
          message: String(error?.message ?? error)
        });
        break;
      }
    }
    return ids;
  }

  return {
    load,
    snapshot,
    upsertTurnFromTracker,
    removeTurn,
    reconcilePending
  };
}
