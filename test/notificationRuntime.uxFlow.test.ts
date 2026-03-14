import { describe, expect, test } from "bun:test";
import { createNotificationRuntime } from "../src/turns/notificationRuntime.js";

type TurnTracker = {
  threadId: string;
  repoChannelId: string;
  channel: {
    platform?: string;
    isTextBased: () => boolean;
    messages: {
      fetch: () => Promise<null>;
    };
  };
  statusMessage: {
    id: string;
    platform?: string;
    channel: {
      platform?: string;
      isTextBased: () => boolean;
      messages: {
        fetch: () => Promise<null>;
      };
    };
    edit: (text: string) => Promise<void>;
  };
  statusMessageId: string;
  lifecyclePhase: string;
  allowFileWrites: boolean;
  sentAttachmentKeys: Set<string>;
  seenAttachmentIssueKeys: Set<string>;
  attachmentIssueCount: number;
  firstToolCallAt: number;
  lastToolCompletedAt: number;
  hasToolCall: boolean;
  hasSummaryImageAttachment: boolean;
  workingMessage: null | { id: string; edit: (text: string) => Promise<void> };
  workingMessageId: string | null;
  workingMessageCreatePromise: null | Promise<void>;
  workingTicker: null | ReturnType<typeof setInterval>;
  thinkingStartedAt: number;
  thinkingTicker: null | ReturnType<typeof setInterval>;
  fullText: string;
  seenDelta: boolean;
  currentStatusLine: string;
  lastRenderedContent: string;
  streamedTextOffset: number;
  streamedSummaryText: string;
  completed: boolean;
  failed: boolean;
  failureMessage: string;
  fileChangeSummary: Map<string, { added: number; removed: number }>;
  statusSyntheticCounter: number;
  flushTimer: null | ReturnType<typeof setTimeout>;
  lastFlushAt: number;
  finalizing: boolean;
  resolve: () => void;
  reject: () => void;
};

type CodexNotification = {
  method: string;
  params: {
    threadId: string;
    item?: { id: string; type: string; [key: string]: unknown };
    delta?: string;
  };
};

function createTracker(options: { platform?: string } = {}) {
  const sentEdits: string[] = [];
  const platform = options.platform ?? "discord";
  const channel = {
    platform,
    isTextBased: () => true,
    messages: {
      fetch: async () => null
    }
  };
  return {
    threadId: "thread-1",
    repoChannelId: "repo-1",
    channel,
    statusMessage: {
      id: "thinking-1",
      platform,
      channel,
      edit: async (text: string) => {
        sentEdits.push(text);
      }
    },
    statusMessageId: "thinking-1",
    lifecyclePhase: "running",
    allowFileWrites: true,
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
    fileChangeSummary: new Map([["src/index.js", { added: 2, removed: 1 }]]),
    statusSyntheticCounter: 0,
    flushTimer: null,
    lastFlushAt: 0,
    finalizing: false,
    resolve: () => {},
    reject: () => {}
  } satisfies TurnTracker;
}

