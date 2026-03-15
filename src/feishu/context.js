import { makeFeishuRouteId } from "./ids.js";

export function resolveFeishuContext(message, options) {
  const { channelSetups, config, generalChat, unboundChat } = options;
  const routeId = String(message?.channelId ?? "").trim();
  if (!routeId) {
    return null;
  }

  const setup = channelSetups[routeId];
  if (setup) {
    return {
      repoChannelId: routeId,
      setup: {
        ...setup,
        bindingKind: "repo",
        mode: "repo",
        sandboxMode: config.sandboxMode,
        allowFileWrites: true
      }
    };
  }

  if (isFeishuGeneralChat(message, generalChat)) {
    return {
      repoChannelId: routeId,
      setup: {
        cwd: generalChat.cwd,
        model: config.defaultModel,
        bindingKind: "general",
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

  if (String(unboundChat?.mode ?? "").trim().toLowerCase() !== "open") {
    return null;
  }

  return {
    repoChannelId: routeId,
    setup: {
      cwd: unboundChat?.cwd,
      model: config.defaultModel,
      bindingKind: "unbound-open",
      mode: "general",
      sandboxMode: "read-only",
      allowFileWrites: false
    }
  };
}

export function isFeishuGeneralChat(messageOrChannel, generalChat) {
  const generalChatId = String(generalChat?.id ?? "").trim();
  if (!generalChatId) {
    return false;
  }

  const routeId = String(messageOrChannel?.channelId ?? messageOrChannel?.id ?? "").trim();
  if (!routeId) {
    return false;
  }

  return routeId === makeFeishuRouteId(generalChatId) || routeId === generalChatId;
}
