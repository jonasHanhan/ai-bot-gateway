import { describe, expect, test } from "bun:test";
import { createRuntimeAdapters } from "../src/app/runtimeAdapters.js";
import { createRuntimeContainer } from "../src/app/runtimeContainer.js";

function makeAdapters(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ type: string; payload: unknown }> = [];
  const attachmentInputBuilder = {
    collectImageAttachments: (message: unknown) => {
      calls.push({ type: "collect", payload: message });
      return [{ id: "img" }];
    },
    buildTurnInputFromMessage: async (message: unknown, text: unknown, imageAttachments: unknown, setup: unknown) => {
      calls.push({ type: "buildInput", payload: { message, text, imageAttachments, setup } });
      return [{ type: "text", text }];
    }
  };
  const runtimeOps = {
    startHeartbeatLoop: () => calls.push({ type: "startHeartbeat", payload: null }),
    writeHeartbeatFile: async () => calls.push({ type: "writeHeartbeat", payload: null }),
    requestSelfRestartFromDiscord: async (message: unknown, reason: unknown) =>
      calls.push({ type: "restart", payload: { message, reason } }),
    maybeCompletePendingRestartNotice: async (discordClient: unknown) => {
      void discordClient;
      calls.push({ type: "completeNotice", payload: null });
    },
    shouldHandleAsSelfRestartRequest: (content: string) => {
      void content;
      return true;
    }
  };
  const turnRunner = {
    enqueuePrompt: (repoChannelId: string, job: unknown) => calls.push({ type: "enqueue", payload: { repoChannelId, job } }),
    getQueue: (repoChannelId: string) => {
      void repoChannelId;
      return ["a"];
    },
    findActiveTurnByRepoChannel: (repoChannelId: string) => {
      void repoChannelId;
      return { threadId: "thread-1" };
    }
  };
  const notificationRuntime = {
    handleNotification: async (event: unknown) => calls.push({ type: "notification", payload: event }),
    onTurnReconnectPending: (threadId: string, context: unknown) =>
      calls.push({ type: "reconnect", payload: { threadId, context } }),
    finalizeTurn: async (threadId: string, error: unknown) => calls.push({ type: "finalize", payload: { threadId, error } })
  };
  const serverRequestRuntime = {
    handleServerRequest: async (request: unknown) => calls.push({ type: "serverRequest", payload: request }),
    findLatestPendingApprovalTokenForChannel: (repoChannelId: string) => {
      void repoChannelId;
      return "0007";
    },
    applyApprovalDecision: async (token: string, decision: string, actorMention: string) => {
      void token;
      void decision;
      void actorMention;
      return { ok: true };
    }
  };
  const discordRuntime = {
    handleMessage: async (message: unknown) => calls.push({ type: "message", payload: message }),
    handleInteraction: async (interaction: unknown) => calls.push({ type: "interaction", payload: interaction })
  };

  const runtimeContainer = createRuntimeContainer();
  const runtimeRefs = {
    runtimeOps,
    turnRunner,
    notificationRuntime,
    serverRequestRuntime,
    discordRuntime,
    ...(typeof overrides.runtimeRefs === "object" && overrides.runtimeRefs
      ? (overrides.runtimeRefs as Record<string, unknown>)
      : {})
  };
  for (const [name, value] of Object.entries(runtimeRefs)) {
    if (value == null) {
      continue;
    }
    runtimeContainer.setRef(name, value);
  }

  const adapters = createRuntimeAdapters({
    attachmentInputBuilder,
    runtimeContainer,
    maybeSendAttachmentsForItemFromService: async (_tracker: unknown, _item: unknown, options: Record<string, unknown>) =>
      calls.push({ type: "attachments", payload: options }),
    maybeSendInferredAttachmentsFromTextFromService: async (
      trackerInput: unknown,
      textInput: string,
      optionsInput: Record<string, unknown>
    ) => {
      void trackerInput;
      void textInput;
      void optionsInput;
      calls.push({ type: "summaryImage", payload: null });
      return 2;
    },
    sendChunkedToChannelFromRenderer: async (channel: unknown, text: string, safeSend: unknown, limit: number) => {
      void channel;
      void text;
      void safeSend;
      void limit;
      calls.push({ type: "sendChunked", payload: null });
    },
    attachmentConfig: {
      attachmentsEnabled: true,
      attachmentItemTypes: new Set(["imageView"]),
      attachmentMaxBytes: 1024,
      attachmentRoots: ["/tmp"],
      imageCacheDir: "/tmp/cache",
      attachmentInferFromText: false,
      attachmentIssueLimitPerTurn: 2
    },
    channelMessagingConfig: {
      statusLabelForItemType: () => "label",
      safeSendToChannel: async () => null,
      safeSendToChannelPayload: async () => null,
      truncateStatusText: (text: string) => text,
      discordMaxMessageLength: 1900
    },
    ...overrides
  });

  return { adapters, calls };
}

