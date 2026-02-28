import { describe, expect, test } from "bun:test";
import {
  buildApprovalActionRows,
  buildResponseForServerRequest,
  describeToolRequestUserInput
} from "../src/codex/approvalPayloads.js";
import { createServerRequestRuntime } from "../src/approvals/serverRequestRuntime.js";

function createHarness() {
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
    isTextBased: () => true,
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
        return threadId === "thread-1" ? "channel-1" : null;
      }
    },
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix: "approval:",
    isGeneralChannel: () => false,
    extractThreadId: (params: Record<string, unknown>) => {
      if (typeof params?.threadId === "string") {
        return params.threadId;
      }
      return null;
    },
    describeToolRequestUserInput,
    buildApprovalActionRows,
    buildResponseForServerRequest,
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
});
