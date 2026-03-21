import fs from "node:fs/promises";
import path from "node:path";
import * as FeishuSdk from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import { makeFeishuRouteId, parseFeishuRouteId } from "./ids.js";
import { resolveFeishuContext } from "./context.js";
import { isFeishuLongConnectionTransport, isFeishuWebhookTransport, normalizeFeishuTransport } from "./transport.js";
import { buildTurnRequestId } from "../turns/requestId.js";
import { stripAnsi } from "../utils/stripAnsi.js";
import { normalizeRecognizedCommandText, normalizeRecognizedSlashCommandText } from "../commands/commandText.js";
import { getActiveAgentId, setupSupportsImageInput } from "../agents/setupResolution.js";

export function createFeishuRuntime(deps) {
  const {
    config,
    runtimeEnv,
    getChannelSetups,
    runManagedRouteCommand,
    getHelpText,
    isCommandSupportedForPlatform,
    handleCommand,
    handleSetPathCommand,
    runtimeAdapters,
    safeReply,
    feishuSdk = FeishuSdk
  } = deps;
  const {
    feishuEnabled,
    feishuAppId,
    feishuAppSecret,
    feishuVerificationToken,
    feishuTransport,
    feishuWebhookPath,
    imageCacheDir,
    feishuGeneralChatId,
    feishuGeneralCwd,
    feishuRequireMentionInGroup,
    feishuLogIngress,
    feishuEventDedupePath,
    feishuEventDedupeTtlMs,
    feishuUnboundChatMode,
    feishuUnboundChatCwd,
    feishuStatusReactions
  } = runtimeEnv;
  const seenEventIds = new Map();
  const sentMessages = new Map();
  const recentOutgoingTextByChat = new Map();
  const inboundMessageChainsByRoute = new Map();
  let persistSeenEventsTimer = null;
  const seenEventsPersistPath =
    typeof feishuEventDedupePath === "string" && feishuEventDedupePath.trim()
      ? feishuEventDedupePath
      : "";
  const seenEventsTtlMs =
    Number.isFinite(feishuEventDedupeTtlMs) && feishuEventDedupeTtlMs > 0
      ? feishuEventDedupeTtlMs
      : 24 * 60 * 60 * 1000;
  const transport = normalizeFeishuTransport(feishuTransport);
  const proxyUrl = getProxyUrl();
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
  let wsClient = null;
  let tenantAccessToken = "";
  let tenantAccessTokenExpiresAt = 0;

  function logInboundIngress(decision, fields = {}, { warn = false, force = false } = {}) {
    if (!feishuLogIngress && !force) {
      return;
    }
    const rendered = Object.entries(fields)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim() : String(value ?? "").trim()])
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    const line = rendered ? `[feishu][${decision}] ${rendered}` : `[feishu][${decision}]`;
    if (warn) {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  async function fetchChannelByRouteId(routeId) {
    const chatId = parseFeishuRouteId(routeId);
    if (!chatId) {
      return null;
    }
    return createChannel(chatId, { routeId });
  }

  async function handleHttpRequest(request, response, options = {}) {
    const method = String(request.method ?? "").toUpperCase();
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (!isFeishuWebhookTransport(transport) || method !== "POST" || pathname !== feishuWebhookPath) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 404, msg: "not found" }));
      return;
    }

    let payload;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 400, msg: "invalid json" }));
      return;
    }

    if (isUrlVerification(payload)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    if (!isValidVerificationToken(payload)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 403, msg: "invalid token" }));
      return;
    }

    if (options.ready === false) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 503, msg: "bridge not ready" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ code: 0 }));

    try {
      await processEventPayload(payload);
    } catch (error) {
      console.error(`feishu event processing failed: ${error.message}`);
    }
  }

  async function processEventPayload(payload) {
    const eventType = String(payload?.header?.event_type ?? "");
    const eventId = String(payload?.header?.event_id ?? payload?.event_id ?? "").trim();
    if (eventType === "im.message.receive_v1") {
      await processMessageReceiveEventOrdered(payload?.event, { eventId });
      return;
    }
    if (eventType === "im.chat.member.bot.added_v1") {
      await processBotAddedEvent(payload?.event, { eventId });
    }
  }

  async function processMessageReceiveEvent(event, options = {}) {
    const eventId = String(options?.eventId ?? "").trim() || buildLongConnectionEventId(event);
    const message = event?.message;
    const senderType = String(event?.sender?.sender_type ?? "");
    const senderOpenId = String(event?.sender?.sender_id?.open_id ?? "").trim();
    const chatId = String(message?.chat_id ?? "").trim();
    const chatType = String(message?.chat_type ?? "").trim();
    const messageId = String(message?.message_id ?? "").trim();
    const routeId = chatId ? makeFeishuRouteId(chatId) : "";
    const messageType = normalizeIncomingMessageType(message?.message_type);
    const rawText =
      messageType === "text" || messageType === "post"
        ? normalizeIncomingText(extractTextMessageContent(message?.content, messageType))
        : "";
    const ingressFields = {
      eventId,
      routeId,
      chatId,
      chatType,
      messageId,
      senderOpenId,
      senderType,
      messageType: messageType || String(message?.message_type ?? ""),
      textPreview: summarizeInboundText(rawText)
    };

    if (eventId && (await markEventSeen(eventId))) {
      logInboundIngress("drop_duplicate", ingressFields);
      return;
    }

    if (senderType && senderType !== "user") {
      logInboundIngress("drop_sender_type", {
        ...ingressFields,
        reason: "sender is not a user"
      });
      return;
    }

    if (!messageType) {
      logInboundIngress("drop_message_type", {
        ...ingressFields,
        reason: "unsupported message type"
      });
      return;
    }

    if (!isAllowedUser(senderOpenId)) {
      logInboundIngress(
        "drop_filtered_user",
        {
          ...ingressFields,
          reason: "sender_open_id is not allowed"
        },
        { warn: true, force: true }
      );
      return;
    }

    const channel = createChannel(message.chat_id, {
      chatType: message.chat_type,
      sourceMessageId: message.message_id
    });
    const inboundMessage = createInboundMessage({
      messageId: message.message_id,
      senderOpenId,
      channel,
      text:
        messageType === "text" || messageType === "post"
          ? normalizeIncomingText(extractTextMessageContent(message.content, messageType))
          : messageType === "file"
            ? "[file]"
            : "[image]"
    });

    if (messageType === "image") {
      await handleInboundImageMessage({ inboundMessage, senderOpenId, message });
      return;
    }
    if (messageType === "file") {
      await handleInboundFileMessage({ inboundMessage, senderOpenId, message });
      return;
    }

    const text = rawText;
    if (!text) {
      logInboundIngress("drop_empty_text", {
        ...ingressFields,
        reason: "normalized text is empty"
      });
      return;
    }
    const handlingDecision = resolveIncomingHandlingDecision(message, text, feishuRequireMentionInGroup);
    if (!handlingDecision.allowed) {
      logInboundIngress("drop_routing", {
        ...ingressFields,
        reason: handlingDecision.reason
      });
      return;
    }
    const resolvedText = resolveQuickReplySelectionText(message.chat_id, text);

    const normalizedCommand = normalizeCommandText(resolvedText);
    if (normalizedCommand === "!help") {
      logInboundIngress("command_help", {
        ...ingressFields,
        command: normalizedCommand
      });
      await safeReply(inboundMessage, getHelpText({ platformId: "feishu" }));
      return;
    }

    if (normalizedCommand === "!where") {
      logInboundIngress("command_where", {
        ...ingressFields,
        command: normalizedCommand
      });
      const context = resolveFeishuContext(inboundMessage, buildFeishuContextOptions());
      await safeReply(
        inboundMessage,
        buildFeishuWhereText({
          inboundMessage,
          senderOpenId,
          context,
          bindingKind: getFeishuBindingKind({
            routeId: inboundMessage.channelId,
            context
          })
        })
      );
      return;
    }

    if (normalizedCommand.startsWith("!joinbot") || normalizedCommand.startsWith("!addbot")) {
      const chatIdArg = normalizedCommand.replace(/^!(?:joinbot|addbot)\b/i, "").trim();
      const targetChatId = resolveTargetChatId(chatIdArg, message.chat_id);
      if (!targetChatId) {
        await safeReply(
          inboundMessage,
          [
            "Usage: `/joinbot <chat_id|feishu:chat_id>`",
            "Example: `/joinbot oc_xxxxxxxxx`"
          ].join("\n")
        );
        return;
      }

      if (!feishuAppId) {
        await safeReply(inboundMessage, "Missing `FEISHU_APP_ID`; cannot invite the current app bot.");
        return;
      }

      try {
        const inviteResult = await inviteCurrentAppBotToChat(targetChatId);
        const lines = [
          `Bot invite request sent for chat_id: \`${targetChatId}\``,
          `bot_app_id: \`${feishuAppId}\``
        ];
        if (inviteResult.invalidIdList.length > 0) {
          lines.push(`invalid_id_list: \`${inviteResult.invalidIdList.join(", ")}\``);
        }
        if (inviteResult.notExistedIdList.length > 0) {
          lines.push(`not_existed_id_list: \`${inviteResult.notExistedIdList.join(", ")}\``);
        }
        if (inviteResult.pendingApprovalIdList.length > 0) {
          lines.push(`pending_approval_id_list: \`${inviteResult.pendingApprovalIdList.join(", ")}\``);
        }
        lines.push("If membership did not change, confirm bot capability + chat member permissions in Feishu app settings.");
        await safeReply(inboundMessage, lines.join("\n"));
      } catch (error) {
        await safeReply(
          inboundMessage,
          [
            `Failed to invite current app bot into chat \`${targetChatId}\`.`,
            `reason: ${error.message}`
          ].join("\n")
        );
      }
      return;
    }

    if (normalizedCommand.startsWith("!setpath")) {
      logInboundIngress("command_setpath", {
        ...ingressFields,
        command: normalizedCommand
      });
      const rest = normalizedCommand.replace(/^!setpath\b/i, "").trim();
      await handleSetPathCommand(inboundMessage, rest);
      return;
    }

    if (normalizedCommand === "!resync") {
      logInboundIngress("command_resync", {
        ...ingressFields,
        command: normalizedCommand
      });
      await runManagedRouteCommand(inboundMessage, { forceRebuild: false });
      return;
    }

    if (normalizedCommand === "!rebuild") {
      logInboundIngress("command_rebuild", {
        ...ingressFields,
        command: normalizedCommand
      });
      await runManagedRouteCommand(inboundMessage, { forceRebuild: true });
      return;
    }

    if (normalizedCommand.startsWith("!initrepo")) {
      if (!isCommandSupportedForPlatform?.("initrepo", "feishu")) {
        await safeReply(
          inboundMessage,
          "This platform does not support `initrepo`. Add `feishu:<chat_id>` to `config/channels.json` instead."
        );
        return;
      }
      await safeReply(
        inboundMessage,
        "Feishu chat bindings are config-driven. Add `feishu:<chat_id>` to `config/channels.json` instead of using `!initrepo`."
      );
      return;
    }

    const context = resolveFeishuContext(inboundMessage, buildFeishuContextOptions());
    if (!context) {
      logInboundIngress("reply_unbound_chat", {
        ...ingressFields,
        reason: "chat is not bound and unbound mode is strict"
      });
      await safeReply(
        inboundMessage,
        [
          "This Feishu chat is not bound to a repo.",
          `chat_id: \`${message.chat_id}\``,
          `route_id: \`${makeFeishuRouteId(message.chat_id)}\``,
          `sender_open_id: \`${senderOpenId || "(unknown)"}\``,
          "Add the route_id above to `config/channels.json`, or set `FEISHU_GENERAL_CHAT_ID` for a read-only general chat.",
          "Tip: send `/where` in this chat to inspect identifiers again."
        ].join("\n")
      );
      return;
    }

    if (normalizedCommand.startsWith("!")) {
      logInboundIngress("command_router", {
        ...ingressFields,
        command: normalizedCommand,
        bindingKind: context.setup?.bindingKind ?? ""
      });
      await handleCommand(inboundMessage, normalizedCommand, context);
      return;
    }

    const pendingApprovalToken = runtimeAdapters.findLatestPendingApprovalTokenForChannel?.(context.repoChannelId) ?? null;
    if (pendingApprovalToken) {
      await safeReply(
        inboundMessage,
        [
          `There is a pending approval in this chat: \`${pendingApprovalToken}\`.`,
          `Reply \`!approve ${pendingApprovalToken}\`, \`!decline ${pendingApprovalToken}\`, or \`!cancel ${pendingApprovalToken}\` first.`
        ].join("\n")
      );
      return;
    }

    const preparedPromptText = prepareFeishuPromptText(resolvedText);
    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, preparedPromptText, [], context.setup);
    if (inputItems.length === 0) {
      logInboundIngress("drop_empty_input_items", {
        ...ingressFields,
        bindingKind: context.setup?.bindingKind ?? "",
        reason: "input builder returned no items"
      });
      return;
    }
    logInboundIngress("enqueue_prompt", {
      ...ingressFields,
      bindingKind: context.setup?.bindingKind ?? "",
      repoChannelId: context.repoChannelId,
      promptPreview: summarizeInboundText(preparedPromptText)
    });
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId,
      platform: "feishu",
      requestId: buildTurnRequestId({
        platform: "feishu",
        routeId: context.repoChannelId,
        messageId: inboundMessage.id
      })
    });
  }

  async function processMessageReceiveEventOrdered(event, options = {}) {
    const chatId = String(event?.message?.chat_id ?? "").trim();
    const routeKey = chatId ? makeFeishuRouteId(chatId) : "feishu:unknown";
    const previous = inboundMessageChainsByRoute.get(routeKey) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        await processMessageReceiveEvent(event, options);
      });

    inboundMessageChainsByRoute.set(routeKey, current);
    try {
      await current;
    } finally {
      if (inboundMessageChainsByRoute.get(routeKey) === current) {
        inboundMessageChainsByRoute.delete(routeKey);
      }
    }
  }

  async function processBotAddedEvent(event, options = {}) {
    const eventId =
      String(options?.eventId ?? "").trim() ||
      buildLongConnectionChatEventId("bot-added", event?.chat_id, event?.operator_id?.open_id);
    if (eventId && (await markEventSeen(eventId))) {
      return;
    }

    const chatId = String(event?.chat_id ?? "").trim();
    if (!chatId) {
      return;
    }

    const routeId = makeFeishuRouteId(chatId);
    const context = resolveFeishuContext(
      {
        channelId: routeId
      },
      buildFeishuContextOptions()
    );
    const channel = createChannel(chatId);
    const operatorOpenId = String(event?.operator_id?.open_id ?? "").trim();
    const welcomeText = buildFeishuBotAddedText({
      chatId,
      operatorOpenId,
      context,
      bindingKind: getFeishuBindingKind({ routeId, context }),
      requireMentionInGroup: feishuRequireMentionInGroup
    });
    await channel.send(welcomeText);
  }

  async function handleInboundImageMessage({ inboundMessage, senderOpenId, message }) {
    const handlingDecision = resolveIncomingHandlingDecision(message, "", feishuRequireMentionInGroup);
    if (!handlingDecision.allowed) {
      logInboundIngress("drop_image_routing", {
        routeId: inboundMessage?.channelId ?? "",
        chatId: inboundMessage?.channel?.chatId ?? "",
        chatType: String(message?.chat_type ?? ""),
        messageId: String(message?.message_id ?? ""),
        senderOpenId,
        reason: handlingDecision.reason
      });
      return;
    }

    const context = resolveInboundContext(inboundMessage);
    if (!context) {
      await replyWithUnboundChatMessage(inboundMessage, senderOpenId);
      return;
    }

    let imageAttachment;
    try {
      imageAttachment = await downloadInboundImageAttachment(message);
    } catch (error) {
      console.warn(`failed to download Feishu image ${message?.message_id ?? "(unknown)"}: ${error.message}`);
      await safeReply(inboundMessage, "I could not download that Feishu image. Please try again or send a text prompt instead.");
      return;
    }

    if (!imageAttachment) {
      await safeReply(inboundMessage, "I could not extract an image from that Feishu message.");
      return;
    }

    if (!setupSupportsImageInput(context.setup, config)) {
      const activeAgent = getActiveAgentId(context.setup, config);
      const agentLabel = activeAgent ? `\`${activeAgent}\`` : "current agent";
      await safeReply(
        inboundMessage,
        `Image input is not supported for ${agentLabel}. Switch agent with \`!setagent <agent-id>\` or send text only.`
      );
      return;
    }

    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, "", [imageAttachment], context.setup);
    if (inputItems.length === 0) {
      await safeReply(inboundMessage, "I received the image but could not build a Codex input from it.");
      return;
    }
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId,
      platform: "feishu",
      requestId: buildTurnRequestId({
        platform: "feishu",
        routeId: context.repoChannelId,
        messageId: inboundMessage.id
      })
    });
  }

  async function handleInboundFileMessage({ inboundMessage, senderOpenId, message }) {
    const handlingDecision = resolveIncomingHandlingDecision(message, "", feishuRequireMentionInGroup);
    if (!handlingDecision.allowed) {
      logInboundIngress("drop_file_routing", {
        routeId: inboundMessage?.channelId ?? "",
        chatId: inboundMessage?.channel?.chatId ?? "",
        chatType: String(message?.chat_type ?? ""),
        messageId: String(message?.message_id ?? ""),
        senderOpenId,
        reason: handlingDecision.reason
      });
      return;
    }

    const context = resolveInboundContext(inboundMessage);
    if (!context) {
      await replyWithUnboundChatMessage(inboundMessage, senderOpenId);
      return;
    }

    let fileAttachment;
    try {
      fileAttachment = await downloadInboundFileAttachment(message);
    } catch (error) {
      console.warn(`failed to download Feishu file ${message?.message_id ?? "(unknown)"}: ${error.message}`);
      await safeReply(inboundMessage, "I could not download that Feishu file. Please try again or send the path manually.");
      return;
    }

    if (!fileAttachment) {
      await safeReply(inboundMessage, "I could not extract a file from that Feishu message.");
      return;
    }

    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, "", [fileAttachment], context.setup);
    if (inputItems.length === 0) {
      await safeReply(inboundMessage, "I received the file but could not build a Codex input from it.");
      return;
    }
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId,
      platform: "feishu",
      requestId: buildTurnRequestId({
        platform: "feishu",
        routeId: context.repoChannelId,
        messageId: inboundMessage.id
      })
    });
  }

  async function start() {
    if (!feishuEnabled) {
      return {
        started: false,
        transport
      };
    }

    await loadSeenEventsFromDisk();

    if (!isFeishuLongConnectionTransport(transport)) {
      return {
        started: true,
        transport,
        webhookPath: feishuWebhookPath
      };
    }

    if (wsClient) {
      return {
        started: true,
        transport
      };
    }

    const wsOptions = {
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      loggerLevel: feishuSdk.LoggerLevel?.warn
    };

    if (proxyAgent) {
      wsOptions.agent = proxyAgent;
      if (feishuSdk.defaultHttpInstance?.defaults) {
        feishuSdk.defaultHttpInstance.defaults.proxy = false;
        feishuSdk.defaultHttpInstance.defaults.httpAgent = proxyAgent;
        feishuSdk.defaultHttpInstance.defaults.httpsAgent = proxyAgent;
      }
      wsOptions.httpInstance = feishuSdk.defaultHttpInstance;
    }

    wsClient = new feishuSdk.WSClient(wsOptions);
    const eventDispatcher = new feishuSdk.EventDispatcher({
      verificationToken: feishuVerificationToken || undefined,
      loggerLevel: feishuSdk.LoggerLevel?.warn
    }).register({
      "im.message.receive_v1": async (event) => {
        await processMessageReceiveEventOrdered(event, {
          eventId: String(event?.event_id ?? "")
        });
      },
      "im.chat.member.bot.added_v1": async (event) => {
        await processBotAddedEvent(event, {
          eventId: String(event?.event_id ?? "")
        });
      }
    });

    await wsClient.start({ eventDispatcher });

    return {
      started: true,
      transport
    };
  }

  function stop() {
    flushSeenEventsToDisk().catch(() => {});
    if (persistSeenEventsTimer) {
      clearTimeout(persistSeenEventsTimer);
      persistSeenEventsTimer = null;
    }
    wsClient?.close?.({ force: true });
    wsClient = null;
  }

  function createChannel(chatId, options = {}) {
    const routeId = String(options.routeId ?? makeFeishuRouteId(chatId)).trim() || makeFeishuRouteId(chatId);
    const bindingKind = resolveFeishuBindingKind(routeId);
    const isWritable = bindingKind === "repo";
    return {
      id: routeId,
      chatId,
      platform: "feishu",
      supportsMessageEdits: false,
      bridgeMeta: {
        mode: isWritable ? "repo" : "general",
        bindingKind,
        allowFileWrites: isWritable
      },
      isTextBased() {
        return true;
      },
      async send(payload) {
        return await sendOutgoingPayload({
          chatId,
          payload,
          replyToMessageId: options.sourceMessageId
        });
      },
      async replyToMessage(messageId, payload) {
        return await sendOutgoingPayload({
          chatId,
          payload,
          replyToMessageId: messageId
        });
      },
      async addReaction(messageId, reaction) {
        return await addReactionToMessage(messageId, reaction);
      },
      messages: {
        fetch: async (messageId) => sentMessages.get(String(messageId)) ?? null,
        edit: async (messageId, payload) => {
          const existing = sentMessages.get(String(messageId));
          if (!existing) {
            return null;
          }
          return await existing.edit(payload);
        },
        react: async (messageId, reaction) => {
          return await addReactionToMessage(messageId, reaction);
        }
      }
    };
  }

  function createInboundMessage({ messageId, senderOpenId, channel, text }) {
    return {
      id: messageId,
      platform: "feishu",
      content: text,
      author: {
        id: senderOpenId,
        bot: false
      },
      channel,
      channelId: channel.id,
      attachments: new Map(),
      async reply(payload) {
        return await sendOutgoingPayload({
          chatId: channel.chatId,
          payload,
          replyToMessageId: messageId
        });
      },
      async react(reaction) {
        return await addReactionToMessage(messageId, reaction);
      }
    };
  }

  async function sendTextMessage({ chatId, text, replyToMessageId }) {
    const normalizedText = stripAnsi(String(text ?? "")).trim();
    if (!normalizedText) {
      return null;
    }
    const outgoing = buildOutgoingTextEnvelope(normalizedText);
    const sent = await sendStructuredMessage({
      chatId,
      msgType: outgoing.msgType,
      content: outgoing.content,
      replyToMessageId,
      displayText: outgoing.displayText
    });
    rememberOutgoingText(chatId, outgoing.displayText);
    return sent;
  }

  async function sendImageMessage({ chatId, imageKey, replyToMessageId }) {
    if (!imageKey) {
      return null;
    }
    return await sendStructuredMessage({
      chatId,
      msgType: "image",
      content: {
        image_key: imageKey
      },
      replyToMessageId
    });
  }

  async function sendFileMessage({ chatId, fileKey, replyToMessageId }) {
    if (!fileKey) {
      return null;
    }
    return await sendStructuredMessage({
      chatId,
      msgType: "file",
      content: {
        file_key: fileKey
      },
      replyToMessageId
    });
  }

  async function sendStructuredMessage({ chatId, msgType, content, replyToMessageId, displayText = "" }) {
    let response;
    if (replyToMessageId) {
      response = await feishuRequest(`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: "POST",
        body: {
          msg_type: msgType,
          content: JSON.stringify(content)
        }
      });
    } else {
      response = await feishuRequest(`/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        body: {
          receive_id: chatId,
          msg_type: msgType,
          content: JSON.stringify(content)
        }
      });
    }

    const messageId =
      String(response?.data?.message_id ?? response?.message_id ?? "").trim() ||
      `feishu-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = createChannel(chatId, {
      sourceMessageId: replyToMessageId
    });
    const sent = {
      id: messageId,
      platform: "feishu",
      supportsEdits: false,
      content: displayText || (msgType === "text" ? String(content?.text ?? "").trim() : JSON.stringify(content)),
      channel,
      channelId: channel.id,
      async edit(payload) {
        throw new Error("Feishu message editing is not supported");
      },
      async react(reaction) {
        return await addReactionToMessage(messageId, reaction);
      }
    };
    sentMessages.set(messageId, sent);
    return sent;
  }

  async function sendOutgoingPayload({ chatId, payload, replyToMessageId }) {
    if (typeof payload === "string" || !payload || typeof payload !== "object") {
      return await sendTextMessage({
        chatId,
        text: extractOutgoingText(payload),
        replyToMessageId
      });
    }

    const text = extractOutgoingContentText(payload);
    const files = Array.isArray(payload.files) ? payload.files : [];
    let lastMessage = null;

    if (text) {
      lastMessage = await sendTextMessage({
        chatId,
        text,
        replyToMessageId
      });
    }

    if (files.length === 0) {
      return lastMessage;
    }

    const unsupportedNames = [];
    for (const file of files) {
      const resolved = resolveOutgoingFile(file);
      if (!resolved?.filePath) {
        const fallbackName = resolved?.name || extractOutgoingFileName(file) || "attachment";
        unsupportedNames.push(fallbackName);
        continue;
      }

      try {
        if (isImageFilePath(resolved.filePath, resolved.name)) {
          const imageKey = await uploadImageAttachment(resolved.filePath, resolved.name);
          const sentImage = await sendImageMessage({
            chatId,
            imageKey,
            replyToMessageId
          });
          if (sentImage) {
            lastMessage = sentImage;
          }
          continue;
        }

        const fileKey = await uploadFileAttachment(resolved.filePath, resolved.name);
        const sentFile = await sendFileMessage({
          chatId,
          fileKey,
          replyToMessageId
        });
        if (sentFile) {
          lastMessage = sentFile;
        }
      } catch (error) {
        console.warn(`failed to upload Feishu attachment ${resolved.filePath}: ${error.message}`);
        unsupportedNames.push(resolved.name || path.basename(resolved.filePath));
      }
    }

    if (unsupportedNames.length > 0) {
      const notice = `Unsupported outbound attachments on Feishu: ${unsupportedNames.join(", ")}`;
      const fallbackMessage = await sendTextMessage({
        chatId,
        text: notice,
        replyToMessageId
      });
      if (fallbackMessage) {
        lastMessage = fallbackMessage;
      }
    }

    return lastMessage;
  }

  async function uploadImageAttachment(filePath, fileName = "") {
    const bytes = await fs.readFile(filePath);
    if (bytes.length === 0) {
      throw new Error("empty file");
    }

    const form = new FormData();
    form.set("image_type", "message");
    form.set("image", new Blob([bytes]), fileName || path.basename(filePath));

    const payload = await feishuMultipartRequest("/open-apis/im/v1/images", form);
    const imageKey = String(payload?.data?.image_key ?? payload?.image_key ?? "").trim();
    if (!imageKey) {
      throw new Error("missing image_key");
    }
    return imageKey;
  }

  async function uploadFileAttachment(filePath, fileName = "") {
    const bytes = await fs.readFile(filePath);
    if (bytes.length === 0) {
      throw new Error("empty file");
    }

    const normalizedName = fileName || path.basename(filePath);
    const form = new FormData();
    form.set("file_type", guessFeishuFileType(normalizedName));
    form.set("file_name", normalizedName);
    form.set("file", new Blob([bytes]), normalizedName);

    const payload = await feishuMultipartRequest("/open-apis/im/v1/files", form);
    const fileKey = String(payload?.data?.file_key ?? payload?.file_key ?? "").trim();
    if (!fileKey) {
      throw new Error("missing file_key");
    }
    return fileKey;
  }

  async function feishuRequest(pathname, options = {}) {
    const token = await getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      const code = Number(payload?.code ?? response.status);
      const msg = String(payload?.msg ?? `HTTP ${response.status}`);
      throw new Error(`Feishu API failed (${code}): ${msg}`);
    }
    return payload;
  }

  async function feishuBinaryRequest(pathname, options = {}) {
    const token = await getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${pathname}`, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {})
      }
    });
    if (!response.ok) {
      throw new Error(`Feishu binary API failed (HTTP ${response.status})`);
    }
    return response;
  }

  async function feishuMultipartRequest(pathname, formData, options = {}) {
    const token = await getTenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${pathname}`, {
      method: options.method ?? "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {})
      },
      body: formData
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code ?? 0) !== 0) {
      const code = Number(payload?.code ?? response.status);
      const msg = String(payload?.msg ?? `HTTP ${response.status}`);
      throw new Error(`Feishu multipart API failed (${code}): ${msg}`);
    }
    return payload;
  }

  async function addReactionToMessage(messageId, reaction) {
    const normalizedMessageId = String(messageId ?? "").trim();
    const emojiType = normalizeReactionType(reaction);
    if (!normalizedMessageId || !emojiType) {
      return null;
    }
    const payload = await feishuRequest(`/open-apis/im/v1/messages/${encodeURIComponent(normalizedMessageId)}/reactions`, {
      method: "POST",
      body: {
        reaction_type: {
          emoji_type: emojiType
        }
      }
    });
    return {
      reactionId: String(payload?.data?.reaction_id ?? "").trim() || null,
      emojiType
    };
  }

  async function inviteCurrentAppBotToChat(chatId) {
    const payload = await feishuRequest(
      `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?member_id_type=app_id&succeed_type=1`,
      {
        method: "POST",
        body: {
          id_list: [feishuAppId]
        }
      }
    );

    return {
      invalidIdList: Array.isArray(payload?.data?.invalid_id_list) ? payload.data.invalid_id_list : [],
      notExistedIdList: Array.isArray(payload?.data?.not_existed_id_list) ? payload.data.not_existed_id_list : [],
      pendingApprovalIdList: Array.isArray(payload?.data?.pending_approval_id_list) ? payload.data.pending_approval_id_list : []
    };
  }

  async function getTenantAccessToken() {
    const now = Date.now();
    if (tenantAccessToken && tenantAccessTokenExpiresAt - 60_000 > now) {
      return tenantAccessToken;
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: feishuAppId,
        app_secret: feishuAppSecret
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || Number(payload?.code ?? 0) !== 0 || !payload?.tenant_access_token) {
      const code = Number(payload?.code ?? response.status);
      const msg = String(payload?.msg ?? `HTTP ${response.status}`);
      throw new Error(`Feishu token request failed (${code}): ${msg}`);
    }
    tenantAccessToken = String(payload.tenant_access_token);
    tenantAccessTokenExpiresAt = now + Math.max(60_000, Number(payload?.expire ?? 7200) * 1000);
    return tenantAccessToken;
  }

  function isAllowedUser(openId) {
    if (!Array.isArray(config.allowedFeishuUserIds) || config.allowedFeishuUserIds.length === 0) {
      return true;
    }
    return config.allowedFeishuUserIds.includes(openId);
  }

  function isValidVerificationToken(payload) {
    if (!feishuVerificationToken) {
      return true;
    }
    return String(payload?.token ?? payload?.header?.token ?? "").trim() === feishuVerificationToken;
  }

  function isUrlVerification(payload) {
    return String(payload?.type ?? "").trim() === "url_verification" && typeof payload?.challenge === "string";
  }

  function normalizeReactionType(reaction) {
    if (typeof reaction === "string") {
      return reaction.trim();
    }
    const emojiType = typeof reaction?.emojiType === "string" ? reaction.emojiType.trim() : "";
    if (emojiType) {
      return emojiType;
    }
    const reactionKey = typeof reaction?.key === "string" ? reaction.key.trim() : "";
    if (!reactionKey || !feishuStatusReactions || typeof feishuStatusReactions !== "object") {
      return "";
    }
    const candidate = feishuStatusReactions[reactionKey];
    return typeof candidate === "string" ? candidate.trim() : "";
  }

  async function markEventSeen(eventId) {
    const now = Date.now();
    for (const [key, timestamp] of seenEventIds.entries()) {
      if (now - timestamp > seenEventsTtlMs) {
        seenEventIds.delete(key);
      }
    }
    if (seenEventIds.has(eventId)) {
      return true;
    }
    seenEventIds.set(eventId, now);
    schedulePersistSeenEvents();
    return false;
  }

  function schedulePersistSeenEvents() {
    if (persistSeenEventsTimer) {
      return;
    }
    persistSeenEventsTimer = setTimeout(() => {
      persistSeenEventsTimer = null;
      void flushSeenEventsToDisk();
    }, 1_000);
    if (typeof persistSeenEventsTimer.unref === "function") {
      persistSeenEventsTimer.unref();
    }
  }

  async function loadSeenEventsFromDisk() {
    if (!seenEventsPersistPath) {
      return;
    }
    try {
      const raw = await fs.readFile(seenEventsPersistPath, "utf8");
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.events) ? parsed.events : [];
      const now = Date.now();
      for (const entry of entries) {
        const id = String(entry?.id ?? "").trim();
        const seenAt = Number(entry?.seenAt ?? 0);
        if (!id || !Number.isFinite(seenAt)) {
          continue;
        }
        if (now - seenAt > seenEventsTtlMs) {
          continue;
        }
        seenEventIds.set(id, seenAt);
      }
    } catch {
      // ignore missing/corrupt cache file
    }
  }

  async function flushSeenEventsToDisk() {
    if (!seenEventsPersistPath) {
      return;
    }
    const now = Date.now();
    const compactEntries = [];
    for (const [id, seenAt] of seenEventIds.entries()) {
      if (now - seenAt > seenEventsTtlMs) {
        seenEventIds.delete(id);
        continue;
      }
      compactEntries.push({ id, seenAt });
    }
    const payload = {
      updatedAt: new Date().toISOString(),
      ttlMs: seenEventsTtlMs,
      events: compactEntries.slice(-20_000)
    };
    const dir = path.dirname(seenEventsPersistPath);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const tempPath = `${seenEventsPersistPath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(payload), "utf8").catch(() => {});
    await fs.rename(tempPath, seenEventsPersistPath).catch(() => {});
  }

  function rememberOutgoingText(chatId, text) {
    const normalizedChatId = String(chatId ?? "").trim();
    const normalizedText = String(text ?? "").trim();
    if (!normalizedChatId || !normalizedText) {
      return;
    }
    const now = Date.now();
    for (const [key, entry] of recentOutgoingTextByChat.entries()) {
      if (!entry || now - entry.at > 30 * 60_000) {
        recentOutgoingTextByChat.delete(key);
      }
    }
    recentOutgoingTextByChat.set(normalizedChatId, {
      text: normalizedText,
      at: now
    });
  }

  function resolveQuickReplySelectionText(chatId, text) {
    const normalizedText = String(text ?? "").trim();
    if (!/^\d{1,2}$/.test(normalizedText)) {
      return normalizedText;
    }
    const recent = recentOutgoingTextByChat.get(String(chatId ?? "").trim());
    if (!recent || Date.now() - recent.at > 30 * 60_000) {
      return normalizedText;
    }
    const selectedOptionText = resolveNumberedOptionText(recent.text, normalizedText);
    if (!selectedOptionText) {
      return normalizedText;
    }
    return `选择第${normalizedText}项：${selectedOptionText}`;
  }

  function buildOutgoingTextEnvelope(text) {
    const normalizedText = String(text ?? "").trim();
    if (!normalizedText) {
      return {
        msgType: "text",
        content: { text: "" },
        displayText: ""
      };
    }
    if (shouldRenderMarkdownAsInteractiveCard(normalizedText)) {
      return {
        msgType: "interactive",
        content: buildMarkdownInteractiveCard(normalizedText),
        displayText: normalizedText
      };
    }
    return {
      msgType: "text",
      content: { text: normalizedText },
      displayText: normalizedText
    };
  }

  return {
    enabled: feishuEnabled,
    transport,
    webhookPath: isFeishuWebhookTransport(transport) ? feishuWebhookPath : "",
    fetchChannelByRouteId,
    start,
    stop,
    handleHttpRequest,
    handleEventPayload: processEventPayload
  };

  function resolveInboundContext(inboundMessage) {
    return resolveFeishuContext(inboundMessage, buildFeishuContextOptions());
  }

  function getFeishuBindingKind({ routeId, context }) {
    if (!context) {
      return "none";
    }
    return resolveFeishuBindingKind(routeId);
  }

  function buildFeishuContextOptions() {
    return {
      channelSetups: getChannelSetups(),
      config,
      generalChat: {
        id: feishuGeneralChatId,
        cwd: feishuGeneralCwd
      },
      unboundChat: {
        mode: feishuUnboundChatMode,
        cwd: feishuUnboundChatCwd
      }
    };
  }

  async function replyWithUnboundChatMessage(inboundMessage, senderOpenId) {
    await safeReply(
      inboundMessage,
      [
        "This Feishu chat is not bound to a repo.",
        `chat_id: \`${inboundMessage?.channel?.chatId ?? "(unknown)"}\``,
        `route_id: \`${inboundMessage?.channelId ?? "(unknown)"}\``,
        `sender_open_id: \`${senderOpenId || "(unknown)"}\``,
        "Add the route_id above to `config/channels.json`, or set `FEISHU_GENERAL_CHAT_ID` for a read-only general chat.",
        "Tip: send `/where` in this chat to inspect identifiers again."
      ].join("\n")
    );
  }

  function resolveFeishuBindingKind(routeId) {
    const normalizedRouteId = String(routeId ?? "").trim();
    if (!normalizedRouteId) {
      return "none";
    }
    if (feishuGeneralChatId && normalizedRouteId === makeFeishuRouteId(feishuGeneralChatId)) {
      return "general";
    }
    return getChannelSetups()[normalizedRouteId] ? "repo" : "unbound-open";
  }

  async function downloadInboundImageAttachment(message) {
    const resource = extractMessageResource(message?.content, {
      primaryKeys: ["image_key", "file_key", "key"],
      fallbackNameKeys: ["file_name", "name", "title"]
    });
    if (!resource) {
      return null;
    }

    const response = await feishuBinaryRequest(
      `/open-apis/im/v1/messages/${encodeURIComponent(message.message_id)}/resources/${encodeURIComponent(resource.resourceKey)}?type=image`
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      return null;
    }

    const extension = guessImageExtensionFromHeaders(response.headers, resource.fileName);
    const targetDir = resolveImageCacheDir(imageCacheDir);
    await fs.mkdir(targetDir, { recursive: true });
    const filePath = path.join(
      targetDir,
      `${Date.now()}-${sanitizeFileToken(message.message_id || "feishu")}-${sanitizeFileToken(resource.resourceKey)}${extension}`
    );
    await fs.writeFile(filePath, bytes);
    return {
      path: filePath,
      contentType: response.headers.get("content-type") ?? "image/*",
      name: path.basename(filePath)
    };
  }

  async function downloadInboundFileAttachment(message) {
    const resource = extractMessageResource(message?.content, {
      primaryKeys: ["file_key", "key", "image_key"],
      fallbackNameKeys: ["file_name", "name", "title"]
    });
    if (!resource) {
      return null;
    }

    const response = await feishuBinaryRequest(
      `/open-apis/im/v1/messages/${encodeURIComponent(message.message_id)}/resources/${encodeURIComponent(resource.resourceKey)}?type=file`
    );
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0) {
      return null;
    }

    const targetDir = resolveImageCacheDir(imageCacheDir);
    await fs.mkdir(targetDir, { recursive: true });
    const targetName = buildDownloadedFileName(message, resource, response.headers);
    const filePath = path.join(targetDir, targetName);
    await fs.writeFile(filePath, bytes);
    return {
      kind: "file",
      path: filePath,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      name: path.basename(filePath),
      sizeBytes: bytes.length
    };
  }
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function shouldRenderMarkdownAsInteractiveCard(text) {
  if (typeof text !== "string") {
    return false;
  }
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return (
    /```[\s\S]*```/.test(normalized) ||
    /(^|\n)\s{0,3}#{1,6}\s+\S/.test(normalized) ||
    /(^|\n)\s{0,3}(?:[-*+]\s+\S|\d+\.\s+\S)/.test(normalized) ||
    /(^|\n)\s*>\s+\S/.test(normalized) ||
    /\*\*[^*][\s\S]*?\*\*/.test(normalized) ||
    /__[^_][\s\S]*?__/.test(normalized) ||
    /~~[^~][\s\S]*?~~/.test(normalized) ||
    /\[[^\]]+\]\((?:https?:\/\/|mailto:|\/|\.{1,2}\/|~\/)/.test(normalized)
  );
}

