import { describe, expect, test } from "bun:test";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  describeToolRequestUserInput
} from "../src/codex/approvalPayloads.js";
import { createServerRequestRuntime } from "../src/approvals/serverRequestRuntime.js";

function createHarness(options: {
  isGeneralChannel?: () => boolean;
  channelIsTextBased?: boolean;
  stateChannelId?: string | null;
  buildResponseForServerRequestOverride?: ((method: string, params: unknown, decision: string) => unknown) | null;
} = {}) {
  const pendingApprovals = new Map<string, Record<string, unknown>>();
  const activeTurns = new Map<string, { threadId: string; repoChannelId: string }>();
  const codexRespondCalls: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const sentWarnings: string[] = [];
  const approvalMessages: Array<Record<string, unknown>> = [];
  const editedApprovalMessages: Array<Record<string, unknown>> = [];

  const approvalMessage = {
    id: "approval-msg-1",
    content: "Approval requested",
      async edit(payload: Record<string, unknown>) {
        editedApprovalMessages.push(payload);
        return this;
      }
    };

  const channel = {
    id: "channel-1",
    isTextBased: () => options.channelIsTextBased !== false,
    async send(payload: Record<string, unknown>) {
      approvalMessages.push(payload);
      return approvalMessage;
    },
    messages: {
      async fetch(messageId: string) {
        void messageId;
        return approvalMessage;
      }
    }
  };

  const runtime = createServerRequestRuntime({
    codex: {
      respond(id: string, payload: Record<string, unknown>) {
        codexRespondCalls.push({ id, payload });
      }
    },
    discord: {
      channels: {
        async fetch(channelId: string) {
          void channelId;
          return channel;
        }
      }
    },
    state: {
      findConversationChannelIdByCodexThreadId(threadId: string) {
        if (threadId !== "thread-1") {
          return null;
        }
        return options.stateChannelId === undefined ? "channel-1" : options.stateChannelId;
      }
    },
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix: "approval:",
    isGeneralChannel: options.isGeneralChannel ?? (() => false),
    extractThreadId: (params: Record<string, unknown>) => {
      if (typeof params?.threadId === "string") {
        return params.threadId;
      }
      return null;
    },
    describeToolRequestUserInput,
    buildApprovalActionRows,
    buildResponseForServerRequest: options.buildResponseForServerRequestOverride ?? buildResponseForServerRequest,
    truncateStatusText: (text: string, limit: number) => text.slice(0, limit),
    truncateForDiscordMessage: (text: string) => text,
    safeSendToChannel: async (_channel: unknown, text: string) => {
      sentWarnings.push(text);
      return null;
    },
    createApprovalToken: (() => {
      let next = 1;
      return () => String(next++).padStart(4, "0");
    })()
  });

  return {
    runtime,
    pendingApprovals,
    codexRespondCalls,
    sentWarnings,
    approvalMessages,
    editedApprovalMessages
  };
}

describe("server request runtime integration", () => {
  test("returns unsupported tool call response and warns in channel", async () => {
    const harness = createHarness();

    await harness.runtime.handleServerRequest({
      id: "req-1",
      method: "tool/call",
      params: { threadId: "thread-1", tool: "restart-bot", callId: "call-1" }
    });

    expect(harness.codexRespondCalls.length).toBe(1);
    expect(harness.codexRespondCalls[0]?.id).toBe("req-1");
    expect(harness.codexRespondCalls[0]?.payload?.isError).toBe(true);
    expect(harness.sentWarnings.length).toBe(1);
    expect(harness.sentWarnings[0]).toContain("dynamic tool call is not supported");
  });

  test("deduplicates approval requests by request id", async () => {
    const harness = createHarness();
    const request = {
      id: "req-2",
      method: "commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        command: "git status",
        cwd: "/tmp/repo"
      }
    };

    await harness.runtime.handleServerRequest(request);
    await harness.runtime.handleServerRequest(request);

    expect(harness.pendingApprovals.size).toBe(1);
    expect(harness.approvalMessages.length).toBe(1);
  });

  test("applies approval decisions through shared command/button path", async () => {
    const harness = createHarness();
    harness.pendingApprovals.set("0001", {
      requestId: "req-3",
      method: "item/commandExecution/requestApproval",
      repoChannelId: "channel-1",
      threadId: "thread-1",
      params: { command: "echo hi" },
      approvalMessageId: "approval-msg-1"
    });

    const result = await harness.runtime.applyApprovalDecision("0001", "accept", "<@123>");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result).toEqual({ ok: true });
    expect(harness.pendingApprovals.size).toBe(0);
    expect(harness.codexRespondCalls.length).toBe(1);
    expect(harness.codexRespondCalls[0]?.id).toBe("req-3");
    expect(harness.codexRespondCalls[0]?.payload).toEqual({ decision: "accept" });
    expect(harness.editedApprovalMessages.length).toBe(1);
    expect(String(harness.editedApprovalMessages[0]?.content ?? "")).toContain("Decision: `accept`");
  });

  test("declines file change requests in general read-only channel", async () => {
    const harness = createHarness({
      isGeneralChannel: () => true
    });

    await harness.runtime.handleServerRequest({
      id: "req-4",
      method: "fileChange/requestApproval",
      params: { threadId: "thread-1", reason: "write file" }
    });

    expect(harness.sentWarnings.some((line) => line.includes("Declined file change in #general"))).toBe(true);
    expect(harness.codexRespondCalls.length).toBe(1);
    expect(harness.codexRespondCalls[0]?.payload).toEqual({ decision: "decline" });
  });

  test("responds with fallback when request thread has no mapped channel", async () => {
    const harness = createHarness({ stateChannelId: null });

    await harness.runtime.handleServerRequest({
      id: "req-5",
      method: "commandExecution/requestApproval",
      params: { threadId: "thread-1", command: "echo hi" }
    });

    expect(harness.codexRespondCalls.length).toBe(1);
    expect(harness.codexRespondCalls[0]?.payload).toEqual({ decision: "decline" });
    expect(harness.approvalMessages.length).toBe(0);
  });

  test("returns decision fallback for unhandled request method carrying decision", async () => {
    const harness = createHarness();

    await harness.runtime.handleServerRequest({
      id: "req-6",
      method: "unknown/method",
      params: { decision: "accept" }
    });

    expect(harness.codexRespondCalls.length).toBe(1);
    expect(harness.codexRespondCalls[0]?.payload).toEqual({ decision: "decline" });
  });

  test("returns structured error when approval response builder throws", async () => {
    const harness = createHarness({
      buildResponseForServerRequestOverride: () => {
        throw new Error("response-builder-failed");
      }
    });
    harness.pendingApprovals.set("0002", {
      requestId: "req-7",
      method: "item/commandExecution/requestApproval",
      repoChannelId: "channel-1",
      threadId: "thread-1",
      params: { command: "echo hi" },
      approvalMessageId: null
    });

    const result = await harness.runtime.applyApprovalDecision("0002", "accept", "<@123>");

    expect(result).toEqual({ ok: false, error: "response-builder-failed" });
    expect(harness.pendingApprovals.has("0002")).toBe(true);
  });
});
