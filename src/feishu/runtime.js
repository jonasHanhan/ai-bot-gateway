import fs from "node:fs/promises";
import path from "node:path";
import * as FeishuSdk from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import { makeFeishuRouteId, parseFeishuRouteId } from "./ids.js";
import { resolveFeishuContext } from "./context.js";
import { isFeishuLongConnectionTransport, isFeishuWebhookTransport, normalizeFeishuTransport } from "./transport.js";

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
    feishuRequireMentionInGroup
  } = runtimeEnv;

  const seenEventIds = new Map();
  const sentMessages = new Map();
  const transport = normalizeFeishuTransport(feishuTransport);
  const proxyUrl = getProxyUrl();
  const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;
  let wsClient = null;
  let tenantAccessToken = "";
  let tenantAccessTokenExpiresAt = 0;

  async function fetchChannelByRouteId(routeId) {
    const chatId = parseFeishuRouteId(routeId);
    if (!chatId) {
      return null;
    }
    return createChannel(chatId);
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

    if (!isValidVerificationToken(payload)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: 403, msg: "invalid token" }));
      return;
    }

    if (isUrlVerification(payload)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ challenge: payload.challenge }));
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
    if (eventType !== "im.message.receive_v1") {
      return;
    }

    await processMessageReceiveEvent(payload?.event, {
      eventId: String(payload?.header?.event_id ?? "")
    });
  }

  async function processMessageReceiveEvent(event, options = {}) {
    const eventId = String(options?.eventId ?? "").trim() || buildLongConnectionEventId(event);
    if (eventId && markEventSeen(eventId)) {
      return;
    }

    const senderType = String(event?.sender?.sender_type ?? "");
    if (senderType && senderType !== "user") {
      return;
    }

    const message = event?.message;
    const messageType = normalizeIncomingMessageType(message?.message_type);
    if (!messageType) {
      return;
    }

    const senderOpenId = String(event?.sender?.sender_id?.open_id ?? "").trim();
    if (!isAllowedUser(senderOpenId)) {
      console.warn(`ignoring Feishu message from filtered user ${senderOpenId || "(unknown)"}`);
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
      text: messageType === "text" ? normalizeIncomingText(extractTextMessageContent(message.content)) : "[image]"
    });

    if (messageType === "image") {
      await handleInboundImageMessage({ inboundMessage, senderOpenId, message });
      return;
    }

    const text = normalizeIncomingText(extractTextMessageContent(message.content));
    if (!text) {
      return;
    }
    if (!shouldHandleIncomingMessage(message, text)) {
      return;
    }

    const normalizedCommand = normalizeCommandText(text);
    if (normalizedCommand === "!help") {
      await safeReply(inboundMessage, getHelpText({ platformId: "feishu" }));
      return;
    }

    if (normalizedCommand === "!where") {
      const context = resolveFeishuContext(inboundMessage, {
        channelSetups: getChannelSetups(),
        config,
        generalChat: {
          id: feishuGeneralChatId,
          cwd: feishuGeneralCwd
        }
      });
      await safeReply(inboundMessage, buildFeishuWhereText({ inboundMessage, senderOpenId, context }));
      return;
    }

    if (normalizedCommand.startsWith("!setpath")) {
      const rest = normalizedCommand.replace(/^!setpath\b/i, "").trim();
      await handleSetPathCommand(inboundMessage, rest);
      return;
    }

    if (normalizedCommand === "!resync") {
      await runManagedRouteCommand(inboundMessage, { forceRebuild: false });
      return;
    }

    if (normalizedCommand === "!rebuild") {
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

    const context = resolveFeishuContext(inboundMessage, {
      channelSetups: getChannelSetups(),
      config,
      generalChat: {
        id: feishuGeneralChatId,
        cwd: feishuGeneralCwd
      }
    });
    if (!context) {
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
      await handleCommand(inboundMessage, normalizedCommand, context);
      return;
    }

    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, text, [], context.setup);
    if (inputItems.length === 0) {
      return;
    }
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
  }

  async function handleInboundImageMessage({ inboundMessage, senderOpenId, message }) {
    if (!shouldHandleIncomingMessage(message, "")) {
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

    const inputItems = await runtimeAdapters.buildTurnInputFromMessage(inboundMessage, "", [imageAttachment], context.setup);
    if (inputItems.length === 0) {
      await safeReply(inboundMessage, "I received the image but could not build a Codex input from it.");
      return;
    }
    runtimeAdapters.enqueuePrompt(context.repoChannelId, {
      inputItems,
      message: inboundMessage,
      setup: context.setup,
      repoChannelId: context.repoChannelId
    });
  }

  async function start() {
    if (!feishuEnabled) {
      return {
        started: false,
        transport
      };
    }

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
        await processMessageReceiveEvent(event);
      }
    });

    await wsClient.start({ eventDispatcher });

    return {
      started: true,
      transport
    };
  }

  function stop() {
    wsClient?.close?.({ force: true });
    wsClient = null;
  }

  function createChannel(chatId, options = {}) {
    const routeId = makeFeishuRouteId(chatId);
    const isGeneral = feishuGeneralChatId && String(chatId) === String(feishuGeneralChatId);
    return {
      id: routeId,
      chatId,
      platform: "feishu",
      bridgeMeta: {
        mode: isGeneral ? "general" : "repo",
        allowFileWrites: !isGeneral
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
      messages: {
        fetch: async (messageId) => sentMessages.get(String(messageId)) ?? null,
        edit: async (messageId, payload) => {
          const existing = sentMessages.get(String(messageId));
          if (!existing) {
            return null;
          }
          return await existing.edit(payload);
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
        return await sendTextMessage({
          chatId: channel.chatId,
          text: extractOutgoingText(payload),
          replyToMessageId: messageId
        });
      }
    };
  }

  async function sendTextMessage({ chatId, text, replyToMessageId }) {
    const normalizedText = String(text ?? "").trim();
    if (!normalizedText) {
      return null;
    }
    let response;
    if (replyToMessageId) {
      response = await feishuRequest(`/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`, {
        method: "POST",
        body: {
          msg_type: "text",
          content: JSON.stringify({ text: normalizedText })
        }
      });
    } else {
      response = await feishuRequest(`/open-apis/im/v1/messages?receive_id_type=chat_id`, {
        method: "POST",
        body: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: normalizedText })
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
      content: normalizedText,
      channel,
      channelId: channel.id,
      async edit(payload) {
        this.content = extractOutgoingText(payload);
        return this;
      }
    };
    sentMessages.set(messageId, sent);
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

  async function sendStructuredMessage({ chatId, msgType, content, replyToMessageId }) {
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
      content: msgType === "text" ? String(content?.text ?? "").trim() : JSON.stringify(content),
      channel,
      channelId: channel.id,
      async edit(payload) {
        this.content = extractOutgoingText(payload);
        return this;
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

  function shouldHandleIncomingMessage(message, text) {
    const normalized = String(text ?? "").trim();
    if (normalized && /^[!/]/.test(normalized)) {
      return true;
    }
    const chatType = String(message?.chat_type ?? "");
    if (chatType === "p2p") {
      return true;
    }
    if (!feishuRequireMentionInGroup) {
      return true;
    }
    return Array.isArray(message?.mentions) && message.mentions.length > 0;
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

  function markEventSeen(eventId) {
    const now = Date.now();
    for (const [key, timestamp] of seenEventIds.entries()) {
      if (now - timestamp > 10 * 60_000) {
        seenEventIds.delete(key);
      }
    }
    if (seenEventIds.has(eventId)) {
      return true;
    }
    seenEventIds.set(eventId, now);
    return false;
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
    return resolveFeishuContext(inboundMessage, {
      channelSetups: getChannelSetups(),
      config,
      generalChat: {
        id: feishuGeneralChatId,
        cwd: feishuGeneralCwd
      }
    });
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

  async function downloadInboundImageAttachment(message) {
    const resource = extractImageMessageResource(message?.content);
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
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function extractTextMessageContent(rawContent) {
  if (typeof rawContent !== "string" || !rawContent.trim()) {
    return "";
  }
  try {
    const parsed = JSON.parse(rawContent);
    return typeof parsed?.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function extractImageMessageResource(rawContent) {
  const parsed = parseFeishuMessageContent(rawContent);
  if (!parsed) {
    return null;
  }
  const resourceKey = findFirstString(parsed, ["image_key", "file_key", "key"]);
  if (!resourceKey) {
    return null;
  }
  return {
    resourceKey,
    fileName: findFirstString(parsed, ["file_name", "name", "title"])
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
  if (normalized === "text" || normalized === "image") {
    return normalized;
  }
  return "";
}

function normalizeIncomingText(text) {
  return String(text ?? "")
    .replace(/\u200B/g, "")
    .replace(/^(?:@\S+\s*)+/, "")
    .trim();
}

function normalizeCommandText(text) {
  const normalized = String(text ?? "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.startsWith("/")) {
    return `!${normalized.slice(1).trim()}`;
  }
  return normalized;
}

function buildLongConnectionEventId(event) {
  const messageId = String(event?.message?.message_id ?? "").trim();
  if (messageId) {
    return `message:${messageId}`;
  }
  return "";
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
  return path.resolve(candidate || "/tmp/codex-discord-bridge-images");
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

function buildFeishuWhereText({ inboundMessage, senderOpenId, context }) {
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

  const threadMode = context.setup.mode === "general" ? "general" : "repo";
  const fileWrites = context.setup.allowFileWrites === false ? "disabled" : "enabled";
  lines.push(`binding: \`${threadMode}\``);
  lines.push(`cwd: \`${context.setup.cwd}\``);
  lines.push(`model: \`${context.setup.model}\``);
  lines.push(`sandbox mode: \`${context.setup.sandboxMode}\``);
  lines.push(`file writes: \`${fileWrites}\``);
  return lines.join("\n");
}