function buildMarkdownInteractiveCard(text) {
  const headerTitle = buildInteractiveCardTitle(text);
  return {
    config: {
      wide_screen_mode: true
    },
    header: {
      template: "blue",
      title: {
        tag: "plain_text",
        content: headerTitle
      }
    },
    elements: [
      {
        tag: "markdown",
        content: text
      }
    ]
  };
}

function buildInteractiveCardTitle(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = lines[0] ?? "";
  const normalized = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/[*_~`[\]()]/g, "")
    .trim();
  if (!normalized) {
    return "Agent Gateway";
  }
  return normalized.slice(0, 60);
}

function extractTextMessageContent(rawContent, messageType = "text") {
  const parsed = parseFeishuMessageContent(rawContent);
  if (!parsed) {
    return "";
  }
  if (messageType === "text") {
    return typeof parsed?.text === "string" ? parsed.text : "";
  }
  if (messageType === "post") {
    return extractPostMessageText(parsed);
  }
  return "";
}

function extractMessageResource(rawContent, options = {}) {
  const parsed = parseFeishuMessageContent(rawContent);
  if (!parsed) {
    return null;
  }
  const resourceKey = findFirstString(parsed, options.primaryKeys ?? ["key"]);
  if (!resourceKey) {
    return null;
  }
  return {
    resourceKey,
    fileName: findFirstString(parsed, options.fallbackNameKeys ?? ["file_name", "name", "title"])
  };
}

function parseFeishuMessageContent(rawContent) {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawContent);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findFirstString(value, candidateKeys) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const queue = [value];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    for (const key of candidateKeys) {
      const candidate = current[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    for (const entry of Object.values(current)) {
      if (entry && typeof entry === "object") {
        queue.push(entry);
      }
    }
  }

  return "";
}

function normalizeIncomingMessageType(messageType) {
  const normalized = String(messageType ?? "").trim().toLowerCase();
  if (normalized === "text" || normalized === "image" || normalized === "post" || normalized === "file") {
    return normalized;
  }
  return "";
}

function buildDownloadedFileName(message, resource, headers) {
  const rawName = String(resource?.fileName ?? "").trim();
  const extension =
    path.extname(rawName).toLowerCase() ||
    guessBinaryExtensionFromHeaders(headers) ||
    ".bin";
  const baseName = sanitizeFileToken(rawName ? rawName.slice(0, Math.max(0, rawName.length - extension.length)) : "attachment");
  return `${Date.now()}-${sanitizeFileToken(message?.message_id || "feishu")}-${sanitizeFileToken(resource?.resourceKey || "file")}-${baseName}${extension}`;
}

function guessBinaryExtensionFromHeaders(headers) {
  const contentType = String(headers?.get?.("content-type") ?? "").toLowerCase();
  if (!contentType) {
    return "";
  }
  const known = {
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "text/markdown": ".md",
    "application/json": ".json",
    "text/csv": ".csv",
    "application/zip": ".zip",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/msword": ".doc",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/vnd.ms-excel": ".xls",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.ms-powerpoint": ".ppt"
  };
  return known[contentType] ?? "";
}

function extractPostMessageText(value) {
  if (!value || typeof value !== "object") {
    return "";
  }

  const collected = [];
  const queue = [value];
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      for (const entry of current) {
        queue.push(entry);
      }
      continue;
    }

    for (const [key, entry] of Object.entries(current)) {
      if ((key === "text" || key === "title") && typeof entry === "string" && entry.trim()) {
        collected.push(entry.trim());
        continue;
      }
      if (entry && typeof entry === "object") {
        queue.push(entry);
      }
    }
  }

  return collected.join("\n");
}

function normalizeIncomingText(text) {
  return String(text ?? "")
    .replace(/\u200B/g, "")
    .replace(/^(?:@\S+\s*)+/, "")
    .trim();
}

function summarizeInboundText(text, max = 160) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, max - 1))}…`;
}

function prepareFeishuPromptText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || !looksLikeAttachmentRequest(trimmed)) {
    return trimmed;
  }
  return [
    "[Platform context: Feishu chat]",
    "You are replying in a Feishu chat bridged through agent-gateway, not a CLI-only terminal session.",
    "This bridge can upload supported local files and images as chat attachments.",
    "If the user asks to send a file as an attachment, do not claim attachments are unsupported.",
    "If a local path is provided, use that path naturally in your answer so the bridge can upload it.",
    "",
    trimmed
  ].join("\n");
}