describe("notification runtime ux flow cutover", () => {
  test("emits staged messages for tool work, summary, image and diff", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const sentMessages: string[] = [];
    const chunkedMessages: string[] = [];
    const attachmentCalls: string[] = [];
    const itemAttachmentCalls: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/started" || method === "item/completed") {
          return { kind: "item_lifecycle", threadId: params.threadId, item: params.item, state: method.split("/")[1] };
        }
        if (method === "turn/completed") {
          return { kind: "turn_completed", threadId: params.threadId };
        }
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async (_tracker: unknown, item: { type?: string }) => {
        itemAttachmentCalls.push(String(item?.type ?? ""));
      },
      maybeSendInferredAttachmentsFromText: async (_tracker: unknown, text: string) => {
        attachmentCalls.push(text);
        return 2;
      },
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "```ansi\n+2 -1\n```",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        sentMessages.push(text);
        return {
          id: `msg-${sentMessages.length}`,
          channel: tracker.channel,
          edit: async (next: string) => {
            sentMessages.push(`edit:${next}`);
          }
        };
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 20
    });

    tracker.fullText = "Summary complete with image /tmp/final.png";
    await runtime.handleNotification({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "tool-1", type: "commandExecution" } }
    });
    await runtime.handleNotification({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "img-1", type: "imageView" } }
    });
    await runtime.handleNotification({
      method: "item/completed",
      params: { threadId: "thread-1", item: { id: "tool-1", type: "commandExecution" } }
    });
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(sentMessages.some((line) => line.startsWith("👷 Working"))).toBe(true);
    expect(sentMessages.some((line) => line.startsWith("✅ Work complete"))).toBe(true);
    expect(sentMessages.some((line) => line.startsWith("🖼️ Image:"))).toBe(false);
    expect(chunkedMessages).toContain("Summary complete with image /tmp/final.png");
    expect(chunkedMessages).toContain("```ansi\n+2 -1\n```");
    expect(attachmentCalls).toEqual(["Summary complete with image /tmp/final.png"]);
    expect(itemAttachmentCalls).toEqual([]);
  });

  test("silently skips summary image stage when no image path is inferred", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const sentMessages: string[] = [];
    const chunkedMessages: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        return method === "turn/completed" ? { kind: "turn_completed", threadId: params.threadId } : { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        sentMessages.push(text);
        return null;
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 200
    });

    tracker.fullText = "Summary without local image path";
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(chunkedMessages).toEqual(["Summary without local image path"]);
    expect(sentMessages).toEqual([]);
  });

  test("creates only one working message under concurrent tool-start events", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const sentMessages: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/started") {
          return { kind: "item_lifecycle", threadId: params.threadId, item: params.item, state: "started" };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sentMessages.push(text);
        return {
          id: `msg-${sentMessages.length}`,
          channel: tracker.channel,
          edit: async () => {}
        };
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 200
    });

    await Promise.all([
      runtime.handleNotification({
        method: "item/started",
        params: { threadId: "thread-1", item: { id: "tool-1", type: "commandExecution" } }
      }),
      runtime.handleNotification({
        method: "item/started",
        params: { threadId: "thread-1", item: { id: "tool-2", type: "commandExecution" } }
      }),
      runtime.handleNotification({
        method: "item/started",
        params: { threadId: "thread-1", item: { id: "tool-3", type: "commandExecution" } }
      })
    ]);

    const workingMessages = sentMessages.filter((line) => line.startsWith("👷 Working"));
    expect(workingMessages.length).toBe(1);
  });

  test("updates thinking stage with elapsed timer before first tool call", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const thinkingEdits: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      thinkingEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/started") {
          return { kind: "item_lifecycle", threadId: params.threadId, item: params.item, state: "started" };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 200
    });

    await runtime.handleNotification({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "reasoning-1", type: "reasoning" } }
    });

    expect(thinkingEdits.some((line) => line.startsWith("⏳ Thinking... ("))).toBe(true);
    if (tracker.thinkingTicker) {
      clearInterval(tracker.thinkingTicker);
      tracker.thinkingTicker = null;
    }
  });

  test("streams agent deltas into the status message before completion", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const statusEdits: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      statusEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {}
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Hello" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(statusEdits).toContain("Hello");
  });

  test("does not resend the first summary chunk when it was already streamed in status message", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const chunkedMessages: string[] = [];
    const statusEdits: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      statusEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        if (method === "turn/completed") {
          return { kind: "turn_completed", threadId: params.threadId };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 100
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Streamed final answer" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(statusEdits.some((value) => value.includes("Streamed final answer"))).toBe(true);
    expect(chunkedMessages).toEqual([]);
  });

  test("streams Feishu deltas as segmented messages instead of editing the status message", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker({ platform: "feishu" });
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const streamedMessages: string[] = [];
    const statusEdits: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      statusEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        streamedMessages.push(text);
        return { id: `feishu-stream-${streamedMessages.length}` };
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {}
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Feishu streaming works." }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(streamedMessages).toEqual(["Feishu streaming works."]);
    expect(statusEdits.some((value) => value.includes("Feishu streaming works."))).toBe(false);
  });

  test("sends only the remaining Feishu summary tail on finalize after streamed segments", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker({ platform: "feishu" });
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const streamedMessages: string[] = [];
    const chunkedMessages: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        if (method === "turn/completed") {
          return { kind: "turn_completed", threadId: params.threadId };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        streamedMessages.push(text);
        return { id: `feishu-stream-${streamedMessages.length}` };
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 100
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Feishu prefix." }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: " tail" }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(streamedMessages).toEqual(["Feishu prefix."]);
    expect(chunkedMessages).toEqual([" tail"]);
  });

  test("retries Feishu summary content on finalize when a streamed segment send is dropped", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker({ platform: "feishu" });
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const streamedMessages: string[] = [];
    const chunkedMessages: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        if (method === "turn/completed") {
          return { kind: "turn_completed", threadId: params.threadId };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text,
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async (_channel: unknown, text: string) => {
        streamedMessages.push(text);
        return null;
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 100
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Feishu dropped segment." }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(streamedMessages).toEqual(["Feishu dropped segment."]);
    expect(chunkedMessages).toEqual(["Feishu dropped segment."]);
  });

  test("stops thinking timer once tool work begins", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/started") {
          return { kind: "item_lifecycle", threadId: params.threadId, item: params.item, state: "started" };
        }
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {}
    });

    await runtime.handleNotification({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "reasoning-1", type: "reasoning" } }
    });
    expect(tracker.thinkingTicker).not.toBeNull();

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "H" }
    });
    expect(tracker.thinkingTicker).not.toBeNull();

    await runtime.handleNotification({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "call-1", type: "commandExecution" } }
    });
    expect(tracker.thinkingTicker).toBeNull();
  });

  test("queues imageView attachment paths in cutover mode (no immediate upload)", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const itemAttachmentCalls: string[] = [];

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "item/completed") {
          return { kind: "item_lifecycle", threadId: params.threadId, item: params.item, state: "completed" };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async (_tracker: unknown, item: { type?: string }) => {
        itemAttachmentCalls.push(String(item?.type ?? ""));
      },
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text.trim(),
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {}
    });

    await runtime.handleNotification({
      method: "item/completed",
      params: { threadId: "thread-1", item: { id: "img-1", type: "imageView", path: "/tmp/example.png" } }
    });
    expect(itemAttachmentCalls).toEqual([]);
    expect((tracker as TurnTracker & { pendingAttachmentPaths?: Set<string> }).pendingAttachmentPaths?.has("/tmp/example.png")).toBe(
      true
    );
  });

  test("clears thinking ticker at finalize start before summary send", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    tracker.fullText = "Final summary";
    tracker.thinkingTicker = setInterval(() => {}, 1000);

    let releaseSummarySend: (() => void) | null = null;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummarySend = resolve;
    });

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        return method === "turn/completed" ? { kind: "turn_completed", threadId: params.threadId } : { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {
        await summaryGate;
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      sanitizeSummaryForDiscord: (text: string) => text,
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 5,
      turnCompletionMaxWaitMs: 200
    });

    const finalizePromise = runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tracker.thinkingTicker).toBeNull();

    releaseSummarySend?.();
    await finalizePromise;
  });

  test("defers finalize when turn/completed arrives before trailing deltas", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const chunkedMessages: string[] = [];
    const statusEdits: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      statusEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => {
        const { method, params } = notification;
        if (method === "turn/completed") {
          return { kind: "turn_completed", threadId: params.threadId };
        }
        if (method === "item/agentMessage/delta") {
          return { kind: "agent_delta", threadId: params.threadId, delta: params.delta };
        }
        return { kind: "unknown" };
      },
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async (_channel: unknown, text: string) => {
        chunkedMessages.push(text);
      },
      normalizeFinalSummaryText: (text: string) => text.trim(),
      sanitizeSummaryForDiscord: (text: string) => text,
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 20,
      turnCompletionMaxWaitMs: 300
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "I’ll check" }
    });
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: " the existing" }
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(statusEdits.some((value) => value.includes("I’ll check the existing"))).toBe(true);
    expect(chunkedMessages).toEqual([]);
    expect(activeTurns.has("thread-1")).toBe(false);
  });
});
