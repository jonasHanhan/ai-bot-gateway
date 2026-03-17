export function createServerRequestRuntime(deps) {
  const {
    codex,
    discord,
    state,
    activeTurns,
    pendingApprovals,
    approvalButtonPrefix,
    isGeneralChannel,
    fetchChannelByRouteId,
    extractThreadId,
    describeToolRequestUserInput,
    buildApprovalActionRows,
    buildResponseForServerRequest,
    truncateStatusText,
    truncateForDiscordMessage,
    safeSendToChannel,
    createApprovalToken
  } = deps;
  const fetchRouteChannel =
    typeof fetchChannelByRouteId === "function"
      ? fetchChannelByRouteId
      : async (routeId) => await discord?.channels?.fetch?.(routeId).catch(() => null);

  const buildFallbackResponseForServerRequest = (method, params) =>
    buildResponseForServerRequest(method, params, "decline");

  const buildBestEffortServerRequestResponse = (resolvedMethod, originalMethod, params) => {
    if (
      resolvedMethod === "item/tool/call" ||
      originalMethod === "item/tool/call" ||
      originalMethod === "tool/call"
    ) {
      return buildUnsupportedToolCallResponse(originalMethod);
    }
    if (resolvedMethod === "item/tool/requestUserInput" || Array.isArray(params?.questions)) {
      return buildResponseForServerRequest("item/tool/requestUserInput", params, "decline");
    }
    if (
      resolvedMethod === "item/commandExecution/requestApproval" ||
      resolvedMethod === "item/fileChange/requestApproval" ||
      resolvedMethod === "execCommandApproval" ||
      resolvedMethod === "applyPatchApproval"
    ) {
      return buildFallbackResponseForServerRequest(resolvedMethod, params);
    }
    if (typeof params?.decision === "string") {
      return { decision: "decline" };
    }
    return {};
  };

  async function handleServerRequest({ id, method, params }) {
    const resolvedMethod = resolveServerRequestMethod(method, params);
    console.log(
      `[approval:request] method=${method} resolved=${resolvedMethod} requestId=${String(id)} requestIdType=${typeof id}`
    );

    if (resolvedMethod === "item/tool/call") {
      const threadId = extractThreadId(params);
      const repoChannelId = threadId ? findRepoChannelIdByCodexThreadId(threadId) : null;
      if (repoChannelId) {
        const channel = await fetchRouteChannel(repoChannelId).catch(() => null);
        if (channel && channel.isTextBased()) {
          const toolName = typeof params?.tool === "string" ? params.tool : "unknown-tool";
          await safeSendToChannel(
            channel,
            `⚠️ dynamic tool call is not supported in this bridge (\`${toolName}\`). Returning failure to Codex.`
          );
        }
      }
      codex.respond(id, buildUnsupportedToolCallResponse(method));
      return;
    }

    if (!isApprovalLikeServerRequestMethod(resolvedMethod)) {
      console.warn(`[approval:request] unhandled method=${method} resolved=${resolvedMethod} requestId=${String(id)}`);
      const bestEffort = buildBestEffortServerRequestResponse(resolvedMethod, method, params);
      codex.respond(id, bestEffort);
      return;
    }

    const threadId = extractThreadId(params);
    const repoChannelId = threadId ? findRepoChannelIdByCodexThreadId(threadId) : null;
    if (!repoChannelId) {
      codex.respond(id, buildFallbackResponseForServerRequest(resolvedMethod, params));
      return;
    }

    const channel = await fetchRouteChannel(repoChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      codex.respond(id, buildFallbackResponseForServerRequest(resolvedMethod, params));
      return;
    }
    if (
      resolvedMethod === "item/fileChange/requestApproval" &&
      (channel?.bridgeMeta?.allowFileWrites === false || isGeneralChannel(channel))
    ) {
      await safeSendToChannel(channel, "Declined file change in #general (read-only mode).");
      codex.respond(id, buildResponseForServerRequest(resolvedMethod, params, "decline"));
      return;
    }

    const existingToken = findPendingApprovalTokenByRequestId(id);
    const token = existingToken ?? createApprovalToken();
    if (!existingToken) {
      pendingApprovals.set(token, {
        requestId: id,
        method: resolvedMethod,
        repoChannelId,
        threadId,
        params,
        approvalMessageId: null
      });
    }

    const detailLines = [];
    if (typeof params?.reason === "string" && params.reason) {
      detailLines.push(`reason: ${params.reason}`);
    }
    detailLines.push(...formatApprovalCommandLines(params?.command, truncateStatusText));
    if (typeof params?.cwd === "string" && params.cwd) {
      detailLines.push(`cwd: \`${params.cwd}\``);
    }
    if (typeof params?.callId === "string" && params.callId) {
      detailLines.push(`call id: \`${params.callId}\``);
    }
    if (typeof params?.toolCallId === "string" && params.toolCallId) {
      detailLines.push(`tool call id: \`${params.toolCallId}\``);
    }
    if (resolvedMethod === "item/tool/requestUserInput") {
      detailLines.push(...describeToolRequestUserInput(params));
    }

    if (existingToken) {
      console.warn(`[approval:request] duplicate requestId=${String(id)} token=${token} threadId=${threadId ?? "n/a"}`);
      return;
    }

    console.log(
      `[approval:request] queued method=${resolvedMethod} token=${token} requestId=${String(id)} channelId=${repoChannelId} threadId=${threadId ?? "n/a"}`
    );

    const supportsApprovalButtons = channel?.platform !== "feishu";
    const approvalContent = truncateForDiscordMessage(
      [
        `Approval requested: \`${resolvedMethod}\``,
        supportsApprovalButtons
          ? `Use buttons below (or \`!approve ${token}\` / \`!decline ${token}\` / \`!cancel ${token}\`)`
          : `Reply \`!approve ${token}\`, \`!decline ${token}\`, or \`!cancel ${token}\` in this chat to continue.`,
        ...detailLines
      ].join("\n")
    );
    const approvalPayload = {
      content: approvalContent
    };
    if (supportsApprovalButtons) {
      approvalPayload.components = buildApprovalActionRows(token, approvalButtonPrefix);
    }
    const approvalMessage = await channel.send(approvalPayload);
    const record = pendingApprovals.get(token);
    if (record) {
      record.approvalMessageId = approvalMessage.id;
    }
  }

  function findLatestPendingApprovalTokenForChannel(repoChannelId) {
    let latest = null;
    for (const [token, approval] of pendingApprovals.entries()) {
      if (approval.repoChannelId === repoChannelId) {
        latest = token;
      }
    }
    return latest;
  }

  async function applyApprovalDecision(token, decision, actorMention) {
    const approval = pendingApprovals.get(token);
    if (!approval) {
      return { ok: false, error: `No pending approval with id ${token}.` };
    }

    try {
      const response = buildResponseForServerRequest(approval.method, approval.params, decision);
      console.log(
        `[approval:decision] method=${approval.method} token=${token} requestId=${String(approval.requestId)} requestIdType=${typeof approval.requestId} decision=${decision}`
      );
      codex.respond(approval.requestId, response);
    } catch (error) {
      return { ok: false, error: error.message };
    }

    pendingApprovals.delete(token);
    void markApprovalResolved(approval, token, decision, actorMention);
    return { ok: true };
  }

  async function markApprovalResolved(approval, token, decision, actorMention) {
    if (!approval?.approvalMessageId) {
      return;
    }
    const channel = await fetchRouteChannel(approval.repoChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return;
    }
    const approvalMessage = await channel.messages.fetch(approval.approvalMessageId).catch(() => null);
    if (!approvalMessage) {
      return;
    }
    const statusLine = `Decision: \`${decision}\` by ${actorMention}`;
    const previous = typeof approvalMessage.content === "string" ? approvalMessage.content : "";
    const content = previous.includes("Decision:") ? previous : `${previous}\n${statusLine}`;
    const editPayload = {
      content
    };
    if (channel?.platform !== "feishu") {
      editPayload.components = buildApprovalActionRows(token, approvalButtonPrefix, {
        disabled: true,
        selectedDecision: decision
      });
    }
    await approvalMessage.edit(editPayload).catch(() => null);
  }

  function findPendingApprovalTokenByRequestId(requestId) {
    const requestKey = makeRpcIdKey(requestId);
    for (const [token, approval] of pendingApprovals.entries()) {
      if (makeRpcIdKey(approval.requestId) === requestKey) {
        return token;
      }
    }
    return null;
  }

  function findRepoChannelIdByCodexThreadId(threadId) {
    const persisted = state.findConversationChannelIdByCodexThreadId(threadId);
    if (persisted) {
      return persisted;
    }
    for (const tracker of activeTurns.values()) {
      if (tracker.threadId === threadId) {
        return tracker.repoChannelId;
      }
    }
    return null;
  }

  return {
    handleServerRequest,
    findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision
  };
}

