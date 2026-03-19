export function createRuntimeAdapters(deps) {
  const {
    attachmentInputBuilder,
    runtimeContainer,
    maybeSendAttachmentsForItemFromService,
    maybeSendInferredAttachmentsFromTextFromService,
    sendChunkedToChannelFromRenderer,
    attachmentConfig,
    channelMessagingConfig
  } = deps;

  function attachmentLog(event, details = {}) {
    if (attachmentConfig.attachmentLogEnabled !== true) {
      return;
    }
    let rendered = "";
    try {
      rendered = JSON.stringify(details);
    } catch {
      rendered = String(details);
    }
    console.log(rendered ? `[attachment][${event}] ${rendered}` : `[attachment][${event}]`);
  }

  function getOptionalRuntime(name) {
    return runtimeContainer.getRef(name);
  }

  function getRequiredRuntime(name) {
    return runtimeContainer.requireRef(name);
  }

  function startHeartbeatLoop() {
    getRequiredRuntime("runtimeOps").startHeartbeatLoop();
  }

  async function writeHeartbeatFile() {
    await getRequiredRuntime("runtimeOps").writeHeartbeatFile();
  }

  async function requestSelfRestartFromDiscord(message, reason) {
    await getRequiredRuntime("runtimeOps").requestSelfRestartFromDiscord(message, reason);
  }

  async function maybeCompletePendingRestartNotice() {
    await getRequiredRuntime("runtimeOps").maybeCompletePendingRestartNotice();
  }

  async function announceStartup(readiness) {
    await getRequiredRuntime("runtimeOps").announceStartup({ readiness });
  }

  function shouldHandleAsSelfRestartRequest(content) {
    return getRequiredRuntime("runtimeOps").shouldHandleAsSelfRestartRequest(content);
  }

  async function handleMessage(message) {
    const platformRegistry = getOptionalRuntime("platformRegistry");
    if (platformRegistry?.handleInboundMessage) {
      await platformRegistry.handleInboundMessage(message);
      return;
    }
    const discordRuntime = getOptionalRuntime("discordRuntime");
    if (discordRuntime?.handleMessage) {
      await discordRuntime.handleMessage(message);
      return;
    }
    throw new Error("Runtime adapter cannot handle message before platform runtimes are attached.");
  }

  async function handleInteraction(interaction) {
    const platformRegistry = getOptionalRuntime("platformRegistry");
    if (platformRegistry?.handleInboundInteraction) {
      await platformRegistry.handleInboundInteraction(interaction);
      return;
    }
    const discordRuntime = getOptionalRuntime("discordRuntime");
    if (discordRuntime?.handleInteraction) {
      await discordRuntime.handleInteraction(interaction);
      return;
    }
    throw new Error("Runtime adapter cannot handle interaction before platform runtimes are attached.");
  }

  async function handleChannelCreate(channel) {
    const discordRuntime = getOptionalRuntime("discordRuntime");
    if (discordRuntime?.handleChannelCreate) {
      await discordRuntime.handleChannelCreate(channel);
      return;
    }
    throw new Error("Runtime adapter cannot handle channelCreate before discord runtime is attached.");
  }

  function collectImageAttachments(message) {
    return attachmentInputBuilder.collectImageAttachments(message);
  }

  async function buildTurnInputFromMessage(message, text, imageAttachments, setup = null) {
    return await attachmentInputBuilder.buildTurnInputFromMessage(message, text, imageAttachments, setup);
  }

  function enqueuePrompt(repoChannelId, job) {
    getRequiredRuntime("turnRunner").enqueuePrompt(repoChannelId, job);
  }

  function getQueue(repoChannelId) {
    return getRequiredRuntime("turnRunner").getQueue(repoChannelId);
  }

  async function handleNotification({ method, params }) {
    await getRequiredRuntime("notificationRuntime").handleNotification({ method, params });
  }

  function onTurnReconnectPending(threadId, context = {}) {
    getRequiredRuntime("notificationRuntime").onTurnReconnectPending(threadId, context);
  }

  async function handleServerRequest({ id, method, params }) {
    await getRequiredRuntime("serverRequestRuntime").handleServerRequest({ id, method, params });
  }

  function findLatestPendingApprovalTokenForChannel(repoChannelId) {
    return getRequiredRuntime("serverRequestRuntime").findLatestPendingApprovalTokenForChannel(repoChannelId);
  }

  async function applyApprovalDecision(token, decision, actorMention) {
    return await getRequiredRuntime("serverRequestRuntime").applyApprovalDecision(token, decision, actorMention);
  }

  function findActiveTurnByRepoChannel(repoChannelId) {
    return getRequiredRuntime("turnRunner").findActiveTurnByRepoChannel(repoChannelId);
  }

  async function finalizeTurn(threadId, error) {
    await getRequiredRuntime("notificationRuntime").finalizeTurn(threadId, error);
  }

  async function maybeSendAttachmentsForItem(tracker, item) {
    const maxAttachmentIssueMessages = tracker?.allowFileWrites === false ? 0 : attachmentConfig.attachmentIssueLimitPerTurn;
    await maybeSendAttachmentsForItemFromService(tracker, item, {
      attachmentsEnabled: attachmentConfig.attachmentsEnabled,
      attachmentItemTypes: attachmentConfig.attachmentItemTypes,
      attachmentMaxBytes: attachmentConfig.attachmentMaxBytes,
      attachmentRoots: attachmentConfig.attachmentRoots,
      imageCacheDir: attachmentConfig.imageCacheDir,
      attachmentInferFromText: attachmentConfig.attachmentInferFromText,
      statusLabelForItemType: channelMessagingConfig.statusLabelForItemType,
      safeSendToChannel: channelMessagingConfig.safeSendToChannel,
      safeSendToChannelPayload: channelMessagingConfig.safeSendToChannelPayload,
      truncateStatusText: channelMessagingConfig.truncateStatusText,
      maxAttachmentIssueMessages,
      attachmentLog
    });
  }

  async function maybeSendInferredAttachmentsFromText(tracker, text) {
    return (
      (await maybeSendInferredAttachmentsFromTextFromService(tracker, text, {
        attachmentsEnabled: attachmentConfig.attachmentsEnabled,
        attachmentMaxBytes: attachmentConfig.attachmentMaxBytes,
        attachmentRoots: attachmentConfig.attachmentRoots,
        imageCacheDir: attachmentConfig.imageCacheDir,
        statusLabelForItemType: channelMessagingConfig.statusLabelForItemType,
        safeSendToChannel: channelMessagingConfig.safeSendToChannel,
        safeSendToChannelPayload: channelMessagingConfig.safeSendToChannelPayload,
        truncateStatusText: channelMessagingConfig.truncateStatusText,
        attachmentLog
      })) ?? 0
    );
  }

  function resolveMessageChunkLimit(channel, overrideLimit) {
    if (Number.isFinite(overrideLimit) && overrideLimit > 0) {
      return Math.floor(overrideLimit);
    }
    const platform = String(channel?.platform ?? "").trim().toLowerCase();
    const routeId = String(channel?.id ?? "").trim().toLowerCase();
    const isFeishu = platform === "feishu" || routeId.startsWith("feishu:");
    if (isFeishu && Number.isFinite(channelMessagingConfig.feishuMaxMessageLength)) {
      return Math.max(200, Math.floor(channelMessagingConfig.feishuMaxMessageLength));
    }
    return Math.max(200, Math.floor(channelMessagingConfig.discordMaxMessageLength));
  }

  async function sendChunkedToChannel(channel, text, limit) {
    await sendChunkedToChannelFromRenderer(
      channel,
      text,
      channelMessagingConfig.safeSendToChannel,
      resolveMessageChunkLimit(channel, limit)
    );
  }

  return {
    startHeartbeatLoop,
    writeHeartbeatFile,
    requestSelfRestartFromDiscord,
    maybeCompletePendingRestartNotice,
    announceStartup,
    shouldHandleAsSelfRestartRequest,
    handleMessage,
    handleInteraction,
    handleChannelCreate,
    collectImageAttachments,
    buildTurnInputFromMessage,
    enqueuePrompt,
    getQueue,
    handleNotification,
    onTurnReconnectPending,
    handleServerRequest,
    findLatestPendingApprovalTokenForChannel,
    applyApprovalDecision,
    findActiveTurnByRepoChannel,
    finalizeTurn,
    maybeSendAttachmentsForItem,
    maybeSendInferredAttachmentsFromText,
    sendChunkedToChannel
  };
}