function looksLikeAttachmentRequest(text) {
  const normalized = String(text ?? "").toLowerCase();
  if (!normalized) {
    return false;
  }
  const hasAttachmentIntent =
    normalized.includes("附件") ||
    normalized.includes("附加") ||
    normalized.includes("attachment") ||
    normalized.includes("attach") ||
    normalized.includes("send file") ||
    normalized.includes("upload file");
  if (!hasAttachmentIntent) {
    return false;
  }
  return normalized.includes("/") || normalized.includes("文件") || normalized.includes("图片") || normalized.includes("image");
}

function resolveIncomingHandlingDecision(message, text, requireMentionInGroup) {
  const normalized = String(text ?? "").trim();
  if (normalized && /^[!/]/.test(normalized)) {
    return { allowed: true, reason: "command_like_text" };
  }
  const chatType = String(message?.chat_type ?? "");
  if (chatType === "p2p") {
    return { allowed: true, reason: "p2p_chat" };
  }
  if (!requireMentionInGroup) {
    return { allowed: true, reason: "group_mentions_not_required" };
  }
  if (Array.isArray(message?.mentions) && message.mentions.length > 0) {
    return { allowed: true, reason: "group_with_mention" };
  }
  return {
    allowed: false,
    reason: "group_plain_text_without_required_mention"
  };
}