function resolveServerRequestMethod(method, params) {
  if (typeof method !== "string") {
    return "";
  }

  if (method === "tool/requestUserInput") {
    return "item/tool/requestUserInput";
  }
  if (method === "tool/call") {
    return "item/tool/call";
  }
  if (method === "commandExecution/requestApproval") {
    return "item/commandExecution/requestApproval";
  }
  if (method === "fileChange/requestApproval") {
    return "item/fileChange/requestApproval";
  }

  if (method !== "item/tool/requestUserInput" && Array.isArray(params?.questions)) {
    return "item/tool/requestUserInput";
  }
  if (method !== "item/tool/call" && typeof params?.tool === "string" && typeof params?.callId === "string") {
    return "item/tool/call";
  }

  return method;
}

function isApprovalLikeServerRequestMethod(method) {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "execCommandApproval" ||
    method === "applyPatchApproval"
  );
}

function buildUnsupportedToolCallResponse(originalMethod) {
  const text = "Dynamic tool calls are not supported by agent-gateway.";
  const modern = {
    contentItems: [{ type: "inputText", text }],
    success: false
  };
  const legacy = {
    content: [{ type: "text", text }],
    structuredContent: { error: text },
    isError: true
  };
  if (originalMethod === "tool/call") {
    return legacy;
  }
  return { ...modern, ...legacy };
}

function makeRpcIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function formatApprovalCommandLines(command, truncateStatusText) {
  if (typeof command === "string" && command) {
    return [`command: \`${truncateStatusText(command, 900)}\``];
  }
  if (!Array.isArray(command) || command.length === 0) {
    return [];
  }

  const stringArgs = command.filter((entry) => typeof entry === "string" && entry);
  if (stringArgs.length === 0) {
    return [];
  }

  const lines = ["command argv:"];
  for (let index = 0; index < Math.min(stringArgs.length, 8); index += 1) {
    lines.push(`[${index}] \`${truncateStatusText(stringArgs[index], 240)}\``);
  }
  if (stringArgs.length > 8) {
    lines.push(`... ${stringArgs.length - 8} more args`);
  }
  return lines;
}
