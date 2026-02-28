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

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-recovery-"));
  tempDirs.push(dir);
  const recoveryPath = path.join(dir, "inflight-turns.json");
  const store = createTurnRecoveryStore({
    fs,
    path,
    recoveryPath,
    debugLog: () => {}
  });
  await store.load();
  return { store, recoveryPath };
}

describe("turn recovery store", () => {
  test("persists and removes in-flight turn checkpoints", async () => {
    const { store, recoveryPath } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-1",
      repoChannelId: "channel-1",
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

    await store.removeTurn("thread-1");
    raw = JSON.parse(await fs.readFile(recoveryPath, "utf8"));
    expect(raw.turns["thread-1"]).toBeUndefined();
  });

  test("reconciles pending checkpoints by editing existing status messages", async () => {
    const { store } = await makeStore();
    await store.upsertTurnFromTracker({
      threadId: "thread-1",
      repoChannelId: "channel-1",
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
      discord: {
        channels: {
          async fetch(channelId: string) {
            void channelId;
            return channel;
          }
        }
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
    expect(Object.keys(store.snapshot().turns).length).toBe(0);
  });
});