function resolveNumberedOptionText(text, selection) {
  const selectedNumber = String(selection ?? "").trim();
  if (!selectedNumber) {
    return "";
  }
  const options = parseNumberedOptions(text);
  if (options.length < 2) {
    return "";
  }
  const matched = options.find((option) => option.number === selectedNumber);
  return matched?.text ?? "";
}

function parseNumberedOptions(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const options = [];
  for (const line of lines) {
    const match = line.match(/^\s*(\d{1,2})\s*([).、]|）)\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const optionText = String(match[3] ?? "").trim();
    if (!optionText) {
      continue;
    }
    options.push({
      number: match[1],
      text: optionText
    });
  }
  return options;
}

function normalizeCommandText(text) {
  const normalizedSlashCommand = normalizeRecognizedSlashCommandText(text, FEISHU_TEXT_COMMANDS);
  return normalizeRecognizedCommandText(normalizedSlashCommand, FEISHU_TEXT_COMMANDS);
}

const FEISHU_TEXT_COMMANDS = new Set([
  "help",
  "ask",
  "setpath",
  "status",
  "new",
  "restart",
  "interrupt",
  "where",
  "approve",
  "decline",
  "cancel",
  "resync",
  "rebuild",
  "initrepo",
  "setmodel",
  "clearmodel",
  "bind",
  "rebind",
  "unbind",
  "mkchannel",
  "mkbind",
  "mkrepo",
  "joinbot",
  "addbot"
]);

