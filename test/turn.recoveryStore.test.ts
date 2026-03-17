import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTurnRecoveryStore } from "../src/turns/recoveryStore.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeStore(recoveryConfig: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-recovery-"));
  tempDirs.push(dir);
  const recoveryPath = path.join(dir, "inflight-turns.json");
  const store = createTurnRecoveryStore({
    fs,
    path,
    recoveryPath,
    debugLog: () => {},
    recoveryConfig,
    dataDir: dir
  });
  await store.load();
  return { store, recoveryPath };
}

describe("turn recovery store", () => {
  test("rejects recovery paths outside the data directory even when they share a prefix", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-recovery-"));
    tempDirs.push(dir);
    const siblingRecoveryPath = path.join(`${dir}-sibling`, "inflight-turns.json");

    expect(() =>
      createTurnRecoveryStore({
        fs,
        path,
        recoveryPath: siblingRecoveryPath,
        debugLog: () => {},
        dataDir: dir
      })
    ).toThrow(/must be within data directory/);
  });

  test("persists and removes in-flight turn checkpoints", async () => {
    const { store, recoveryPath } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-1",
      repoChannelId: "channel-1",
      requestId: "req-1",
      sourceMessageId: "msg-1",
      channel: { id: "channel-1" },
      statusMessageId: "status-1",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: true,
      fullText: "partial"
    });

    let raw = JSON.parse(await fs.readFile(recoveryPath, "utf8"));
    expect(raw.turns["thread-1"]).toBeTruthy();
    expect(raw.turns["thread-1"].repoChannelId).toBe("channel-1");
    expect(raw.requests["req-1"]).toBeTruthy();
    expect(raw.requests["req-1"].status).toBe("processing");

    await store.removeTurn("thread-1", { status: "done" });
    raw = JSON.parse(await fs.readFile(recoveryPath, "utf8"));
    expect(raw.turns["thread-1"]).toBeUndefined();
    expect(raw.requests["req-1"].status).toBe("done");
    expect(store.getRequestStatus("req-1")?.status).toBe("done");
  });

  test("reconciles pending checkpoints by editing existing status messages", async () => {
    const { store } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-1",
      repoChannelId: "channel-1",
      requestId: "req-2",
      channel: { id: "channel-1" },
      statusMessageId: "status-1",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });

    const editedMessages: string[] = [];
    const channel = {
      isTextBased: () => true,
      messages: {
        async fetch(messageId: string) {
          return {
            id: messageId,
            async edit(content: string) {
              editedMessages.push(content);
              return this;
            }
          };
        }
      }
    };

    const summary = await store.reconcilePending({
      fetchChannelByRouteId: async (channelId: string) => {
        void channelId;
        return channel;
      },
      codex: {
        async request(method: string) {
          if (method === "thread/list") {
            return { data: [{ id: "thread-1" }], nextCursor: null };
          }
          return { data: [], nextCursor: null };
        }
      },
      safeSendToChannel: async () => null
    });

    expect(summary.reconciled).toBe(1);
    expect(summary.resumedKnown).toBe(1);
    expect(editedMessages.length).toBe(1);
    expect(editedMessages[0]).toContain("Recovered after restart");
    expect(editedMessages[0]).toContain("request_id");
    expect(Object.keys(store.snapshot().turns).length).toBe(0);
    expect(store.getRequestStatus("req-2")?.status).toBe("recovery_resumed");
  });

  test("marks recovered request status as unknown when thread listing fails", async () => {
    const { store } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-1",
      repoChannelId: "channel-1",
      requestId: "req-unknown",
      channel: { id: "channel-1" },
      statusMessageId: "status-1",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });

    const editedMessages: string[] = [];
    const channel = {
      isTextBased: () => true,
      messages: {
        async fetch(messageId: string) {
          return {
            id: messageId,
            async edit(content: string) {
              editedMessages.push(content);
              return this;
            }
          };
        }
      }
    };

    const summary = await store.reconcilePending({
      fetchChannelByRouteId: async () => channel,
      codex: {
        async request() {
          throw new Error("state db missing rollout path for thread thread-1");
        }
      },
      safeSendToChannel: async () => null
    });

    expect(summary.reconciled).toBe(1);
    expect(summary.resumedKnown).toBe(0);
    expect(summary.missingThread).toBe(0);
    expect(editedMessages[0]).toContain("could not be verified safely");
    expect(store.getRequestStatus("req-unknown")?.status).toBe("recovery_unknown");
  });

  test("does not send duplicate recovery notice for an already-notified turn", async () => {
    const { store, recoveryPath } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-repeat",
      repoChannelId: "channel-repeat",
      requestId: "req-repeat",
      channel: { id: "channel-repeat" },
      statusMessageId: "status-repeat",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });

    const raw = JSON.parse(await fs.readFile(recoveryPath, "utf8"));
    raw.turns["thread-repeat"].recoveryNotifiedAt = "2026-03-14T00:00:00.000Z";
    await fs.writeFile(recoveryPath, JSON.stringify(raw, null, 2), "utf8");
    await store.load();

    let sendCount = 0;
    let editCount = 0;
    const channel = {
      isTextBased: () => true,
      messages: {
        async fetch(messageId: string) {
          return {
            id: messageId,
            async edit() {
              editCount += 1;
              return this;
            }
          };
        }
      }
    };

    const summary = await store.reconcilePending({
      fetchChannelByRouteId: async () => channel,
      codex: {
        async request(method: string) {
          if (method === "thread/list") {
            return { data: [{ id: "thread-repeat" }], nextCursor: null };
          }
          return { data: [], nextCursor: null };
        }
      },
      safeSendToChannel: async () => {
        sendCount += 1;
        return null;
      }
    });

    expect(summary.reconciled).toBe(1);
    expect(editCount).toBe(0);
    expect(sendCount).toBe(0);
    expect(Object.keys(store.snapshot().turns).length).toBe(0);
    expect(store.getRequestStatus("req-repeat")?.status).toBe("recovery_resumed");
  });

  test("does not emit recovery notice when notifyEnabled=false", async () => {
    const { store } = await makeStore({ notifyEnabled: false });
    await store.upsertTurnFromTracker({
      threadId: "thread-silent",
      repoChannelId: "channel-silent",
      requestId: "req-silent",
      channel: { id: "channel-silent" },
      statusMessageId: "status-silent",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });

    let sendCount = 0;
    let editCount = 0;
    const channel = {
      isTextBased: () => true,
      messages: {
        async fetch(messageId: string) {
          return {
            id: messageId,
            async edit() {
              editCount += 1;
              return this;
            }
          };
        }
      }
    };

    const summary = await store.reconcilePending({
      fetchChannelByRouteId: async () => channel,
      codex: {
        async request(method: string) {
          if (method === "thread/list") {
            return { data: [{ id: "thread-silent" }], nextCursor: null };
          }
          return { data: [], nextCursor: null };
        }
      },
      safeSendToChannel: async () => {
        sendCount += 1;
        return null;
      }
    });

    expect(summary.reconciled).toBe(1);
    expect(editCount).toBe(0);
    expect(sendCount).toBe(0);
    expect(Object.keys(store.snapshot().turns).length).toBe(0);
    expect(store.getRequestStatus("req-silent")?.status).toBe("recovery_resumed");
  });

  test("auto-evicts old request statuses when requestStatusMaxPerThread is reached", async () => {
    const { store } = await makeStore({ requestStatusMaxPerThread: 2 });

    await store.upsertTurnFromTracker({
      threadId: "thread-cap",
      repoChannelId: "channel-cap",
      requestId: "req-cap-1",
      sourceMessageId: "msg-cap-1",
      channel: { id: "channel-cap" },
      statusMessageId: "status-cap-1",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });
    await store.upsertTurnFromTracker({
      threadId: "thread-cap",
      repoChannelId: "channel-cap",
      requestId: "req-cap-2",
      sourceMessageId: "msg-cap-2",
      channel: { id: "channel-cap" },
      statusMessageId: "status-cap-2",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });
    await store.upsertTurnFromTracker({
      threadId: "thread-cap",
      repoChannelId: "channel-cap",
      requestId: "req-cap-3",
      sourceMessageId: "msg-cap-3",
      channel: { id: "channel-cap" },
      statusMessageId: "status-cap-3",
      cwd: "/tmp/repo",
      lifecyclePhase: "running",
      seenDelta: false,
      fullText: ""
    });

    expect(store.getRequestStatus("req-cap-1")).toBeNull();
    expect(store.getRequestStatus("req-cap-2")?.status).toBe("processing");
    expect(store.getRequestStatus("req-cap-3")?.status).toBe("processing");
  });
});
