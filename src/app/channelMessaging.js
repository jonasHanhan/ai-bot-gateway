import { stripAnsi } from "../utils/stripAnsi.js";

export function createChannelMessaging(deps) {
  const { fetchChannelByRouteId, stripAnsiForDiscord = false } = deps;

  async function safeReply(message, content) {
    const sanitizedContent = sanitizeOutboundText(content, resolvePlatform(message));
    try {
      return await message.reply(sanitizedContent);
    } catch (error) {
      if (!isChannelUnavailableError(error) && !message?.channel?.isTextBased?.()) {
        throw error;
      }
      const channel =
        (message?.channel?.isTextBased?.() ? message.channel : null) ??
        (await fetchChannelByRouteId(message.channelId).catch(() => null));
      if (channel && channel.isTextBased()) {
        try {
          const fallbackContent = sanitizeOutboundText(sanitizedContent, resolvePlatform(message, channel));
          return await channel.send(fallbackContent);
        } catch (sendError) {
          if (!isChannelUnavailableError(sendError)) {
            throw sendError;
          }
        }
      }
      console.warn(`reply dropped in unavailable channel ${message.channelId}`);
      return null;
    }
  }

  async function safeSendToChannel(channel, text) {
    if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
      return null;
    }
    try {
      return await channel.send(sanitizeOutboundText(text, resolvePlatform(null, channel)));
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        throw error;
      }
      return null;
    }
  }

  async function safeSendToChannelPayload(channel, payload) {
    if (!channel || typeof channel.isTextBased !== "function" || !channel.isTextBased()) {
      return null;
    }
    try {
      const platform = resolvePlatform(null, channel);
      const sanitizedPayload = sanitizePayload(payload, platform);
      return await channel.send(sanitizedPayload);
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        throw error;
      }
      return null;
    }
  }

  async function safeAddReaction(message, reaction) {
    if (!message) {
      return null;
    }
    try {
      if (typeof message.react === "function") {
        return await message.react(reaction);
      }
      const channel =
        (message?.channel?.isTextBased?.() ? message.channel : null) ??
        (message?.channelId ? await fetchChannelByRouteId(message.channelId).catch(() => null) : null);
      if (channel?.messages && typeof channel.messages.react === "function" && message?.id) {
        return await channel.messages.react(message.id, reaction);
      }
      return null;
    } catch (error) {
      if (!isChannelUnavailableError(error)) {
        console.warn(`reaction dropped for message ${message?.id ?? "(unknown)"}: ${String(error?.message ?? error)}`);
      }
      return null;
    }
  }

  function resolvePlatform(message, channel) {
    const platform = String(channel?.platform ?? message?.platform ?? "").trim().toLowerCase();
    if (platform) {
      return platform;
    }
    const routeId = String(channel?.id ?? message?.channelId ?? "").trim().toLowerCase();
    if (routeId.startsWith("feishu:")) {
      return "feishu";
    }
    return "discord";
  }

  function sanitizeOutboundText(content, platform) {
    if (typeof content !== "string") {
      return content;
    }
    if (platform === "feishu" || (platform === "discord" && stripAnsiForDiscord)) {
      return stripAnsi(content);
    }
    return content;
  }

  function sanitizePayload(payload, platform) {
    if (!payload || typeof payload !== "object") {
      return sanitizeOutboundText(payload, platform);
    }
    if (typeof payload.content !== "string") {
      return payload;
    }
    const sanitizedContent = sanitizeOutboundText(payload.content, platform);
    if (sanitizedContent === payload.content) {
      return payload;
    }
    return {
      ...payload,
      content: sanitizedContent
    };
  }

  return {
    safeReply,
    safeSendToChannel,
    safeSendToChannelPayload,
    safeAddReaction
  };
}

export function isChannelUnavailableError(error) {
  const code = String(error?.code ?? "");
  const apiCode = Number(error?.rawError?.code ?? 0);
  const message = String(error?.message ?? "").toLowerCase();
  return (
    code === "ChannelNotCached" ||
    code === "10003" ||
    apiCode === 10003 ||
    message.includes("channel not cached") ||
    message.includes("unknown channel")
  );
}