function resolveTargetChatId(raw, fallbackChatId = "") {
  const normalizedRaw = String(raw ?? "").trim();
  if (!normalizedRaw) {
    return String(fallbackChatId ?? "").trim();
  }

  const token = normalizedRaw.split(/\s+/, 1)[0]?.trim().replace(/^`|`$/g, "") ?? "";
  if (!token) {
    return String(fallbackChatId ?? "").trim();
  }
  const routeChatId = parseFeishuRouteId(token);
  if (routeChatId) {
    return routeChatId;
  }
  return token;
}

function buildLongConnectionEventId(event) {
  const messageId = String(event?.message?.message_id ?? "").trim();
  if (messageId) {
    return `message:${messageId}`;
  }
  return "";
}

function buildLongConnectionChatEventId(prefix, chatId, operatorOpenId = "") {
  const normalizedChatId = String(chatId ?? "").trim();
  if (!normalizedChatId) {
    return "";
  }
  const normalizedOperator = String(operatorOpenId ?? "").trim();
  return `${prefix}:${normalizedChatId}:${normalizedOperator || "unknown"}`;
}

function getProxyUrl() {
  return (
    String(process.env.HTTPS_PROXY ?? "").trim() ||
    String(process.env.https_proxy ?? "").trim() ||
    String(process.env.HTTP_PROXY ?? "").trim() ||
    String(process.env.http_proxy ?? "").trim()
  );
}

