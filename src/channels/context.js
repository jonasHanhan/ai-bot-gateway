import { DISCORD_CHANNEL_TYPES } from "../discord/constants.js";
import { resolveSetupAgentAndModel } from "../agents/setupResolution.js";

export function isGeneralChannel(channel, generalChannel) {
  if (channel?.type !== DISCORD_CHANNEL_TYPES.GuildText) {
    return false;
  }
  const generalChannelId = String(generalChannel?.id ?? "").trim();
  if (generalChannelId) {
    return channel.id === generalChannelId;
  }
  const configuredName = String(generalChannel?.name ?? "general")
    .trim()
    .toLowerCase();
  return channel.name.toLowerCase() === configuredName;
}

export function resolveRepoContext(message, options) {
  const { channelSetups, config, generalChannel } = options;
  if (message.channel.type !== DISCORD_CHANNEL_TYPES.GuildText) {
    return null;
  }

  const setup = channelSetups[message.channelId];
  if (!setup) {
    const resolvedGeneral = resolveSetupAgentAndModel({}, config);
    if (!isGeneralChannel(message.channel, generalChannel)) {
      return null;
    }
    return {
      repoChannelId: message.channelId,
      setup: {
        cwd: generalChannel.cwd,
        resolvedModel: resolvedGeneral.resolvedModel ?? config.defaultModel,
        ...(typeof resolvedGeneral.resolvedAgentId === "string" && resolvedGeneral.resolvedAgentId.length > 0
          ? { resolvedAgentId: resolvedGeneral.resolvedAgentId }
          : {}),
        mode: "general",
        sandboxMode: "read-only",
        allowFileWrites: false
      }
    };
  }

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
    repoChannelId: message.channelId,
    setup: {
      ...setup,
      ...(shouldAttachResolvedModel ? { resolvedModel: resolvedRepo.resolvedModel } : {}),
      ...(shouldAttachResolvedAgent ? { resolvedAgentId: resolvedRepo.resolvedAgentId } : {}),
      mode: "repo",
      sandboxMode: config.sandboxMode,
      allowFileWrites: true
    }
  };
}
