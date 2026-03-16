import { makeFeishuRouteId } from "./ids.js";
import { resolveSetupAgentAndModel } from "../agents/setupResolution.js";

export function resolveFeishuContext(message, options) {
  const { channelSetups, config, generalChat, unboundChat } = options;
  const routeId = String(message?.channelId ?? "").trim();
  if (!routeId) {
    return null;
  }

  const setup = channelSetups[routeId];
  if (setup) {
    const resolvedRepo = resolveSetupAgentAndModel(setup, config);
    const normalizedSetupAgentId = String(setup?.agentId ?? "").trim();
    const shouldAttachResolvedModel =
      typeof resolvedRepo.resolvedModel === "string" &&
      resolvedRepo.resolvedModel.length > 0 &&
      resolvedRepo.resolvedModel !== String(setup?.model ?? "").trim();
    const shouldAttachResolvedAgent =
      !normalizedSetupAgentId &&
      typeof resolvedRepo.resolvedAgentId === "string" &&
      resolvedRepo.resolvedAgentId.length > 0;

    return {
      repoChannelId: routeId,
      setup: {
        ...setup,
        ...(shouldAttachResolvedModel ? { resolvedModel: resolvedRepo.resolvedModel } : {}),
        ...(shouldAttachResolvedAgent ? { resolvedAgentId: resolvedRepo.resolvedAgentId } : {}),
        bindingKind: "repo",
        mode: "repo",
        sandboxMode: config.sandboxMode,
        allowFileWrites: true
      }
    };
  }

  if (isFeishuGeneralChat(message, generalChat)) {
    const resolvedGeneral = resolveSetupAgentAndModel({}, config);
    return {
      repoChannelId: routeId,
      setup: {
        cwd: generalChat.cwd,
        resolvedModel: resolvedGeneral.resolvedModel ?? config.defaultModel,
        ...(typeof resolvedGeneral.resolvedAgentId === "string" && resolvedGeneral.resolvedAgentId.length > 0
          ? { resolvedAgentId: resolvedGeneral.resolvedAgentId }
          : {}),
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

  const resolvedUnbound = resolveSetupAgentAndModel({}, config);
  return {
    repoChannelId: routeId,
    setup: {
      cwd: unboundChat?.cwd,
      resolvedModel: resolvedUnbound.resolvedModel ?? config.defaultModel,
      ...(typeof resolvedUnbound.resolvedAgentId === "string" && resolvedUnbound.resolvedAgentId.length > 0
        ? { resolvedAgentId: resolvedUnbound.resolvedAgentId }
        : {}),
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