function resolveImageCacheDir(imageCacheDir) {
  const candidate = typeof imageCacheDir === "string" ? imageCacheDir.trim() : "";
  return path.resolve(candidate || "/tmp/agent-gateway-images");
}

function guessImageExtensionFromHeaders(headers, fileName = "") {
  const byName = path.extname(String(fileName ?? "")).toLowerCase();
  if (byName && byName.length <= 10) {
    return byName;
  }

  const contentType = String(headers?.get?.("content-type") ?? "").toLowerCase();
  const known = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/tiff": ".tif",
    "image/svg+xml": ".svg"
  };
  return known[contentType] ?? ".png";
}

function sanitizeFileToken(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "file";
}

function extractOutgoingContentText(payload) {
  if (typeof payload === "string") {
    return payload.trim();
  }
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "").trim();
  }
  return typeof payload.content === "string" ? payload.content.trim() : "";
}

function extractOutgoingText(payload) {
  if (typeof payload === "string") {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return String(payload ?? "");
  }

  const lines = [];
  if (typeof payload.content === "string" && payload.content.trim()) {
    lines.push(payload.content.trim());
  }
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    const fileNames = payload.files
      .map((entry) => String(entry?.name ?? entry?.attachment ?? "").trim())
      .filter((value) => value.length > 0);
    if (fileNames.length > 0) {
      lines.push(`Files: ${fileNames.join(", ")}`);
    }
  }
  return lines.join("\n").trim();
}

