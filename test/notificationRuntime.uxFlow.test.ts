import { describe, expect, test } from "bun:test";
import { createNotificationRuntime } from "../src/turns/notificationRuntime.js";

type TurnTracker = {
  threadId: string;
  repoChannelId: string;
  channel: {
    platform?: string;
    supportsMessageEdits?: boolean;
    isTextBased: () => boolean;
    messages: {
      fetch: () => Promise<null>;
    };
  };
  statusMessage: {
    id: string;
    platform?: string;
    supportsEdits?: boolean;
    channel: {
      platform?: string;
      supportsMessageEdits?: boolean;
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
    supportsMessageEdits: platform !== "feishu",
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
      supportsEdits: platform !== "feishu",
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
    const statusEdits: string[] = [];
    const chunkedMessages: string[] = [];
    const itemAttachmentCalls: string[] = [];
    const inferredAttachmentTexts: string[] = [];
    tracker.statusMessage.edit = async (text: string) => {
      statusEdits.push(text);
    };

    const runtime = createNotificationRuntime({
      activeTurns,
      renderVerbosity: "ops",
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
        inferredAttachmentTexts.push(text);
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

    expect(statusEdits.some((line) => line.startsWith("👷 Working"))).toBe(true);
    expect(statusEdits.some((line) => line.startsWith("✅ Work complete"))).toBe(true);
    expect(sentMessages.some((line) => line.startsWith("🖼️ Image:"))).toBe(false);
    expect(chunkedMessages).toContain("Summary complete with image /tmp/final.png");
    expect(chunkedMessages).toContain("```ansi\n+2 -1\n```");
    expect(itemAttachmentCalls).toEqual(["commandExecution"]);
    expect(inferredAttachmentTexts).toEqual(["Summary complete with image /tmp/final.png"]);
    expect(tracker.hasSummaryImageAttachment).toBe(true);
  });

  test("silently skips summary image stage when no image path is inferred", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const sentMessages: string[] = [];
    const chunkedMessages: string[] = [];
    const inferredAttachmentTexts: string[] = [];

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
      maybeSendInferredAttachmentsFromText: async (_tracker: unknown, text: string) => {
        inferredAttachmentTexts.push(text);
        return 0;
      },
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
    expect(inferredAttachmentTexts).toEqual(["Summary without local image path"]);
    expect(tracker.hasSummaryImageAttachment).toBe(false);
  });

  test("does not send file diff block in user verbosity", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
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
      buildFileDiffSection: () => "```ansi\n+2 -1\n```",
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
      turnCompletionMaxWaitMs: 20
    });

    tracker.fullText = "Summary only";
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(chunkedMessages).toContain("Summary only");
    expect(chunkedMessages.some((line) => line.includes("```ansi"))).toBe(false);
  });

  test("creates only one working message under concurrent tool-start events", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    activeTurns.set("thread-1", tracker);
    const sentMessages: string[] = [];
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

    const workingMessages = statusEdits.filter((line) => line.startsWith("👷 Working"));
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

  test("streams Discord agent deltas as segmented messages instead of editing the status message", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
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
        return { id: `discord-stream-${streamedMessages.length}` };
      },
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {}
    });

    await runtime.handleNotification({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", delta: "Hello." }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(streamedMessages).toEqual(["Hello."]);
    expect(statusEdits.some((value) => value.includes("Hello."))).toBe(false);
  });

  test("does not resend the first Discord summary chunk when it was already streamed as a message", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    tracker.lastFlushAt = Date.now() - 5000;
    activeTurns.set("thread-1", tracker);
    const streamedMessages: string[] = [];
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
      safeSendToChannel: async (_channel: unknown, text: string) => {
        streamedMessages.push(text);
        return { id: `discord-stream-${streamedMessages.length}` };
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
      params: { threadId: "thread-1", delta: "Streamed final answer." }
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(streamedMessages).toEqual(["Streamed final answer."]);
    expect(chunkedMessages).toEqual([]);
    expect(statusEdits.some((value) => value.includes("Streamed final answer."))).toBe(false);
  });

  test("sends only the remaining Discord summary tail on finalize after streamed segments", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
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
        return { id: `discord-stream-${streamedMessages.length}` };
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
      params: { threadId: "thread-1", delta: "Discord prefix." }
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

    expect(streamedMessages).toEqual(["Discord prefix."]);
    expect(chunkedMessages).toEqual([" tail"]);
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
      feishuSegmentedStreaming: true,
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
      feishuSegmentedStreaming: true,
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
      feishuSegmentedStreaming: true,
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

  test("sends Feishu final summary as a new message when status edits are unsupported", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker({ platform: "feishu" });
    activeTurns.set("thread-1", tracker);
    const statusEdits: string[] = [];
    const chunkedMessages: string[] = [];
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

    tracker.fullText = "Feishu final summary";
    tracker.seenDelta = true;
    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(statusEdits).toEqual([]);
    expect(chunkedMessages).toEqual(["Feishu final summary"]);
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

  test("sends imageView attachments immediately when item completes", async () => {
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
    expect(itemAttachmentCalls).toEqual(["imageView"]);
    expect((tracker as TurnTracker & { pendingAttachmentPaths?: Set<string> }).pendingAttachmentPaths).toBeUndefined();
  });

  test("passes completed mcp tool results through attachment sender", async () => {
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
      params: {
        threadId: "thread-1",
        item: { id: "tool-1", type: "mcpToolCall", path: "/tmp/google-home.png" }
      }
    });

    expect(itemAttachmentCalls).toEqual(["mcpToolCall"]);
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

    expect(statusEdits.some((value) => value.includes("I’ll check the existing"))).toBe(false);
    expect(chunkedMessages).toEqual(["I’ll check the existing"]);
    expect(activeTurns.has("thread-1")).toBe(false);
  });

  test("ignores missing rollout path errors even when tracker is absent", async () => {
    const runtime = createNotificationRuntime({
      activeTurns: new Map(),
      renderVerbosity: "user",
      TURN_PHASE: {
        RUNNING: "running",
        RECONNECTING: "reconnecting",
        FINALIZING: "finalizing",
        FAILED: "failed",
        DONE: "done"
      },
      transitionTurnPhase: () => true,
      normalizeCodexNotification: (notification: CodexNotification) => ({
        kind: "error",
        threadId: notification.params.threadId,
        errorMessage: "state db missing rollout path for thread thread-1"
      }),
      extractAgentMessageText: () => "",
      maybeSendAttachmentsForItem: async () => {},
      maybeSendInferredAttachmentsFromText: async () => 0,
      recordFileChanges: () => {},
      summarizeItemForStatus: () => [],
      extractWebSearchDetails: () => [],
      buildFileDiffSection: () => "",
      buildTurnRenderPlan: () => ({ primaryMessage: "", statusMessages: [], attachments: [] }),
      sendChunkedToChannel: async () => {},
      normalizeFinalSummaryText: (text: string) => text,
      sanitizeSummaryForDiscord: (text: string) => text,
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
      method: "error",
      params: { threadId: "thread-1" }
    });
  });

  test("rejects the tracker when finalization work throws", async () => {
    const activeTurns = new Map<string, TurnTracker>();
    const tracker = createTracker();
    tracker.fullText = "final summary";
    let resolved = 0;
    let rejectedError: Error | null = null;
    tracker.resolve = () => {
      resolved += 1;
    };
    tracker.reject = (error?: Error) => {
      rejectedError = error ?? new Error("missing error");
    };
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
      sendChunkedToChannel: async () => {
        throw new Error("summary send failed");
      },
      normalizeFinalSummaryText: (text: string) => text,
      sanitizeSummaryForDiscord: (text: string) => text,
      truncateStatusText: (text: string) => text,
      isTransientReconnectErrorMessage: () => false,
      safeSendToChannel: async () => null,
      truncateForDiscordMessage: (text: string) => text,
      discordMaxMessageLength: 1900,
      debugLog: () => {},
      writeHeartbeatFile: async () => {},
      onTurnFinalized: async () => {},
      turnCompletionQuietMs: 10,
      turnCompletionMaxWaitMs: 50
    });

    await runtime.handleNotification({
      method: "turn/completed",
      params: { threadId: "thread-1" }
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(resolved).toBe(0);
    expect(rejectedError?.message).toBe("summary send failed");
    expect(activeTurns.has("thread-1")).toBe(false);
  });
});