describe("runtime adapters", () => {
  test("delegates discord runtime handlers", async () => {
    const { adapters, calls } = makeAdapters();
    await adapters.handleMessage({ id: "m1" });
    await adapters.handleInteraction({ id: "i1" });
    expect(calls.some((entry) => entry.type === "message")).toBe(true);
    expect(calls.some((entry) => entry.type === "interaction")).toBe(true);
  });

  test("delegates runtime ops, queue, notifications, approvals and render helpers", async () => {
    const { adapters, calls } = makeAdapters();
    const message = { id: "msg-1" };
    const interaction = { id: "ix-1" };
    const threadId = "thread-1";
    const channel = { id: "channel-1" };

    adapters.startHeartbeatLoop();
    await adapters.writeHeartbeatFile();
    await adapters.requestSelfRestartFromDiscord(message, "manual");
    await adapters.maybeCompletePendingRestartNotice();
    expect(adapters.shouldHandleAsSelfRestartRequest("please restart")).toBe(true);

    await adapters.handleMessage(message);
    await adapters.handleInteraction(interaction);

    expect(adapters.collectImageAttachments(message)).toEqual([{ id: "img" }]);
    await adapters.buildTurnInputFromMessage(message, "hello", [{ id: "img-1" }], { setup: true });
    adapters.enqueuePrompt("repo-1", { prompt: "hello" });
    expect(adapters.getQueue("repo-1")).toEqual(["a"]);
    expect(adapters.findActiveTurnByRepoChannel("repo-1")).toEqual({ threadId: "thread-1" });

    await adapters.handleNotification({ method: "m", params: { ok: true } });
    adapters.onTurnReconnectPending(threadId, { retry: true });
    await adapters.handleServerRequest({ id: "r-1", method: "approve", params: { token: "0001" } });
    expect(adapters.findLatestPendingApprovalTokenForChannel("repo-1")).toBe("0007");
    expect(await adapters.applyApprovalDecision("0001", "approve", "@howii")).toEqual({ ok: true });
    await adapters.finalizeTurn(threadId, null);

    await adapters.maybeSendAttachmentsForItem({ allowFileWrites: true }, { type: "imageView" });
    expect(await adapters.maybeSendInferredAttachmentsFromText({ allowFileWrites: true }, "/tmp/final.png")).toBe(2);
    await adapters.sendChunkedToChannel(channel, "hello world");

    expect(calls.some((entry) => entry.type === "startHeartbeat")).toBe(true);
    expect(calls.some((entry) => entry.type === "writeHeartbeat")).toBe(true);
    expect(calls.some((entry) => entry.type === "restart")).toBe(true);
    expect(calls.some((entry) => entry.type === "completeNotice")).toBe(true);
    expect(calls.some((entry) => entry.type === "collect")).toBe(true);
    expect(calls.some((entry) => entry.type === "buildInput")).toBe(true);
    expect(calls.some((entry) => entry.type === "enqueue")).toBe(true);
    expect(calls.some((entry) => entry.type === "notification")).toBe(true);
    expect(calls.some((entry) => entry.type === "reconnect")).toBe(true);
    expect(calls.some((entry) => entry.type === "serverRequest")).toBe(true);
    expect(calls.some((entry) => entry.type === "finalize")).toBe(true);
    expect(calls.some((entry) => entry.type === "attachments")).toBe(true);
    expect(calls.some((entry) => entry.type === "summaryImage")).toBe(true);
    expect(calls.some((entry) => entry.type === "sendChunked")).toBe(true);
  });

  test("throws when approval runtime is unavailable", async () => {
    const { adapters } = makeAdapters({
      runtimeRefs: {
        serverRequestRuntime: null
      }
    });
    await expect(adapters.applyApprovalDecision("0001", "accept", "@user")).rejects.toThrow(
      "serverRequestRuntime"
    );
  });

  test("forces attachment issue suppression for read-only turns", async () => {
    const { adapters, calls } = makeAdapters();
    await adapters.maybeSendAttachmentsForItem({ allowFileWrites: false }, { type: "imageView" });
    const attachmentCall = calls.find((entry) => entry.type === "attachments");
    expect(attachmentCall).toBeDefined();
    const options = (attachmentCall?.payload ?? {}) as Record<string, unknown>;
    expect(options.maxAttachmentIssueMessages).toBe(0);
  });

  test("throws explicit initialization error when required runtimes are missing", async () => {
    const { adapters } = makeAdapters({
      runtimeRefs: {
        runtimeOps: null,
        turnRunner: null,
        notificationRuntime: null,
        serverRequestRuntime: null,
        discordRuntime: null
      }
    });

    expect(() => adapters.startHeartbeatLoop()).toThrow("runtimeOps");
    expect(() => adapters.enqueuePrompt("repo-1", { prompt: "noop" })).toThrow("turnRunner");
    await expect(adapters.handleNotification({ method: "noop", params: {} })).rejects.toThrow("notificationRuntime");
    await expect(adapters.handleServerRequest({ id: "noop", method: "noop", params: {} })).rejects.toThrow(
      "serverRequestRuntime"
    );
    await expect(adapters.handleMessage({ id: "msg-1" })).rejects.toThrow("before platform runtimes are attached");
  });
});