function resolveOutgoingFile(file) {
  if (typeof file === "string") {
    return {
      filePath: file.trim() ? path.resolve(file.trim()) : "",
      name: path.basename(file.trim())
    };
  }
  if (!file || typeof file !== "object") {
    return null;
  }

  const filePath =
    typeof file.attachment === "string" && file.attachment.trim()
      ? path.resolve(file.attachment.trim())
      : typeof file.path === "string" && file.path.trim()
        ? path.resolve(file.path.trim())
        : "";
  const name =
    typeof file.name === "string" && file.name.trim()
      ? file.name.trim()
      : filePath
        ? path.basename(filePath)
        : "";
  return {
    filePath,
    name
  };
}

function extractOutgoingFileName(file) {
  if (typeof file === "string") {
    return path.basename(file);
  }
  if (!file || typeof file !== "object") {
    return "";
  }
  if (typeof file.name === "string" && file.name.trim()) {
    return file.name.trim();
  }
  if (typeof file.attachment === "string" && file.attachment.trim()) {
    return path.basename(file.attachment.trim());
  }
  if (typeof file.path === "string" && file.path.trim()) {
    return path.basename(file.path.trim());
  }
  return "";
}

function isImageFilePath(filePath, fileName = "") {
  const candidate = String(fileName || filePath || "").toLowerCase();
  // Feishu's image message upload endpoint is stricter than Discord-style image handling.
  // Keep vector/icon assets on the generic file path so `.svg` / `.ico` still round-trip.
  return /\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(candidate);
}

function guessFeishuFileType(fileName = "") {
  const extension = path.extname(String(fileName ?? "")).toLowerCase();
  if (extension === ".opus") {
    return "opus";
  }
  if (extension === ".mp4") {
    return "mp4";
  }
  if (extension === ".pdf") {
    return "pdf";
  }
  if (extension === ".doc" || extension === ".docx") {
    return "doc";
  }
  if (extension === ".xls" || extension === ".xlsx" || extension === ".csv") {
    return "xls";
  }
  if (extension === ".ppt" || extension === ".pptx") {
    return "ppt";
  }
  return "stream";
}

function buildFeishuWhereText({ inboundMessage, senderOpenId, context, bindingKind = "none" }) {
  const routeId = String(inboundMessage?.channelId ?? "").trim();
  const chatId = String(inboundMessage?.channel?.chatId ?? "").trim();
  const lines = [
    "platform: `feishu`",
    `chat_id: \`${chatId || "(unknown)"}\``,
    `route_id: \`${routeId || "(unknown)"}\``,
    `sender_open_id: \`${senderOpenId || "(unknown)"}\``
  ];

  if (!context) {
    lines.push("binding: none");
    lines.push("Add the route_id to `config/channels.json`, or set `FEISHU_GENERAL_CHAT_ID` for a read-only general chat.");
    return lines.join("\n");
  }

  const threadMode =
    bindingKind === "unbound-open" ? "unbound-open" : context.setup.bindingKind ?? (context.setup.mode === "general" ? "general" : "repo");
  const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
  lines.push(`binding: \`${threadMode}\``);
  lines.push(`cwd: \`${context.setup.cwd}\``);
  lines.push(`model: \`${context.setup.resolvedModel ?? context.setup.model}\``);
  lines.push(`sandbox mode: \`${context.setup.sandboxMode}\``);
  lines.push(`file writes: \`${fileWrites}\``);
  return lines.join("\n");
}

function buildFeishuBotAddedText({ chatId, operatorOpenId, context, bindingKind, requireMentionInGroup }) {
  const lines = ["Bridge is ready in this Feishu chat."];

  if (!context) {
    lines.push(`chat_id: \`${chatId || "(unknown)"}\``);
    lines.push(`route_id: \`${makeFeishuRouteId(chatId)}\``);
    if (operatorOpenId) {
      lines.push(`invited_by_open_id: \`${operatorOpenId}\``);
    }
    lines.push("This chat is not bound yet. Send `/where` to inspect identifiers or `/setpath /absolute/path` to bind it.");
    return lines.join("\n");
  }

  if (bindingKind === "general") {
    lines.push("This chat is using the read-only Feishu general workspace.");
  } else if (bindingKind === "unbound-open") {
    lines.push("This new chat is usable immediately with the default Feishu workspace.");
  } else {
    lines.push("This chat is already bound to a repo workspace.");
  }

  lines.push(`cwd: \`${context.setup.cwd}\``);
  lines.push(`model: \`${context.setup.resolvedModel ?? context.setup.model}\``);
  lines.push("Try `/where` to inspect identifiers or `/setpath /absolute/path` to switch workspaces.");
  lines.push(
    requireMentionInGroup
      ? "Use `/ask <prompt>` or `@bot <prompt>` in group chats."
      : "Use `/ask <prompt>` or send a plain prompt directly in this chat."
  );
  return lines.join("\n");
}
